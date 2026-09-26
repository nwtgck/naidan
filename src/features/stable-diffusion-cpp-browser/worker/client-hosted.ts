import { imageDiagnosticEnvelopeSchema, sanitizeImageLog, imageErrorContext, type ImageDiagnostic } from '@/features/stable-diffusion-cpp-browser/diagnostics';
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
      let firstFailureStage: ImageDiagnostic['stage'] | undefined;
      const secrets = [request.parameters.prompt, request.parameters.negativePrompt, request.parameters.modelArguments];
      const failureContext: string[] = [];
      const rememberFailure = ({ message }: { message: string }) => {
        const safe = sanitizeImageLog({ message, secrets });
        if (safe && failureContext.at(-1) !== safe) failureContext.push(safe);
        if (failureContext.length > 8) failureContext.shift();
      };
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
        switch (value.diagnostic.event) {
        case 'start': case 'complete': case 'progress': lastStage = value.diagnostic.stage; break;
        case 'failed':
          if (value.diagnostic.message) rememberFailure({ message: value.diagnostic.message });
          // Cleanup observations must not relabel the primary native failure.
          firstFailureStage ??= (() => {
            switch (value.diagnostic.stage) {
            case 'worker': return lastStage;
            case 'runtime-fetch': case 'runtime-init': case 'model-header': case 'model-load':
            case 'generation': case 'sampling': case 'decoding': case 'encoding': case 'cleanup': return value.diagnostic.stage;
            default: { const exhaustive: never = value.diagnostic.stage; throw new Error(String(exhaustive)); }
            }
          })();
          break;
        case 'gpu':
          if (value.diagnostic.message && /^(?:uncaptured GPU error:|device lost:|GPU error scope:)/.test(value.diagnostic.message)) {
            firstFailureStage ??= value.diagnostic.stage;
            rememberFailure({ message: value.diagnostic.message });
          }
          break;
        case 'request': case 'native': case 'file-summary': case 'file-read': case 'waiting': case 'cancelled': case 'dropped': break;
        default: { const exhaustive: never = value.diagnostic.event; throw new Error(String(exhaustive)); }
        }
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
      // eslint-disable-next-line local-rules-named-args/require-named-args -- Worker EventListener signature.
      const crash = (event: Event) => {
        // Worker errors may occur outside the inference promise (notably the
        // native WebGPU error callback). Preserve already-delivered GPU/abort
        // diagnostics rather than replacing them with an opaque message.
        // Never include event.filename or a raw error stack in the export.
        const frames = event instanceof ErrorEvent ? imageErrorContext({ error: event.error }).wasmFrames : '';
        const message = event instanceof ErrorEvent ? event.message : '';
        rejectStopped(new Error([
          `Image Worker failed: stage=${firstFailureStage ?? lastStage}, profile=${request.artifact.profile}, source=${request.artifact.modulePath.split('/')[1]}`,
          ...failureContext,
          ...(message ? [sanitizeImageLog({ message, secrets })] : []),
          ...(frames ? [`Wasm frames: ${frames}`] : []),
          event.type === 'messageerror' ? 'Worker message could not be decoded. Its runtime has been released.' : 'Its runtime has been released.',
        ].join('\n')));
      };
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
        const cancelled = signal.aborted || disposed;
        const diagnostic: ImageDiagnostic = { event: cancelled ? 'cancelled' : 'failed', stage: cancelled ? lastStage : firstFailureStage ?? lastStage, elapsedMs: performance.now() - began,
          message: cancelled ? undefined : sanitizeImageLog({ message: error instanceof Error ? error.message : String(error), secrets }), fields: {} };
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
