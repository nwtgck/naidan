// @vitest-environment node
import { afterEach, expect, it, vi } from 'vitest';
import { effectScope, ref } from 'vue';
import { useImageLibrary } from './use-image-library';
import { scanImageRepositories, type ModelInventory } from './logic/model-candidates';
import { temporaryImageRepositories, restoreTemporaryImageFiles } from './logic/temporary-repositories';
import { temporaryModelFiles } from '@/logic/temporary-model-files';
import { temporaryModels } from '@/features/llama-cpp-browser/runtime/temporary-model-store';
import { imageLoraRequests } from './lora-form';
import type { LocalImageRepository } from './logic/repository-store';
import { ggufFixture, safetensorsFixture, zImageTensors, fluxVaeTensors, qwenTextTensors, tensor } from './test-utils/weights.test-support';
const scopes: ReturnType<typeof effectScope>[] = [];

afterEach(() => {
  for (const scope of scopes.splice(0)) {
    scope.stop();
  }
  for (const root of temporaryModelFiles.list()) {
    temporaryModelFiles.remove({ rootId: root.id });
  }
});

function files() {
  return [
    { path: 'image/model/diffusion/model.gguf', file: ggufFixture({ name: 'model.gguf', tensors: zImageTensors, metadata: {}, extraBytes: 0 }).file },
    { path: 'image/vae/vae.safetensors', file: safetensorsFixture({ name: 'vae.safetensors', tensors: fluxVaeTensors }).file },
    { path: 'language/qwen/text.gguf', file: ggufFixture({ name: 'text.gguf', tensors: qwenTextTensors({ width: 2560, layers: 36 }), metadata: { 'general.architecture': 'qwen3' }, extraBytes: 0 }).file },
    { path: 'README.md', file: new File(['model collection'], 'README.md') },
    { path: 'image/model/diffusion/.model.gguf.complete', file: new File(['untrusted receipt'], '.model.gguf.complete') },
  ];
}

function harness({ stored, scan }: { stored: LocalImageRepository[], scan: typeof scanImageRepositories | undefined }) {
  const scope = effectScope();
  scopes.push(scope);
  const blocked = ref(false), list = vi.fn(async () => stored), copy = vi.fn(), download = vi.fn(), onSelection = vi.fn();
  const library = scope.run(() => useImageLibrary({
    downloadsBlocked: () => false,
    blocked: () => blocked.value,
    onSelection,
    dependencies: { list, scan: scan ?? scanImageRepositories, import: copy, download },
  }))!;
  return { library, scope, blocked, list, copy, download, onSelection };
}

async function settled({ library }: { library: ReturnType<typeof useImageLibrary> }): Promise<void> {
  await vi.waitFor(() => {
    expect(library.scanState.value).toBe('idle');
    expect(library.models.value.length).toBeGreaterThan(0);
  });
}

it('uses a llama-tab root for image generation while preserving saved candidates and exact File objects', async () => {
  const entries = files();
  const storedFile = ggufFixture({ name: 'saved.gguf', tensors: zImageTensors, metadata: {}, extraBytes: 0 }).file;
  const h = harness({ stored: [{ id: 'user/saved', name: 'saved', files: [{ path: storedFile.name, file: storedFile }] }], scan: undefined });
  await h.library.refresh();
  const selectedBefore = h.library.main.value;
  const llama = await temporaryModels.registerDirectory({ directory: { name: 'shared', files: entries }, signal: undefined });
  expect(llama.some(model => model.id.startsWith('temp/shared/language/qwen:'))).toBe(true);
  await vi.waitFor(() => expect(h.library.models.value.some(model => model.id === JSON.stringify(['temp/shared', entries[0]!.path]))).toBe(true));
  expect(h.library.models.value.some(model => model.id === JSON.stringify(['user/saved', storedFile.name]))).toBe(true);
  expect(h.library.main.value).toBe(selectedBefore);
  h.library.chooseMain({ id: JSON.stringify(['temp/shared', entries[0]!.path]) });
  expect(h.library.ready.value).toBe(true);
  const models = h.library.selectedModels()!;
  expect(models.map(model => model.slot)).toEqual(['diffusion', 'vae', 'lm']);
  for (const [index, model] of models.entries()) {
    expect(model.file).toBe(entries[index]!.file);
    expect(model.path).toBe(entries[index]!.path);
  }
  expect(h.copy).not.toHaveBeenCalled();
  expect(h.download).not.toHaveBeenCalled();
  expect(h.list).toHaveBeenCalledTimes(1);
  expect(temporaryModelFiles.list()[0]?.files).toHaveLength(5);
});

it('registers an image-tab drop for llama resolution without any persistence and survives closing the image view', async () => {
  const entry = files()[2]!;
  const h = harness({ stored: [], scan: undefined });
  await h.library.dropDirectory({ event: { dataTransfer: { items: [], files: [entry.file] } } as unknown as DragEvent, storage: 'temp' });
  expect(h.copy).not.toHaveBeenCalled();
  const root = temporaryModelFiles.list()[0]!;
  expect(root.id).toBe('temp/text-GGUF');
  const source = await temporaryModels.resolveSource({ name: root.id, signal: undefined });
  expect(source?.files[0]?.file).toBe(entry.file);
  h.scope.stop();
  expect(temporaryModelFiles.get({ rootId: root.id })).toBe(root);
  expect(await temporaryModels.resolveSource({ name: root.id, signal: undefined })).toMatchObject({ id: root.id });
});

