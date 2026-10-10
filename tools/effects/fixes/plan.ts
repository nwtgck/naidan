import path from 'node:path';
import ts from 'typescript';
import type { ContractOwner } from '../analysis/values.ts';
import type { Effect } from '../contracts/effects.ts';
import type { EffectsAnalysis } from '../analysis/analyze.ts';
import { mayOmitEffectAnnotation } from '../analysis/annotation-policy.ts';
import { MODULE_EFFECTS_TAG } from '../syntax/annotations.ts';
import { printEffects } from '../syntax/expression.ts';

export type EffectFileEdit = { file: string, before: string, after: string };
export type EffectFixPlan = { edits: readonly EffectFileEdit[], snapshots: ReadonlyMap<string, string> };

/** Keep next-line lint directives adjacent to their original target. */
function newAnnotationStart({ anchor, source }: { anchor: ts.Node, source: string }): number {
  const file = anchor.getSourceFile();
  let start = anchor.getStart(file);
  const comments = ts.getLeadingCommentRanges(source, anchor.getFullStart()) ?? [];
  for (const comment of [...comments].reverse()) {
    if (source.slice(comment.end, start).trim() !== ''
      || file.getLineAndCharacterOfPosition(start).line !== file.getLineAndCharacterOfPosition(comment.end).line + 1) break;
    const content = source.slice(comment.pos + 2, comment.end - (source.startsWith('/*', comment.pos) ? 2 : 0)).trim();
    const directive = 'eslint-disable-next-line';
    const remainder = content.slice(directive.length);
    if (!content.startsWith(directive) || remainder !== '' && remainder.trimStart() === remainder) break;
    start = comment.pos;
  }
  return start;
}

export function planEffectFix({ analysis }: { analysis: EffectsAnalysis }): EffectFixPlan {
  const blockers = analysis.diagnostics.filter(diagnostic => diagnostic.code !== 'missing' && diagnostic.code !== 'exceeds');
  if (blockers.length > 0) throw new Error('Effect fix refused: syntax, type, boundary or unsupported diagnostics remain.');
  return planEffectRows({ owners: analysis.owners, rows: analysis.solution.rows, sources: analysis.sources, omitAnnotations: new Set() });
}

export function planEffectRows({ owners, rows, sources, omitAnnotations }: {
  owners: readonly ContractOwner[], rows: ReadonlyMap<number, readonly Effect[]>, sources: ReadonlyMap<string, string>,
  omitAnnotations: ReadonlySet<number>,
}): EffectFixPlan {
  const ranges = new Map<string, { start: number, end: number, text: string, module: boolean }[]>();
  for (const owner of owners) {
    if (owner.role === 'symbolic' || owner.role === 'body') continue;
    const effects = rows.get(owner.id) ?? [];
    const omit = omitAnnotations.has(owner.id);
    if (omit && (owner.annotation === undefined || effects.length !== 0 || !mayOmitEffectAnnotation({ owner }))) throw new Error('Only an empty annotation on a trivial implementation can be omitted.');
    const module = owner.role === 'module';
    if (owner.annotation === undefined && effects.length === 0 && (module || mayOmitEffectAnnotation({ owner }))) continue;
    const row = printEffects({ effects });
    if (!omit && owner.annotation !== undefined && printEffects({ effects: owner.declared }) === row) continue;
    const file = path.resolve(owner.location.file);
    const source = sources.get(file);
    if (source === undefined) throw new Error('Missing source snapshot for an effect edit.');
    let headerStart = source.startsWith('\uFEFF') ? 1 : 0;
    if (module && source.startsWith('#!', headerStart)) {
      const end = source.indexOf('\n', headerStart);
      headerStart = end === -1 ? source.length : end + 1;
    }
    const start = owner.annotation?.start ?? (module ? headerStart : newAnnotationStart({ anchor: owner.anchor, source }));
    const end = owner.annotation?.end ?? start;
    const lineStart = source.lastIndexOf('\n', start - 1) + 1;
    const indentation = module ? '' : source.slice(lineStart, start);
    const standalone = [...indentation].every(character => character === ' ' || character === '\t');
    const newline = source.includes('\r\n') ? '\r\n' : '\n';
    // Never insert a line terminator after return/throw/yield or inside an arrow expression.
    const suffix = owner.annotation === undefined ? standalone ? newline + indentation : ' ' : '';
    const items = ranges.get(file) ?? [];
    // Retain line breaks for ASI and a separator for adjacent keyword/function tokens.
    const removedComment = [...source.slice(start, end)].filter(character => character === '\r' || character === '\n').join('') || (standalone ? '' : ' ');
    items.push({ start, end, module, text: omit ? removedComment : `/** ${module ? MODULE_EFFECTS_TAG : '@effects'} ${row} */${suffix}` });
    ranges.set(file, items);
  }
  const edits: EffectFileEdit[] = [];
  for (const [file, items] of ranges) {
    const before = sources.get(file)!;
    const ordered = [...items].sort((a, b) => a.start - b.start || Number(b.module) - Number(a.module) || a.end - b.end);
    const chunks: string[] = [];
    let cursor = 0;
    let previous: typeof ordered[number] | undefined;
    for (const item of ordered) {
      if (item.start < cursor || item.start === previous?.start && !(previous.module && previous.start === previous.end)) throw new Error(`Overlapping effect edits in ${file}.`);
      chunks.push(before.slice(cursor, item.start), item.text);
      cursor = item.end;
      previous = item;
    }
    chunks.push(before.slice(cursor));
    const after = chunks.join('');
    if (before !== after) edits.push({ file, before, after });
  }
  return { edits, snapshots: sources };
}
