import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import productionConfig from '../../../effects.config.ts';
import { EffectsAnalyzer } from '../analysis/analyze.ts';
import { analyzeEffects, runEffects } from '../index.ts';
import { createEffectsProgram, typescriptDiagnostics } from '../project.ts';
import { runEffectTidy } from './tidy.ts';
import { planEffectRows, planEffectFix } from '../fixes/plan.ts';
import { printEffect } from '../contracts/effects.ts';
import { UNVERIFIED_EFFECT_NOTE } from './unverified.ts';

const root = path.resolve(import.meta.dirname, '../../..');
const probeBoundaryMessage = 'Global property showDirectoryPicker needs a checked default-library identity; a member name is not a native model.';
const probeBoundaryStart = fs.readFileSync(path.join(root, 'src/utils/opfs-detection.ts'), 'utf8').indexOf('.showDirectoryPicker') + 1;
const config = {
  ...productionConfig,
  files: [
    'src/utils/opfs-detection.ts',
    'src/utils/ollama-detection.ts',
    'src/composables/useCodeBlockSettings.ts',
    'src/composables/useStoragePersistence.ts',
    'src/features/naidan-piping-duplex/role.ts',
    'src/features/wesh/commands/_shared/ascii-order.ts',
    'src/features/wesh/commands/git/branch.ts',
  ],
};
const markedFiles = [
  'src/composables/useStoragePersistence.ts',
  'src/features/naidan-piping-duplex/role.ts',
  'src/features/wesh/commands/_shared/ascii-order.ts',
  'src/features/wesh/commands/git/branch.ts',
  'src/utils/opfs-detection.ts',
].map(file => path.join(root, file));

function contractView({ analysis }: { analysis: ReturnType<typeof analyzeEffects> }) {
  expect(analysis.diagnostics.filter(item => item.message === UNVERIFIED_EFFECT_NOTE).map(item => item.file).sort()).toEqual(markedFiles.filter(file => analysis.coverage.files.includes(file)).sort());
  const initializers = analysis.diagnostics.filter(item => item.message.startsWith('Runtime import initialization'));
  expect(initializers.map(item => item.file).sort()).toEqual(['src/composables/useCodeBlockSettings.ts'].map(file => path.join(root, file)).filter(file => analysis.coverage.files.includes(file)).sort());
  expect(initializers.every(item => item.code === 'unsupported')).toBe(true);
  const boundaries = analysis.diagnostics.filter(item => item.code === 'boundary' && item.message === probeBoundaryMessage);
  expect(boundaries.map(item => ({ file: item.file, message: item.message, start: item.start, length: item.length }))).toEqual(analysis.coverage.files.includes(path.join(root, 'src/utils/opfs-detection.ts'))
    ? [{ file: path.join(root, 'src/utils/opfs-detection.ts'), message: probeBoundaryMessage, start: probeBoundaryStart, length: 'showDirectoryPicker'.length }] : []);

  // These source regressions inspect callable rows only after asserting that
  // strict checking still reports every draft, unknown initializer and native-identity boundary.
  return { ...analysis, diagnostics: analysis.diagnostics.filter(item => item.message !== UNVERIFIED_EFFECT_NOTE && !initializers.includes(item) && !boundaries.includes(item)) };
}

