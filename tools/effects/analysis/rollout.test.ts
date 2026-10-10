import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import productionConfig from '../../../effects.config.ts';
import { createEffectsProgram, typescriptDiagnostics } from '../project.ts';
import { analyzeEffects } from '../index.ts';
import { planEffectFix } from '../fixes/plan.ts';
import { printEffect } from '../contracts/effects.ts';
import { UNVERIFIED_EFFECT_NOTE } from '../maintenance/unverified.ts';

const root = path.resolve(import.meta.dirname, '../../..');
const probeBoundaryMessage = 'Global property showDirectoryPicker needs a checked default-library identity; a member name is not a native model.';
const probeBoundaryStart = fs.readFileSync(path.join(root, 'src/utils/opfs-detection.ts'), 'utf8').indexOf('.showDirectoryPicker') + 1;
// These real-source scenarios inspect the original contracts and representative utilities.
const config = {
  ...productionConfig,
  files: [
    'src/utils/opfs-detection.ts',
    'src/utils/ollama-detection.ts',
    'src/composables/useCodeBlockSettings.ts',
    'src/composables/useStoragePersistence.ts',
    'src/composables/useLayout.ts',
    'src/composables/useOverlay.ts',
    'src/features/naidan-piping-duplex/role.ts',
    'src/features/wesh/commands/_shared/ascii-order.ts',
    'src/features/wesh/commands/git/branch.ts',
  ],
};
const codeBlock = path.join(root, 'src/composables/useCodeBlockSettings.ts');
const persistence = path.join(root, 'src/composables/useStoragePersistence.ts');
const markedFiles = [
  'src/composables/useOverlay.ts',
  'src/composables/useStoragePersistence.ts',
  'src/features/naidan-piping-duplex/role.ts',
  'src/features/wesh/commands/_shared/ascii-order.ts',
  'src/features/wesh/commands/git/branch.ts',
  'src/utils/opfs-detection.ts',
].map(file => path.join(root, file));

function check({ overlays }: { overlays: ReadonlyMap<string, string> }) {
  const entries = overlays.size === 0 ? config : { ...config, files: [...overlays.keys()].map(file => path.relative(root, file)) };
  const program = createEffectsProgram({ root, config: entries, overlays });
  expect(typescriptDiagnostics({ program })).toEqual([]);
  const analysis = analyzeEffects({ program, root, config: entries });
  // The real enrolled sources include draft rollout markers. Assert their
  // exact files separately before inspecting the existing concrete rows.
  expect(analysis.diagnostics.filter(item => item.message === UNVERIFIED_EFFECT_NOTE).map(item => item.file).sort()).toEqual(markedFiles.filter(file => analysis.coverage.files.includes(file)).sort());
  const initializers = analysis.diagnostics.filter(item => item.message.startsWith('Runtime import initialization'));
  expect(initializers.map(item => item.file).sort()).toEqual(['src/composables/useCodeBlockSettings.ts', 'src/composables/useLayout.ts', 'src/composables/useOverlay.ts'].map(file => path.join(root, file)).filter(file => analysis.coverage.files.includes(file)).sort());
  expect(initializers.every(item => item.code === 'unsupported')).toBe(true);
  const boundaries = analysis.diagnostics.filter(item => item.code === 'boundary' && item.message === probeBoundaryMessage);
  expect(boundaries.map(item => ({ file: item.file, message: item.message, start: item.start, length: item.length }))).toEqual(analysis.coverage.files.includes(path.join(root, 'src/utils/opfs-detection.ts'))
    ? [{ file: path.join(root, 'src/utils/opfs-detection.ts'), message: probeBoundaryMessage, start: probeBoundaryStart, length: 'showDirectoryPicker'.length }] : []);

  // These source regressions inspect callable rows only after asserting that
  // strict checking still reports every draft, unknown initializer and native-identity boundary.
  return { ...analysis, diagnostics: analysis.diagnostics.filter(item => item.message !== UNVERIFIED_EFFECT_NOTE && !initializers.includes(item) && !boundaries.includes(item)) };
}

