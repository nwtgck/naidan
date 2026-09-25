// @vitest-environment node
import { afterEach, expect, it, vi } from 'vitest';
import { effectScope } from 'vue';
import { useImageLibrary } from './use-image-library';
import { scanImageRepositories, type ModelInventory } from './logic/model-candidates';
import type { LocalImageRepository } from './logic/repository-store';
import { ggufFixture, safetensorsFixture, zImageTensors, fluxVaeTensors, qwenTextTensors } from './test-utils/weights';

const scopes: ReturnType<typeof effectScope>[] = [];
afterEach(() => {
  for (const scope of scopes.splice(0)) scope.stop();
});
function repositories(): LocalImageRepository[] {
  const files = [
    ggufFixture({ name: 'z_image_turbo.gguf', tensors: zImageTensors, metadata: {}, extraBytes: 0 }).file,
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
  const library = scope.run(() => useImageLibrary({ blocked: () => blocked, onSelection, dependencies: { list, scan: scan ?? scanImageRepositories, import: vi.fn(async () => 'user/imported'), download: vi.fn() } }))!;
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
  const first = h.library.refresh(); await Promise.resolve();
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
  const pending = h.library.refresh(); await Promise.resolve(); h.block();
  finish?.(actual); await pending; expect(h.library.models.value).toEqual([]);
  await h.library.refresh(); expect(h.list).toHaveBeenCalledTimes(1);
  h.scope.stop(); await h.library.refresh(); expect(h.list).toHaveBeenCalledTimes(1);
});
