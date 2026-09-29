import { readDiagnostics } from '@/features/llama-cpp-browser/test-utils/diagnostics';
import { importModelDirectory, resolveModelFiles } from './model-directory';
import { File as NodeFile } from 'node:buffer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { importStoredModel, listStoredModels, planStoredModelRemoval, removeStoredModel, storedModelDirectory, withModelStoreLock } from './model-store';

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
      if (failMarker && name === '.llama-cpp-import-pending') throw new DOMException('private marker details', 'QuotaExceededError');
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
  vi.spyOn(console, 'log').mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks(); vi.unstubAllGlobals();
});

async function userFolder(): Promise<StoredDirectory> {
  return (await root.getDirectoryHandle("models", { create: true })).getDirectoryHandle("user", { create: true });
}
async function modelFolder({ name }: { name: string }): Promise<StoredDirectory> {
  return (await userFolder()).getDirectoryHandle(`${name.slice(0, -5)}-GGUF`, { create: true });
}
async function putModelFile({ name }: { name: string }): Promise<StoredDirectory> {
  const folder = await modelFolder({ name });
  (await folder.getFileHandle(name, { create: true })).content = new Uint8Array(await fixture({ name }).arrayBuffer());
  return folder;
}
async function selectedFile({ name }: { name: string }): Promise<FileSystemFileHandle> {
  const directory = await storedModelDirectory({ name });
  const file = directory.files.find(file => file.path === directory.modelPath);
  if (!file) throw new Error('Missing selected file');
  return file.handle;
}
describe("local GGUF model store", () => {
  it("streams the original filename into a readable tree and publishes only after close", async () => {
    const file = fixture({ name: "local.gguf" });
    const wholeFile = vi.spyOn(file, "arrayBuffer").mockRejectedValue(new Error("Do not buffer the full model"));
    const progress = vi.fn();
    const model = await withModelStoreLock({ operation: () => importStoredModel({ signal: undefined, file, onProgress: progress }) });
    expect(wholeFile).not.toHaveBeenCalled();
    expect(committed).toEqual(["local.gguf"]);
    expect(model.id).toBe("user/local-GGUF");
    expect(model.name).toBe("local-GGUF"); expect(model.size).toBe(256);
    expect(model.importedAt).toBe(123);
    const folder = await modelFolder({ name: file.name });
    expect([...folder.children.keys()]).toEqual(["local.gguf"]);
    expect(await listStoredModels()).toEqual([{ ...model, name: `user/${model.name}` }]);
    expect((await (await selectedFile({ name: model.id })).getFile()).size).toBe(256);
    expect((await (await selectedFile({ name: model.id })).getFile()).name).toBe(file.name);
    expect(progress).toHaveBeenLastCalledWith({ progress: { phase: "importing", completed: 256, total: 256 } });
  });
  it("rejects an ambiguous directory rather than selecting an arbitrary base file", async () => {
    await importStoredModel({ signal: undefined, file: fixture({ name: "local.gguf" }), onProgress: () => {} });
    const folder = await modelFolder({ name: "local.gguf" });
    (await folder.getFileHandle("local.GGUF", { create: true })).content = new Uint8Array(await fixture({ name: "local.GGUF" }).arrayBuffer());
    await expect(selectedFile({ name: "user/local-GGUF" })).rejects.toThrow("unsupported-input");
    expect(await listStoredModels()).toEqual([]);
  });
  it("rejects invalid GGUF magic or version without publishing", async () => {
    for (const bytes of [new Uint8Array(40), new Uint8Array([71, 71, 85, 70, 9, 0, 0, 0, ...Array<number>(40).fill(0)])]) {
      await expect(importStoredModel({ signal: undefined, file: new NodeFile([bytes], "invalid.gguf") as unknown as File, onProgress: () => {} })).rejects.toThrow("invalid-gguf");
    }
    expect(await listStoredModels()).toEqual([]);
  });
  it("rejects completed duplicate names without replacing the file", async () => {
    await importStoredModel({ signal: undefined, file: fixture({ name: "same.gguf" }), onProgress: () => {} });
    const folder = await modelFolder({ name: "same.gguf" }); const before = folder.children.get("same.gguf");
    await expect(importStoredModel({ signal: undefined, file: fixture({ name: "same.gguf" }), onProgress: () => {} })).rejects.toThrow("duplicate-model");
    expect(folder.children.get("same.gguf")).toBe(before);
    expect(await listStoredModels()).toHaveLength(1);
  });
  it("removes failed import data and does not log user-controlled names or errors", async () => {
    failWrite = true;
    await expect(importStoredModel({ signal: undefined, file: fixture({ name: "private.gguf" }), onProgress: () => {} })).rejects.toThrow();
    failWrite = false;
    expect(await listStoredModels()).toEqual([]);
    expect((await userFolder()).children.size).toBe(0);
    expect(JSON.stringify(vi.mocked(console.log).mock.calls)).not.toContain("private");
  });
  it("leaves pending imports intact during discovery instead of repairing or deleting them", async () => {
    const folder = await putModelFile({ name: "interrupted.gguf" });
    await folder.getFileHandle(".llama-cpp-import-pending", { create: true });
    await root.getDirectoryHandle("other-feature", { create: true });
    expect(await listStoredModels()).toEqual([]);
    expect(folder.children.has("interrupted.gguf")).toBe(true);
    expect(folder.children.has(".llama-cpp-import-pending")).toBe(true);
    expect(root.children.has("other-feature")).toBe(true);
  });
  it("reimports an incomplete directory only after explicit planned deletion", async () => {
    const folder = await modelFolder({ name: "retry.gguf" });
    (await folder.getFileHandle("retry.gguf", { create: true })).content = new Uint8Array([1]);
    await folder.getFileHandle(".llama-cpp-import-pending", { create: true });
    await expect(importStoredModel({ signal: undefined, file: fixture({ name: "retry.gguf" }), onProgress: () => {} })).rejects.toThrow("duplicate-model");
    await removeStoredModel({ plan: await planStoredModelRemoval({ id: "user/retry-GGUF" }) });
    const model = await importStoredModel({ signal: undefined, file: fixture({ name: "retry.gguf" }), onProgress: () => {} });
    expect(await listStoredModels()).toEqual([{ ...model, name: `user/${model.name}` }]);
    expect((await (await modelFolder({ name: "retry.gguf" })).getFileHandle("retry.gguf")).content.length).toBe(256);
  });
  it("rejects unsafe names and deletion paths without escaping the model root", async () => {
    for (const name of ["../local.gguf", "dir/local.gguf", "dir\\local.gguf", ".gguf", "local.bin", "a\u0000.gguf", "a".repeat(251) + ".gguf"]) {
      await expect(importStoredModel({ signal: undefined, file: fixture({ name }), onProgress: () => {} })).rejects.toThrow("invalid-gguf");
    }
    const model = await importStoredModel({ signal: undefined, file: fixture({ name: "local.gguf" }), onProgress: () => {} });
    for (const id of ["../other-feature", "other/local-GGUF/local.gguf", "user/../local.gguf", model.id + "/extra"]) {
      await expect(removeStoredModel({ plan: { id, files: [] } })).rejects.toThrow();
    }
    expect(await listStoredModels()).toEqual([{ ...model, name: `user/${model.name}` }]);
    await removeStoredModel({ plan: await planStoredModelRemoval({ id: model.id }) });
    expect(await listStoredModels()).toEqual([]);
    await expect(selectedFile({ name: model.id })).rejects.toThrow("missing-model");
  });
  it("does not expose a directory with a truncated or invalid GGUF header", async () => {
    await importStoredModel({ signal: undefined, file: fixture({ name: "truncated.gguf" }), onProgress: () => {} });
    const folder = await modelFolder({ name: "truncated.gguf" });
    (await folder.getFileHandle("truncated.gguf")).content = new Uint8Array(1);
    expect(await listStoredModels()).toEqual([]);
    expect(folder.children.has("truncated.gguf")).toBe(true);
    await expect(selectedFile({ name: "user/truncated-GGUF" })).rejects.toThrow("invalid-gguf");
  });
  it("rediscovers plain files after module reload without touching other files in the shared models root", async () => {
    const sibling = await root.getDirectoryHandle("models", { create: true });
    const other = await sibling.getFileHandle("other-runtime.bin", { create: true }); other.content = new Uint8Array([1, 2, 3]);
    const model = await importStoredModel({ signal: undefined, file: fixture({ name: "persistent.gguf" }), onProgress: () => {} });
    vi.resetModules(); const reloaded = await import("./model-store");
    expect(await reloaded.listStoredModels()).toEqual([{ ...model, name: `user/${model.name}` }]);
    expect((await (await selectedFile({ name: model.id })).getFile()).size).toBe(256);
    expect(root.children.has("llama-cpp-browser-models-v1")).toBe(false);
    expect(other.content).toEqual(new Uint8Array([1, 2, 3]));
  });
  it("discovers externally added files without permanent markers or a registry", async () => {
    expect(await listStoredModels()).toEqual([]);
    const folder = await putModelFile({ name: "external.gguf" });
    expect(await listStoredModels()).toEqual([{ id: "user/external-GGUF", name: "user/external-GGUF", size: 256, importedAt: 123 }]);
    await folder.getFileHandle(".llama-cpp-import-pending", { create: true });
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
    await importStoredModel({ signal: undefined, file: fixture({ name: "new.gguf" }), onProgress: () => {} });
    expect((await listStoredModels()).map(model => model.name)).toEqual(["user/new-GGUF"]);
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
    await expect(importStoredModel({ signal: undefined, file: fixture({ name: "failed.gguf" }), onProgress: () => {} })).rejects.toThrow();
    failMarker = false;
    expect(await listStoredModels()).toEqual([]);
    expect((await userFolder()).children.size).toBe(0);
  });
  it("preserves files added after a deletion plan was confirmed", async () => {
    const model = await importStoredModel({ signal: undefined, file: fixture({ name: "notes.gguf" }), onProgress: () => {} });
    const folder = await modelFolder({ name: "notes.gguf" });
    const plan = await planStoredModelRemoval({ id: model.id });
    await folder.getFileHandle("extra.gguf", { create: true });
    expect(await removeStoredModel({ plan })).toBe("changed");
    expect([...folder.children.keys()]).toEqual(["notes.gguf", "extra.gguf"]);
  });
  it("does not overwrite a different file or a marker in the target folder", async () => {
    const folder = await modelFolder({ name: "protected.gguf" });
    await folder.getFileHandle("notes.txt", { create: true });
    await expect(importStoredModel({ signal: undefined, file: fixture({ name: "protected.gguf" }), onProgress: () => {} })).rejects.toThrow("duplicate-model");
    expect([...folder.children.keys()]).toEqual(["notes.txt"]);
  });
  it("preserves non-ASCII filenames and uppercase GGUF extensions", async () => {
    const name = "\u30e2\u30c7\u30eb.Q4.GGUF";
    const model = await importStoredModel({ signal: undefined, file: fixture({ name }), onProgress: () => {} });
    expect(model.id).toBe(`user/${name.slice(0, -5)}-GGUF`);
    expect(model.name).toBe(`${name.slice(0, -5)}-GGUF`);
    expect((await (await selectedFile({ name: model.id })).getFile()).name).toBe(name);
    expect(await listStoredModels()).toEqual([{ ...model, name: `user/${model.name}` }]);
  });
  it('accepts a 255-byte filename without reserving space for a permanent marker', async () => {
    const name = `${'a'.repeat(250)}.gguf`;
    const model = await importStoredModel({ signal: undefined, file: fixture({ name }), onProgress: () => {} });
    expect([...((await modelFolder({ name })).children.keys())]).toEqual([name]);
    expect((await storedModelDirectory({ name: model.id })).modelPath).toBe(name);
  });
  it("cancels the source stream after a write error instead of leaving a reader running", async () => {
    const file = fixture({ name: "local.gguf" }); const cancel = vi.fn();
    const data = new Uint8Array(await file.arrayBuffer());
    const stream = new ReadableStream<Uint8Array<ArrayBuffer>>({ start(controller) {
      controller.enqueue(data);
    }, cancel });
    vi.spyOn(file, "stream").mockReturnValue(stream);
    failModelWrite = true;
    await expect(importStoredModel({ signal: undefined, file, onProgress: () => {} })).rejects.toThrow();
    expect(cancel).toHaveBeenCalledOnce();
    expect(await listStoredModels()).toEqual([]);
  });

});

