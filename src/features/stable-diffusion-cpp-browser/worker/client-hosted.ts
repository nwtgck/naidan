import { imageDiagnosticEnvelopeSchema, sanitizeImageLog, imageErrorContext, type ImageDiagnostic } from '@/features/stable-diffusion-cpp-browser/diagnostics';
import { releaseWorkerRemote, workerProxy, wrapWorkerRemote, subscribeWorkerNotifications, postWorkerNotification, type WorkerRemote } from '@/utils/worker-transport';
import { progressSchema, requestSchema, workerResultSchema, cancelControlSchema, previewSettingsSchema, previewControlSchema, previewFrameSchema, type PreviewSettings } from '@/features/stable-diffusion-cpp-browser/types';
import { createImageSessionKeys } from '@/features/stable-diffusion-cpp-browser/session-key';
import type { ImageClient, ImageReleaseReason, ImageWorker } from './types';

type WorkerState = { worker: Worker, remote: WorkerRemote<ImageWorker>, key: string, id: string, closed: boolean, unsubscribe: (() => void)[] };
type Active = { state: WorkerState, runId: number, revision: number, mode: PreviewSettings['mode'], enabled: boolean, cancelRequested: boolean,
  reject({ error }: { error: unknown }): void, diagnostic({ diagnostic }: { diagnostic: ImageDiagnostic }): void,
  preview: NonNullable<Parameters<ImageClient['generate']>[0]['onPreview']>, crash: EventListener };

/** Page-owned, lazy client. Success and safe cooperative cancellation retain a
 * compatible worker. Failure or forced abort retires it. No profiles are retried. */
