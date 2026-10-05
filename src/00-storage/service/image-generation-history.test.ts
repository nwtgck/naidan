import { beforeEach, describe, expect, it, vi } from 'vitest';
import { toBinaryObjectId, toImageGenerationId } from '@/01-models/ids';
import type { ImageGenerationRecord } from '@/01-models/image-generation-history';
import { captureImageGenerationHistoryTarget, deleteImageGenerationRecord, loadImageGenerationRecord, queryImageGenerationHistory, saveImageGenerationRecord } from './image-generation-history';

const failures = new Set<string>();
class MockFile {
  readonly kind = 'file';
  text = '';
  readError: Error | undefined;
  constructor(readonly name: string) {}
  async getFile() {
    if (this.readError) throw this.readError;
    return { text: async () => this.text };
  }
  async createWritable() {
    let pending = '';
    return {
      // FileSystemWritableFileStream uses positional arguments.
      write: async (value: string) => {
        pending = value;
      },
      close: async () => {
        if (failures.delete(this.name)) throw new Error(`Cannot commit ${this.name}`);
        this.text = pending;
      },
      abort: async () => {},
    };
  }
}
class MockDirectory {
  readonly kind = 'directory';
  async isSameEntry(other: MockDirectory) {
    return this === other;
  }
  readonly children = new Map<string, MockDirectory | MockFile>();
  constructor(readonly name: string) {}
  // FileSystemDirectoryHandle uses positional arguments.
  async getDirectoryHandle(name: string, options?: { create?: boolean }): Promise<MockDirectory> {
    let child = this.children.get(name);
    if (!child && options?.create) {
      child = new MockDirectory(name); this.children.set(name, child);
    }
    if (!child) throw new DOMException('Missing directory', 'NotFoundError');
    if (!(child instanceof MockDirectory)) throw new Error('Not a directory');
    return child;
  }
  async getFileHandle(name: string, options?: { create?: boolean }): Promise<MockFile> {
    let child = this.children.get(name);
    if (!child && options?.create) {
      child = new MockFile(name); this.children.set(name, child);
    }
    if (!child) throw new DOMException('Missing file', 'NotFoundError');
    if (!(child instanceof MockFile)) throw new Error('Not a file');
    return child;
  }
  async *entries() {
    yield* this.children.entries();
  }
  async removeEntry(name: string) {
    if (failures.delete(name)) throw new Error(`Cannot remove ${name}`);
    if (!this.children.delete(name)) throw new DOMException('Missing entry', 'NotFoundError');
  }
}

let root: MockDirectory;
const getDirectory = vi.fn();
function record({ id, prompt, createdAt }: { id: string, prompt: string, createdAt: number }): ImageGenerationRecord {
  return {
    id: toImageGenerationId({ raw: id }), createdAt,
    request: {
      parameters: {
        prompt, negativePrompt: 'blur', width: 256, height: 256, steps: 9, guidance: 1, seed: '-1',
        sampler: 'euler', scheduler: 'simple', distilledGuidance: 3.5, vaeTiling: false, vaeTileSize: 32,
        flashAttention: true, bf16WeightType: 'f32', qwenVaePolicy: 'bounded', conditioningCacheSize: 4, modelArguments: '',
      },
      models: [{ slot: 'diffusion', path: 'model.gguf', file: { type: 'opfs', path: 'models/user/example/model.gguf', name: 'model.gguf', size: 1000, lastModified: 1 }, companions: [] }],
      loras: [], imageInputs: { initImage: undefined, strength: 0.75, referenceImages: [] },
      preview: { enabled: true, interval: 2, startStep: 1, mode: 'projection', maxEdge: 256 },
      runtime: { sourceCommit: 'source', profile: 'webgpu-wasm64-jspi', weightResidency: 'auto', gpuBudgetMiB: undefined },
    },
    result: { binaryObjectId: toBinaryObjectId({ raw: 'image-final' }), width: 256, height: 256, modelVersion: 'model', uniformOutput: false, elapsedMs: 1234 },
    previews: [{ binaryObjectId: toBinaryObjectId({ raw: 'image-preview' }), step: 2, steps: 9, mode: 'projection', width: 128, height: 128 }],
  };
}
async function shard() {
  let directory = root;
  for (const name of ['naidan-storage', 'experimental', 'image-generation', 'generations', 'ab']) directory = await directory.getDirectoryHandle(name);
  return directory;
}
const query = { text: '', offset: 0, limit: 20 };