function row({ analysis, file, label }: { analysis: ReturnType<typeof check>, file: string, label: string }) {
  const owner = analysis.owners.find(item => item.location.file === file && item.label === label)!;
  expect(owner).toBeDefined();
  return (analysis.solution.rows.get(owner.id) ?? []).map(effect => printEffect({ effect }));
}

describe('enrolled Naidan source (not extracted helper replacements)', () => {
  it('keeps the actual draft marker visible to strict checking and refuses a verified fix', () => {
    const program = createEffectsProgram({ root, config, overlays: new Map() });
    expect(typescriptDiagnostics({ program })).toEqual([]);
    const analysis = analyzeEffects({ program, root, config });
    expect(analysis.diagnostics.filter(item => item.message === UNVERIFIED_EFFECT_NOTE).map(item => item.file).sort()).toEqual([...markedFiles].sort());
    expect(analysis.diagnostics.filter(item => item.message.startsWith('Runtime import initialization'))).toHaveLength(3);
    expect(analysis.diagnostics.filter(item => item.code === 'boundary').map(item => ({ file: item.file, message: item.message, start: item.start, length: item.length }))).toEqual([{ file: path.join(root, 'src/utils/opfs-detection.ts'), message: probeBoundaryMessage, start: probeBoundaryStart, length: 'showDirectoryPicker'.length }]);
    expect(analysis.diagnostics).toHaveLength(markedFiles.length + 4);
    expect(() => planEffectFix({ analysis })).toThrow('refused');
  });

  it('checks the original source contracts and additional real utilities without annotation edits', () => {
    const analysis = check({ overlays: new Map() });
    expect(analysis.diagnostics).toEqual([]);
    const originalFiles = new Set([
      'src/utils/opfs-detection.ts', 'src/utils/ollama-detection.ts',
      'src/composables/useCodeBlockSettings.ts', 'src/composables/useStoragePersistence.ts',
      'src/composables/useLayout.ts', 'src/composables/useOverlay.ts',
    ].map(file => path.join(root, file)));
    expect(analysis.coverage.files).toEqual(expect.arrayContaining([...originalFiles]));
    expect(analysis.owners.filter(owner => owner.role === 'implementation' && originalFiles.has(owner.location.file))).toHaveLength(26);
    for (const [file, label] of [
      ['src/features/naidan-piping-duplex/role.ts', 'isInitiator'],
      ['src/features/wesh/commands/_shared/ascii-order.ts', 'compareAsciiStrings'],
      ['src/features/wesh/commands/git/branch.ts', 'branchRefName'],
    ] as const) {
      expect(analysis.coverage.files).toContain(path.join(root, file));
      expect(row({ analysis, file: path.join(root, file), label })).toEqual([]);
    }
    expect(planEffectFix({ analysis }).edits).toEqual([]);
    expect(row({ analysis, file: codeBlock, label: 'toggleLineWrap' })).toEqual([]);
    expect(row({ analysis, file: persistence, label: 'useStoragePersistence' })).toEqual([]);
    expect(analysis.assumptions.some(item => item.includes('Vue boundary:'))).toBe(true);
  });

  it('detects a direct storage change in the real toggle without charging its factory', () => {
    const original = fs.readFileSync(codeBlock, 'utf8');
    const changed = original.replace('function toggleLineWrap() {', 'function toggleLineWrap() { localStorage.clear();');
    expect(changed).not.toBe(original);
    const analysis = check({ overlays: new Map([[codeBlock, changed]]) });
    expect(analysis.diagnostics.filter(item => item.code !== 'exceeds')).toEqual([]);
    expect(row({ analysis, file: codeBlock, label: 'toggleLineWrap' })).toEqual(['localstorage.write(*)']);
    expect(row({ analysis, file: codeBlock, label: 'useCodeBlockSettings' })).toEqual([]);
    const plan = planEffectFix({ analysis });
    expect(plan.edits.map(edit => edit.file)).toEqual([codeBlock]);
    const after = check({ overlays: new Map(plan.edits.map(edit => [edit.file, edit.after])) });
    expect(after.diagnostics).toEqual([]);
    expect(planEffectFix({ analysis: after }).edits).toEqual([]);
    expect(fs.readFileSync(codeBlock, 'utf8')).toBe(original);
  });

  it('checks a real Vue watcher callback but does not add its storage effect to the toggle', () => {
    const original = fs.readFileSync(codeBlock, 'utf8');
    const changed = original.replace("import { ref } from 'vue';", "import { ref, watch } from 'vue';") + `\
watch(isLineWrapEnabled, () => { localStorage.clear(); }, { flush: 'sync' });
`;
    const analysis = check({ overlays: new Map([[codeBlock, changed]]) });
    expect(analysis.diagnostics.filter(item => item.code !== 'missing' && item.code !== 'exceeds')).toEqual([]);
    expect(row({ analysis, file: codeBlock, label: 'toggleLineWrap' })).toEqual([]);
    const plan = planEffectFix({ analysis });
    const after = check({ overlays: new Map(plan.edits.map(edit => [edit.file, edit.after])) });
    expect(after.diagnostics).toEqual([]);
    expect(planEffectFix({ analysis: after }).edits).toEqual([]);
    expect(fs.readFileSync(codeBlock, 'utf8')).toBe(original);
  });

  it('detects added network work inside the real persistence callback, not its factory', () => {
    const original = fs.readFileSync(persistence, 'utf8');
    const changed = original.replace('const requestPersistence = async () => {', "const requestPersistence = async () => { await fetch('/probe');");
    expect(changed).not.toBe(original);
    const analysis = check({ overlays: new Map([[persistence, changed]]) });
    expect(analysis.diagnostics.some(item => item.code === 'exceeds' && item.message.includes('network.http(*)'))).toBe(true);
    expect(analysis.diagnostics.filter(item => item.code !== 'exceeds')).toEqual([]);
    expect(row({ analysis, file: persistence, label: 'useStoragePersistence' })).toEqual([]);
    expect(fs.readFileSync(persistence, 'utf8')).toBe(original);
  });
});

