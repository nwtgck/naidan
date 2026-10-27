import { File as NodeFile } from 'node:buffer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WorkerServerApi } from '@/utils/worker-transport';
import { memoryDirectory, ggufBytes } from '@/features/llama-cpp-browser/hugging-face/test-opfs';
import { llamaCppBrowserService } from '@/features/llama-cpp-browser/index-hosted';
import { TEST_ONLY as modelFileTest } from '@/features/llama-cpp-browser/model-files';
import { createWorkerApi } from './api';
import type { LlamaCppWorkerApi } from './types';

// Keep the real public service and stream importer connected. Local file
// operations must not create an inference Worker or mutate its EngineState.
const transport = vi.hoisted(() => ({ remote: undefined as WorkerServerApi<LlamaCppWorkerApi> | undefined, release: vi.fn() }));
vi.mock('@/utils/worker-transport', async importOriginal => ({
  ...await importOriginal<typeof import('@/utils/worker-transport')>(),
  wrapWorkerRemote: () => transport.remote,
  releaseWorkerRemote: transport.release,
  workerProxy: ({ value }: { value: unknown }) => value,
}));
vi.mock('@/features/llama-cpp-browser/runtime/detect-profile', () => ({ probeRuntimeProfiles: vi.fn() }));
vi.mock('./session', () => ({ invalidateStoredModel: vi.fn(), releaseSession: vi.fn() }));
vi.mock('./generation', () => ({ generate: vi.fn() }));
class TestWorker extends EventTarget {
  static instances: TestWorker[] = [];
  terminate = vi.fn();

  constructor() {
    super();
    TestWorker.instances.push(this);
  }
}
let root: ReturnType<typeof memoryDirectory>;

function modelFile({ name, beforeComplete }: { name: string, beforeComplete: (() => void) | undefined }): File {
  // Preserve jsdom's File identity for the real wire schemas, while supplying
  // the Blob streaming methods that jsdom does not implement.
  const file = new File([ggufBytes()], name);
  const source = new NodeFile([ggufBytes()], name);
  Object.defineProperties(file, {
    stream: {
      value: () => {
        const stream = source.stream();
        const reader = stream.getReader();
        const read = reader.read.bind(reader);
        Object.defineProperty(reader, 'read', {
          value: async () => {
            const next = await read();
            if (next.done) {
              beforeComplete?.();
            }
            return next;
          },
        });
        Object.defineProperty(stream, 'getReader', { value: () => reader });
        return stream;
      },
    },
    slice: { value: source.slice.bind(source) },
    arrayBuffer: { value: () => source.arrayBuffer() },
  });
  return file;
}

async function userFolder() {
  return (await root.getDirectoryHandle('models', { create: true })).getDirectoryHandle('user', { create: true });
}

beforeEach(() => {
  vi.clearAllMocks();
  modelFileTest.resetPublications();
  TestWorker.instances = [];
  root = memoryDirectory({ name: '' });
  vi.stubGlobal('Worker', TestWorker);
  let lockTail = Promise.resolve();
  vi.stubGlobal('navigator', {
    storage: { getDirectory: async () => root },
    locks: {
      request: async (name: string, optionsOrOperation: LockOptions | ((lock: Lock) => Promise<unknown>), operation?: (lock: Lock) => Promise<unknown>) => {
        const callback = typeof optionsOrOperation === 'function' ? optionsOrOperation : operation;
        if (!callback) {
          throw new Error('Missing lock callback');
        }
        const previous = lockTail;
        const released = Promise.withResolvers<void>();
        lockTail = released.promise;
        await previous;
        try {
          return await callback({ name, mode: 'exclusive' } as Lock);
        } finally {
          released.resolve();
        }
      },
    },
  });
  vi.spyOn(console, 'log').mockImplementation(() => {});
  transport.remote = createWorkerApi();
});