beforeEach(() => {
  root = new MockDirectory('root'); failures.clear(); getDirectory.mockReset().mockResolvedValue(root);
  const tails = new Map<string, Promise<unknown>>();
  vi.stubGlobal('navigator', {
    storage: { getDirectory },
    locks: {
      // Web Locks uses positional arguments.
      request<T>(name: string, operation: () => Promise<T>): Promise<T> {
        const pending = (tails.get(name) ?? Promise.resolve()).then(operation);
        tails.set(name, pending.catch(() => {}));
        return pending;
      },
    },
  });
});

describe('experimental image history storage', () => {
  it('does not access OPFS for memory or local storage', async () => {
    for (const storageType of ['memory', 'local'] as const) {
      await expect(queryImageGenerationHistory({ storageType, query })).rejects.toThrow('requires OPFS');
      await expect(saveImageGenerationRecord({ storageType, record: record({ id: 'example-aB', prompt: 'cat', createdAt: 1 }), writeImages: async () => {} })).rejects.toThrow('requires OPFS');
    }
    expect(getDirectory).not.toHaveBeenCalled();
  });
  it('uses a lowercase suffix shard and preserves a requested random seed and all request details', async () => {
    const original = record({ id: 'example-aB', prompt: '\uFEFF cat \n', createdAt: 1 });
    const writeImages = vi.fn().mockResolvedValue(undefined);
    await saveImageGenerationRecord({ storageType: 'opfs', record: original, writeImages });
    expect(writeImages).toHaveBeenCalledOnce();
    expect((await shard()).children.has('example-aB.json')).toBe(true);
    expect(await loadImageGenerationRecord({ storageType: 'opfs', id: original.id })).toEqual(original);
    const page = await queryImageGenerationHistory({ storageType: 'opfs', query });
    expect(page.items[0]?.prompt).toBe(original.request.parameters.prompt);
    expect(page.items[0]?.previewCount).toBe(1);
  });
  it('recovers an indexed save that failed after the immutable record was committed', async () => {
    const original = record({ id: 'example-aB', prompt: 'cat', createdAt: 1 });
    failures.add('index.json');
    await expect(saveImageGenerationRecord({ storageType: 'opfs', record: original, writeImages: async () => {} })).rejects.toThrow('Cannot commit');
    expect(await loadImageGenerationRecord({ storageType: 'opfs', id: original.id })).toEqual(original);
    const page = await queryImageGenerationHistory({ storageType: 'opfs', query });
    expect(page.items.map(item => item.id)).toEqual([original.id]);
    expect((await shard()).children.has('index.json')).toBe(true);
  });
  it('keeps a corrupt index unchanged and does not write images or a new record', async () => {
    const first = record({ id: 'first-aB', prompt: 'cat', createdAt: 1 });
    await saveImageGenerationRecord({ storageType: 'opfs', record: first, writeImages: async () => {} });
    const directory = await shard();
    const index = await directory.getFileHandle('index.json'); index.text = '{broken';
    const writeImages = vi.fn();
    await expect(saveImageGenerationRecord({ storageType: 'opfs', record: record({ id: 'second-aB', prompt: 'dog', createdAt: 2 }), writeImages })).rejects.toThrow();
    expect(writeImages).not.toHaveBeenCalled();
    expect(index.text).toBe('{broken');
    expect(directory.children.has('second-aB.json')).toBe(false);
    const page = await queryImageGenerationHistory({ storageType: 'opfs', query });
    expect(page.items.map(item => item.id)).toEqual([first.id]);
    expect(page.warningCount).toBeGreaterThan(0); expect(index.text).toBe('{broken');
    await expect(deleteImageGenerationRecord({ storageType: 'opfs', id: first.id })).rejects.toThrow();
    expect(directory.children.has('first-aB.json')).toBe(true);
  });
  it.each(['record', 'index'] as const)('reads intact history without changing a zero-byte %s left by abrupt termination', async interrupted => {
    const first = record({ id: 'first-aB', prompt: 'cat', createdAt: 1 });
    await saveImageGenerationRecord({ storageType: 'opfs', record: first, writeImages: async () => {} });
    const directory = await shard();
    const healthyText = (await directory.getFileHandle('first-aB.json')).text;
    const index = await directory.getFileHandle('index.json');
    const originalIndex = index.text;
    const incompleteName = interrupted === 'record' ? 'incomplete-aB.json' : 'index.json';
    const incomplete = await directory.getFileHandle(incompleteName, { create: true });
    incomplete.text = '';
    const page = await queryImageGenerationHistory({ storageType: 'opfs', query });
    expect(page.items.map(item => item.id)).toEqual([first.id]); expect(page.total).toBe(1);
    expect(page.warningCount).toBeGreaterThan(0); expect(page.warnings).not.toEqual([]);
    expect(incomplete.text).toBe('');
    expect((await directory.getFileHandle('first-aB.json')).text).toBe(healthyText);
    expect(index.text).toBe(interrupted === 'record' ? originalIndex : '');
    const writeImages = vi.fn();
    await expect(saveImageGenerationRecord({ storageType: 'opfs', record: record({ id: 'second-aB', prompt: 'dog', createdAt: 2 }), writeImages })).rejects.toThrow();
    expect(writeImages).not.toHaveBeenCalled();
  });
  it('rejects different contents for an existing ID but permits identical retries', async () => {
    const first = record({ id: 'first-aB', prompt: 'cat', createdAt: 1 });
    await saveImageGenerationRecord({ storageType: 'opfs', record: first, writeImages: async () => {} });
    await expect(saveImageGenerationRecord({ storageType: 'opfs', record: record({ id: 'first-aB', prompt: 'dog', createdAt: 2 }), writeImages: async () => {} })).rejects.toThrow('immutable');
    await saveImageGenerationRecord({ storageType: 'opfs', record: first, writeImages: async () => {} });
    expect((await queryImageGenerationHistory({ storageType: 'opfs', query })).total).toBe(1);
  });
  it('reads known fields from extended records without rewriting their original JSON during query, load or retry', async () => {
    const original = record({ id: 'first-aB', prompt: 'cat', createdAt: 1 });
    await saveImageGenerationRecord({ storageType: 'opfs', record: original, writeImages: async () => {} });
    const file = await (await shard()).getFileHandle('first-aB.json');
    const extended = { ...original, futureRecordField: { enabled: true },
      request: { ...original.request, parameters: { ...original.request.parameters, futureSetting: 'preserved in source' } } };
    file.text = JSON.stringify(extended, undefined, 2);
    const source = file.text;
    const page = await queryImageGenerationHistory({ storageType: 'opfs', query });
    expect(page.items.map(item => item.id)).toEqual([original.id]); expect(page.warningCount).toBe(0);
    expect(await loadImageGenerationRecord({ storageType: 'opfs', id: original.id })).toEqual(original);
    await saveImageGenerationRecord({ storageType: 'opfs', record: original, writeImages: async () => {} });
    expect(file.text).toBe(source);
    file.text = JSON.stringify({ ...extended, request: { ...extended.request, parameters: { ...extended.request.parameters, steps: 'invalid known field' } } });
    await expect(loadImageGenerationRecord({ storageType: 'opfs', id: original.id })).rejects.toThrow();
  });
  it('serializes concurrent saves in the same shard without dropping entries', async () => {
    await Promise.all(['first-aB', 'second-aB', 'third-aB'].map((id, createdAt) => saveImageGenerationRecord({ storageType: 'opfs', record: record({ id, prompt: 'cat', createdAt }), writeImages: async () => {} })));
    const page = await queryImageGenerationHistory({ storageType: 'opfs', query: { text: 'cat model', offset: 1, limit: 1 } });
    expect(page.total).toBe(3);
    expect(page.items.map(item => item.id)).toEqual([toImageGenerationId({ raw: 'second-aB' })]);
  });
  it('does not hide failures after acquiring a record handle', async () => {
    const original = record({ id: 'first-aB', prompt: 'cat', createdAt: 1 });
    await saveImageGenerationRecord({ storageType: 'opfs', record: original, writeImages: async () => {} });
    (await (await shard()).getFileHandle('first-aB.json')).readError = new DOMException('Storage disappeared', 'NotFoundError');
    await expect(loadImageGenerationRecord({ storageType: 'opfs', id: original.id })).rejects.toThrow('Storage disappeared');
  });
  it('fails deletion visibly and recovers an index when metadata deletion completed first', async () => {
    const original = record({ id: 'first-aB', prompt: 'cat', createdAt: 1 });
    await saveImageGenerationRecord({ storageType: 'opfs', record: original, writeImages: async () => {} });
    failures.add('first-aB.json');
    await expect(deleteImageGenerationRecord({ storageType: 'opfs', id: original.id })).rejects.toThrow('Cannot remove');
    expect((await queryImageGenerationHistory({ storageType: 'opfs', query })).total).toBe(1);
    failures.add('index.json');
    await expect(deleteImageGenerationRecord({ storageType: 'opfs', id: original.id })).rejects.toThrow('Cannot commit');
    expect((await queryImageGenerationHistory({ storageType: 'opfs', query })).total).toBe(0);
    expect(root.children.has('naidan-storage')).toBe(true);
  });
});


