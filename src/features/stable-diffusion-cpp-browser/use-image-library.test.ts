// @vitest-environment node
import { afterEach, expect, it, vi } from 'vitest';
import { effectScope } from 'vue';
import { useImageLibrary } from './use-image-library';
import { scanImageRepositories, type ModelInventory } from './logic/model-candidates';
import type { LocalImageRepository } from './logic/repository-store';
import { idToRaw } from '@/01-models/ids';
import { ggufFixture, safetensorsFixture, zImageTensors, fluxVaeTensors, qwenTextTensors } from './test-utils/weights';

const scopes: ReturnType<typeof effectScope>[] = [];
afterEach(() => {
  for (const scope of scopes.splice(0)) scope.stop();
});
function repositories(): LocalImageRepository[] {
  const files = [
    ggufFixture({ name: 'z_image_turbo.gguf', tensors: zImageTensors, metadata: { 'general.name': 'Z-Image-Turbo' }, extraBytes: 0 }).file,
    safetensorsFixture({ name: 'ae.safetensors', tensors: fluxVaeTensors }).file,
    ggufFixture({ name: 'text.gguf', tensors: qwenTextTensors({ width: 2560, layers: 36 }), metadata: { 'general.architecture': 'qwen3' }, extraBytes: 0 }).file,
  ];
  return files.map((file, i) => ({ id: `user/${i}`, name: `repo ${i}`, files: [{ path: `original/${file.name}`, file }] }));
}
function harness({ entries, scan }: { entries: LocalImageRepository[], scan: typeof scanImageRepositories | undefined }) {
  let blocked = false;
  let current = entries;
  const list = vi.fn(async () => current);
  const onSelection = vi.fn();
  const scope = effectScope(); scopes.push(scope);
  const library = scope.run(() => useImageLibrary({ downloadsBlocked: () => false, blocked: () => blocked, onSelection, dependencies: { list, scan: scan ?? scanImageRepositories, import: vi.fn(async () => 'user/imported'), download: vi.fn() } }))!;
  return { library, list, onSelection, scope, block() {
    blocked = true;
  }, entries({ next }: { next: LocalImageRepository[] }) {
    current = next;
  } };
}
it('resolves required components across repositories and keeps the original file paths', async () => {
  const h = harness({ entries: repositories(), scan: undefined });
  expect(h.list).not.toHaveBeenCalled();
  await h.library.refresh();
  expect(h.library.models.value).toHaveLength(1);
  expect(h.library.ready.value).toBe(true);
  expect(h.onSelection).toHaveBeenCalledWith({ family: 'z-image', turbo: true });
  const models = h.library.selectedModels()!;
  expect(models.map(model => model.slot)).toEqual(['diffusion', 'vae', 'lm']);
  expect(models.map(model => model.path)).toEqual(['original/z_image_turbo.gguf', 'original/ae.safetensors', 'original/text.gguf']);
  expect(models.every(model => model.companions?.length === 0)).toBe(true);
  h.library.showAll.value = true;
  expect(h.library.models.value).toHaveLength(3);
});
it('resolves history weights only by their local location and matching file metadata', async () => {
  const entries = repositories();
  const h = harness({ entries, scan: undefined }); await h.library.refresh();
  const file = entries[0]!.files[0]!.file;
  const location = h.library.historyFileLocation({ file });
  expect(location).toMatchObject({ type: 'opfs', path: 'models/user/0/original/z_image_turbo.gguf' });
  expect(h.library.findHistoryFile({ location })).toBe(file);
  expect(h.library.findHistoryFile({ location: { ...location, size: file.size + 1 } })).toBeUndefined();
  expect(h.library.findHistoryFile({ location: { ...location, lastModified: file.lastModified + 1 } })).toBeUndefined();
  expect(h.library.findHistoryFile({ location: { ...location, type: 'opfs', path: 'models/user/other/original/z_image_turbo.gguf' } })).toBeUndefined();
  const direct = new File([file], file.name, { lastModified: file.lastModified });
  const directLocation = h.library.historyFileLocation({ file: direct });
  expect(directLocation.type).toBe('file');
  expect(h.library.findHistoryFile({ location: directLocation })).toBeUndefined();
  expect(h.list).toHaveBeenCalledOnce();
});
it('keeps the registered host directory identity separate from OPFS history paths', async () => {
  const entries = repositories();
  entries[0]!.hostSource = { directoryId: 'host-models', directoryName: 'Shared weights', repository: 'org/model' };
  const h = harness({ entries, scan: undefined }); await h.library.refresh();
  const file = entries[0]!.files[0]!.file;
  const location = h.library.historyFileLocation({ file });
  if (location.type !== 'host') throw new Error('Expected host model location');
  expect(idToRaw({ id: location.directoryId })).toBe('host-models');
  expect(location.path).toBe('org/model/original/z_image_turbo.gguf');
  expect(h.library.findHistoryFile({ location })).toBe(file);
  expect(h.library.findHistoryFile({ location: { type: 'opfs', path: location.path, name: file.name, size: file.size, lastModified: file.lastModified } })).toBeUndefined();
});
it('does not replace a deliberate empty component, even after refresh; generation stays blocked', async () => {
  const h = harness({ entries: repositories(), scan: undefined }); await h.library.refresh();
  h.library.chooseComponent({ slot: 'vae', id: '' });
  expect(h.library.ready.value).toBe(false);
  await h.library.refresh();
  expect(h.library.components.value.find(component => component.slot === 'vae')?.selected).toBe('');
  expect(h.library.selectedModels()).toBeUndefined();
  const choice = h.library.components.value.find(component => component.slot === 'vae')!.choices[0]!;
  h.library.chooseComponent({ slot: 'vae', id: choice.id });
  expect(h.library.ready.value).toBe(true);
});
it('preserves a manual component selection when another same-class file appears', async () => {
  const entries = repositories(); const h = harness({ entries, scan: undefined }); await h.library.refresh();
  const selected = h.library.components.value.find(component => component.slot === 'lm')!.selected;
  h.library.chooseComponent({ slot: 'lm', id: selected });
  const alternative = { ...entries[2]!, id: 'user/alternative' };
  h.entries({ next: [alternative, ...entries] }); await h.library.refresh();
  expect(h.library.components.value.find(component => component.slot === 'lm')!.selected).toBe(selected);
});
it('does not auto-select a different primary after the user clears it or switches to manual files', async () => {
  const h = harness({ entries: repositories(), scan: undefined }); await h.library.refresh();
  h.library.chooseMain({ id: '' }); await h.library.refresh(); expect(h.library.main.value).toBe('');
  const id = h.library.models.value[0]!.id; h.library.chooseMain({ id });
  h.library.useManualFiles(); await h.library.refresh(); expect(h.library.main.value).toBe(''); expect(h.library.ready.value).toBe(false);
});
it('rejects known incompatible candidates instead of trusting an advanced selection', async () => {
  const entries = repositories();
  const bad = ggufFixture({ name: 'qwen3-4b.gguf', tensors: qwenTextTensors({ width: 2560, layers: 36 }), metadata: { 'general.architecture': 'gemma' }, extraBytes: 0 }).file;
  entries.push({ id: 'user/gemma', name: 'Gemma', files: [{ path: bad.name, file: bad }] });
  const h = harness({ entries, scan: undefined }); await h.library.refresh(); h.library.showAll.value = true;
  const component = h.library.components.value.find(item => item.slot === 'lm')!;
  const gemma = component.choices.find(choice => choice.detail.includes('user/gemma'))!;
  expect(gemma.status).toBe('incompatible');
  h.library.chooseComponent({ slot: 'lm', id: gemma.id });
  expect(h.library.components.value.find(item => item.slot === 'lm')!.selected).toBe(component.selected);
});
it('discards a stale asynchronous inventory rather than overwriting a newer result', async () => {
  const entries = repositories(); const actual = await scanImageRepositories({ repositories: entries, signal: undefined });
  let finish: ((value: ModelInventory) => void) | undefined;
  let calls = 0;
  const scan: typeof scanImageRepositories = async () => ++calls === 1 ? new Promise<ModelInventory>(resolve => {
    finish = resolve;
  }) : actual;
  const h = harness({ entries, scan });
  const first = h.library.refresh(); for (let i = 0; i < 12; i++) await Promise.resolve();
  h.library.cancelScan(); await first;
  await h.library.refresh(); const main = h.library.main.value;
  finish?.({ candidates: [], issues: [] }); await first;
  expect(h.library.main.value).toBe(main); expect(h.library.ready.value).toBe(true);
});
it('stops scanning on dispose and does not publish results while generation is locked', async () => {
  let finish: ((value: ModelInventory) => void) | undefined;
  const entries = repositories(), actual = await scanImageRepositories({ repositories: entries, signal: undefined });
  const h = harness({ entries, scan: () => new Promise<ModelInventory>(resolve => {
    finish = resolve;
  }) });
  const pending = h.library.refresh(); for (let i = 0; i < 12; i++) await Promise.resolve(); h.block();
  finish?.(actual); await pending; expect(h.library.models.value).toEqual([]);
  await h.library.refresh(); expect(h.list).toHaveBeenCalledTimes(1);
  h.scope.stop(); await h.library.refresh(); expect(h.list).toHaveBeenCalledTimes(1);
});