it('invalidates both projections immediately on unregister and intentionally resolves a replacement at the same pathname', async () => {
  const entries = files();
  const root = temporaryModelFiles.register({ directory: { name: 'shared', files: entries }, signal: undefined });
  const h = harness({ stored: [], scan: undefined });
  await h.library.refresh();
  h.library.chooseMain({ id: JSON.stringify([root.id, entries[0]!.path]) });
  const file = entries[0]!.file;
  const location = h.library.historyFileLocation({ file });
  expect(location).toMatchObject({ type: 'temp', path: `${root.id}/${entries[0]!.path}` });
  const choice = h.library.captureModelSelection({ loras: [] })!;
  expect(choice.primary.location.kind).toBe('temp');
  await temporaryModels.ensure({ signal: undefined });
  temporaryModelFiles.remove({ rootId: root.id });
  expect(h.library.findHistoryFile({ location })).toBeUndefined();
  expect(h.library.ready.value).toBe(false);
  expect(() => temporaryModels.source({ name: 'temp/shared/language/qwen:text' })).toThrow('missing-model');
  const replacement = files();
  Object.defineProperty(replacement[0]!.file, 'lastModified', { value: file.lastModified + 123 });
  temporaryModelFiles.register({ directory: { name: 'shared', files: replacement }, signal: undefined });
  await settled({ library: h.library });
  expect(h.library.findHistoryFile({ location: { ...location, name: 'old-name', size: 1, lastModified: 0 } })).toBe(replacement[0]!.file);
  expect(h.library.restoreModelSelection({ selection: choice }).missing).toEqual([]);
  expect(h.library.selectedModels()?.[0]?.file).toBe(replacement[0]!.file);
  expect(temporaryModels.list()).toEqual([]);
  expect((await temporaryModels.resolveSource({ name: 'temp/shared/language/qwen:text', signal: undefined }))?.files[0]?.file).toBe(replacement[2]!.file);
});

it('preserves original temporary File identities after inspection clones and unrelated refreshes', async () => {
  const root = temporaryModelFiles.register({ directory: { name: 'shared', files: files() }, signal: undefined });
  const inventory = await scanImageRepositories({ repositories: temporaryImageRepositories({ roots: [root] }), signal: undefined });
  const cloned: ModelInventory = { ...inventory, candidates: inventory.candidates.map(candidate => ({ ...candidate, files: candidate.files.map(entry => ({ ...entry, file: new File(['cloned wrapper'], entry.file.name) })) })) };
  const restored = restoreTemporaryImageFiles({ inventory: cloned, roots: [root] });
  for (const candidate of restored.candidates) {
    for (const entry of candidate.files) {
      expect(entry.file).toBe(root.files.find(file => file.path === entry.path)?.file);
    }
  }
  const h = harness({ stored: [], scan: undefined });
  await h.library.refresh();
  h.library.chooseMain({ id: JSON.stringify([root.id, root.files[0]!.path]) });
  const before = h.library.selectedModels()!;
  await h.library.refresh();
  expect(h.library.selectedModels()?.map(model => model.file)).toEqual(before.map(model => model.file));
  for (const [index, model] of h.library.selectedModels()!.entries()) {
    expect(model.file).toBe(before[index]!.file);
  }
});

it('discards a late scan for an unregistered root and reschedules the replacement without resurrecting old files', async () => {
  const gate = Promise.withResolvers<ModelInventory>();
  const stale = temporaryModelFiles.register({ directory: { name: 'shared', files: files() }, signal: undefined });
  const staleInventory = await scanImageRepositories({ repositories: temporaryImageRepositories({ roots: [stale] }), signal: undefined });
  const scan = vi.fn(scanImageRepositories).mockReturnValueOnce(gate.promise);
  const h = harness({ stored: [], scan });
  const initial = h.library.refresh();
  await vi.waitFor(() => expect(scan).toHaveBeenCalledOnce());
  temporaryModelFiles.remove({ rootId: stale.id });
  const replacement = temporaryModelFiles.register({ directory: { name: 'shared', files: files() }, signal: undefined });
  await settled({ library: h.library });
  gate.resolve(staleInventory);
  await initial;
  h.library.chooseMain({ id: JSON.stringify([replacement.id, replacement.files[0]!.path]) });
  expect(h.library.selectedModels()?.[0]?.file).toBe(replacement.files[0]!.file);
  expect(h.library.failure.value).toBe('');
});

