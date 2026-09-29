// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTransformersJsService } from '@/features/transformers-js/index-hosted';
import { memoryDirectory, ggufBytes } from '@/features/llama-cpp-browser/hugging-face/test-opfs';
import { listStoredModels, planStoredModelRemoval, removeStoredModel, storedModelDirectory } from '@/features/llama-cpp-browser/runtime/model-store';
import { scanDeletionTree } from '@/features/llama-cpp-browser/runtime/deletion-plan';
import { createDownloadWriter } from '@/features/llama-cpp-browser/hugging-face/writer';

let root: ReturnType<typeof memoryDirectory>;
let service: ReturnType<typeof createTransformersJsService>;
const createWorkerClient = vi.fn(() => {
  throw new Error('Model storage must not start a Worker');
});

async function file({ path, content }: { path: string; content: Uint8Array }): Promise<void> {
  const parts = path.split('/'); const name = parts.pop()!;
  let folder = root;
  for (const part of parts) folder = await folder.getDirectoryHandle(part, { create: true });
  const access = await (await folder.getFileHandle(name, { create: true })).createSyncAccessHandle();
  try {
    access.write(content, { at: 0 });
  } finally {
    access.close();
  }
}
async function textFile({ path }: { path: string }): Promise<void> {
  await file({ path, content: new TextEncoder().encode('{}') });
}
async function onnxModel({ path }: { path: string }): Promise<void> {
  for (const name of ['model.onnx', '.model.onnx.complete', 'config.json', '.config.json.complete']) await textFile({ path: `${path}/${name}` });
}
async function folderAt({ path }: { path: string }): Promise<FileSystemDirectoryHandle> {
  let folder = root;
  for (const part of path.split('/')) folder = await folder.getDirectoryHandle(part);
  return folder as unknown as FileSystemDirectoryHandle;
}
beforeEach(() => {
  root = memoryDirectory({ name: '' });
  vi.stubGlobal('navigator', { storage: { getDirectory: async () => root }, locks: {
    request: async (_name: string, optionsOrCallback: object | (() => Promise<unknown>), callback?: (lock: object) => Promise<unknown>) => callback ? callback({}) : typeof optionsOrCallback === 'function' ? optionsOrCallback() : undefined,
  } });
  service = createTransformersJsService({ createWorkerClient });
});
afterEach(async () => {
  await service.dispose();
  expect(createWorkerClient).not.toHaveBeenCalled();
  vi.unstubAllGlobals();
});

