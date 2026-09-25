import { imageDiagnosticEnvelopeSchema, type ImageDiagnostic } from '@/features/stable-diffusion-cpp-browser/diagnostics';
import { releaseWorkerRemote, workerProxy, wrapWorkerRemote, subscribeWorkerNotifications } from '@/utils/worker-transport';
import { progressSchema, requestSchema, responseSchema } from '@/features/stable-diffusion-cpp-browser/types';
import type { ImageClient, ImageWorker } from './types';

export function createImageClient(): ImageClient {
  let active: { terminate: () => void } | undefined;
  let disposed = false;
  return {
    async generate({ request: rawRequest, signal, onProgress, onDiagnostic }) {
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
      const began = performance.now(); let lastMessage = began; let lastStage: ImageDiagnostic['stage'] = 'worker';
      let closed = false;
      function publish({ diagnostic }: { diagnostic: ImageDiagnostic }): void {
        if (closed || signal.aborted || disposed) return;
        try {
          onDiagnostic?.({ diagnostic });
        } catch { /* A log view cannot interrupt native work. */ }
        switch (request.debug) {
        case 'on': try {
          console.log('[stable-diffusion-cpp-browser] ' + JSON.stringify(diagnostic));
        } catch { /* Logging is observational. */ } break;
        case 'off': case undefined: break;
        default: { const exhaustive: never = request.debug; throw new Error(String(exhaustive)); }
        }
      }
      const unsubscribe = subscribeWorkerNotifications({ endpoint: worker, schema: imageDiagnosticEnvelopeSchema, listener: ({ value }) => {
        lastMessage = performance.now();
        if (['start', 'complete', 'progress'].includes(value.diagnostic.event)) lastStage = value.diagnostic.stage;
        publish({ diagnostic: value.diagnostic });
      } });
      publish({ diagnostic: { event: 'start', stage: 'worker', elapsedMs: 0, fields: { profile: request.artifact.profile } } });
      // Runs in the window even when synchronous Wasm blocks the Worker. Silence
      // is not proof of deadlock and never triggers automatic cancellation/retry.
      const heartbeat = setInterval(() => publish({ diagnostic: { event: 'waiting', stage: lastStage,
        elapsedMs: performance.now() - began, fields: { workerSilentMs: performance.now() - lastMessage } } }), 5000);
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
      } catch (error) {
        const diagnostic: ImageDiagnostic = { event: signal.aborted || disposed ? 'cancelled' : 'failed', stage: lastStage, elapsedMs: performance.now() - began, fields: {} };
        try {
          onDiagnostic?.({ diagnostic });
        } catch { /* diagnostic only */ }
        throw error;
      } finally {
        closed = true; clearInterval(heartbeat); unsubscribe();
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