export function createImageClient({ onReleased }: { onReleased?: () => void } = {}): ImageClient {
  const keys = createImageSessionKeys();
  let disposed = false, state: WorkerState | undefined, active: Active | undefined, nextRun = 0, nextWorker = 0;
  let lastRetired: ImageReleaseReason | undefined;
  function retire({ target, reason = 'failed' }: { target: WorkerState | undefined, reason?: ImageReleaseReason }): void {
    if (!target || target.closed) return;
    target.closed = true; lastRetired = reason;
    for (const unsubscribe of target.unsubscribe) unsubscribe();
    // Never wait for a response from a suspended native call.
    try {
      Promise.resolve(releaseWorkerRemote({ remote: target.remote })).catch(() => undefined);
    } catch { /* already gone */ }
    target.worker.terminate();
    if (state === target) state = undefined;
    try {
      onReleased?.();
    } catch { /* UI is observational */ }
  }
  function create({ key }: { key: string }): WorkerState {
    const worker = new Worker(new URL('./entry.ts', import.meta.url), { type: 'module', name: 'stable-diffusion-cpp-browser' });
    let remote: WorkerRemote<ImageWorker>;
    try {
      remote = wrapWorkerRemote<ImageWorker>({ endpoint: worker });
    } catch (error) {
      worker.terminate(); throw error;
    }
    const target: WorkerState = { worker, remote, key, id: String(++nextWorker), closed: false, unsubscribe: [] };
    target.unsubscribe.push(subscribeWorkerNotifications({ endpoint: worker, schema: imageDiagnosticEnvelopeSchema, listener({ value }) {
      if (target.closed) return;
      if (active?.state === target) {
        const id = value.diagnostic.fields.runId;
        if (id === undefined || id === active.runId) active.diagnostic({ diagnostic: value.diagnostic });
      } else if (value.diagnostic.event === 'failed' || (value.diagnostic.event === 'gpu' && /^(?:uncaptured GPU error:|device lost:|GPU error scope:)/.test(value.diagnostic.message ?? ''))) retire({ target });
    } }));
    target.unsubscribe.push(subscribeWorkerNotifications({ endpoint: worker, schema: previewFrameSchema, listener({ value }) {
      if (target.closed || active?.state !== target || value.runId !== active.runId || value.revision !== active.revision || active.cancelRequested || !active.enabled || value.mode !== active.mode) return;
      try {
        active.preview({ frame: value });
      } catch { /* UI is observational */ }
    } }));
    const crash: EventListener = event => {
      if (active?.state === target) active.crash(event);
      else retire({ target });
    };
    worker.addEventListener('error', crash); worker.addEventListener('messageerror', crash);
    target.unsubscribe.push(() => {
      worker.removeEventListener('error', crash); worker.removeEventListener('messageerror', crash);
    });
    return target;
  }
  function release({ reason = 'explicit-release' }: { reason?: ImageReleaseReason } = {}): void {
    const target = state;
    if (active && active.state === target) active.reject({ error: new DOMException('Image runtime released', 'AbortError') });
    retire({ target, reason });
  }
  return {
    async generate({ request: rawRequest, signal, onProgress, onPreview, onDiagnostic }) {
      if (disposed || active) throw new Error('Image client is disposed or busy');
      signal.throwIfAborted();
      const parsedRequest = requestSchema.parse(rawRequest), key = keys.key({ request: parsedRequest });
      if (state && state.key !== key) retire({ target: state, reason: 'context-key-changed' });
      const reused = !!state, workerReason = reused ? 'same-session-key' : lastRetired ?? 'first-use';
      state ??= create({ key });
      const target = state, request = { ...parsedRequest, runId: ++nextRun, sessionId: target.id };
      const began = performance.now(); let lastMessage = began, lastStage: ImageDiagnostic['stage'] = 'worker', firstFailureStage: ImageDiagnostic['stage'] | undefined;
      let closed = false;
      const secrets = [request.parameters.prompt, request.parameters.negativePrompt, request.parameters.modelArguments], failureContext: string[] = [];
      function publish({ diagnostic }: { diagnostic: ImageDiagnostic }): void {
        if (closed || disposed || signal.aborted) return;
        try {
          onDiagnostic?.({ diagnostic });
        } catch { /* observational */ }
        switch (request.debug) {
        case 'on': try {
          console.log('[stable-diffusion-cpp-browser] ' + JSON.stringify(diagnostic));
        } catch { /* observational */ } break;
        case 'off': case undefined: break;
        default: { const exhaustive: never = request.debug; throw new Error(String(exhaustive)); }
        }
      }
      function remember({ message }: { message: string }): void {
        const safe = sanitizeImageLog({ message, secrets });
        if (safe && failureContext.at(-1) !== safe) failureContext.push(safe);
        if (failureContext.length > 8) failureContext.shift();
      }
      const stopped = Promise.withResolvers<never>();
      const gpuFailure = Symbol('image GPU failure');
      const operation: Active = { state: target, runId: request.runId, revision: 0, cancelRequested: false, mode: request.preview.mode, enabled: request.preview.enabled, reject: ({ error }) => stopped.reject(error),
        diagnostic({ diagnostic }) {
          if (closed) return;
          lastMessage = performance.now();
          switch (diagnostic.event) {
          case 'start': case 'complete': case 'progress': lastStage = diagnostic.stage; break;
          case 'failed':
            if (diagnostic.message) remember({ message: diagnostic.message });
            firstFailureStage ??= (() => {
              switch (diagnostic.stage) {
              case 'worker': return lastStage;
              case 'runtime-fetch': case 'runtime-init': case 'model-header': case 'model-load': case 'generation':
              case 'sampling': case 'decoding': case 'encoding': case 'cleanup': return diagnostic.stage;
              default: { const exhaustive: never = diagnostic.stage; throw new Error(String(exhaustive)); }
              }
            })();
            if (diagnostic.fields.kind === 'preview-control' || diagnostic.fields.kind === 'cancel-control') stopped.reject(new Error(diagnostic.message ?? 'Preview control failed'));
            break;
          case 'gpu':
            if (diagnostic.message && /^(?:uncaptured GPU error:|device lost:|GPU error scope:)/.test(diagnostic.message)) {
              firstFailureStage ??= diagnostic.stage; remember({ message: diagnostic.message });
              // A GPU failure must never be converted to a successful retained
              // cancellation, even if the native operation subsequently returns.
              stopped.reject(gpuFailure);
            }
            break;
          case 'request': case 'native': case 'file-summary': case 'file-read': case 'waiting': case 'cancelled': case 'dropped': break;
          default: { const exhaustive: never = diagnostic.event; throw new Error(String(exhaustive)); }
          }
          publish({ diagnostic });
        },
        preview({ frame }) {
          if (!closed && !operation.cancelRequested && !disposed && !signal.aborted) onPreview?.({ frame });
        },

        crash(event) {
          const frames = event instanceof ErrorEvent ? imageErrorContext({ error: event.error }).wasmFrames : '';
          const message = event instanceof ErrorEvent ? event.message : '';
          stopped.reject(new Error([`Image Worker failed: stage=${firstFailureStage ?? lastStage}, profile=${request.artifact.profile}, source=${request.artifact.modulePath.split('/')[1]}`,
            ...failureContext, ...(message ? [sanitizeImageLog({ message, secrets })] : []), ...(frames ? [`Wasm frames: ${frames}`] : []),
            event.type === 'messageerror' ? 'Worker message could not be decoded. Its runtime has been released.' : 'Its runtime has been released.'].join('\n')));
        },
      };
      active = operation;
      const abort = () => {
        stopped.reject(new DOMException('Image generation cancelled', 'AbortError')); retire({ target, reason: 'forced-abort' });
      };
      signal.addEventListener('abort', abort, { once: true });
      const heartbeat = setInterval(() => publish({ diagnostic: { event: 'waiting', stage: lastStage, elapsedMs: performance.now() - began, fields: { workerSilentMs: performance.now() - lastMessage } } }), 5000);
      try {
        if (signal.aborted) abort();
        const generated = target.remote.generate(request, workerProxy({ value: ({ event }) => {
          const parsed = progressSchema.safeParse(event);
          if (parsed.success && !closed && active === operation && !signal.aborted && !disposed) try {
            onProgress({ event: parsed.data });
          } catch { /* observational */ }
        } }));
        // Queue the generate command before callbacks may request a live update.
        // Worker endpoint ordering then preserves even an immediate ON/OFF.
        publish({ diagnostic: { event: 'start', stage: 'worker', elapsedMs: 0, fields: { profile: request.artifact.profile } } });
        switch (request.debug) {
        case 'on': publish({ diagnostic: { event: 'native', stage: 'worker', elapsedMs: Math.max(0, performance.now() - began),
          fields: { metric: 'worker-selection', perfVersion: 1, runId: request.runId, reusedWorker: reused, reason: workerReason } } }); break;
        case 'off': case undefined: break;
        default: { const exhaustive: never = request.debug; throw new Error(String(exhaustive)); }
        }
        const result = await Promise.race([generated, stopped.promise]);
        const response = workerResultSchema.parse(result);
        if ('cancelled' in response) return response;
        if (operation.cancelRequested) return { cancelled: true, modelResident: true };
        if (response.width !== request.parameters.width || response.height !== request.parameters.height) throw new Error('Image response dimensions differ from request');
        return response;
      } catch (caught) {
        const error = caught === gpuFailure ? new Error([
          `Image Worker failed: stage=${firstFailureStage ?? lastStage}, profile=${request.artifact.profile}, source=${request.artifact.modulePath.split('/')[1]}`,
          ...failureContext, 'Its runtime has been released.',
        ].join('\n')) : caught;
        retire({ target });
        const cancelled = signal.aborted || disposed || error instanceof DOMException && error.name === 'AbortError';
        try {
          onDiagnostic?.({ diagnostic: { event: cancelled ? 'cancelled' : 'failed', stage: firstFailureStage ?? lastStage, elapsedMs: performance.now() - began,
            message: cancelled ? undefined : sanitizeImageLog({ message: error instanceof Error ? error.message : String(error), secrets }), fields: {} } });
        } catch { /* observational */ }
        throw error;
      } finally {
        closed = true; clearInterval(heartbeat); signal.removeEventListener('abort', abort);
        if (active === operation) active = undefined;
      }
    },
    cancel() {
      if (!active || disposed || active.state.closed || active.cancelRequested) return;
      active.cancelRequested = true;
      try {
        postWorkerNotification({ endpoint: active.state.worker, schema: cancelControlSchema,
          value: { type: 'naidan-image-cancel-v1', runId: active.runId } });
      } catch (error) {
        active.reject({ error }); retire({ target: active.state });
      }
    },
    updatePreview({ settings }) {
      const parsed = previewSettingsSchema.safeParse(settings);
      if (!parsed.success || !active || active.cancelRequested || disposed || active.state.closed || parsed.data.mode !== active.mode) return;
      const control = { type: 'naidan-image-preview-control-v1' as const, runId: active.runId, revision: ++active.revision, settings: parsed.data };
      active.enabled = parsed.data.enabled;
      postWorkerNotification({ endpoint: active.state.worker, schema: previewControlSchema, value: control });
    },
    release,
    dispose() {
      if (disposed) return; disposed = true; release({ reason: 'page-exit' });
    },
  };
}
export const TEST_ONLY = {
};
