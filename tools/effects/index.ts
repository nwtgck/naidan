import { executableTokens } from './fixes/executable.ts';
import type ts from 'typescript';
import { EffectsAnalyzer, type EffectsAnalysis } from './analysis/analyze.ts';
import type { EffectsConfig } from './config.ts';
import { applyEffectFix, assertEffectSnapshots } from './fixes/apply.ts';
import { planUnresolvedEffectFix, planVerifiedEffectFix } from './maintenance/unverified.ts';
import { checkModelInputs, createEffectsProgram, effectProgramInputs, typescriptDiagnostics } from './project.ts';

export type EffectsRun = { analysis: EffectsAnalysis, changedFiles: readonly string[], unresolved?: { mode: 'fix' | 'tidy', write: 'write' | 'preview', plannedFiles: readonly string[] } };

export function analyzeEffects({ program, root, config }: { program: ts.Program, root: string, config: EffectsConfig }): EffectsAnalysis {
  return new EffectsAnalyzer({ program, root, config }).analyze();
}

export function runEffects({ root, config, mode, inputSnapshots, files, unresolved }: {
  root: string, config: EffectsConfig, mode: 'check' | 'fix', inputSnapshots: ReadonlyMap<string, string>,
  files?: readonly string[] | undefined,
  unresolved?: { mode: 'fix' | 'tidy', write: 'write' | 'preview' },
}): EffectsRun {
  assertEffectSnapshots({ root, plan: { edits: [], snapshots: inputSnapshots } });
  const program = createEffectsProgram({ root, config, overlays: new Map() });
  const snapshots = new Map([...effectProgramInputs({ program }), ...inputSnapshots]);
  const types = typescriptDiagnostics({ program });
  const analysis = analyzeEffects({ program, root, config });
  analysis.diagnostics = [...types, ...analysis.diagnostics];
  assertEffectSnapshots({ root, plan: { edits: [], snapshots } });
  switch (mode) {
  case 'check': return { analysis, changedFiles: [] };
  case 'fix': break;
  default: { const exhaustive: never = mode; throw new Error(String(exhaustive)); }
  }
  const plan = unresolved === undefined ? planVerifiedEffectFix({ analysis, root, files }) : planUnresolvedEffectFix({ analysis, root, files: files ?? analysis.coverage.files, mode: unresolved.mode });
  const projected = createEffectsProgram({ root, config, overlays: new Map(plan.edits.map(edit => [edit.file, edit.after])) });
  const after = analyzeEffects({ program: projected, root, config });
  const errors = [...typescriptDiagnostics({ program: projected }), ...after.diagnostics];
  after.diagnostics = errors;
  if (unresolved === undefined && errors.length > 0) throw new Error(`Effect fix did not verify before writing:\n${errors.map(error => error.message).join('\n')}`);
  if (unresolved === undefined && planVerifiedEffectFix({ analysis: after, root, files }).edits.length !== 0) throw new Error('Effect fix is not idempotent.');
  // TypeScript must emit the same executable token stream: comments cannot change ASI.
  for (const edit of plan.edits) {
    const before = executableTokens({ source: edit.before, file: edit.file });
    const output = executableTokens({ source: edit.after, file: edit.file });
    if (before !== output) throw new Error(`Effect comments changed executable code: ${edit.file}`);
  }
  checkModelInputs({ root, config });
  for (const [file, content] of plan.snapshots) {
    const previous = snapshots.get(file);
    if (previous !== undefined && previous !== content) throw new Error(`Effect input changed during analysis: ${file}`);
    snapshots.set(file, content);
  }
  const changedFiles: string[] = [];
  const write = unresolved === undefined ? 'write' : unresolved.write;
  switch (write) {
  case 'write':
    applyEffectFix({ root, plan: { edits: plan.edits, snapshots } });
    changedFiles.push(...plan.edits.map(edit => edit.file));
    break;
  case 'preview': break;
  default: { const exhaustive: never = write; throw new Error(String(exhaustive)); }
  }
  return {
    analysis: after,
    changedFiles,
    ...(unresolved === undefined ? {} : { unresolved: { mode: unresolved.mode, write: unresolved.write, plannedFiles: plan.edits.map(edit => edit.file) } }),
  };
}