describe('maintenance on the enrolled Naidan modules', () => {
  it('refuses strict tidy but previews draft notes without writing and keeps the unsafe exception', () => {
    expect(() => runEffectTidy({ root, config, files: config.files, write: 'preview', inputSnapshots: new Map() })).toThrow('a clean ordinary check is required');
    const result = runEffects({ root, config, mode: 'fix', inputSnapshots: new Map(), files: config.files, unresolved: { mode: 'tidy', write: 'preview' } });
    const boundaries = result.analysis.diagnostics.filter(item => item.code === 'boundary' && item.message === probeBoundaryMessage);
    expect(boundaries.map(item => ({ file: item.file, message: item.message, start: item.start, length: item.length }))).toEqual([{ file: path.join(root, 'src/utils/opfs-detection.ts'), message: probeBoundaryMessage, start: probeBoundaryStart, length: 'showDirectoryPicker'.length }]);
    expect(result.analysis.diagnostics.filter(item => item.message !== UNVERIFIED_EFFECT_NOTE && !boundaries.includes(item))).toHaveLength(1);
    expect(result.analysis.diagnostics.filter(item => item.message !== UNVERIFIED_EFFECT_NOTE && !boundaries.includes(item)).every(item => item.message.startsWith('Runtime import initialization'))).toBe(true);
    const newMarkers = ['src/composables/useCodeBlockSettings.ts'].map(file => path.join(root, file));
    const marked = new Set(markedFiles);
    expect(result.analysis.diagnostics.filter(item => item.message === UNVERIFIED_EFFECT_NOTE).map(item => item.file).sort()).toEqual([...marked, ...newMarkers].sort());
    expect(result.analysis.diagnostics.filter(item => !boundaries.includes(item)).every(item => item.code === 'unsupported')).toBe(true);
    expect([...(result.unresolved?.plannedFiles ?? [])].sort()).toEqual([...newMarkers].sort());
    for (const [file, label, effects] of [
      ['src/composables/useStoragePersistence.ts', 'useStoragePersistence', []],
      ['src/features/wesh/commands/_shared/ascii-order.ts', 'compareAsciiStrings', []],
      ['src/features/wesh/commands/git/branch.ts', 'branchRefName', []],
      ['src/utils/ollama-detection.ts', 'detectOllama', ['network.http(*)']],
    ] as const) {
      const absolute = path.join(root, file);
      expect(result.analysis.sources.get(absolute)).toBe(fs.readFileSync(absolute, 'utf8'));
      expect(result.analysis.diagnostics.filter(item => item.file === absolute).map(item => item.message)).toEqual(marked.has(absolute) ? [UNVERIFIED_EFFECT_NOTE] : []);
      const owner = result.analysis.owners.find(item => item.location.file === absolute && item.role === 'implementation' && item.label === label)!;
      expect(owner.declared.map(effect => printEffect({ effect }))).toEqual(effects);
      expect((result.analysis.solution.rows.get(owner.id) ?? []).map(effect => printEffect({ effect }))).toEqual(effects);
    }
    expect(result.changedFiles).toEqual([]);
    expect(result.analysis.coverage.files).toEqual(expect.arrayContaining([
      path.join(root, 'src/features/naidan-piping-duplex/role.ts'),
      path.join(root, 'src/features/wesh/commands/_shared/ascii-order.ts'),
      path.join(root, 'src/features/wesh/commands/git/branch.ts'),
    ]));
    expect(result.analysis.unsafeSuppressions).toHaveLength(1);
    expect(result.analysis.owners[result.analysis.unsafeSuppressions[0]!.owner]?.label).toBe('checkOPFSSupport');
    const program = createEffectsProgram({ root, config, overlays: new Map() });
    const tidy = new EffectsAnalyzer({ root, config, program }).analyzeForTidy({ files: new Set(config.files.map(file => path.join(root, file))) });
    expect(contractView({ analysis: tidy.analysis }).diagnostics).toEqual([]);
    expect(tidy.selections.some(item => item.disposition === 'infer')).toBe(true);
    expect(tidy.selections.some(item => item.disposition === 'preserve')).toBe(true);
    expect(planEffectFix({ analysis: contractView({ analysis: tidy.analysis }) }).edits).toEqual([]);
  }, 10_000);

  it('removes injected broad annotations using real code without altering or writing executable source', () => {
    const file = path.join(root, 'src/composables/useCodeBlockSettings.ts');
    const config = { ...productionConfig, files: [path.relative(root, file)] };
    const original = fs.readFileSync(file, 'utf8');
    const broad = original.replaceAll('/** @effects [] */', '/** @effects ["network.http(*)"] */');
    expect(broad).not.toBe(original);
    const program = createEffectsProgram({ root, config, overlays: new Map([[file, broad]]) });
    expect(typescriptDiagnostics({ program })).toEqual([]);
    const result = new EffectsAnalyzer({ root, config, program }).analyzeForTidy({ files: new Set([file]) });
    expect(contractView({ analysis: result.analysis }).diagnostics).toEqual([]);
    const chosen = new Set(result.selections.filter(item => item.disposition === 'infer').map(item => item.owner));
    const plan = planEffectRows({
      owners: result.analysis.owners.filter(owner => chosen.has(owner.id)),
      rows: result.analysis.solution.rows,
      sources: result.analysis.sources,
      omitAnnotations: new Set(),
    });
    expect(plan.edits).toHaveLength(1);
    expect(plan.edits[0]?.after).toBe(original);
    const projected = createEffectsProgram({ root, config, overlays: new Map(plan.edits.map(edit => [edit.file, edit.after])) });
    const checked = contractView({ analysis: analyzeEffects({ root, config, program: projected }) });
    expect(checked.diagnostics).toEqual([]);
    expect(planEffectFix({ analysis: checked }).edits).toEqual([]);
    expect(fs.readFileSync(file, 'utf8')).toBe(original);
  });
});