afterEach(() => {
  llamaCppBrowserService.release();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('local import cancellation through the public file service', () => {
  it.each(['file', 'folder'] as const)('cancels a %s copy, removes partial data, and imports the identical selection again', async kind => {
    const controller = new AbortController();
    const file = modelFile({ name: 'same.gguf', beforeComplete: () => controller.abort() });
    const imported = vi.fn();
    const unsubscribeModels = llamaCppBrowserService.subscribeModelList({ listener: imported });
    const stateChanged = vi.fn();
    const unsubscribe = llamaCppBrowserService.subscribe({ listener: stateChanged });
    stateChanged.mockClear();
    const copy = ({ signal }: { signal: AbortSignal | undefined }) => {
      switch (kind) {
      case 'file': return llamaCppBrowserService.importModel({ file, signal });
      case 'folder': return llamaCppBrowserService.importDirectory({ directory: { rootName: 'same-GGUF', files: [{ relativePath: file.name, file }] }, signal });
      default: {
        const exhaustive: never = kind;
        throw new Error(String(exhaustive));
      }
      }
    };
    using _cleanupResource = {
      [Symbol.dispose]() {
        unsubscribe();
        unsubscribeModels();
      },
    };
    await expect(copy({ signal: controller.signal })).rejects.toThrow('aborted');
    expect((await userFolder()).children.size).toBe(0);
    expect(await llamaCppBrowserService.listModelEntries({ signal: undefined })).toEqual([]);
    expect(llamaCppBrowserService.getState()).toEqual({ status: 'idle' });
    expect(imported).not.toHaveBeenCalled();
    expect(TestWorker.instances).toHaveLength(0);
    expect(stateChanged).not.toHaveBeenCalled();
    await copy({ signal: undefined });
    expect(await llamaCppBrowserService.listModelEntries({ signal: undefined })).toEqual([
      { modelId: 'user/same-GGUF/same', size: file.size, importedAt: 123 },
    ]);
    expect(imported).toHaveBeenCalledOnce();
    expect(TestWorker.instances).toHaveLength(0);
  });

  it('keeps a second import queued until the cancelled copy has finished deleting its destination', async () => {
    const controller = new AbortController();
    const file = modelFile({ name: 'same.gguf', beforeComplete: () => controller.abort() });
    const user = await userFolder();
    const rollback = Promise.withResolvers<void>();
    const entered = Promise.withResolvers<void>();
    const remove = user.removeEntry.bind(user);
    vi.spyOn(user, 'removeEntry').mockImplementationOnce(async (name, options) => {
      entered.resolve();
      await rollback.promise;
      await remove(name, options);
    });
    using _cleanupResource = {
      [Symbol.dispose]() {
        rollback.resolve();
      },
    };
    let settled = false;
    const first = llamaCppBrowserService.importModel({ file, signal: controller.signal }).finally(() => {
      settled = true;
    });
    const rejected = expect(first).rejects.toThrow('aborted');
    await entered.promise;
    const second = llamaCppBrowserService.importModel({ file, signal: undefined });
    await Promise.resolve();
    expect(settled).toBe(false);
    expect(user.children.has('same-GGUF')).toBe(true);
    expect(TestWorker.instances).toHaveLength(0);
    rollback.resolve();
    await rejected;
    await second;
    expect(await llamaCppBrowserService.listModelEntries({ signal: undefined })).toHaveLength(1);
    expect(TestWorker.instances).toHaveLength(0);
  });

  it('retries an empty single-file placeholder left by the previous forced-termination implementation', async () => {
    const file = modelFile({ name: 'same.gguf', beforeComplete: undefined });
    const user = await userFolder();
    const folder = await user.getDirectoryHandle('same-GGUF', { create: true });
    await folder.getFileHandle('.llama-cpp-import-pending', { create: true });
    await folder.getFileHandle(file.name, { create: true });
    expect(await llamaCppBrowserService.listModelEntries({ signal: undefined })).toEqual([]);
    await llamaCppBrowserService.importModel({ file, signal: undefined });
    expect(await llamaCppBrowserService.listModelEntries({ signal: undefined })).toHaveLength(1);
    const installed = await user.getDirectoryHandle('same-GGUF');
    expect([...installed.children.keys()]).toEqual([file.name]);
    expect(new Uint8Array(await (await (await installed.getFileHandle(file.name)).getFile()).arrayBuffer())).toEqual(ggufBytes());
  });
});