describe('shared OPFS model storage', () => {
  it('lists each engine format independently for user and Hugging Face models', async () => {
    for (const base of ['models/user', 'models/huggingface.co/org']) {
      const suffix = base.endsWith('/org') ? '/resolve/main' : '';
      await onnxModel({ path: `${base}/onnx${suffix}` });
      await file({ path: `${base}/gguf${suffix}/model-Q4_K_M.gguf`, content: ggufBytes() });
      await textFile({ path: `${base}/gguf${suffix}/config.json` });
      await textFile({ path: `${base}/metadata${suffix}/tokenizer.model` });
      await onnxModel({ path: `${base}/mixed${suffix}` });
      await file({ path: `${base}/mixed${suffix}/model-Q4_K_M.gguf`, content: ggufBytes() });
    }
    expect((await service.service.listCachedModels()).map(model => model.id).sort()).toEqual(['hf.co/org/mixed', 'hf.co/org/onnx', 'user/mixed', 'user/onnx']);
    expect((await service.service.listCachedModels()).every(model => model.isComplete)).toBe(true);
    expect((await service.service.listCachedModels()).every(model => model.size === 4 && model.fileCount === 2)).toBe(true);
    const llamaModels = await listStoredModels();
    expect(llamaModels.map(model => model.name)).toEqual(['hf.co/org/gguf:model-Q4_K_M', 'hf.co/org/mixed:model-Q4_K_M', 'user/gguf', 'user/mixed']);
    for (const model of llamaModels) expect((await storedModelDirectory({ name: model.id })).files.every(entry => entry.path.endsWith('.gguf'))).toBe(true);
  });

  it('keeps incomplete ONNX visible and does not treat tokenizer-only directories as models', async () => {
    await textFile({ path: 'models/user/partial/model.onnx' });
    await textFile({ path: 'models/user/tokenizer/tokenizer.model' });
    await onnxModel({ path: 'models/user/missing-metadata-marker' });
    await (await folderAt({ path: 'models/user/missing-metadata-marker' })).removeEntry('.config.json.complete');
    expect(await service.service.listCachedModels()).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'user/partial', isComplete: false }),
      expect.objectContaining({ id: 'user/missing-metadata-marker', isComplete: false }),
    ]));
    expect((await service.service.listCachedModels()).map(model => model.id)).not.toContain('user/tokenizer');
    expect(await listStoredModels()).toEqual([]);
  });

  it.each(['user/mixed', 'hf.co/org/mixed'])('deleting TJS %s preserves GGUF files and llama pending state', async id => {
    const path = id.startsWith('user/') ? `models/${id}` : 'models/huggingface.co/org/mixed/resolve/main';
    await onnxModel({ path });
    for (const name of ['model-00001-of-00002.gguf', 'model-00002-of-00002.gguf', 'mmproj.gguf']) await file({ path: `${path}/${name}`, content: ggufBytes() });
    await textFile({ path: `${path}/.llama-cpp-import-pending` });
    await textFile({ path: `${path}/notes.txt` });
    await textFile({ path: `${path}/.model-00001-of-00002.gguf.complete` });
    await textFile({ path: `${path}/.model.onnx.staging-f28f6802-947c-4b9d-bc99-223d8d469f4b` });
    await textFile({ path: `${path}/unfinished.onnx` });
    await service.service.deleteModel({ modelId: id });
    expect((await scanDeletionTree({ folder: await folderAt({ path }) })).files.map(entry => entry.path)).toEqual([
      '.llama-cpp-import-pending', '.model-00001-of-00002.gguf.complete', 'mmproj.gguf', 'model-00001-of-00002.gguf', 'model-00002-of-00002.gguf', 'notes.txt',
    ]);
    expect(await service.service.listCachedModels()).toEqual([]);
  });

  it('removes completed external tensors with arbitrary names but preserves unmarked unknown files', async () => {
    const path = 'models/user/external';
    await onnxModel({ path });
    for (const name of ['tensor-chunk', '.tensor-chunk.complete', 'unknown-chunk', 'model.onnx_data', 'model.onnx_data_1']) await textFile({ path: `${path}/${name}` });
    await service.service.deleteModel({ modelId: 'user/external' });
    expect((await scanDeletionTree({ folder: await folderAt({ path }) })).files.map(entry => entry.path)).toEqual(['unknown-chunk']);
  });

  it('downloads GGUF alongside a completed TJS repository without hiding or changing the ONNX model', async () => {
    const path = 'models/huggingface.co/org/mixed/resolve/main';
    await onnxModel({ path });
    const before = await service.service.listCachedModels();
    const writer = createDownloadWriter();
    const selection = { repository: 'org/mixed', revision: 'a'.repeat(40), files: [{ path: 'model.gguf', size: 128 }] };
    expect(await writer.begin({ selection })).toMatchObject({ status: 'ready' });
    expect(await service.service.listCachedModels()).toEqual(before);
    expect(await listStoredModels()).toEqual([]);
    await writer.open({ fileIndex: 0, start: 0 });
    await writer.append({ bytes: ggufBytes() });
    await writer.finishFile(); await writer.finish();
    expect(await service.service.listCachedModels()).toEqual(before);
    expect(await listStoredModels()).toEqual([expect.objectContaining({ id: 'hf.co/org/mixed:model.gguf', size: 128 })]);
    expect(root.children.has('llama-cpp-browser-models')).toBe(false);
  });

  it.each(['user/mixed', 'hf.co/org/mixed'])('deleting llama %s preserves TJS files and remains usable by TJS', async id => {
    const path = id.startsWith('user/') ? `models/${id}` : 'models/huggingface.co/org/mixed/resolve/main';
    await onnxModel({ path });
    await file({ path: `${path}/model-Q4_K_M.gguf`, content: ggufBytes() });
    await file({ path: `${path}/mmproj.gguf`, content: ggufBytes() });
    const model = (await listStoredModels())[0]!;
    const plan = await planStoredModelRemoval({ id: model.id });
    expect(plan.files.map(entry => entry.path)).toEqual(['mmproj.gguf', 'model-Q4_K_M.gguf']);
    await textFile({ path: `${path}/tokenizer.json` });
    await textFile({ path: `${path}/.tokenizer.json.complete` });
    expect(await removeStoredModel({ plan })).toBe('deleted');
    expect(await listStoredModels()).toEqual([]);
    expect(await service.service.listCachedModels()).toEqual([expect.objectContaining({ id, isComplete: true })]);
  });

  it('ignores the former llama root without migrating, mutating, or listing it', async () => {
    const oldPath = 'llama-cpp-browser-models/user/old';
    await file({ path: `${oldPath}/model.gguf`, content: ggufBytes() });
    expect(await listStoredModels()).toEqual([]);
    expect(await service.service.listCachedModels()).toEqual([]);
    await expect(storedModelDirectory({ name: 'user/old' })).rejects.toThrow('missing-model');
    expect((await scanDeletionTree({ folder: await folderAt({ path: oldPath }) })).files).toHaveLength(1);
  });
});
