import { z } from 'zod';
import { releaseWorkerRemote, workerProxy, wrapWorkerRemote } from '@/utils/worker-transport';
import { errorCode, LlamaCppBrowserError, modelSchema, modelsSchema, progressSchema } from '@/features/llama-cpp-browser/types';
import { workerGenerateInputSchema, type LlamaCppWorkerApi, type LlamaCppWorkerClient } from './types';

export function createLlamaCppWorkerClient(): LlamaCppWorkerClient {
  if (typeof Worker === 'undefined') {
    const unavailable = async (): Promise<never> => {
      throw new LlamaCppBrowserError({ code: 'unavailable' });
    };
    return { listModels: unavailable, importModel: unavailable, removeModel: unavailable, generate: unavailable, dispose() {} };
  }
  const worker = new Worker(new URL('./entry.ts', import.meta.url), { type: 'module', name: 'naidan-llama-cpp-browser' });
  const remote = wrapWorkerRemote<LlamaCppWorkerApi>({ endpoint: worker });
  let disposed = false;
  let rejectActive: (() => void) | undefined;
  const dispose = (): void => {
    if (disposed) return;
    disposed = true;
    rejectActive?.();
    try {
      void Promise.resolve(releaseWorkerRemote({ remote })).catch(() => {});
    } finally {
      worker.terminate();
    }
  };
  worker.addEventListener('error', (event) => {
    event.preventDefault(); dispose();
  });
  worker.addEventListener('messageerror', dispose);
  async function invoke<T>({ call, signal }: { call: () => Promise<T>, signal: AbortSignal | undefined }): Promise<T> {
    if (signal?.aborted) throw new LlamaCppBrowserError({ code: 'aborted' });
    if (disposed) throw new LlamaCppBrowserError({ code: 'worker-failed' });
    if (rejectActive) throw new LlamaCppBrowserError({ code: 'busy' });
    signal?.addEventListener('abort', dispose, { once: true });
    try {
      return await new Promise<T>((resolve, reject) => {
        rejectActive = () => reject(new LlamaCppBrowserError({ code: signal?.aborted ? 'aborted' : 'worker-failed' }));
        void call().then(resolve, reject);
      });
    } catch (error) {
      throw new LlamaCppBrowserError({ code: signal?.aborted ? 'aborted' : errorCode({ error }) });
    } finally {
      signal?.removeEventListener('abort', dispose);
      rejectActive = undefined;
    }
  }
  return {
    listModels: async ({ signal }) => modelsSchema.parse(await invoke({ call: () => remote.listModels(), signal })),
    importModel: async ({ file, onProgress, signal }) => modelSchema.parse(await invoke({
      call: () => remote.importModel({ file }, workerProxy({ value: ({ ...event }) => {
        if (!disposed) onProgress({ progress: progressSchema.parse(event) });
      } })), signal,
    })),
    removeModel: async ({ id, signal }) => {
      await invoke({ call: () => remote.removeModel({ id: z.uuid().parse(id) }), signal });
    },
    generate: async ({ request, onChunk, onProgress, signal }) => {
      const accepted = workerGenerateInputSchema.parse({ ...request,
        assetBaseURL: new URL(`${import.meta.env.BASE_URL}llama-cpp-browser-runtime/profiles/`, document.baseURI).href,
      });
      await invoke({ call: () => remote.generate(accepted,
        workerProxy({ value: ({ ...event }) => {
          if (!disposed) onChunk({ chunk: z.object({ text: z.string() }).strict().parse(event).text });
        } }),
        workerProxy({ value: ({ ...event }) => {
          if (!disposed) onProgress({ progress: progressSchema.parse(event) });
        } })), signal });
    },
    dispose,
  };
}
export const TEST_ONLY = {
};
