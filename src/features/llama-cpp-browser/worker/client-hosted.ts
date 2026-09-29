import { releaseWorkerRemote, wrapWorkerRemote } from '@/utils/worker-transport';
import { LlamaCppBrowserError } from '@/features/llama-cpp-browser/types';
import { createLlamaCppWorkerSessionClient } from './client-session';
import type { LlamaCppWorkerApi, LlamaCppWorkerClient } from './types';

export function createLlamaCppWorkerClient(): LlamaCppWorkerClient {
  if (typeof Worker === 'undefined') {
    const unavailable = async (): Promise<never> => {
      throw new LlamaCppBrowserError({ code: 'unavailable' });
    };
    return { subscribeDisposed: () => () => {}, probeProfiles: unavailable, listModels: unavailable, importModel: unavailable, importDirectory: unavailable, removeModel: unavailable, generate: unavailable, generateAudio: unavailable, canReuse: () => false, dispose() {} };
  }
  const worker = new Worker(new URL('./entry.ts', import.meta.url), { type: 'module', name: 'naidan-llama-cpp-browser' });
  const remote = wrapWorkerRemote<LlamaCppWorkerApi>({ endpoint: worker });
  return createLlamaCppWorkerSessionClient({
    worker, remote,
    disposeTransport() {
      try {
        void Promise.resolve(releaseWorkerRemote({ remote })).catch(() => {});
      } finally {
        worker.terminate();
      }
    },
    getAssetBaseURL: () => new URL(`${import.meta.env.BASE_URL}llama-cpp-browser-runtime/profiles/`, document.baseURI).href,
  });
}
export const TEST_ONLY = {
};