describe('directory model imports', () => {
  it('uses the same directory identifier for folder and single-file imports', async () => {
    await importModelDirectory({ signal: undefined, directory: { name: 'Local', files: [{ path: 'model.gguf', file: fixture({ name: 'model.gguf' }) }] }, onProgress: () => {} });
    expect((await storedModelDirectory({ name: 'user/Local' })).id).toBe('user/Local');
    const legacy = await importStoredModel({ signal: undefined, file: fixture({ name: 'legacy.gguf' }), onProgress: () => {} });
    expect(legacy.id).toBe('user/legacy-GGUF');
    expect((await storedModelDirectory({ name: legacy.id })).id).toBe(legacy.id);
  });
  it('lists HF models in their own namespace and scans Explorer changes without a journal', async () => {
    let folder = root;
    for (const name of ['models', 'huggingface.co', 'owner', 'repo', 'resolve', 'main']) folder = await folder.getDirectoryHandle(name, { create: true });
    (await folder.getFileHandle('model.gguf', { create: true })).content = new Uint8Array(await fixture({ name: 'model.gguf' }).arrayBuffer());
    expect((await listStoredModels()).map(model => model.name)).toEqual(['hf.co/owner/repo:model']);
    expect((await storedModelDirectory({ name: 'hf.co/owner/repo' })).projectorPath).toBeUndefined();
    (await folder.getFileHandle('mmproj.gguf', { create: true })).content = new Uint8Array(await fixture({ name: 'mmproj.gguf' }).arrayBuffer());
    expect((await storedModelDirectory({ name: 'hf.co/owner/repo' })).projectorPath).toBe('mmproj.gguf');
  });
  it('replaces colons only in a newly imported root name and preserves relative files', async () => {
    const model = await importModelDirectory({ signal: undefined, directory: { name: 'LiquidAI:LFM2.5-VL:GGUF', files: [
      { path: 'weights:original/model.gguf', file: fixture({ name: 'model.gguf' }) },
    ] }, onProgress: () => {} });
    expect(model.id).toBe('user/LiquidAI_LFM2.5-VL_GGUF'); expect(model.name).toBe('LiquidAI_LFM2.5-VL_GGUF');
    expect(root.children.has('LiquidAI:LFM2.5-VL:GGUF')).toBe(false);
    expect((await storedModelDirectory({ name: model.id })).modelPath).toBe('weights:original/model.gguf');
    expect((await listStoredModels()).map(entry => entry.name)).toEqual([`user/${model.name}`]);
  });
  it('rejects normalized root collisions without replacing existing data', async () => {
    const existing = await (await userFolder()).getDirectoryHandle('owner_model', { create: true });
    const preserved = await existing.getFileHandle('notes.txt', { create: true });
    await expect(importModelDirectory({ signal: undefined, directory: { name: 'owner:model', files: [
      { path: 'model.gguf', file: fixture({ name: 'model.gguf' }) },
    ] }, onProgress: () => {} })).rejects.toThrow('duplicate-model');
    expect(existing.children.get('notes.txt')).toBe(preserved);
    expect(existing.children.size).toBe(1);
  });
  it('ignores old OPFS-root models and leaves them untouched when importing the same name', async () => {
    const folder = await root.getDirectoryHandle('Same', { create: true });
    const oldFile = await folder.getFileHandle('old.gguf', { create: true });
    oldFile.content = new Uint8Array(await fixture({ name: 'old.gguf' }).arrayBuffer());
    expect(await listStoredModels()).toEqual([]);
    await expect(storedModelDirectory({ name: 'Same' })).rejects.toThrow();
    await expect(planStoredModelRemoval({ id: 'Same' })).rejects.toThrow('missing-model');
    const model = await importModelDirectory({ signal: undefined, directory: { name: 'Same', files: [{ path: 'new.gguf', file: fixture({ name: 'new.gguf' }) }] }, onProgress: () => {} });
    expect((await storedModelDirectory({ name: 'user/Same' })).modelPath).toBe('new.gguf');
    expect(await listStoredModels()).toEqual([{ ...model, name: 'user/Same' }]);
    await removeStoredModel({ plan: await planStoredModelRemoval({ id: model.id }) });
    expect(root.children.get('Same')).toBe(folder);
    expect(folder.children.get('old.gguf')).toBe(oldFile);
    expect(oldFile.content).toEqual(new Uint8Array(await fixture({ name: 'old.gguf' }).arrayBuffer()));
  });
  it('keeps the dropped root name and nested relative files with no manifest', async () => {
    const model = await importModelDirectory({ signal: undefined, directory: { name: 'my-Qwen-VL-GGUF', files: [
      { path: 'weights/Qwen.gguf', file: fixture({ name: 'Qwen.gguf' }) },
      { path: 'vision/mmproj-BF16.gguf', file: fixture({ name: 'mmproj-BF16.gguf' }) },
      { path: 'README.md', file: new NodeFile(['Model notes'], 'README.md') as unknown as File },
    ] }, onProgress: () => {} });
    expect(model.id).toBe('user/my-Qwen-VL-GGUF'); expect(model.name).toBe('my-Qwen-VL-GGUF'); expect(model.size).toBe(512);
    const user = await userFolder(); const folder = await user.getDirectoryHandle(model.name);
    expect(root.children.has(model.name)).toBe(false);
    expect([...folder.children.keys()]).toEqual(['weights', 'vision', 'README.md']);
    const directory = await storedModelDirectory({ name: model.id });
    expect(directory.modelPath).toBe('weights/Qwen.gguf'); expect(directory.projectorPath).toBe('vision/mmproj-BF16.gguf');
    expect(await listStoredModels()).toContainEqual({ ...model, name: `user/${model.name}` });
    const plan = await planStoredModelRemoval({ id: model.id });
    await removeStoredModel({ plan }); expect([...folder.children.keys()]).toEqual(['README.md']);
  });
  it('imports and rediscovers a model with a suffix-named projector', async () => {
    const name = 'gemma-4-26B_q4_0-it-multi';
    const modelPath = 'gemma-4-26B_q4_0-it.gguf'; const projectorPath = 'gemma-4-26B-it-mmproj.gguf';
    const model = await importModelDirectory({ signal: undefined, directory: { name, files: [
      { path: modelPath, file: fixture({ name: modelPath }) },
      { path: projectorPath, file: fixture({ name: projectorPath }) },
    ] }, onProgress: () => {} });
    expect(model.name).toBe(name); expect(model.size).toBe(512);
    expect((await storedModelDirectory({ name: `user/${name}` })).modelPath).toBe(modelPath);
    expect((await storedModelDirectory({ name: `user/${name}` })).projectorPath).toBe(projectorPath);
    expect(await listStoredModels()).toEqual([{ ...model, name: `user/${model.name}` }]);
  });
  it.each(['mmproj-BF16.gguf', 'model-mmproj.gguf', 'model.mmproj.F16.gguf', 'model_MMPROJ_F16.GGUF', 'modelmmprojF16.gguf'])('recognizes a projector regardless of marker placement: %s', projectorPath => {
    expect(resolveModelFiles({ files: [{ path: 'weights/model.gguf' }, { path: `vision/${projectorPath}` }] })).toEqual({ modelPath: 'weights/model.gguf', projectorPath: `vision/${projectorPath}` });
  });
  it('does not classify a model by a marker in its parent directory name', () => {
    expect(resolveModelFiles({ files: [{ path: 'mmproj/model.gguf' }] })).toEqual({ modelPath: 'mmproj/model.gguf', projectorPath: undefined });
  });
  it('rejects mixed base model candidates before writing OPFS and logs only a fixed layout reason', async () => {
    const name = 'private-model-folder';
    await expect(importModelDirectory({ signal: undefined, directory: { name, files: ['private-model.gguf', 'another-private-model.gguf', 'mmproj-first.gguf'].map(path => ({ path, file: fixture({ name: path }) })) }, onProgress: () => {} })).rejects.toThrow('unsupported-input');
    expect(root.children.has(name)).toBe(false); expect(committed).toEqual([]);
    expect(readDiagnostics({ calls: vi.mocked(console.log).mock.calls })).toContainEqual(expect.objectContaining({ stage: 'model-resolve', reason: 'model-directory-layout', code: 'unsupported-input' }));
    expect(JSON.stringify(vi.mocked(console.log).mock.calls)).not.toContain('private');
  });
  it('rediscovers projector additions in the imported user directory without layout metadata', async () => {
    await importModelDirectory({ signal: undefined, directory: { name: 'External', files: [{ path: 'model.gguf', file: fixture({ name: 'model.gguf' }) }] }, onProgress: () => {} });
    const folder = await (await userFolder()).getDirectoryHandle('External');
    expect((await storedModelDirectory({ name: 'user/External' })).projectorPath).toBeUndefined();
    (await folder.getFileHandle('mmproj.gguf', { create: true })).content = new Uint8Array(await fixture({ name: 'mmproj.gguf' }).arrayBuffer());
    expect((await storedModelDirectory({ name: 'user/External' })).projectorPath).toBe('mmproj.gguf');
    expect((await listStoredModels()).map(model => model.name)).toEqual(['user/External']);
  });
  it('requires complete split sets and rejects ambiguous weights', () => {
    expect(resolveModelFiles({ files: [{ path: 'x/model-00001-of-00002.gguf' }, { path: 'x/model-00002-of-00002.gguf' }] }).modelPath).toBe('x/model-00001-of-00002.gguf');
    for (const paths of [ ['model-00001-of-00002.gguf'], ['a.gguf', 'b.gguf'], ['a-00001-of-00002.gguf', 'b-00002-of-00002.gguf'] ]) {
      expect(() => resolveModelFiles({ files: paths.map(path => ({ path })) })).toThrow();
    }
  });
  it('does not overwrite existing user data or import unsafe directory names', async () => {
    const folder = await (await userFolder()).getDirectoryHandle('Existing', { create: true });
    await folder.getFileHandle('notes.txt', { create: true });
    for (const name of ['Existing', '..', '.hidden', 'a/b']) {
      await expect(importModelDirectory({ signal: undefined, directory: { name, files: [{ path: 'model.gguf', file: fixture({ name: 'model.gguf' }) }] }, onProgress: () => {} })).rejects.toThrow();
    }
    expect([...folder.children.keys()]).toEqual(['notes.txt']);
  });
  it('accepts names reserved by unrelated OPFS-root features inside the user namespace', async () => {
    const other = await root.getDirectoryHandle('models', { create: true });
    const untouched = await other.getFileHandle('other-runtime.bin', { create: true });
    const model = await importModelDirectory({ signal: undefined, directory: { name: 'models', files: [
      { path: 'weights/model-00001-of-00002.gguf', file: fixture({ name: 'model-00001-of-00002.gguf' }) },
      { path: 'weights/model-00002-of-00002.gguf', file: fixture({ name: 'model-00002-of-00002.gguf' }) },
    ] }, onProgress: () => {} });
    expect(model.id).toBe('user/models');
    const directory = await storedModelDirectory({ name: model.id });
    expect(directory.files).toHaveLength(2);
    expect(directory.modelPath).toBe('weights/model-00001-of-00002.gguf');
    expect(other.children.get('other-runtime.bin')).toBe(untouched);
  });
  it('rejects a user-namespace file with the target directory name without replacing it', async () => {
    const user = await userFolder(); const existing = await user.getFileHandle('Existing', { create: true });
    await expect(importModelDirectory({ signal: undefined, directory: { name: 'Existing', files: [{ path: 'model.gguf', file: fixture({ name: 'model.gguf' }) }] }, onProgress: () => {} })).rejects.toThrow('duplicate-model');
    expect(user.children.get('Existing')).toBe(existing);
  });
  it('never publishes partial imports and cleans normal write failures', async () => {
    let observedPending = false; const user = await userFolder();
    await importModelDirectory({ signal: undefined, directory: { name: 'Imported', files: [{ path: 'model.gguf', file: fixture({ name: 'model.gguf' }) }] }, onProgress: () => {
      const folder = user.children.get('Imported');
      observedPending = folder?.kind === 'directory' && folder.children.has('.llama-cpp-import-pending');
    } });
    expect(observedPending).toBe(true);
    failWrite = true;
    await expect(importModelDirectory({ signal: undefined, directory: { name: 'Failed', files: [{ path: 'model.gguf', file: fixture({ name: 'model.gguf' }) }] }, onProgress: () => {} })).rejects.toThrow();
    expect(user.children.has('Failed')).toBe(false);
    const pending = await user.getDirectoryHandle('Pending', { create: true });
    (await pending.getFileHandle('model.gguf', { create: true })).content = new Uint8Array(await fixture({ name: 'model.gguf' }).arrayBuffer());
    await pending.getFileHandle('.llama-cpp-import-pending', { create: true });
    expect((await listStoredModels()).map(model => model.name)).toEqual(['user/Imported']);
  });
  it('rejects path traversal, duplicates and file/directory collisions before creating a model directory', async () => {
    for (const paths of [['../model.gguf'], ['/model.gguf'], ['sub\\model.gguf'], ['model.gguf', 'model.gguf'], ['model.gguf', 'model.gguf/other.gguf'], ['model.gguf', '.llama-cpp-import-pending'], ['model.gguf', '.llama-cpp-import-pending/nested']]) {
      await expect(importModelDirectory({ signal: undefined, directory: { name: 'Unsafe', files: paths.map(path => ({ path, file: fixture({ name: 'model.gguf' }) })) }, onProgress: () => {} })).rejects.toThrow();
      expect(root.children.has('Unsafe')).toBe(false);
    }
  });
  it('refuses importing a root name that would make a legacy selection ambiguous', async () => {
    await importStoredModel({ signal: undefined, file: fixture({ name: 'same.gguf' }), onProgress: () => {} });
    await expect(importModelDirectory({ signal: undefined, directory: { name: 'same-GGUF', files: [{ path: 'other.gguf', file: fixture({ name: 'other.gguf' }) }] }, onProgress: () => {} })).rejects.toThrow('duplicate-model');
    expect(root.children.has('same-GGUF')).toBe(false);
    expect((await storedModelDirectory({ name: 'user/same-GGUF' })).modelPath).toBe('same.gguf');
  });
  it('cooperatively cancels and removes a partially written directory', async () => {
    const controller = new AbortController();
    await expect(importModelDirectory({ signal: controller.signal, directory: { name: 'Cancelled', files: [{ path: 'model.gguf', file: fixture({ name: 'model.gguf' }) }] }, onProgress: () => controller.abort() })).rejects.toThrow('aborted');
    expect((await userFolder()).children.has('Cancelled')).toBe(false);
  });
});


