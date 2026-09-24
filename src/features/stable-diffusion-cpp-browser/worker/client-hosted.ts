import { releaseWorkerRemote, workerProxy, wrapWorkerRemote } from '@/utils/worker-transport';
import { progressSchema, requestSchema, responseSchema } from '@/features/stable-diffusion-cpp-browser/types';
import type { ImageClient, ImageWorker } from './types';

export function createImageClient(): ImageClient {
  let active: { terminate: () => void } | undefined;
  let disposed = false;
  return {
    async generate({ request: rawRequest, signal, onProgress }) {
      if (disposed || active) throw new Error('Image client is disposed or busy');
      if (signal.aborted) throw new DOMException('Image generation cancelled', 'AbortError');
      const request = requestSchema.parse(rawRequest);
      const worker = new Worker(new URL('./entry.ts', import.meta.url), { type: 'module', name: 'stable-diffusion-cpp-browser' });
      const remote = (() => {
        try {
          return wrapWorkerRemote<ImageWorker>({ endpoint: worker });
        } catch (error) {
          worker.terminate(); throw error;
        }
      })();
      let rejectStopped: ReturnType<typeof Promise.withResolvers<never>>['reject'] = () => undefined;
      const stopped = new Promise<never>((_resolve, reject) => {
        rejectStopped = reject;
      });
      const abort = () => rejectStopped(new DOMException('Image generation cancelled', 'AbortError'));
      const crash = () => rejectStopped(new Error('Image Worker failed. Its runtime has been released.'));
      // Cancellation is independent of a possibly suspended Wasm/Comlink call.
      const terminate = () => {
        abort(); worker.terminate();
      };
      active = { terminate };
      signal.addEventListener('abort', terminate, { once: true });
      worker.addEventListener('error', crash); worker.addEventListener('messageerror', crash);
      try {
        if (signal.aborted) terminate();
        const result = await Promise.race([
          remote.generate(request, workerProxy({ value: ({ event }) => {
            const parsed = progressSchema.safeParse(event);
            if (parsed.success && !signal.aborted && !disposed) onProgress({ event: parsed.data });
          } })),
          stopped,
        ]);
        const parsed = responseSchema.parse(result);
        if (parsed.width !== request.parameters.width || parsed.height !== request.parameters.height) throw new Error('Image response dimensions differ from request');
        return parsed;
      } finally {
        signal.removeEventListener('abort', terminate);
        worker.removeEventListener('error', crash); worker.removeEventListener('messageerror', crash);
        // Never await a proxy acknowledgement from an unresponsive native call.
        try {
          Promise.resolve(releaseWorkerRemote({ remote })).catch(() => undefined);
        } catch { /* already stopped */ }
        worker.terminate(); active = undefined;
      }
    },
    dispose() {
      disposed = true; active?.terminate();
    },
  };
}
export const TEST_ONLY = {
};
