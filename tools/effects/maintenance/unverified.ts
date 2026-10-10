import path from 'node:path';
import ts from 'typescript';
import type { EffectsAnalysis } from '../analysis/analyze.ts';
import { mayOmitEffectAnnotation } from '../analysis/annotation-policy.ts';
import { mergeEffects, printEffect } from '../contracts/effects.ts';
import { planEffectFix, planEffectRows, type EffectFixPlan } from '../fixes/plan.ts';
import { resolveProjectPath } from '../project.ts';

export const UNVERIFIED_EFFECT_NOTE = '// TODO(effects): UNVERIFIED effect candidates; unresolved bodies/paths may be omitted.';

/** Only the fixed file-header note belongs to this maintenance operation. */
export function unverifiedEffectNotes({ source }: { source: string }): readonly { start: number, end: number }[] {
  const offset = source.startsWith('\uFEFF') ? 1 : 0;
  const scanner = ts.createScanner(ts.ScriptTarget.Latest, false, ts.LanguageVariant.Standard, source.slice(offset));
  const notes: { start: number, end: number }[] = [];
  for (let token = scanner.scan(); token !== ts.SyntaxKind.EndOfFileToken; token = scanner.scan()) {
    if (token === ts.SyntaxKind.SingleLineCommentTrivia && scanner.getTokenText() === UNVERIFIED_EFFECT_NOTE) {
      notes.push({ start: scanner.getTokenPos() + offset, end: scanner.getTextPos() + offset });
    } else if (token < ts.SyntaxKind.FirstTriviaToken || token > ts.SyntaxKind.LastTriviaToken) break;
  }
  return notes;
}

function clearNotes({ source }: { source: string }): string {
  let result = source;
  for (const note of [...unverifiedEffectNotes({ source })].reverse()) {
    const end = source.startsWith('\r\n', note.end) ? note.end + 2 : source[note.end] === '\n' ? note.end + 1 : note.end;
    result = result.slice(0, note.start) + result.slice(end);
  }
  return result;
}

function markSource({ source }: { source: string }): string {
  const clean = clearNotes({ source });
  const newline = clean.includes('\r\n') ? '\r\n' : '\n';
  let start = clean.startsWith('\uFEFF') ? 1 : 0;
  if (clean.startsWith('#!', start)) {
    const end = clean.indexOf('\n', start);
    if (end === -1) return clean + newline + UNVERIFIED_EFFECT_NOTE + newline;
    start = end + 1;
  }
  return clean.slice(0, start) + UNVERIFIED_EFFECT_NOTE + newline + clean.slice(start);
}

function localFiles({ analysis, root, files }: { analysis: EffectsAnalysis, root: string, files: readonly string[] }): ReadonlySet<string> {
  const coverage = new Set(analysis.coverage.files.map(file => path.resolve(file)));
  const selected = new Set<string>();
  for (const file of files) {
    const absolute = path.resolve(root, file);
    if (!coverage.has(absolute) || !analysis.sources.has(absolute) || !absolute.endsWith('.ts') || absolute.endsWith('.d.ts') || absolute.endsWith('.test.ts') || path.relative(root, absolute).split(path.sep).includes('node_modules')) continue;
    selected.add(resolveProjectPath({ root, relative: absolute }));
  }
  return selected;
}

