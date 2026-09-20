import { logFailure } from '@/features/llama-cpp-browser/debug-log';
import { z } from 'zod';
import { releaseWorkerRemote, workerProxy, wrapWorkerRemote } from '@/utils/worker-transport';
import { errorCode, generationResultSchema, LlamaCppBrowserError, modelSchema, modelsSchema, progressSchema } from '@/features/llama-cpp-browser/types';
import { workerGenerateCallSchema, type LlamaCppWorkerApi, type LlamaCppWorkerClient } from './types';

export function createLlamaCppWorkerClient(): LlamaCppWorkerClient {
  if (typeof Worker === 'undefined') {
    const unavailable = async (): Promise<never> => {
      throw new LlamaCppBrowserError({ code: 'unavailable' });
    };
    return { listModels: unavailable, importModel: unavailable, removeModel: unavailable, generate: unavailable, canReuse: () => false, dispose() {} };
  }
  const worker = new Worker(new URL('./entry.ts', import.meta.url), { type: 'module', name: 'naidan-llama-cpp-browser' });
  const remote = wrapWorkerRemote<LlamaCppWorkerApi>({ endpoint: worker });
  let disposed = false;
  let nextGenerationId = 0;
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
    logFailure({ stage: 'worker-error', error: undefined });
    event.preventDefault(); dispose();
  });
  worker.addEventListener('messageerror', () => {
    logFailure({ stage: 'worker-messageerror', error: undefined }); dispose();
  });
  async function invoke<T>({ call, signal, onAbort }: { call: () => Promise<T>, signal: AbortSignal | undefined, onAbort: (() => void) | undefined }): Promise<T> {
    if (signal?.aborted) throw new LlamaCppBrowserError({ code: 'aborted' });
    if (disposed) throw new LlamaCppBrowserError({ code: 'worker-failed' });
    if (rejectActive) throw new LlamaCppBrowserError({ code: 'busy' });
    let abortTimer: ReturnType<typeof setTimeout> | undefined;
    const abort = (): void => {
      if (!onAbort) {
        dispose(); return;
      }
      // Cooperative generation cancellation normally preserves resident weights.
      // A stuck native call still has a bounded escape hatch; imports always
      // terminate because a sync OPFS operation cannot reliably service messages.
      abortTimer = setTimeout(dispose, 5000);
      onAbort();
    };
    signal?.addEventListener('abort', abort, { once: true });
    try {
      const result = await new Promise<T>((resolve, reject) => {
        rejectActive = () => reject(new LlamaCppBrowserError({ code: signal?.aborted ? 'aborted' : 'worker-failed' }));
        void call().then(resolve, reject);
      });
      if (signal?.aborted) throw new LlamaCppBrowserError({ code: 'aborted' });
      return result;
    } catch (error) {
      logFailure({ stage: 'worker-rpc', error });
      const code = errorCode({ error });
      if (signal?.aborted && (code === 'runtime-error' || code === 'worker-failed')) dispose();
      throw new LlamaCppBrowserError({ code: signal?.aborted ? 'aborted' : errorCode({ error }) });
    } finally {
      if (abortTimer !== undefined) clearTimeout(abortTimer);
      signal?.removeEventListener('abort', abort);
      rejectActive = undefined;
    }
  }
  return {
    listModels: async ({ signal }) => modelsSchema.parse(await invoke({ call: () => remote.listModels(), signal, onAbort: undefined })),
    importModel: async ({ file, onProgress, signal }) => modelSchema.parse(await invoke({
      call: () => remote.importModel({ file }, workerProxy({ value: ({ ...event }) => {
        if (!disposed) onProgress({ progress: progressSchema.parse(event) });
      } })), signal, onAbort: undefined,
    })),
    removeModel: async ({ id, signal }) => {
      await invoke({ call: () => remote.removeModel({ id: modelSchema.shape.id.parse(id) }), signal, onAbort: undefined });
    },
    generate: async ({ request, onChunk, onProgress, signal }) => {
      const accepted = workerGenerateCallSchema.parse({ ...request, generationId: ++nextGenerationId,
        assetBaseURL: new URL(`${import.meta.env.BASE_URL}llama-cpp-browser-runtime/profiles/`, document.baseURI).href,
      });
      let acceptingEvents = true;
      try {
        const result = await invoke({ call: () => remote.generate(accepted,
          workerProxy({ value: ({ ...event }) => {
            if (acceptingEvents && !disposed && !signal?.aborted) onChunk({ chunk: z.object({ text: z.string() }).strict().parse(event).text });
          } }),
          workerProxy({ value: ({ ...event }) => {
            if (acceptingEvents && !disposed && !signal?.aborted) onProgress({ progress: progressSchema.parse(event) });
          } })), signal, onAbort: () => {
          void remote.cancelGeneration({ generationId: accepted.generationId }).catch(dispose);
        } });
        return generationResultSchema.parse(result);
      } finally {
        acceptingEvents = false;
      }
    },
    canReuse: () => !disposed,
    dispose,
  };
}
export const TEST_ONLY = {
};