it('never republishes a deleted record, including an absent record with a pending save', async () => {
  const original = record({ id: 'pending-aB', prompt: 'cat', createdAt: 1 });
  const writeImages = vi.fn();
  await deleteImageGenerationRecord({ storageType: 'opfs', id: original.id });
  await expect(saveImageGenerationRecord({ storageType: 'opfs', record: original, writeImages })).rejects.toThrow('deleted');
  expect(writeImages).not.toHaveBeenCalled();
});
it('rejects a lost-acknowledgement retry after deleting its saved record', async () => {
  const original = record({ id: 'saved-aB', prompt: 'cat', createdAt: 1 });
  await saveImageGenerationRecord({ storageType: 'opfs', record: original, writeImages: async () => {} });
  await deleteImageGenerationRecord({ storageType: 'opfs', id: original.id });
  const writeImages = vi.fn();
  await expect(saveImageGenerationRecord({ storageType: 'opfs', record: original, writeImages })).rejects.toThrow('deleted');
  expect(writeImages).not.toHaveBeenCalled();
});
it('does not recreate a removed or replaced captured history store', async () => {
  const expectedDirectory = await captureImageGenerationHistoryTarget({ storageType: 'opfs' });
  const original = record({ id: 'saved-aB', prompt: 'cat', createdAt: 1 });
  root = new MockDirectory('replacement');
  getDirectory.mockResolvedValue(root);
  const writeImages = vi.fn();
  await expect(saveImageGenerationRecord({ storageType: 'opfs', record: original, writeImages, expectedDirectory })).rejects.toThrow('changed or was removed');
  expect(root.children.size).toBe(0); expect(writeImages).not.toHaveBeenCalled();
});
it('does not republish an input deleted through the workspace deletion boundary', async () => {
  const original = record({ id: 'saved-aB', prompt: 'cat', createdAt: 1 });
  const { imageGenerationRoot } = await import('./image-generation/context');
  const { markImageGenerationBinariesDeleted } = await import('./image-generation/deletions');
  const directory = await imageGenerationRoot({ create: true });
  if (!directory) throw new Error('Missing root');
  const id = toBinaryObjectId({ raw: 'input-aa' });
  original.request.imageInputs.initImage = { binaryObjectId: id, name: 'input.png' };
  await markImageGenerationBinariesDeleted({ directory, ids: ['input-aa'] });
  const writeImages = vi.fn();
  await expect(saveImageGenerationRecord({ storageType: 'opfs', record: original, writeImages })).rejects.toThrow('permanently deleted');
  expect(writeImages).not.toHaveBeenCalled();
});
