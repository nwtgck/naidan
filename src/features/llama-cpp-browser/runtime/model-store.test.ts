import { readDiagnostics } from '@/features/llama-cpp-browser/test-utils/diagnostics';
import { importModelDirectory, resolveModelFiles } from './model-directory';
import { File as NodeFile } from 'node:buffer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { importStoredModel, listStoredModels, removeStoredModel, storedModelDirectory, storedModelHandle, withModelStoreLock } from './model-store';

type StoredFile = { kind: 'file', content: Uint8Array, getFile: () => Promise<NodeFile>, createWritable: () => Promise<ReturnType<typeof makeWriter>> };
type StoredDirectory = { kind: 'directory', children: Map<string, StoredFile | StoredDirectory>,
  getDirectoryHandle: (name: string, options?: { create?: boolean }) => Promise<StoredDirectory>,
  getFileHandle: (name: string, options?: { create?: boolean }) => Promise<StoredFile>,
  removeEntry: (name: string, options?: { recursive?: boolean }) => Promise<void>,
  entries: () => AsyncGenerator<[string, StoredFile | StoredDirectory]>,
};
let failWrite = false;
let failModelWrite = false;
let truncateOnClose = false;
let failMarker = false;
let failClose = false;
let committed: string[] = [];
function makeWriter({ file, name }: { file: StoredFile, name: string }) {
  const parts: Uint8Array[] = [];
  return {
    async write(data: string | Uint8Array) {
      if (failWrite || (failModelWrite && name.endsWith('.gguf'))) throw new DOMException('private quota details', 'QuotaExceededError');
      parts.push(typeof data === 'string' ? new TextEncoder().encode(data) : data.slice());
    },
    async close() {
      const merged = new Uint8Array(parts.reduce((size, value) => size + value.length, 0));
      let position = 0;
      for (const part of parts) {
        merged.set(part, position); position += part.length;
      }
      if (failClose) throw new DOMException('private close details', 'QuotaExceededError');
      file.content = truncateOnClose ? merged.subarray(0, 8) : merged; committed.push(name);
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
      if (failMarker && name.endsWith('.complete')) throw new DOMException('private marker details', 'QuotaExceededError');
      let entry = children.get(name);
      if (!entry && options?.create) {
        const file: StoredFile = { kind: 'file', content: new Uint8Array(),
          getFile: async () => new NodeFile([file.content], name, { lastModified: 123 }),
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
  root = makeDirectory(); failWrite = false; failModelWrite = false; committed = []; truncateOnClose = false; failMarker = false; failClose = false;
  vi.stubGlobal('navigator', { storage: { getDirectory: async () => root }, locks: { request: async (_name: string, operation: () => Promise<unknown>) => operation() } });
  vi.spyOn(console, 'debug').mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks(); vi.unstubAllGlobals();
});

async function userFolder(): Promise<StoredDirectory> {
  return (await root.getDirectoryHandle("llama-cpp-browser-models", { create: true })).getDirectoryHandle("user", { create: true });
}
async function modelFolder({ name }: { name: string }): Promise<StoredDirectory> {
  return (await userFolder()).getDirectoryHandle(`${name.slice(0, -5)}-GGUF`, { create: true });
}
async function putModelFile({ name }: { name: string }): Promise<StoredDirectory> {
  const folder = await modelFolder({ name });
  (await folder.getFileHandle(name, { create: true })).content = new Uint8Array(await fixture({ name }).arrayBuffer());
  return folder;
}
describe("local GGUF model store", () => {
  it("streams the original filename into a readable tree and publishes only after close", async () => {
    const file = fixture({ name: "local.gguf" });
    const wholeFile = vi.spyOn(file, "arrayBuffer").mockRejectedValue(new Error("Do not buffer the full model"));
    const progress = vi.fn();
    const model = await withModelStoreLock({ operation: () => importStoredModel({ file, onProgress: progress }) });
    expect(wholeFile).not.toHaveBeenCalled();
    expect(committed).toEqual(["local.gguf"]);
    expect(model.id).toBe("user/local-GGUF/local.gguf");
    expect(model.name).toBe("local-GGUF"); expect(model.size).toBe(256);
    expect(model.importedAt).toBe(123);
    const folder = await modelFolder({ name: file.name });
    expect([...folder.children.keys()]).toEqual(["local.gguf", ".local.gguf.complete"]);
    expect(await listStoredModels()).toEqual([model]);
    expect((await (await storedModelHandle({ name: file.name })).getFile()).size).toBe(256);
    expect((await (await storedModelHandle({ name: model.name })).getFile()).name).toBe(file.name);
    expect(progress).toHaveBeenLastCalledWith({ progress: { phase: "importing", completed: 256, total: 256 } });
  });
  it("rejects an ambiguous directory selection while preserving explicit legacy filenames", async () => {
    await importStoredModel({ file: fixture({ name: "local.gguf" }), onProgress: () => {} });
    const folder = await modelFolder({ name: "local.gguf" });
    (await folder.getFileHandle("local.GGUF", { create: true })).content = new Uint8Array(await fixture({ name: "local.GGUF" }).arrayBuffer());
    await folder.getFileHandle(".local.GGUF.complete", { create: true });
    await expect(storedModelHandle({ name: "local-GGUF" })).rejects.toThrow("unsupported-input");
    expect((await (await storedModelHandle({ name: "local.gguf" })).getFile()).name).toBe("local.gguf");
  });
  it("rejects invalid GGUF magic or version without publishing", async () => {
    for (const bytes of [new Uint8Array(40), new Uint8Array([71, 71, 85, 70, 9, 0, 0, 0, ...Array<number>(40).fill(0)])]) {
      await expect(importStoredModel({ file: new NodeFile([bytes], "invalid.gguf") as unknown as File, onProgress: () => {} })).rejects.toThrow("invalid-gguf");
    }
    expect(await listStoredModels()).toEqual([]);
  });
  it("rejects completed duplicate names without replacing the file", async () => {
    await importStoredModel({ file: fixture({ name: "same.gguf" }), onProgress: () => {} });
    const folder = await modelFolder({ name: "same.gguf" }); const before = folder.children.get("same.gguf");
    await expect(importStoredModel({ file: fixture({ name: "same.gguf" }), onProgress: () => {} })).rejects.toThrow("duplicate-model");
    expect(folder.children.get("same.gguf")).toBe(before);
    expect(await listStoredModels()).toHaveLength(1);
  });
  it("removes failed import data and does not log user-controlled names or errors", async () => {
    failWrite = true;
    await expect(importStoredModel({ file: fixture({ name: "private.gguf" }), onProgress: () => {} })).rejects.toThrow();
    failWrite = false;
    expect(await listStoredModels()).toEqual([]);
    expect((await userFolder()).children.size).toBe(0);
    expect(JSON.stringify(vi.mocked(console.debug).mock.calls)).not.toContain("private");
  });
  it("leaves unmarked files intact during discovery instead of repairing or deleting them", async () => {
    const folder = await putModelFile({ name: "interrupted.gguf" });
    await root.getDirectoryHandle("other-feature", { create: true });
    expect(await listStoredModels()).toEqual([]);
    expect(folder.children.has("interrupted.gguf")).toBe(true);
    expect(folder.children.has(".interrupted.gguf.complete")).toBe(false);
    expect(root.children.has("other-feature")).toBe(true);
  });
  it("explicitly retries an incomplete import of the same file", async () => {
    const folder = await modelFolder({ name: "retry.gguf" });
    (await folder.getFileHandle("retry.gguf", { create: true })).content = new Uint8Array([1]);
    const model = await importStoredModel({ file: fixture({ name: "retry.gguf" }), onProgress: () => {} });
    expect(await listStoredModels()).toEqual([model]);
    expect((await folder.getFileHandle("retry.gguf")).content.length).toBe(256);
  });
  it("rejects unsafe names and deletion paths without escaping the model root", async () => {
    for (const name of ["../local.gguf", "dir/local.gguf", "dir\\local.gguf", ".gguf", "local.bin", "a\u0000.gguf", "a".repeat(241) + ".gguf"]) {
      await expect(importStoredModel({ file: fixture({ name }), onProgress: () => {} })).rejects.toThrow("invalid-gguf");
    }
    const model = await importStoredModel({ file: fixture({ name: "local.gguf" }), onProgress: () => {} });
    for (const id of ["../other-feature", "other/local-GGUF/local.gguf", "user/../local.gguf", model.id + "/extra"]) {
      await expect(removeStoredModel({ id })).rejects.toThrow();
    }
    expect(await listStoredModels()).toEqual([model]);
    await removeStoredModel({ id: model.id });
    expect(await listStoredModels()).toEqual([]);
    await expect(storedModelHandle({ name: model.name })).rejects.toThrow("missing-model");
  });
  it("does not expose a marked file with a truncated or invalid header", async () => {
    await importStoredModel({ file: fixture({ name: "truncated.gguf" }), onProgress: () => {} });
    const folder = await modelFolder({ name: "truncated.gguf" });
    (await folder.getFileHandle("truncated.gguf")).content = new Uint8Array(1);
    expect(await listStoredModels()).toEqual([]);
    expect(folder.children.has("truncated.gguf")).toBe(true);
    await expect(storedModelHandle({ name: "truncated.gguf" })).rejects.toThrow("missing-model");
  });
  it("rediscovers plain files after module reload without touching the tjs models sibling", async () => {
    const sibling = await root.getDirectoryHandle("models", { create: true });
    const other = await sibling.getFileHandle("other-runtime.bin", { create: true }); other.content = new Uint8Array([1, 2, 3]);
    const model = await importStoredModel({ file: fixture({ name: "persistent.gguf" }), onProgress: () => {} });
    vi.resetModules(); const reloaded = await import("./model-store");
    expect(await reloaded.listStoredModels()).toEqual([model]);
    expect((await (await reloaded.storedModelHandle({ name: model.name })).getFile()).size).toBe(256);
    expect(root.children.has("llama-cpp-browser-models-v1")).toBe(false);
    expect(other.content).toEqual(new Uint8Array([1, 2, 3]));
  });
  it("discovers externally added files and markers without a registry", async () => {
    expect(await listStoredModels()).toEqual([]);
    const folder = await putModelFile({ name: "external.gguf" });
    await folder.getFileHandle(".external.gguf.complete", { create: true });
    expect(await listStoredModels()).toEqual([{ id: "user/external-GGUF/external.gguf", name: "external-GGUF", size: 256, importedAt: 123 }]);
    await folder.removeEntry(".external.gguf.complete");
    expect(await listStoredModels()).toEqual([]);
    expect(folder.children.has("external.gguf")).toBe(true);
  });
  // This unreleased feature deliberately has no migration path. Preserve the
  // old migration safety cases as explicit non-migration/data-preservation cases.
  it.each(["complete", "write-failed", "interrupted-copy", "sibling", "already-moved", "movable", "move-unsupported", "corrupt-destination", "extra-files"])("does not migrate or delete legacy data: %s", async state => {
    const legacy = await root.getDirectoryHandle("llama-cpp-browser-models-v1", { create: true });
    const id = "00000000-0000-4000-8000-000000000001";
    const oldFolder = await legacy.getDirectoryHandle(id, { create: true });
    const oldFile = await oldFolder.getFileHandle("model.gguf", { create: true });
    oldFile.content = new Uint8Array(await fixture({ name: "old.gguf" }).arrayBuffer());
    const metadata = await oldFolder.getFileHandle("metadata.json", { create: true });
    metadata.content = new TextEncoder().encode(state === "corrupt-destination" ? "{broken" : JSON.stringify({ id, name: "old.gguf", size: 256, importedAt: 123 }));
    const metadataBefore = metadata.content.slice(); const bytesBefore = oldFile.content.slice();
    if (state === "extra-files") await oldFolder.getFileHandle("notes.txt", { create: true });
    const move = vi.fn(); Object.defineProperty(oldFile, "move", { value: move });
    const sibling = await root.getDirectoryHandle("models", { create: true });
    const sharedFile = await sibling.getFileHandle("existing-model.bin", { create: true }); sharedFile.content = new Uint8Array([11, 22, 33]);
    expect(await listStoredModels()).toEqual([]);
    await importStoredModel({ file: fixture({ name: "new.gguf" }), onProgress: () => {} });
    expect((await listStoredModels()).map(model => model.name)).toEqual(["new-GGUF"]);
    expect(move).not.toHaveBeenCalled(); expect(root.children.get("llama-cpp-browser-models-v1")).toBe(legacy);
    expect(oldFile.content).toEqual(bytesBefore); expect(metadata.content).toEqual(metadataBefore);
    expect(sharedFile.content).toEqual(new Uint8Array([11, 22, 33]));
  });
  it("requires storage and the model-store lock", async () => {
    vi.stubGlobal("navigator", { storage: {} });
    await expect(listStoredModels()).rejects.toThrow("unavailable");
    await expect(withModelStoreLock({ operation: () => Promise.resolve() })).rejects.toThrow("unavailable");
  });
  it.each(["write", "close", "size", "marker"])("never publishes a failed %s", async step => {
    failModelWrite = step === "write"; failClose = step === "close"; truncateOnClose = step === "size"; failMarker = step === "marker";
    await expect(importStoredModel({ file: fixture({ name: "failed.gguf" }), onProgress: () => {} })).rejects.toThrow();
    failMarker = false;
    expect(await listStoredModels()).toEqual([]);
    expect((await userFolder()).children.size).toBe(0);
  });
  it("preserves unrelated files on explicit model deletion", async () => {
    const model = await importStoredModel({ file: fixture({ name: "notes.gguf" }), onProgress: () => {} });
    const folder = await modelFolder({ name: "notes.gguf" });
    await folder.getFileHandle("notes.txt", { create: true });
    await removeStoredModel({ id: model.id });
    expect([...folder.children.keys()]).toEqual(["notes.txt"]);
  });
  it("does not overwrite a different file or a marker in the target folder", async () => {
    const folder = await modelFolder({ name: "protected.gguf" });
    await folder.getFileHandle("notes.txt", { create: true });
    await expect(importStoredModel({ file: fixture({ name: "protected.gguf" }), onProgress: () => {} })).rejects.toThrow("duplicate-model");
    expect([...folder.children.keys()]).toEqual(["notes.txt"]);
  });
  it("preserves non-ASCII filenames and uppercase GGUF extensions", async () => {
    const name = "\u30e2\u30c7\u30eb.Q4.GGUF";
    const model = await importStoredModel({ file: fixture({ name }), onProgress: () => {} });
    expect(model.id).toBe(`user/${name.slice(0, -5)}-GGUF/${name}`);
    expect(model.name).toBe(`${name.slice(0, -5)}-GGUF`);
    expect((await (await storedModelHandle({ name: model.name })).getFile()).name).toBe(name);
    expect((await (await storedModelHandle({ name })).getFile()).name).toBe(name);
    expect(await listStoredModels()).toEqual([model]);
  });
  it("cancels the source stream after a write error instead of leaving a reader running", async () => {
    const file = fixture({ name: "local.gguf" }); const cancel = vi.fn();
    const data = new Uint8Array(await file.arrayBuffer());
    const stream = new ReadableStream<Uint8Array<ArrayBuffer>>({ start(controller) {
      controller.enqueue(data);
    }, cancel });
    vi.spyOn(file, "stream").mockReturnValue(stream);
    failModelWrite = true;
    await expect(importStoredModel({ file, onProgress: () => {} })).rejects.toThrow();
    expect(cancel).toHaveBeenCalledOnce();
    expect(await listStoredModels()).toEqual([]);
  });

});

describe('directory model imports', () => {
  it('replaces colons only in a newly imported root name and preserves relative files', async () => {
    const model = await importModelDirectory({ signal: undefined, directory: { name: 'LiquidAI:LFM2.5-VL:GGUF', files: [
      { path: 'weights:original/model.gguf', file: fixture({ name: 'model.gguf' }) },
    ] }, onProgress: () => {} });
    expect(model.id).toBe('LiquidAI_LFM2.5-VL_GGUF'); expect(model.name).toBe(model.id);
    expect(root.children.has('LiquidAI:LFM2.5-VL:GGUF')).toBe(false);
    expect((await storedModelDirectory({ name: model.name })).modelPath).toBe('weights:original/model.gguf');
    expect((await listStoredModels()).map(entry => entry.name)).toEqual([model.name]);
  });
  it('rejects normalized root collisions without replacing existing data', async () => {
    const existing = await root.getDirectoryHandle('owner_model', { create: true });
    const preserved = await existing.getFileHandle('notes.txt', { create: true });
    await expect(importModelDirectory({ signal: undefined, directory: { name: 'owner:model', files: [
      { path: 'model.gguf', file: fixture({ name: 'model.gguf' }) },
    ] }, onProgress: () => {} })).rejects.toThrow('duplicate-model');
    expect(existing.children.get('notes.txt')).toBe(preserved);
    expect(existing.children.size).toBe(1);
  });
  it('continues listing and loading existing roots containing colons', async () => {
    const folder = await root.getDirectoryHandle('owner:model', { create: true });
    (await folder.getFileHandle('model.gguf', { create: true })).content = new Uint8Array(await fixture({ name: 'model.gguf' }).arrayBuffer());
    expect((await listStoredModels()).map(model => model.name)).toEqual(['owner:model']);
    expect((await storedModelDirectory({ name: 'owner:model' })).modelPath).toBe('model.gguf');
    expect(root.children.get('owner:model')).toBe(folder);
    expect(root.children.has('owner_model')).toBe(false);
  });
  it('keeps the dropped root name and nested relative files with no manifest', async () => {
    const model = await importModelDirectory({ signal: undefined, directory: { name: 'my-Qwen-VL-GGUF', files: [
      { path: 'weights/Qwen.gguf', file: fixture({ name: 'Qwen.gguf' }) },
      { path: 'vision/mmproj-BF16.gguf', file: fixture({ name: 'mmproj-BF16.gguf' }) },
      { path: 'README.md', file: new NodeFile(['Model notes'], 'README.md') as unknown as File },
    ] }, onProgress: () => {} });
    expect(model.id).toBe('my-Qwen-VL-GGUF'); expect(model.name).toBe('my-Qwen-VL-GGUF'); expect(model.size).toBe(512);
    const folder = await root.getDirectoryHandle(model.id);
    expect([...folder.children.keys()]).toEqual(['weights', 'vision', 'README.md']);
    const directory = await storedModelDirectory({ name: model.name });
    expect(directory.modelPath).toBe('weights/Qwen.gguf'); expect(directory.projectorPath).toBe('vision/mmproj-BF16.gguf');
    expect(await listStoredModels()).toContainEqual(model);
    await removeStoredModel({ id: model.id }); expect(root.children.has(model.id)).toBe(false);
  });
  it('imports and rediscovers a model with a suffix-named projector', async () => {
    const name = 'gemma-4-26B_q4_0-it-multi';
    const modelPath = 'gemma-4-26B_q4_0-it.gguf'; const projectorPath = 'gemma-4-26B-it-mmproj.gguf';
    const model = await importModelDirectory({ signal: undefined, directory: { name, files: [
      { path: modelPath, file: fixture({ name: modelPath }) },
      { path: projectorPath, file: fixture({ name: projectorPath }) },
    ] }, onProgress: () => {} });
    expect(model.name).toBe(name); expect(model.size).toBe(512);
    expect((await storedModelDirectory({ name })).modelPath).toBe(modelPath);
    expect((await storedModelDirectory({ name })).projectorPath).toBe(projectorPath);
    expect(await listStoredModels()).toEqual([model]);
  });
  it.each(['mmproj-BF16.gguf', 'model-mmproj.gguf', 'model.mmproj.F16.gguf', 'model_MMPROJ_F16.GGUF', 'modelmmprojF16.gguf'])('recognizes a projector regardless of marker placement: %s', projectorPath => {
    expect(resolveModelFiles({ files: [{ path: 'weights/model.gguf' }, { path: `vision/${projectorPath}` }] })).toEqual({ modelPath: 'weights/model.gguf', projectorPath: `vision/${projectorPath}` });
  });
  it('does not classify a model by a marker in its parent directory name', () => {
    expect(resolveModelFiles({ files: [{ path: 'mmproj/model.gguf' }] })).toEqual({ modelPath: 'mmproj/model.gguf', projectorPath: undefined });
  });
  it('rejects mixed projector candidates before writing OPFS and logs only a fixed layout reason', async () => {
    const name = 'private-model-folder';
    await expect(importModelDirectory({ signal: undefined, directory: { name, files: ['private-model.gguf', 'mmproj-first.gguf', 'private-mmproj.gguf'].map(path => ({ path, file: fixture({ name: path }) })) }, onProgress: () => {} })).rejects.toThrow('unsupported-input');
    expect(root.children.has(name)).toBe(false); expect(committed).toEqual([]);
    expect(readDiagnostics({ calls: vi.mocked(console.debug).mock.calls })).toContainEqual(expect.objectContaining({ stage: 'model-resolve', reason: 'model-directory-layout', code: 'unsupported-input' }));
    expect(JSON.stringify(vi.mocked(console.debug).mock.calls)).not.toContain('private');
  });
  it('discovers Explorer-created directories and projector additions without metadata', async () => {
    const folder = await root.getDirectoryHandle('External', { create: true });
    (await folder.getFileHandle('model.gguf', { create: true })).content = new Uint8Array(await fixture({ name: 'model.gguf' }).arrayBuffer());
    expect((await storedModelDirectory({ name: 'External' })).projectorPath).toBeUndefined();
    (await folder.getFileHandle('mmproj.gguf', { create: true })).content = new Uint8Array(await fixture({ name: 'mmproj.gguf' }).arrayBuffer());
    expect((await storedModelDirectory({ name: 'External' })).projectorPath).toBe('mmproj.gguf');
    expect((await listStoredModels()).map(model => model.name)).toEqual(['External']);
  });
  it('requires complete split sets and rejects ambiguous weights or projectors', () => {
    expect(resolveModelFiles({ files: [{ path: 'x/model-00001-of-00002.gguf' }, { path: 'x/model-00002-of-00002.gguf' }] }).modelPath).toBe('x/model-00001-of-00002.gguf');
    for (const paths of [ ['model-00001-of-00002.gguf'], ['a.gguf', 'b.gguf'], ['a.gguf', 'mmproj-a.gguf', 'mmproj-b.gguf'], ['a-00001-of-00002.gguf', 'b-00002-of-00002.gguf'] ]) {
      expect(() => resolveModelFiles({ files: paths.map(path => ({ path })) })).toThrow();
    }
  });
  it('does not overwrite existing root data or import reserved namespaces', async () => {
    const folder = await root.getDirectoryHandle('Existing', { create: true });
    await folder.getFileHandle('notes.txt', { create: true });
    for (const name of ['Existing', 'naidan-storage', 'models', '..', '.hidden', 'a/b']) {
      await expect(importModelDirectory({ signal: undefined, directory: { name, files: [{ path: 'model.gguf', file: fixture({ name: 'model.gguf' }) }] }, onProgress: () => {} })).rejects.toThrow();
    }
    expect([...folder.children.keys()]).toEqual(['notes.txt']);
  });
  it('never publishes partial imports and cleans normal write failures', async () => {
    let observedPending = false;
    await importModelDirectory({ signal: undefined, directory: { name: 'Imported', files: [{ path: 'model.gguf', file: fixture({ name: 'model.gguf' }) }] }, onProgress: () => {
      const folder = root.children.get('Imported');
      observedPending = folder?.kind === 'directory' && folder.children.has('.llama-cpp-import-pending');
    } });
    expect(observedPending).toBe(true);
    failWrite = true;
    await expect(importModelDirectory({ signal: undefined, directory: { name: 'Failed', files: [{ path: 'model.gguf', file: fixture({ name: 'model.gguf' }) }] }, onProgress: () => {} })).rejects.toThrow();
    expect(root.children.has('Failed')).toBe(false);
    const pending = await root.getDirectoryHandle('Pending', { create: true });
    (await pending.getFileHandle('model.gguf', { create: true })).content = new Uint8Array(await fixture({ name: 'model.gguf' }).arrayBuffer());
    await pending.getFileHandle('.llama-cpp-import-pending', { create: true });
    expect((await listStoredModels()).map(model => model.name)).toEqual(['Imported']);
  });
  it('rejects path traversal, duplicates and file/directory collisions before creating a root', async () => {
    for (const paths of [['../model.gguf'], ['/model.gguf'], ['sub\\model.gguf'], ['model.gguf', 'model.gguf'], ['model.gguf', 'model.gguf/other.gguf']]) {
      await expect(importModelDirectory({ signal: undefined, directory: { name: 'Unsafe', files: paths.map(path => ({ path, file: fixture({ name: 'model.gguf' }) })) }, onProgress: () => {} })).rejects.toThrow();
      expect(root.children.has('Unsafe')).toBe(false);
    }
  });
  it('refuses importing a root name that would make a legacy selection ambiguous', async () => {
    await importStoredModel({ file: fixture({ name: 'same.gguf' }), onProgress: () => {} });
    await expect(importModelDirectory({ signal: undefined, directory: { name: 'same-GGUF', files: [{ path: 'other.gguf', file: fixture({ name: 'other.gguf' }) }] }, onProgress: () => {} })).rejects.toThrow('duplicate-model');
    expect(root.children.has('same-GGUF')).toBe(false);
    expect((await storedModelDirectory({ name: 'same-GGUF' })).modelPath).toBe('same.gguf');
  });
  it('cooperatively cancels and removes a partially written directory', async () => {
    const controller = new AbortController();
    await expect(importModelDirectory({ signal: controller.signal, directory: { name: 'Cancelled', files: [{ path: 'model.gguf', file: fixture({ name: 'model.gguf' }) }] }, onProgress: () => controller.abort() })).rejects.toThrow('aborted');
    expect(root.children.has('Cancelled')).toBe(false);
  });
});