describe('layout and overlay enrollment keeps application state changes separate from I/O', () => {
  const layout = path.join(root, 'src/composables/useLayout.ts');
  const overlay = path.join(root, 'src/composables/useOverlay.ts');

  it('uses real binding names and keeps all eighteen added functions free of storage and network effects', () => {
    const analysis = check({ overlays: new Map() });
    const owners = analysis.owners.filter(owner => owner.role === 'implementation' && [layout, overlay].includes(owner.location.file));
    expect(owners).toHaveLength(18);
    expect(owners.every(owner => analysis.solution.rows.get(owner.id)?.length === 0)).toBe(true);
    expect(owners.some(owner => owner.label === 'toggleOverlay')).toBe(true);
    expect(owners.some(owner => owner.label === 'setActiveFocusArea')).toBe(true);
    expect(analysis.diagnostics).toEqual([]);
  });

  it('detects a direct network addition to the real overlay setter without charging its factory', () => {
    const original = fs.readFileSync(overlay, 'utf8');
    const changed = original.replace("activeOverlay.value = 'none';", "fetch('/unexpected'); activeOverlay.value = 'none';");
    expect(changed).not.toBe(original);
    const analysis = check({ overlays: new Map([[overlay, changed]]) });
    expect(analysis.diagnostics.filter(item => item.code !== 'exceeds')).toEqual([]);
    expect(row({ analysis, file: overlay, label: 'closeOverlay' })).toEqual(['network.http(*)']);
    expect(row({ analysis, file: overlay, label: 'useOverlay' })).toEqual([]);
    expect(row({ analysis, file: overlay, label: 'toggleOverlay' })).toEqual([]);
    const plan = planEffectFix({ analysis });
    const after = check({ overlays: new Map(plan.edits.map(edit => [edit.file, edit.after])) });
    expect(after.diagnostics).toEqual([]);
    expect(planEffectFix({ analysis: after }).edits).toEqual([]);
    expect(fs.readFileSync(overlay, 'utf8')).toBe(original);
  });

  it('does not back-propagate a new watcher into the real conditional overlay update', () => {
    const original = fs.readFileSync(overlay, 'utf8');
    const changed = original.replace("import { ref } from 'vue';", "import { ref, watch } from 'vue';") + `\
watch(activeOverlay, value => { localStorage.setItem('overlay', value); }, { flush: 'sync' });
`;
    const analysis = check({ overlays: new Map([[overlay, changed]]) });
    expect(analysis.diagnostics.filter(item => item.code !== 'missing' && item.code !== 'exceeds')).toEqual([]);
    expect(row({ analysis, file: overlay, label: 'toggleOverlay' })).toEqual([]);
    const callback = analysis.owners.find(owner => owner.location.file === overlay && owner.role === 'implementation' && owner.label === '<anonymous>')!;
    expect(analysis.solution.rows.get(callback.id)?.map(effect => printEffect({ effect }))).toEqual(['localstorage.write(*)']);
    const plan = planEffectFix({ analysis });
    const after = check({ overlays: new Map(plan.edits.map(edit => [edit.file, edit.after])) });
    expect(after.diagnostics).toEqual([]);
  });
});

