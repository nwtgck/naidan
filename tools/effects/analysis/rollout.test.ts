import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import config from '../../../effects.config.ts';
import { createEffectsProgram, typescriptDiagnostics } from '../project.ts';
import { analyzeEffects } from '../index.ts';
import { planEffectFix } from '../fixes/plan.ts';
import { printEffect } from '../contracts/effects.ts';

const root = path.resolve(import.meta.dirname, '../../..');
const codeBlock = path.join(root, 'src/composables/useCodeBlockSettings.ts');
const persistence = path.join(root, 'src/composables/useStoragePersistence.ts');

function check({ overlays }: { overlays: ReadonlyMap<string, string> }) {
  const program = createEffectsProgram({ root, config, overlays });
  expect(typescriptDiagnostics({ program })).toEqual([]);
  return analyzeEffects({ program, root, config });
}

function row({ analysis, file, label }: { analysis: ReturnType<typeof check>, file: string, label: string }) {
  const owner = analysis.owners.find(item => item.location.file === file && item.label === label)!;
  expect(owner).toBeDefined();
  return (analysis.solution.rows.get(owner.id) ?? []).map(effect => printEffect({ effect }));
}

describe('enrolled Naidan source (not extracted helper replacements)', () => {
  it('checks the six actual source modules and needs no annotation edits', () => {
    const analysis = check({ overlays: new Map() });
    expect(analysis.diagnostics).toEqual([]);
    expect(analysis.coverage.files).toHaveLength(6);
    expect(analysis.coverage.functions).toBe(26);
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