describe('cancelled local imports and explicit retries', () => {
  it('rolls back a single-file import before accepting the same file again', async () => {
    const file = fixture({ name: 'cancel-and-retry.gguf' }); const controller = new AbortController();
    await expect(importStoredModel({ file, signal: controller.signal, onProgress: () => controller.abort() })).rejects.toThrow('aborted');
    expect((await userFolder()).children.size).toBe(0);
    expect(await listStoredModels()).toEqual([]);
    expect(committed).toEqual([]);
    const model = await importStoredModel({ file, signal: undefined, onProgress: () => {} });
    expect(model.id).toBe('user/cancel-and-retry-GGUF');
    expect((await listStoredModels()).map(entry => entry.id)).toEqual([model.id]);
  });
  it('wakes a pending source read on cancel and releases the reader before retry', async () => {
    const file = fixture({ name: 'blocked.gguf' }); const controller = new AbortController();
    const entered = Promise.withResolvers<void>(); const cancel = vi.fn();
    const stream = new ReadableStream<Uint8Array<ArrayBuffer>>({ pull() {
      entered.resolve();
    }, cancel }, { highWaterMark: 0 });
    const source = vi.spyOn(file, 'stream').mockReturnValue(stream);
    const pending = importStoredModel({ file, signal: controller.signal, onProgress: () => {} });
    const rejected = expect(pending).rejects.toThrow('aborted');
    await entered.promise; controller.abort(); await rejected;
    expect(cancel).toHaveBeenCalledOnce(); expect(stream.locked).toBe(false);
    expect((await userFolder()).children.size).toBe(0);
    source.mockRestore();
    await expect(importStoredModel({ file, signal: undefined, onProgress: () => {} })).resolves.toMatchObject({ id: 'user/blocked-GGUF' });
  });
  it('rolls back closed files as well as the current nested file when cancelling a folder', async () => {
    const directory = { name: 'Cancelled folder', files: [
      { path: 'weights/model.gguf', file: fixture({ name: 'model.gguf' }) },
      { path: 'vision/mmproj.gguf', file: fixture({ name: 'mmproj.gguf' }) },
    ] };
    const controller = new AbortController();
    await expect(importModelDirectory({ directory, signal: controller.signal, onProgress: ({ progress }) => {
      if (progress.completed > 256) controller.abort();
    } })).rejects.toThrow('aborted');
    expect(committed).toEqual(['model.gguf']);
    expect((await userFolder()).children.has(directory.name)).toBe(false);
    const model = await importModelDirectory({ directory, signal: undefined, onProgress: () => {} });
    expect((await storedModelDirectory({ name: model.id })).files).toHaveLength(2);
  });
  it('does not create or recover a directory for an already cancelled request', async () => {
    const folder = await modelFolder({ name: 'cancelled.gguf' });
    await folder.getFileHandle('.llama-cpp-import-pending', { create: true });
    const controller = new AbortController(); controller.abort();
    await expect(importStoredModel({ file: fixture({ name: 'cancelled.gguf' }), signal: controller.signal, onProgress: () => {} })).rejects.toThrow('aborted');
    expect([...folder.children.keys()]).toEqual(['.llama-cpp-import-pending']);
    expect((await userFolder()).children.get('cancelled-GGUF')).toBe(folder);
  });
  it.each(['marker-only', 'empty-destination'] as const)('reclaims a legacy %s leftover only when the same model is explicitly imported', async residue => {
    const file = fixture({ name: 'old-cancel.gguf' }); const folder = await modelFolder({ name: file.name });
    await folder.getFileHandle('.llama-cpp-import-pending', { create: true });
    switch (residue) {
    case 'marker-only': break;
    case 'empty-destination': await folder.getFileHandle(file.name, { create: true }); break;
    default: { const exhaustive: never = residue; throw new Error(String(exhaustive)); }
    }
    const before = [...folder.children.keys()];
    expect(await listStoredModels()).toEqual([]); expect([...folder.children.keys()]).toEqual(before);
    const model = await importStoredModel({ file, signal: undefined, onProgress: () => {} });
    const current = await modelFolder({ name: file.name });
    expect([...current.children.keys()]).toEqual([file.name]);
    expect((await current.getFileHandle(file.name)).content).toEqual(new Uint8Array(await file.arrayBuffer()));
    expect((await listStoredModels()).map(entry => entry.id)).toEqual([model.id]);
  });
  it('reclaims empty interrupted nested destinations belonging to the explicit folder input', async () => {
    const user = await userFolder(); const folder = await user.getDirectoryHandle('Nested', { create: true });
    await folder.getFileHandle('.llama-cpp-import-pending', { create: true });
    const nested = await folder.getDirectoryHandle('weights', { create: true });
    await nested.getFileHandle('model.gguf', { create: true });
    const model = await importModelDirectory({ directory: { name: 'Nested', files: [{ path: 'weights/model.gguf', file: fixture({ name: 'model.gguf' }) }] }, signal: undefined, onProgress: () => {} });
    expect((await storedModelDirectory({ name: model.id })).modelPath).toBe('weights/model.gguf');
  });
  it.each(['missing-marker', 'nonempty-marker', 'partial-file', 'complete-file', 'unrelated-file', 'unrelated-directory', 'marker-directory'] as const)('never treats %s as disposable cancellation residue', async residue => {
    const file = fixture({ name: 'protected.gguf' }); const folder = await modelFolder({ name: file.name });
    const marker = await folder.getFileHandle('.llama-cpp-import-pending', { create: true });
    const target = await folder.getFileHandle(file.name, { create: true });
    switch (residue) {
    case 'missing-marker': folder.children.delete('.llama-cpp-import-pending'); break;
    case 'nonempty-marker': marker.content = new Uint8Array([1]); break;
    case 'partial-file': target.content = new Uint8Array([1]); break;
    case 'complete-file': target.content = new Uint8Array(await file.arrayBuffer()); break;
    case 'unrelated-file': await folder.getFileHandle('notes.txt', { create: true }); break;
    case 'unrelated-directory': await folder.getDirectoryHandle('unrelated', { create: true }); break;
    case 'marker-directory': folder.children.delete('.llama-cpp-import-pending'); await folder.getDirectoryHandle('.llama-cpp-import-pending', { create: true }); break;
    default: { const exhaustive: never = residue; throw new Error(String(exhaustive)); }
    }
    const entries = [...folder.children.entries()]; const bytes = target.content.slice();
    const remove = vi.spyOn(folder, 'removeEntry');
    await expect(importStoredModel({ file, signal: undefined, onProgress: () => {} })).rejects.toThrow('duplicate-model');
    expect(remove).not.toHaveBeenCalled(); expect([...folder.children.entries()]).toEqual(entries);
    expect(target.content).toEqual(bytes);
  });
  it('does not recursively sweep files added while reclaiming empty cancellation residue', async () => {
    const file = fixture({ name: 'race.gguf' }); const folder = await modelFolder({ name: file.name });
    await folder.getFileHandle('.llama-cpp-import-pending', { create: true });
    await folder.getFileHandle(file.name, { create: true });
    const user = await userFolder(); const remove = user.removeEntry.bind(user);
    const removal = vi.spyOn(user, 'removeEntry').mockImplementationOnce(async (name, options) => {
      (await folder.getFileHandle('external.txt', { create: true })).content = new Uint8Array([1, 2, 3]);
      return remove(name, options);
    });
    await expect(importStoredModel({ file, signal: undefined, onProgress: () => {} })).rejects.toThrow('duplicate-model');
    expect(removal).toHaveBeenCalledWith('race-GGUF');
    expect((await folder.getFileHandle('external.txt')).content).toEqual(new Uint8Array([1, 2, 3]));
    expect(user.children.get('race-GGUF')).toBe(folder);
  });
});