/** Candidates retain every existing upper bound; the header explicitly denies verification. */
export function planUnresolvedEffectFix({ analysis, root, files, mode }: {
  analysis: EffectsAnalysis, root: string, files: readonly string[], mode: 'fix' | 'tidy',
}): EffectFixPlan {
  const selected = localFiles({ analysis, root, files });
  const unsafe = new Set(analysis.unsafeSuppressions.map(item => item.owner));
  const symbolicAnchors = new Set(analysis.owners.filter(owner => owner.role === 'symbolic').map(owner => owner.anchor));
  const syntaxFiles = new Set(analysis.diagnostics.filter(item => item.code === 'syntax').map(item => path.resolve(item.file)));
  const owners = analysis.owners.filter(owner => selected.has(path.resolve(owner.location.file)) && !owner.anchor.getSourceFile().isDeclarationFile
    && !unsafe.has(owner.id) && !syntaxFiles.has(path.resolve(owner.location.file))
    // Adding a bound to a shared declaration turns callers' symbolic parameters
    // into fixed contracts. A partial implementation row cannot choose it.
    && !(owner.annotation === undefined && (owner.role === 'signature' || symbolicAnchors.has(owner.anchor))));
  const rows = new Map(owners.map(owner => [owner.id, mergeEffects({
    groups: [
      owner.declared,
      (analysis.solution.rows.get(owner.id) ?? []).filter(effect => {
        switch (effect.kind) {
        case 'operation': return true;
          // Partial propagation can carry another owner's parameter path. Do not
          // publish a new invalid contract; retain its evidence in the analysis.
        case 'callback': return owner.callbackPaths.has(printEffect({ effect }));
        default: { const exhaustive: never = effect; throw new Error(String(exhaustive)); }
        }
      }),
    ],
  })]));
  const omitAnnotations = new Set(owners.filter(owner => mode === 'tidy' && owner.annotation !== undefined
    && owner.declared.length === 0 && (rows.get(owner.id) ?? []).length === 0 && !unsafe.has(owner.id)
    && mayOmitEffectAnnotation({ owner })).map(owner => owner.id));
  const plan = planEffectRows({ owners, rows, sources: analysis.sources, omitAnnotations });
  const rewritten = new Map(plan.edits.map(edit => [edit.file, edit.after]));
  const diagnosed = new Set(analysis.diagnostics.map(item => path.resolve(item.file)));
  const dependentFiles = new Set(analysis.dependencies.map(edge => path.resolve(analysis.owners[edge.target]!.location.file)));
  const trivialFiles = new Map<string, boolean>();
  const effectfulModules = new Set<string>();
  for (const owner of analysis.owners) {
    const file = path.resolve(owner.location.file);
    switch (owner.role) {
    case 'implementation': trivialFiles.set(file, (trivialFiles.get(file) ?? true) && mayOmitEffectAnnotation({ owner })); break;
    case 'module': if ((analysis.solution.rows.get(owner.id) ?? []).length > 0) effectfulModules.add(file); break;
    case 'slot': case 'signature': case 'symbolic': case 'body': break;
    default: { const exhaustive: never = owner.role; throw new Error(String(exhaustive)); }
    }
  }
  const edits = [...selected].flatMap(file => {
    const before = analysis.sources.get(file)!;
    // Dependency targets include callers whose callees may have unsupported bodies.
    // Unchanged, clean files without those dependencies need no new draft warning.
    if (!rewritten.has(file) && !diagnosed.has(file) && (trivialFiles.get(file) === true || !dependentFiles.has(file)) && !effectfulModules.has(file)) return [];
    const after = markSource({ source: rewritten.get(file) ?? before });
    return before === after ? [] : [{ file, before, after }];
  });
  return { edits, snapshots: analysis.sources };
}

/** A normal successful fix removes the fixed note only after all real blockers disappear. */
export function planVerifiedEffectFix({ analysis, root, files }: { analysis: EffectsAnalysis, root: string, files?: readonly string[] | undefined }): EffectFixPlan {
  const selected = localFiles({ analysis, root, files: files ?? analysis.coverage.files });
  const ordinary = { ...analysis, owners: analysis.owners.filter(owner => selected.has(path.resolve(owner.location.file))), diagnostics: analysis.diagnostics.filter(item => item.code !== 'unsupported' || item.message !== UNVERIFIED_EFFECT_NOTE) };
  const plan = planEffectFix({ analysis: ordinary });
  for (const edit of plan.edits) if (!selected.has(edit.file)) throw new Error(`Effect fix attempted to edit outside analyzed application sources: ${edit.file}`);
  const rewritten = new Map(plan.edits.map(edit => [edit.file, edit.after]));
  const edits = [...selected].flatMap(file => {
    const before = analysis.sources.get(file)!;
    const after = clearNotes({ source: rewritten.get(file) ?? before });
    return before === after ? [] : [{ file, before, after }];
  });
  return { edits, snapshots: analysis.sources };
}
