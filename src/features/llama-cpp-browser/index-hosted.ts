import { createLlamaCppWorkerClient } from '@/features/llama-cpp-browser/worker/client';
import type { LlamaCppWorkerClient } from './worker/types';
import { errorCode, generateInputSchema, LlamaCppBrowserError, runtimeOptionsSchema, type EngineState, type Progress, type RuntimeOptions } from './types';
import type { LlamaCppBrowserService } from './service-contract';
import { logDiagnostic } from './debug-log';

let state: EngineState = { status: 'idle' };
let options: RuntimeOptions = { profile: 'webgpu-wasm64-jspi', contextSize: 4096 };
let client: LlamaCppWorkerClient | undefined;
let activeController: AbortController | undefined;
let queue: Promise<void> = Promise.resolve();
const listeners = new Set<({ state }: { state: EngineState }) => void>();
const modelListeners = new Set<() => void>();
function publish({ next }: { next: EngineState }): void {
  state = next;
  for (const listener of listeners) {
    try {
      listener({ state: { ...state } });
    } catch {
      logDiagnostic({ diagnostic: { event: 'failed' } });
    }
  }
}
function progress({ progress }: { progress: Progress }): void {
  publish({ next: { status: 'working', progress } });
}
async function run<T>({ signal, operation }: {
  signal: AbortSignal | undefined,
  operation: ({ worker, signal }: { worker: LlamaCppWorkerClient, signal: AbortSignal }) => Promise<T>,
}): Promise<T> {
  if (signal?.aborted) throw new LlamaCppBrowserError({ code: 'aborted' });
  const predecessor = queue;
  let releaseLane: () => void = () => {};
  queue = new Promise<void>(resolve => {
    releaseLane = resolve;
  });
  try {
    await predecessor;
    if (signal?.aborted) throw new LlamaCppBrowserError({ code: 'aborted' });
    const controller = new AbortController(); activeController = controller;
    const forwardAbort = (): void => controller.abort();
    signal?.addEventListener('abort', forwardAbort, { once: true });
    try {
      client ??= createLlamaCppWorkerClient();
      const result = await operation({ worker: client, signal: controller.signal });
      publish({ next: { status: 'idle' } }); return result;
    } catch (error) {
      client?.dispose(); client = undefined;
      const code = controller.signal.aborted ? 'aborted' : errorCode({ error });
      switch (code) {
      case 'aborted':
        publish({ next: { status: 'idle' } });
        logDiagnostic({ diagnostic: { event: 'cancelled' } });
        break;
      case 'unavailable': case 'invalid-gguf': case 'duplicate-model': case 'missing-model':
      case 'storage-error': case 'runtime-error': case 'template-unsupported': case 'context-full':
      case 'unsupported-input': case 'busy': case 'worker-failed':
        publish({ next: { status: 'error', code } });
        logDiagnostic({ diagnostic: { event: 'failed' } });
        break;
      default: { const exhaustive: never = code; throw new Error(`Unhandled error code: ${exhaustive}`); }
      }
      throw new LlamaCppBrowserError({ code });
    } finally {
      signal?.removeEventListener('abort', forwardAbort); activeController = undefined;
    }
  } finally {
    releaseLane();
  }
}
export const llamaCppBrowserService: LlamaCppBrowserService = {
  getState: () => ({ ...state }),
  getOptions: () => ({ ...options }),
  setOptions({ options: next }) {
    options = runtimeOptionsSchema.parse(next);
  },
  subscribe({ listener }) {
    listeners.add(listener); listener({ state: { ...state } }); return () => {
      listeners.delete(listener);
    };
  },
  subscribeModelList({ listener }) {
    modelListeners.add(listener); return () => {
      modelListeners.delete(listener);
    };
  },
  listModels({ signal }) {
    return run({ signal, operation: ({ worker, signal }) => worker.listModels({ signal }) });
  },
  importModel({ file, signal }) {
    return run({ signal, operation: async ({ worker, signal }) => {
      progress({ progress: { phase: 'importing', completed: 0, total: file.size } });
      await worker.importModel({ file, onProgress: progress, signal });
      for (const listener of modelListeners) {
        try {
          listener();
        } catch {
          logDiagnostic({ diagnostic: { event: 'failed' } });
        }
      }
    } });
  },
  removeModel({ id, signal }) {
    return run({ signal, operation: async ({ worker, signal }) => {
      await worker.removeModel({ id, signal }); for (const listener of modelListeners) {
        try {
          listener();
        } catch {
          logDiagnostic({ diagnostic: { event: 'failed' } });
        }
      }
    } });
  },
  generate({ input, onChunk, signal }) {
    // Snapshot accepted inputs before waiting in the queue; Vue proxies never cross RPC.
    const request = generateInputSchema.parse({ ...input, options: { ...options } });
    return run({ signal, operation: async ({ worker, signal }) => {
      progress({ progress: { phase: 'initializing', completed: 0, total: 0 } });
      await worker.generate({ request, onChunk, onProgress: progress, signal });
    } });
  },
  cancel() {
    activeController?.abort();
  },
  release() {
    activeController?.abort(); client?.dispose(); client = undefined; publish({ next: { status: 'idle' } });
  },
};
export const TEST_ONLY = {
};