it('publishes shared roots while the editor is busy without changing the selected settings', async () => {
  const h = harness({ stored: [], scan: undefined });
  await h.library.refresh();
  h.blocked.value = true;
  const root = temporaryModelFiles.register({ directory: { name: 'shared', files: files() }, signal: undefined });
  await settled({ library: h.library });
  expect(h.library.models.value.some(model => model.id === JSON.stringify([root.id, root.files[0]!.path]))).toBe(true);
  expect(h.library.main.value).toBe('');
  expect(h.onSelection).not.toHaveBeenCalled();
});

it('shares root-name reservations between image imports and llama imports without renaming live roots', async () => {
  const file = files()[2]!.file;
  const h = harness({ stored: [], scan: undefined });
  await h.library.dropDirectory({ event: { dataTransfer: { items: [], files: [file] } } as unknown as DragEvent, storage: 'temp' });
  const fromImage = temporaryModelFiles.list()[0]!;
  const fromLlama = await temporaryModels.registerDirectory({ directory: { name: fromImage.name, files: [{ path: file.name, file }] }, signal: undefined });
  expect(fromImage.id).toBe('temp/text-GGUF');
  expect(fromLlama[0]?.id).toBe('temp/text-GGUF-2');
  temporaryModelFiles.remove({ rootId: fromImage.id });
  expect((await temporaryModels.resolveSource({ name: 'temp/text-GGUF-2', signal: undefined }))?.files[0]?.file).toBe(file);
  expect(temporaryModelFiles.list().map(root => root.id)).toEqual(['temp/text-GGUF-2']);
});

it('keeps temporary LoRA selections and history locators restorable without storing or copying their bytes', async () => {
  const adapter = safetensorsFixture({ name: 'style.safetensors', tensors: ['layer.lora_A.weight', 'layer.lora_B.weight'].map(name => tensor({ name, shape: [4, 8] })) }).file;
  const entries = [...files(), { path: 'adapters/styles/style.safetensors', file: adapter }];
  const root = temporaryModelFiles.register({ directory: { name: 'shared', files: entries }, signal: undefined });
  const h = harness({ stored: [], scan: undefined });
  await h.library.refresh();
  h.library.chooseMain({ id: JSON.stringify([root.id, entries[0]!.path]) });
  const saved = h.library.savedLoras.value[0]!;
  expect(saved.file).toBe(adapter);
  expect(saved.path).toBe('adapters/styles/style.safetensors');
  const selected = { file: saved.file, path: saved.path, sourceLabel: saved.detail, enabled: true, strength: 0.7 };
  const selection = h.library.captureModelSelection({ loras: [selected] })!;
  expect(selection.loras).toEqual([{ location: { kind: 'temp', path: 'temp/shared/adapters/styles/style.safetensors' }, enabled: 'enabled', strength: 0.7 }]);
  expect(h.library.restoreModelSelection({ selection }).loras[0]?.file).toBe(adapter);
  const request = imageLoraRequests({ selections: [selected] });
  expect(request[0]?.file).toBe(adapter);
  expect(request[0]?.path).toBe(saved.path);
  const location = h.library.historyFileLocation({ file: adapter });
  expect(location.type).toBe('temp');
  expect(h.library.findHistoryFile({ location })).toBe(adapter);
  temporaryModelFiles.remove({ rootId: root.id });
  expect(h.library.restoreModelSelection({ selection }).missing).toContain('temp/shared/adapters/styles/style.safetensors');
  expect(h.library.findHistoryFile({ location })).toBeUndefined();
  expect(h.copy).not.toHaveBeenCalled();
});

it('retains split weights and safetensors index files in shared directories, including their exact companion paths', async () => {
  const shards = zImageTensors.slice(0, 2).map((value, index) => ({
    path: `diffusion/model-0000${index + 1}-of-00002.gguf`,
    file: ggufFixture({ name: `model-0000${index + 1}-of-00002.gguf`, tensors: [value], metadata: { 'split.no': index, 'split.count': 2, 'split.tensors.count': 2 }, extraBytes: 0 }).file,
  }));
  const weight = safetensorsFixture({ name: 'part.safetensors', tensors: [tensor({ name: 'x', shape: [1] })] }).file;
  const index = new File([JSON.stringify({ weight_map: { x: 'part.safetensors' } })], 'model.safetensors.index.json');
  const root = temporaryModelFiles.register({ directory: { name: 'sharded', files: [...shards, { path: 'encoder/model.safetensors.index.json', file: index }, { path: 'encoder/part.safetensors', file: weight }] }, signal: undefined });
  const h = harness({ stored: [], scan: undefined });
  await h.library.refresh();
  expect(h.library.issues.value).toEqual([]);
  for (const entry of root.files) {
    const location = h.library.historyFileLocation({ file: entry.file });
    expect(location).toMatchObject({ type: 'temp', path: `${root.id}/${entry.path}` });
    expect(h.library.findHistoryFile({ location })).toBe(entry.file);
  }
  const inventory = await scanImageRepositories({ repositories: temporaryImageRepositories({ roots: [root] }), signal: undefined });
  expect(inventory.candidates.map(candidate => candidate.files.map(entry => entry.path))).toEqual(expect.arrayContaining([
    shards.map(entry => entry.path), ['encoder/model.safetensors.index.json', 'encoder/part.safetensors'],
  ]));
});
