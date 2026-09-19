import { File as NodeFile } from 'node:buffer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { importStoredModel, listStoredModels, removeStoredModel, storedModelHandle, withModelStoreLock } from './model-store';

type StoredFile = { kind: 'file', content: Uint8Array, getFile: () => Promise<NodeFile>, createWritable: () => Promise<ReturnType<typeof makeWriter>> };
type StoredDirectory = { kind: 'directory', children: Map<string, StoredFile | StoredDirectory>,
  getDirectoryHandle: (name: string, options?: { create?: boolean }) => Promise<StoredDirectory>,
  getFileHandle: (name: string, options?: { create?: boolean }) => Promise<StoredFile>,
  removeEntry: (name: string, options?: { recursive?: boolean }) => Promise<void>,
  entries: () => AsyncGenerator<[string, StoredFile | StoredDirectory]>,
};
let failWrite = false;
let failModelWrite = false;
let committed: string[] = [];
function makeWriter({ file, name }: { file: StoredFile, name: string }) {
  const parts: Uint8Array[] = [];
  return {
    async write(data: string | Uint8Array) {
      if (failWrite || (failModelWrite && name === 'model.gguf')) throw new DOMException('private quota details', 'QuotaExceededError');
      parts.push(typeof data === 'string' ? new TextEncoder().encode(data) : data.slice());
    },
    async close() {
      const merged = new Uint8Array(parts.reduce((size, value) => size + value.length, 0));
      let position = 0;
      for (const part of parts) {
        merged.set(part, position); position += part.length;
      }
      file.content = merged; committed.push(name);
    },
    async abort() {
      parts.length = 0;
    },
  };
}
function makeDirectory(): StoredDirectory {
  const children = new Map<string, StoredFile | StoredDirectory>();
  return {
    kind: 'directory', children,
    async getDirectoryHandle(name, options) {
      let entry = children.get(name);
      if (!entry && options?.create) {
        entry = makeDirectory(); children.set(name, entry);
      }
      if (!entry) throw new DOMException('not found', 'NotFoundError');
      if (entry.kind !== 'directory') throw new DOMException('wrong type', 'TypeMismatchError');
      return entry;
    },
    async getFileHandle(name, options) {
      let entry = children.get(name);
      if (!entry && options?.create) {
        const file: StoredFile = { kind: 'file', content: new Uint8Array(),
          getFile: async () => new NodeFile([file.content], name),
          createWritable: async () => makeWriter({ file, name }),
        };
        entry = file; children.set(name, entry);
      }
      if (!entry) throw new DOMException('not found', 'NotFoundError');
      if (entry.kind !== 'file') throw new DOMException('wrong type', 'TypeMismatchError');
      return entry;
    },
    async removeEntry(name, options) {
      const entry = children.get(name);
      if (!entry) throw new DOMException('not found', 'NotFoundError');
      if (entry.kind === 'directory' && entry.children.size > 0 && !options?.recursive) throw new DOMException('not empty', 'InvalidModificationError');
      children.delete(name);
    },
    async *entries() {
      yield* children.entries();
    },
  };
}
function fixture({ name }: { name: string }): File {
  const bytes = new Uint8Array(256); bytes.set([71, 71, 85, 70, 3, 0, 0, 0]);
  return new NodeFile([bytes], name) as unknown as File;
}
let root: StoredDirectory;
beforeEach(() => {
  root = makeDirectory(); failWrite = false; failModelWrite = false; committed = [];
  vi.stubGlobal('navigator', { storage: { getDirectory: async () => root }, locks: { request: async (_name: string, operation: () => Promise<unknown>) => operation() } });
  vi.spyOn(console, 'debug').mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks(); vi.unstubAllGlobals();
});