it('coalesces repeated focus/refresh calls instead of starving a long scan', async () => {
  const entered = Promise.withResolvers<void>(), gate = Promise.withResolvers<ModelInventory>();
  const scan = vi.fn(async () => {
    entered.resolve(); return gate.promise;
  });
  const h = harness({ entries: [], scan });
  const first = h.library.refresh(); await entered.promise;
  const others = Array.from({ length: 25 }, () => h.library.refresh());
  expect(scan).toHaveBeenCalledTimes(1); expect(h.list).toHaveBeenCalledTimes(1);
  expect(h.library.scanState.value).toBe('scanning');
  gate.resolve({ candidates: [], issues: [] }); await Promise.all([first, ...others]);
  expect(h.library.scanState.value).toBe('idle');
});
it('lets explicit history reuse await the initial scan without applying automatic model settings', async () => {
  const entries = repositories();
  const actual = await scanImageRepositories({ repositories: entries, signal: undefined });
  const entered = Promise.withResolvers<void>(), gate = Promise.withResolvers<ModelInventory>();
  const scan = vi.fn(async () => {
    entered.resolve(); return gate.promise;
  });
  const h = harness({ entries, scan });
  const initial = h.library.refresh(); await entered.promise;
  h.block();
  const preparing = h.library.prepareHistoryFiles({ requiredFiles: [] });
  expect(scan).toHaveBeenCalledOnce();
  gate.resolve(actual); await Promise.all([initial, preparing]);
  expect(h.onSelection).not.toHaveBeenCalled(); expect(h.library.main.value).toBe('');
  const file = entries[0]!.files[0]!.file;
  const location = h.library.historyFileLocation({ file });
  expect(h.library.findHistoryFile({ location })).toBe(file);
});
it('starts a local history preparation scan when needed and rejects read failures instead of reporting missing weights', async () => {
  const scan = vi.fn(async () => {
    throw new Error('Local directory cannot be read');
  });
  const h = harness({ entries: [], scan }); h.block();
  await expect(h.library.prepareHistoryFiles({ requiredFiles: [] })).rejects.toThrow('Local directory cannot be read');
  expect(h.list).toHaveBeenCalledOnce(); expect(h.onSelection).not.toHaveBeenCalled();
});
it('cancels an unresponsive injected read immediately and ignores its late rejection', async () => {
  const gate = Promise.withResolvers<ModelInventory>(), entered = Promise.withResolvers<void>();
  const h = harness({ entries: [], scan: async () => {
    entered.resolve(); return gate.promise;
  } });
  const first = h.library.refresh(); await entered.promise;
  h.library.cancelScan(); await first;
  expect(h.library.scanState.value).toBe('idle');
  gate.reject(new Error('old failure')); await Promise.resolve();
  expect(h.library.failure.value).toBe('');
});
it('finishes all waiters when disposed during a stalled read', async () => {
  const entered = Promise.withResolvers<void>();
  const h = harness({ entries: [], scan: async () => {
    entered.resolve(); return new Promise<ModelInventory>(() => undefined);
  } });
  const first = h.library.refresh(); await entered.promise;
  const second = h.library.refresh(); h.scope.stop();
  await Promise.all([first, second]); expect(h.library.scanState.value).toBe('idle');
});
it('enumerates benchmark targets with the same companion choices, without switching the primary selection', async () => {
  const h = harness({ entries: repositories(), scan: undefined }); await h.library.refresh();
  const before = h.library.main.value;
  expect(h.library.benchmarkTargets({ selections: {} })).toHaveLength(1);
  expect(h.library.benchmarkTargets({ selections: {} })[0]?.models).toEqual(h.library.selectedModels());
  expect(h.library.benchmarkTargets({ selections: {} })[0]?.composition).toBe('selected'); expect(h.library.main.value).toBe(before);
  h.library.chooseComponent({ slot: 'vae', id: '' });
  expect(h.library.benchmarkTargets({ selections: {} })[0]?.models).toBeUndefined(); expect(h.library.benchmarkTargets({ selections: {} })[0]?.missing).toContain('vae');
});
it('enumerates every complete primary independently, excludes text/VAE-only and records missing components', async () => {
  const entries = repositories();
  const main = entries[0]!;
  const h = harness({ entries: [...entries, { ...main, id: 'user/second-diffusion' }], scan: undefined }); await h.library.refresh();
  expect(h.library.benchmarkTargets({ selections: {} })).toHaveLength(2);
  expect(h.library.benchmarkTargets({ selections: {} }).every(target => target.models?.map(model => model.slot).join(',') === 'diffusion,vae,lm')).toBe(true);
  h.entries({ next: [entries[0]!] }); await h.library.refresh();
  expect(h.library.benchmarkTargets({ selections: {} })[0]).toMatchObject({ models: undefined, missing: ['vae','lm'] });
});
it('resolves benchmark component overrides independently and never replaces a missing or incompatible choice', async () => {
  const entries = repositories();
  const alternative = { ...entries[1]!, id: 'user/alternative-vae' };
  const h = harness({ entries: [...entries, { ...entries[0]!, id: 'user/second-model' }, alternative], scan: undefined });
  await h.library.refresh();
  const before = h.library.selectedModels();
  const targets = h.library.benchmarkTargets({ selections: {} });
  const first = targets[0]!, second = targets[1]!;
  const alternativeId = first.components.find(component => component.slot === 'vae')!.choices.find(choice => choice.detail.startsWith(alternative.id + '/'))!.id;
  const selections = { [first.id]: { vae: alternativeId } };
  const changed = h.library.benchmarkTargets({ selections });
  expect(changed[0]!.components.find(component => component.slot === 'vae')!.selected).toBe(alternativeId);
  expect(changed[1]!.components).toEqual(second.components);
  expect(h.library.selectedModels()).toEqual(before);
  const incomplete = h.library.benchmarkTargets({ selections: { [first.id]: { vae: '' } } })[0]!;
  expect(incomplete.models).toBeUndefined(); expect(incomplete.missing).toContain('vae');
  const textId = first.components.find(component => component.slot === 'lm')!.selected;
  expect(h.library.benchmarkTargets({ selections: { [first.id]: { vae: textId } } })[0]!.models).toBeUndefined();
  h.entries({ next: entries }); await h.library.refresh();
  const stale = h.library.benchmarkTargets({ selections }).find(target => target.id === first.id)!;
  expect(stale.components.find(component => component.slot === 'vae')!.selected).toBe(alternativeId);
  expect(stale.missing).toContain('vae'); expect(stale.models).toBeUndefined();
});

