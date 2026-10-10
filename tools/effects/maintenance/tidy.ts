import path from 'node:path';
import { EffectsAnalyzer, type EffectsAnalysis } from '../analysis/analyze.ts';
import type { EffectsConfig } from '../config.ts';
import { effectCovered, printEffect } from '../contracts/effects.ts';
import { applyEffectFix, assertEffectSnapshots } from '../fixes/apply.ts';
import { executableTokens } from '../fixes/executable.ts';
import { planEffectFix, planEffectRows, type EffectFileEdit } from '../fixes/plan.ts';
import { checkModelInputs, createEffectsProgram, effectProgramInputs, resolveProjectPath, typescriptDiagnostics } from '../project.ts';
import type { TidySelection } from './selection.ts';
import { mayOmitEffectAnnotation } from '../analysis/annotation-policy.ts';
import type { ContractOwner } from '../analysis/values.ts';

export type TidyChange = {
  file: string,
  start: number,
  label: string,
  before: readonly string[],
  after: readonly string[],
  removed: readonly string[],
  annotation: 'remove' | 'retain',
};
export type EffectTidyRun = {
  analysis: EffectsAnalysis,
  selections: readonly TidySelection[],
  changes: readonly TidyChange[],
  edits: readonly EffectFileEdit[],
  changedFiles: readonly string[],
};

function requireClean({ analysis, stage }: { analysis: EffectsAnalysis, stage: string }): void {
  if (analysis.diagnostics.length !== 0) {
    throw new Error(`Effect tidy ${stage}: a clean ordinary check is required; run effects:fix first or resolve diagnostics.\n${analysis.diagnostics.map(item => item.message).join('\n')}`);
  }
}

function trivialAnnotations({ analysis, owners }: { analysis: EffectsAnalysis, owners: readonly ContractOwner[] }): ReadonlySet<number> {
  const unsafe = new Set(analysis.unsafeSuppressions.map(item => item.owner));
  return new Set(owners.filter(owner => owner.annotation !== undefined && !unsafe.has(owner.id)
    && (analysis.solution.rows.get(owner.id) ?? []).length === 0 && mayOmitEffectAnnotation({ owner })).map(owner => owner.id));
}

/**
 * Compute a new least fixed point with selected declarations removed as seeds,
 * while retaining slots/signatures, scope boundaries, suppression and all
 * non-effect conditions. Validate the projected source, not only the row math.
 * Preview and write follow the same checks; preview never changes source files.
 */
export function runEffectTidy({ root, config, files, write, inputSnapshots }: {
  root: string,
  config: EffectsConfig,
  files: readonly string[],
  write: 'preview' | 'write',
  inputSnapshots: ReadonlyMap<string, string>,
}): EffectTidyRun {
  assertEffectSnapshots({ root, plan: { edits: [], snapshots: inputSnapshots } });
  if (files.length === 0) throw new Error('Select at least one tidy file.');
  const selected = new Set(files.map(relative => resolveProjectPath({ root, relative })));
  const program = createEffectsProgram({ root, config, overlays: new Map() });
  const original = new EffectsAnalyzer({ root, config, program }).analyze();
  original.diagnostics = [...typescriptDiagnostics({ program }), ...original.diagnostics];
  requireClean({ analysis: original, stage: 'precondition' });
  const coverage = new Set([...original.coverage.files, ...original.coverage.excludedTests].map(file => path.resolve(file)));
  for (const file of selected) if (!coverage.has(file)) throw new Error(`Tidy selection is outside the analyzed scope: ${file}`);
  const snapshots = new Map([...effectProgramInputs({ program }), ...inputSnapshots]);
  for (const [file, content] of original.sources) {
    const captured = snapshots.get(file);
    if (captured !== undefined && captured !== content) throw new Error(`Effect input changed during tidy analysis: ${file}`);
    snapshots.set(file, content);
  }
  const { analysis: inferred, selections } = new EffectsAnalyzer({ root, config, program }).analyzeForTidy({ files: selected });
  requireClean({ analysis: inferred, stage: 'inference' });
  const inferIds = new Set(selections.filter(item => item.disposition === 'infer').map(item => item.owner));
  const owners = inferred.owners.filter(owner => inferIds.has(owner.id));
  const omitAnnotations = trivialAnnotations({ analysis: inferred, owners });
  const changes: TidyChange[] = [];
  for (const owner of owners) {
    const candidate = inferred.solution.rows.get(owner.id) ?? [];
    if (candidate.some(effect => !effectCovered({ effect, allowed: owner.declared }))) throw new Error('Effect tidy cannot widen a selected declaration.');
    const before = owner.declared.map(effect => printEffect({ effect }));
    const after = candidate.map(effect => printEffect({ effect }));
    if (before.join('\n') !== after.join('\n') || omitAnnotations.has(owner.id)) {
      changes.push({
        file: owner.location.file,
        start: owner.location.start,
        label: owner.label,
        before,
        after,
        removed: before.filter(effect => !after.includes(effect)),
        annotation: omitAnnotations.has(owner.id) ? 'remove' : 'retain',
      });
    }
  }
  const plan = planEffectRows({ owners, rows: inferred.solution.rows, sources: inferred.sources, omitAnnotations });
  const projected = createEffectsProgram({ root, config, overlays: new Map(plan.edits.map(edit => [edit.file, edit.after])) });
  const after = new EffectsAnalyzer({ root, config, program: projected }).analyze();
  after.diagnostics = [...typescriptDiagnostics({ program: projected }), ...after.diagnostics];
  requireClean({ analysis: after, stage: 'projected validation' });
  if (planEffectFix({ analysis: after }).edits.length !== 0) throw new Error('Widening fix would undo tidy; run effects:fix before maintenance.');
  const repeat = new EffectsAnalyzer({ root, config, program: projected }).analyzeForTidy({ files: selected });
  requireClean({ analysis: repeat.analysis, stage: 'idempotence validation' });
  const repeatIds = new Set(repeat.selections.filter(item => item.disposition === 'infer').map(item => item.owner));
  const repeatOwners = repeat.analysis.owners.filter(owner => repeatIds.has(owner.id));
  if (planEffectRows({
    owners: repeatOwners,
    rows: repeat.analysis.solution.rows,
    sources: repeat.analysis.sources,
    omitAnnotations: trivialAnnotations({ analysis: repeat.analysis, owners: repeatOwners }),
  }).edits.length !== 0) throw new Error('Effect tidy is not idempotent.');
  for (const edit of plan.edits) {
    if (!selected.has(path.resolve(edit.file))) throw new Error('Tidy attempted to edit an unselected file.');
    if (executableTokens({ source: edit.before, file: edit.file }) !== executableTokens({ source: edit.after, file: edit.file })) throw new Error(`Effect tidy changed executable code: ${edit.file}`);
  }
  checkModelInputs({ root, config });
  assertEffectSnapshots({ root, plan: { edits: [], snapshots } });
  const changedFiles: string[] = [];
  switch (write) {
  case 'preview': break;
  case 'write':
    applyEffectFix({ root, plan: { edits: plan.edits, snapshots } });
    changedFiles.push(...plan.edits.map(edit => edit.file)); break;
  default: { const exhaustive: never = write; throw new Error(String(exhaustive)); }
  }
  return {
    analysis: after,
    selections,
    changes,
    edits: plan.edits,
    changedFiles,
  };
}