describe('local GGUF model store', () => {
  it('imports a stream and publishes metadata only after model data is closed', async () => {
    const file = fixture({ name: 'local.gguf' });
    const wholeFile = vi.spyOn(file, 'arrayBuffer').mockRejectedValue(new Error('Do not buffer the full model'));
    const model = await withModelStoreLock({ operation: () => importStoredModel({ file, onProgress: () => {} }) });
    expect(wholeFile).not.toHaveBeenCalled();
    expect(committed).toEqual(['model.gguf', 'metadata.json']);
    expect(model.name).toBe('local.gguf');
    expect(model.size).toBe(256);
    expect(await listStoredModels()).toEqual([model]);
    expect((await (await storedModelHandle({ name: 'local.gguf' })).getFile()).size).toBe(256);
  });
  it('rejects invalid GGUF magic or version without publishing a model', async () => {
    for (const bytes of [new Uint8Array(40), new Uint8Array([71, 71, 85, 70, 9, 0, 0, 0, ...Array<number>(40).fill(0)])]) {
      const file = new NodeFile([bytes], 'invalid.gguf') as unknown as File;
      await expect(importStoredModel({ file, onProgress: () => {} })).rejects.toThrow('invalid-gguf');
    }
    expect(await listStoredModels()).toEqual([]);
  });
  it('rejects duplicate display names rather than silently changing model identity', async () => {
    await importStoredModel({ file: fixture({ name: 'same.gguf' }), onProgress: () => {} });
    await expect(importStoredModel({ file: fixture({ name: 'same.gguf' }), onProgress: () => {} })).rejects.toThrow('duplicate-model');
    expect(await listStoredModels()).toHaveLength(1);
  });
  it('removes a failed streaming import without making a partial model selectable', async () => {
    failWrite = true;
    await expect(importStoredModel({ file: fixture({ name: 'private.gguf' }), onProgress: () => {} })).rejects.toThrow();
    failWrite = false;
    expect(await listStoredModels()).toEqual([]);
    const folder = await root.getDirectoryHandle('llama-cpp-browser-models');
    expect(folder.children.size).toBe(0);
    expect(JSON.stringify(vi.mocked(console.debug).mock.calls)).not.toContain('private.gguf');
    expect(JSON.stringify(vi.mocked(console.debug).mock.calls)).not.toContain('private quota details');
  });
  it('cleans an unpublished interrupted import only within the owned model directory', async () => {
    const models = await root.getDirectoryHandle('llama-cpp-browser-models', { create: true });
    const id = crypto.randomUUID(); const incomplete = await models.getDirectoryHandle(id, { create: true });
    await incomplete.getFileHandle('model.gguf', { create: true });
    await root.getDirectoryHandle('other-feature', { create: true });
    expect(await listStoredModels()).toEqual([]);
    expect(models.children.has(id)).toBe(false);
    expect(root.children.has('other-feature')).toBe(true);
  });
  it('reclaims an import interrupted before the metadata writer commits', async () => {
    const models = await root.getDirectoryHandle('llama-cpp-browser-models', { create: true });
    const id = crypto.randomUUID(); const incomplete = await models.getDirectoryHandle(id, { create: true });
    await incomplete.getFileHandle('model.gguf', { create: true });
    await incomplete.getFileHandle('metadata.json', { create: true });
    expect(await listStoredModels()).toEqual([]);
    expect(models.children.has(id)).toBe(false);
  });
  it('deletes by internal UUID and rejects paths or unknown model names', async () => {
    const model = await importStoredModel({ file: fixture({ name: '../local.gguf' }), onProgress: () => {} });
    await expect(removeStoredModel({ id: '../other-feature' })).rejects.toThrow();
    await removeStoredModel({ id: model.id });
    expect(await listStoredModels()).toEqual([]);
    await expect(storedModelHandle({ name: model.name })).rejects.toThrow('missing-model');
  });
  it('does not expose a committed model with a mismatched stored size', async () => {
    const model = await importStoredModel({ file: fixture({ name: 'wrong-size.gguf' }), onProgress: () => {} });
    const models = await root.getDirectoryHandle('llama-cpp-browser-models');
    const folder = await models.getDirectoryHandle(model.id); const file = await folder.getFileHandle('model.gguf');
    file.content = new Uint8Array(1);
    expect(await listStoredModels()).toEqual([]);
    expect(models.children.has(model.id)).toBe(true);
  });
  it('rebuilds the model list and file access from OPFS after a module reload', async () => {
    const otherModels = await root.getDirectoryHandle('models', { create: true });
    const untouched = await otherModels.getFileHandle('other-runtime.bin', { create: true });
    untouched.content = new Uint8Array([1, 2, 3]);
    const model = await importStoredModel({ file: fixture({ name: 'persistent.gguf' }), onProgress: () => {} });
    vi.resetModules();
    const reloaded = await import('./model-store');
    expect(await reloaded.listStoredModels()).toEqual([model]);
    expect((await (await reloaded.storedModelHandle({ name: model.name })).getFile()).size).toBe(256);
    expect(root.children.has('llama-cpp-browser-models')).toBe(true);
    expect(root.children.has('llama-cpp-browser-models-v1')).toBe(false);
    expect(untouched.content).toEqual(new Uint8Array([1, 2, 3]));
  });
  it('discovers models added to the canonical OPFS directory rather than a cached array', async () => {
    expect(await listStoredModels()).toEqual([]);
    const model = { id: crypto.randomUUID(), name: 'external.gguf', size: 256, importedAt: 123 };
    const models = await root.getDirectoryHandle('llama-cpp-browser-models');
    const folder = await models.getDirectoryHandle(model.id, { create: true });
    (await folder.getFileHandle('metadata.json', { create: true })).content = new TextEncoder().encode(JSON.stringify(model));
    (await folder.getFileHandle('model.gguf', { create: true })).content = new Uint8Array(await fixture({ name: model.name }).arrayBuffer());
    expect(await listStoredModels()).toEqual([model]);
    await models.removeEntry(model.id, { recursive: true });
    expect(await listStoredModels()).toEqual([]);
  });
  it('migrates the prior versioned directory without changing model identity', async () => {
    const model = await importStoredModel({ file: fixture({ name: 'existing.gguf' }), onProgress: () => {} });
    const legacy = root.children.get('llama-cpp-browser-models')!;
    root.children.set('llama-cpp-browser-models-v1', legacy); root.children.delete('llama-cpp-browser-models');
    committed = [];
    expect(await listStoredModels()).toEqual([model]);
    expect(committed).toEqual(['metadata.json', 'model.gguf']);
    expect(root.children.has('llama-cpp-browser-models-v1')).toBe(false);
    expect((await (await storedModelHandle({ name: model.name })).getFile()).size).toBe(256);
  });
  it('retains the legacy model when migration fails and retries after reloading', async () => {
    const model = await importStoredModel({ file: fixture({ name: 'retry.gguf' }), onProgress: () => {} });
    const legacy = await root.getDirectoryHandle('llama-cpp-browser-models');
    root.children.set('llama-cpp-browser-models-v1', legacy); root.children.delete('llama-cpp-browser-models');
    failWrite = true;
    await expect(listStoredModels()).rejects.toThrow();
    expect((await (await (await legacy.getDirectoryHandle(model.id)).getFileHandle('model.gguf')).getFile()).size).toBe(256);
    failWrite = false; vi.resetModules();
    const reloaded = await import('./model-store');
    expect(await reloaded.listStoredModels()).toEqual([model]);
  });
  it('recovers a legacy copy interrupted after publishing its destination metadata', async () => {
    const file = fixture({ name: 'interrupted-copy.gguf' });
    const model = await importStoredModel({ file, onProgress: () => {} });
    const legacy = await root.getDirectoryHandle('llama-cpp-browser-models');
    root.children.set('llama-cpp-browser-models-v1', legacy); root.children.delete('llama-cpp-browser-models');
    failModelWrite = true; committed = [];
    await expect(listStoredModels()).rejects.toThrow();
    expect(committed).toEqual(['metadata.json']);
    const source = await (await legacy.getDirectoryHandle(model.id)).getFileHandle('model.gguf');
    expect(source.content).toEqual(new Uint8Array(await file.arrayBuffer()));
    const target = await (await root.getDirectoryHandle('llama-cpp-browser-models')).getDirectoryHandle(model.id);
    expect((await target.getFileHandle('model.gguf')).content).toHaveLength(0);
    expect(JSON.parse(await (await (await target.getFileHandle('metadata.json')).getFile()).text())).toEqual(model);
    failModelWrite = false; vi.resetModules();
    const reloaded = await import('./model-store');
    expect(await reloaded.listStoredModels()).toEqual([model]);
    expect((await target.getFileHandle('model.gguf')).content).toEqual(new Uint8Array(await file.arrayBuffer()));
    expect(root.children.has('llama-cpp-browser-models-v1')).toBe(false);
  });
  it('preserves the existing models sibling while importing and migrating GGUF models', async () => {
    const otherModels = await root.getDirectoryHandle('models', { create: true });
    const external = await otherModels.getFileHandle('existing-model.bin', { create: true });
    external.content = new Uint8Array([11, 22, 33]);
    const model = await importStoredModel({ file: fixture({ name: 'sibling.gguf' }), onProgress: () => {} });
    root.children.set('llama-cpp-browser-models-v1', await root.getDirectoryHandle('llama-cpp-browser-models'));
    root.children.delete('llama-cpp-browser-models');
    expect(await listStoredModels()).toEqual([model]);
    expect(root.children.get('models')).toBe(otherModels);
    expect((await otherModels.getFileHandle('existing-model.bin')).content).toEqual(new Uint8Array([11, 22, 33]));
  });
  it('recovers a completed transfer interrupted before removing the legacy metadata', async () => {
    const model = await importStoredModel({ file: fixture({ name: 'moved.gguf' }), onProgress: () => {} });
    const legacy = await root.getDirectoryHandle('llama-cpp-browser-models-v1', { create: true });
    const folder = await legacy.getDirectoryHandle(model.id, { create: true });
    (await folder.getFileHandle('metadata.json', { create: true })).content = new TextEncoder().encode(JSON.stringify(model));
    expect(await listStoredModels()).toEqual([model]);
    expect(root.children.has('llama-cpp-browser-models-v1')).toBe(false);
  });
  it('moves a legacy OPFS file without streaming a second copy when the browser supports move', async () => {
    const model = await importStoredModel({ file: fixture({ name: 'movable.gguf' }), onProgress: () => {} });
    const legacy = await root.getDirectoryHandle('llama-cpp-browser-models');
    root.children.set('llama-cpp-browser-models-v1', legacy); root.children.delete('llama-cpp-browser-models');
    const folder = await legacy.getDirectoryHandle(model.id); const source = await folder.getFileHandle('model.gguf');
    const move = vi.fn(async (target: StoredDirectory, name: string) => {
      target.children.set(name, source); folder.children.delete('model.gguf');
    });
    Object.defineProperty(source, 'move', { value: move });
    committed = [];
    expect(await listStoredModels()).toEqual([model]);
    expect(move).toHaveBeenCalledTimes(1);
    expect(committed).toEqual(['metadata.json']);
    expect(root.children.has('llama-cpp-browser-models-v1')).toBe(false);
  });
  it('falls back to a bounded stream when the optional move operation is unsupported', async () => {
    const model = await importStoredModel({ file: fixture({ name: 'copy.gguf' }), onProgress: () => {} });
    const legacy = await root.getDirectoryHandle('llama-cpp-browser-models');
    root.children.set('llama-cpp-browser-models-v1', legacy); root.children.delete('llama-cpp-browser-models');
    const source = await (await legacy.getDirectoryHandle(model.id)).getFileHandle('model.gguf');
    const move = vi.fn(async () => {
      throw new DOMException('unsupported', 'NotSupportedError');
    });
    Object.defineProperty(source, 'move', { value: move });
    committed = [];
    expect(await listStoredModels()).toEqual([model]);
    expect(move).toHaveBeenCalledTimes(1);
    expect(committed).toEqual(['metadata.json', 'model.gguf']);
  });
  it('does not overwrite a corrupt destination or remove its valid legacy source', async () => {
    const model = await importStoredModel({ file: fixture({ name: 'protected.gguf' }), onProgress: () => {} });
    const legacy = await root.getDirectoryHandle('llama-cpp-browser-models');
    root.children.set('llama-cpp-browser-models-v1', legacy); root.children.delete('llama-cpp-browser-models');
    const target = await (await root.getDirectoryHandle('llama-cpp-browser-models', { create: true })).getDirectoryHandle(model.id, { create: true });
    const corrupt = await target.getFileHandle('metadata.json', { create: true });
    corrupt.content = new TextEncoder().encode('{broken');
    await expect(listStoredModels()).rejects.toThrow('storage-error');
    expect(new TextDecoder().decode(corrupt.content)).toBe('{broken');
    expect((await (await (await legacy.getDirectoryHandle(model.id)).getFileHandle('model.gguf')).getFile()).size).toBe(256);
  });
  it('leaves unrelated entries in the old directory intact after migration', async () => {
    const model = await importStoredModel({ file: fixture({ name: 'with-extra.gguf' }), onProgress: () => {} });
    const legacy = await root.getDirectoryHandle('llama-cpp-browser-models');
    root.children.set('llama-cpp-browser-models-v1', legacy); root.children.delete('llama-cpp-browser-models');
    const folder = await legacy.getDirectoryHandle(model.id);
    const extra = await folder.getFileHandle('notes.txt', { create: true }); extra.content = new Uint8Array([1]);
    expect(await listStoredModels()).toEqual([model]);
    expect(folder.children.has('notes.txt')).toBe(true);
    expect(folder.children.has('model.gguf')).toBe(false);
    expect(await listStoredModels()).toEqual([model]);
  });
  it('requires the browser storage and model-store lock capabilities', async () => {
    vi.stubGlobal('navigator', { storage: {} });
    await expect(listStoredModels()).rejects.toThrow('unavailable');
    await expect(withModelStoreLock({ operation: () => Promise.resolve() })).rejects.toThrow('unavailable');
  });
});
