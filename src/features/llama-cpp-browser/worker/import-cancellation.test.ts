import { File as NodeFile, Blob as NodeBlob } from 'node:buffer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WorkerServerApi } from '@/utils/worker-transport';
import { memoryDirectory, ggufBytes } from '@/features/llama-cpp-browser/hugging-face/test-opfs';
import { llamaCppBrowserService } from '@/features/llama-cpp-browser/index-hosted';
import { createWorkerApi } from './api';
import type { LlamaCppWorkerApi } from './types';

// Keep the real service, session client, Worker API and importer connected. Only
// Worker transport and storage are in-memory: this catches cancellation wiring
// regressions that a manager test with a mocked importModel() cannot observe.
const transport = vi.hoisted(() => ({ remote: undefined as WorkerServerApi<LlamaCppWorkerApi> | undefined, release: vi.fn() }));
vi.mock('@/utils/worker-transport', async importOriginal => ({ ...await importOriginal<typeof import('@/utils/worker-transport')>(), wrapWorkerRemote: () => transport.remote,
  releaseWorkerRemote: transport.release, workerProxy: ({ value }: { value: unknown }) => value }));
vi.mock('@/features/llama-cpp-browser/runtime/detect-profile', () => ({ probeRuntimeProfiles: vi.fn() }));
vi.mock('./session', () => ({ invalidateStoredModel: vi.fn(), releaseSession: vi.fn() }));
vi.mock('./generation', () => ({ generate: vi.fn() }));
class TestWorker extends EventTarget {
  static instances: TestWorker[] = [];
  terminate = vi.fn();
  constructor() {
    super(); TestWorker.instances.push(this);
  }
}
let root: ReturnType<typeof memoryDirectory>;
function modelFile({ name }: { name: string }): File {
  // The directory schema captured JSDOM's File constructor at module load.
  // Keep that identity; only the byte/stream operations use real native Blob data.
  const file = new File([ggufBytes()], name);
  const source = new NodeFile([ggufBytes()], name);
  Object.defineProperties(file, {
    stream: { value: () => source.stream() },
    slice: { value: source.slice.bind(source) },
    arrayBuffer: { value: () => source.arrayBuffer() },
    text: { value: () => source.text() },
  });
  return file;
}
async function userFolder() {
  return (await root.getDirectoryHandle('models', { create: true })).getDirectoryHandle('user', { create: true });
}
beforeEach(() => {
  vi.clearAllMocks(); TestWorker.instances = []; root = memoryDirectory({ name: '' });
  vi.stubGlobal('Worker', TestWorker);
  vi.stubGlobal('Blob', NodeBlob);
  vi.stubGlobal('navigator', { storage: { getDirectory: async () => root }, locks: { request: async (_name: string, operation: () => Promise<unknown>) => operation() } });
  vi.spyOn(console, 'log').mockImplementation(() => {});
  transport.remote = createWorkerApi();
});
afterEach(() => {
  llamaCppBrowserService.release(); vi.restoreAllMocks(); vi.unstubAllGlobals();
});

describe('local import cancellation through service and Worker boundaries', () => {
  it.each(['file', 'folder'] as const)('cancels a %s copy, removes partial data, and imports the identical selection again', async kind => {
    const file = modelFile({ name: 'same.gguf' }); const controller = new AbortController();
    const imported = vi.fn(); const unsubscribeModels = llamaCppBrowserService.subscribeModelList({ listener: imported });
    const unsubscribe = llamaCppBrowserService.subscribe({ listener: ({ state }) => {
      if (state.status === 'working' && state.progress.phase === 'importing' && state.progress.completed > 0) controller.abort();
    } });
    const copy = ({ signal }: { signal: AbortSignal | undefined }) => {
      switch (kind) {
      case 'file': return llamaCppBrowserService.importModel({ file, signal });
      case 'folder': return llamaCppBrowserService.importDirectory({ directory: { name: 'same-GGUF', files: [{ path: file.name, file }] }, signal });
      default: { const exhaustive: never = kind; throw new Error(String(exhaustive)); }
      }
    };
    try {
      await expect(copy({ signal: controller.signal })).rejects.toThrow('aborted');
      expect((await userFolder()).children.size).toBe(0);
      expect(await llamaCppBrowserService.listModels({ signal: undefined })).toEqual([]);
      expect(llamaCppBrowserService.getState()).toEqual({ status: 'idle' });
      expect(imported).not.toHaveBeenCalled();
      expect(TestWorker.instances[0]?.terminate).not.toHaveBeenCalled();
      await copy({ signal: undefined });
      expect(await llamaCppBrowserService.listModels({ signal: undefined })).toEqual([
        { id: 'user/same-GGUF', name: 'user/same-GGUF', size: file.size, importedAt: 123 },
      ]);
      expect(imported).toHaveBeenCalledOnce(); expect(TestWorker.instances).toHaveLength(1);
    } finally {
      unsubscribe(); unsubscribeModels();
    }
  });
  it('keeps a second import queued until the cancelled copy has finished deleting its destination', async () => {
    const file = modelFile({ name: 'same.gguf' }); const controller = new AbortController();
    const user = await userFolder(); const rollback = Promise.withResolvers<void>(); const entered = Promise.withResolvers<void>();
    const remove = user.removeEntry.bind(user);
    vi.spyOn(user, 'removeEntry').mockImplementationOnce(async (name, options) => {
      entered.resolve(); await rollback.promise; await remove(name, options);
    });
    const unsubscribe = llamaCppBrowserService.subscribe({ listener: ({ state }) => {
      if (state.status === 'working' && state.progress.phase === 'importing' && state.progress.completed > 0) controller.abort();
    } });
    try {
      let settled = false;
      const first = llamaCppBrowserService.importModel({ file, signal: controller.signal }).finally(() => {
        settled = true;
      });
      const rejected = expect(first).rejects.toThrow('aborted');
      await entered.promise;
      const second = llamaCppBrowserService.importModel({ file, signal: undefined });
      await Promise.resolve();
      expect(settled).toBe(false); expect(user.children.has('same-GGUF')).toBe(true);
      expect(TestWorker.instances[0]?.terminate).not.toHaveBeenCalled();
      rollback.resolve(); await rejected; await second;
      expect(await llamaCppBrowserService.listModels({ signal: undefined })).toHaveLength(1);
      expect(TestWorker.instances).toHaveLength(1);
    } finally {
      rollback.resolve(); unsubscribe();
    }
  });
  it('retries an empty single-file placeholder left by the previous forced-termination implementation', async () => {
    const file = modelFile({ name: 'same.gguf' }); const user = await userFolder();
    const folder = await user.getDirectoryHandle('same-GGUF', { create: true });
    await folder.getFileHandle('.llama-cpp-import-pending', { create: true });
    await folder.getFileHandle(file.name, { create: true });
    expect(await llamaCppBrowserService.listModels({ signal: undefined })).toEqual([]);
    await llamaCppBrowserService.importModel({ file, signal: undefined });
    expect(await llamaCppBrowserService.listModels({ signal: undefined })).toHaveLength(1);
    const installed = await user.getDirectoryHandle('same-GGUF');
    expect([...installed.children.keys()]).toEqual([file.name]);
    expect(new Uint8Array(await (await (await installed.getFileHandle(file.name)).getFile()).arrayBuffer())).toEqual(ggufBytes());
  });
});