it('reuses resolved files across session restorations and only retries a missing reference once per inventory', async () => {
  const entries = repositories(), h = harness({ entries, scan: undefined });
  await h.library.refresh(); const file = entries[0]!.files[0]!.file;
  const location = h.library.historyFileLocation({ file });
  h.onSelection.mockClear();
  for (let i = 0; i < 3; i++) await h.library.prepareHistoryFiles({ requiredFiles: [location] });
  expect(h.list).toHaveBeenCalledOnce(); expect(h.onSelection).not.toHaveBeenCalled();
  expect(h.library.findHistoryFile({ location })).toBe(file);
  const missing = { ...location, size: location.size + 1 };
  await h.library.prepareHistoryFiles({ requiredFiles: [missing] });
  await h.library.prepareHistoryFiles({ requiredFiles: [missing] });
  expect(h.list).toHaveBeenCalledTimes(2);
  await h.library.refresh(); await h.library.prepareHistoryFiles({ requiredFiles: [missing] });
  expect(h.list).toHaveBeenCalledTimes(4);
});

it('keeps the exact main and component Files after an unrelated import, but refreshes them on explicit rescan', async () => {
  const entries = repositories(), scan = vi.fn(scanImageRepositories);
  const h = harness({ entries, scan }); await h.library.refresh();
  const before = h.library.selectedModels()!;
  // These are sparse fixture Files: copying their Blob bytes would lose the mocked tensor data.
  const fresh = repositories();
  const imported = { ...repositories()[0]!, id: 'user/imported' };
  h.entries({ next: [...fresh, imported] });
  const onSelectionCount = h.onSelection.mock.calls.length;
  const inputFile = new File(['imported'], 'readme.txt');
  Object.defineProperty(inputFile, 'webkitRelativePath', { value: 'imported/readme.txt' });
  class TestInput {
    files = [inputFile]; value = 'selected';
  }
  vi.stubGlobal('HTMLInputElement', TestInput);
  try {
    const event = new Event('change'); Object.defineProperty(event, 'target', { value: new TestInput() });
    await h.library.importDirectory({ event });
  } finally {
    vi.unstubAllGlobals();
  }
  expect(scan.mock.calls.at(-1)?.[0].repositories.map(repository => repository.id)).toEqual(['user/imported']);
  const after = h.library.selectedModels()!;
  expect(after.map(model => model.slot)).toEqual(before.map(model => model.slot));
  after.forEach((model, index) => expect(model.file).toBe(before[index]!.file));
  expect(h.onSelection).toHaveBeenCalledTimes(onSelectionCount);
  await h.library.refresh();
  const rescanned = h.library.selectedModels()!;
  rescanned.forEach((model, index) => expect(model.file).not.toBe(before[index]!.file));
});