describe('reviewed category refinements on real enrolled modules', () => {
  it('keeps browser policy outside I/O on the real method and exposes its primitive rationale', () => {
    const analysis = check({ overlays: new Map() });
    expect(row({ analysis, file: persistence, label: 'requestPersistence' })).toEqual([]);
    expect(analysis.modelDecisions.filter(item => item.file === persistence).map(item => item.rule).sort()).toEqual(['storage-manager.persist', 'storage-manager.persisted']);
    expect(row({ analysis, file: persistence, label: 'useStoragePersistence' })).toEqual([]);
  });

  it('keeps no-cleanup watch stop free of storage on a real module overlay', () => {
    const original = fs.readFileSync(codeBlock, 'utf8');
    const changed = original.replace("import { ref } from 'vue';", "import { ref, watch } from 'vue';") + `\
const handle = watch(isLineWrapEnabled, () => { localStorage.clear(); });
export function stopWatching() { handle.stop(); }
`;
    const analysis = check({ overlays: new Map([[codeBlock, changed]]) });
    expect(analysis.diagnostics.filter(item => item.code !== 'missing' && item.code !== 'exceeds')).toEqual([]);
    expect(row({ analysis, file: codeBlock, label: 'stopWatching' })).toEqual([]);
    expect(row({ analysis, file: codeBlock, label: 'toggleLineWrap' })).toEqual([]);
    const plan = planEffectFix({ analysis });
    const fixed = check({ overlays: new Map(plan.edits.map(edit => [edit.file, edit.after])) });
    expect(fixed.diagnostics).toEqual([]);
    expect(planEffectFix({ analysis: fixed }).edits).toEqual([]);
    expect(fs.readFileSync(codeBlock, 'utf8')).toBe(original);
  });

  it('propagates added cleanup to stop but not to the real state setter', () => {
    const original = fs.readFileSync(codeBlock, 'utf8');
    const changed = original.replace("import { ref } from 'vue';", "import { ref, watch, onWatcherCleanup } from 'vue';") + `\
const handle = watch(isLineWrapEnabled, () => { onWatcherCleanup(() => { localStorage.clear(); }); });
export function stopWatching() { handle.stop(); }
`;
    const analysis = check({ overlays: new Map([[codeBlock, changed]]) });
    expect(analysis.diagnostics.filter(item => item.code !== 'missing' && item.code !== 'exceeds')).toEqual([]);
    expect(row({ analysis, file: codeBlock, label: 'stopWatching' })).toEqual(['localstorage.write(*)']);
    expect(row({ analysis, file: codeBlock, label: 'toggleLineWrap' })).toEqual([]);
    const plan = planEffectFix({ analysis });
    const fixed = check({ overlays: new Map(plan.edits.map(edit => [edit.file, edit.after])) });
    expect(fixed.diagnostics).toEqual([]);
    expect(planEffectFix({ analysis: fixed }).edits).toEqual([]);
    expect(fs.readFileSync(codeBlock, 'utf8')).toBe(original);
  });
});
