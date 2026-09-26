import { createImageTrace, sanitizeImageLog, imageErrorContext, type ImageDiagnosticInput, type ImageDiagnosticListener } from '@/features/stable-diffusion-cpp-browser/diagnostics';
import { observeImageGpu } from './gpu-diagnostics';
import { installImageWebGpu } from './webgpu';
import { releaseWorkerRemote, type WorkerRemote, type WorkerServerApi } from '@/utils/worker-transport';
import { getProfileConfiguration, requestSchema, responseSchema, progressSchema, previewControlSchema, previewFrameSchema, cancelControlSchema, cancelledResultSchema,
  type Progress, type PreviewFrame, type PreviewControl, type Request } from '@/features/stable-diffusion-cpp-browser/types';
import type { ImageWorker, Report } from './types';
import { createImageGenerationSession } from './session';
import { createPreviewOutput } from './preview-output';
import { encodeImagePixels } from './image-output';
import { loadCoreFactory } from './core-loader';
import type { SyncBlobReader } from './gguf-file';
declare const FileReaderSync: { new (): SyncBlobReader };

/** Long-lived only after success. A failed instance is terminal; the window
 * owns physical Worker termination and never automatically retries generation. */
export function createImageWorker({ reportDiagnostic, reportPreview }: {
  reportDiagnostic: ImageDiagnosticListener | undefined,
  reportPreview?: ({ frame }: { frame: PreviewFrame }) => void,
}): WorkerServerApi<ImageWorker> {
  let busy = false, failed = false, identity: string | undefined;
  let session: ReturnType<typeof createImageGenerationSession> | undefined;
  let observed: ReturnType<typeof observeImageGpu> | undefined, boundary: ReturnType<typeof installImageWebGpu> | undefined;
  let current: { request: Request, trace: ReturnType<typeof createImageTrace>, phase: Progress['phase'], latest: PreviewControl, cancelRequested: boolean,
    log: ({ message, level }: { message: string, level?: number }) => void } | undefined;
  const emitCurrent = ({ ...entry }: ImageDiagnosticInput) => {
    if (entry.event === 'gpu' && /^(?:uncaptured GPU error:|device lost:|GPU error scope:)/.test(entry.message ?? '')) failed = true;
    if (current) current.trace.emit(entry);
    else if (entry.event === 'failed' || entry.event === 'gpu' && /^(?:uncaptured GPU error:|device lost:|GPU error scope:)/.test(entry.message ?? '')) {
      failed = true;
      try {
        reportDiagnostic?.({ diagnostic: { ...entry, message: (() => {
          switch (entry.event) {
          case 'failed': return 'Image runtime failed while idle';
          case 'gpu': return sanitizeImageLog({ message: entry.message ?? '', secrets: [] });
          default: { const exhaustive: never = entry.event; throw new Error(String(exhaustive)); }
          }
        })(), elapsedMs: 0 } });
      } catch { /* observational */ }
    }
  };
  const api: WorkerServerApi<ImageWorker> = {
    // eslint-disable-next-line local-rules-named-args/require-named-args -- Top-level Comlink callback transfer.
    async generate(rawRequest, report) {
      if (busy || failed) throw new Error('Image worker is busy or failed; replace it before generating');
      const request = requestSchema.parse(rawRequest);
      const key = JSON.stringify({ sessionId: request.sessionId, artifact: request.artifact, baseUrl: request.baseUrl });
      if (identity !== undefined && key !== identity) throw new Error('Replace the Worker before changing image models or runtime');
      identity = key; busy = true;
      const diagnostics: string[] = [], secrets = [request.parameters.prompt, request.parameters.negativePrompt, request.parameters.modelArguments];
      const trace = createImageTrace({ debug: request.debug ?? 'off', secrets, listener: reportDiagnostic ? ({ diagnostic }) => reportDiagnostic({ diagnostic: { ...diagnostic, fields: { ...diagnostic.fields, runId: request.runId } } }) : undefined, now: () => performance.now() });
      const log = ({ message, level }: { message: string, level?: number }) => {
        trace.native({ message, level }); diagnostics.push(sanitizeImageLog({ message, secrets }).slice(0, 1024));
        if (diagnostics.length > 24) diagnostics.shift();
      };
      current = { request, trace, cancelRequested: false, phase: 'runtime', latest: { type: 'naidan-image-preview-control-v1', runId: request.runId, revision: 0, settings: request.preview }, log };
      const operation = current;
      const previews = createPreviewOutput({
        publish({ frame }) {
          reportPreview?.({ frame: previewFrameSchema.parse(frame) });
        },
        valid: ({ revision }) => current === operation && !operation.cancelRequested && operation.latest.settings.enabled && operation.latest.revision === revision,
        onError({ error }) {
          trace.emit({ event: 'native', stage: 'encoding', message: 'Preview encoding failed; final generation continues', fields: imageErrorContext({ error }) });
        },
      });
      const notify = ({ event }: { event: Progress }) => {
        operation.phase = event.phase;
        // Handles controls received while runtime/model initialization was pending.
        if (operation.cancelRequested) session?.cancel({ control: { type: 'naidan-image-cancel-v1', runId: request.runId } });
        else if (operation.latest.revision) session?.updatePreview({ control: operation.latest });
        if (event.phase === 'sampling' || event.phase === 'decoding') trace.emit({ event: 'progress', stage: event.phase, message: undefined, fields: { step: event.step, steps: event.steps } });
        try {
          Promise.resolve(report({ event: progressSchema.parse(event) })).catch(() => undefined);
        } catch { /* renderer gone */ }
      };
      trace.emit({ event: 'request', stage: 'worker', message: undefined, fields: {
        profile: request.artifact.profile, source: request.artifact.modulePath.split('/')[1]!, schema: request.artifact.schemaSha256,
        debug: request.debug ?? 'off', models: request.models.length, width: request.parameters.width, height: request.parameters.height,
        steps: request.parameters.steps, gpuBudgetMiB: request.gpuBudgetMiB ?? 'unset', weightResidency: request.weightResidency,
        guidance: request.parameters.guidance, sampler: request.parameters.sampler, scheduler: request.parameters.scheduler, seed: request.parameters.seed,
        flashAttention: request.parameters.flashAttention, vaeTiling: request.parameters.vaeTiling, vaeTileSize: request.parameters.vaeTileSize,
        previewEnabled: request.preview.enabled, previewMode: request.preview.mode, previewInterval: request.preview.interval, reuse: !!session,
      } });
      try {
        if (!session) {
          if (typeof FileReaderSync !== 'function') throw new Error('Synchronous file reading is unavailable in this Worker');
          if (!navigator.gpu?.requestAdapter) throw new Error('WebGPU is unavailable in this Worker');
          observed = observeImageGpu({ emit: emitCurrent, debug: request.debug ?? 'off' });
          boundary = installImageWebGpu({ gpu: navigator.gpu, emit: emitCurrent });
          notify({ event: { phase: 'runtime', step: 0, steps: 0 } });
          trace.emit({ event: 'start', stage: 'runtime-fetch', message: undefined, fields: {} });
          const { create, wasmBinary, moduleUrl, helpers } = await loadCoreFactory({ artifact: request.artifact, baseUrl: request.baseUrl });
          trace.emit({ event: 'complete', stage: 'runtime-fetch', message: undefined, fields: { bytes: wasmBinary.length } });
          trace.emit({ event: 'start', stage: 'runtime-init', message: undefined, fields: {} });
          const module = await create({ wasmBinary,
            // eslint-disable-next-line local-rules-named-args/require-named-args -- Emscripten callback signature.
            locateFile(name) {
              if (name !== 'core.wasm') throw new Error('Unexpected image runtime side file');
              return new URL(name, moduleUrl).href;
            },
            // Permanent callbacks route to the CURRENT generation, never its predecessor's prompts or phase.
            // eslint-disable-next-line local-rules-named-args/require-named-args -- Emscripten callback signature.
            onAbort(reason) {
              failed = true;
              const phase = current?.phase ?? 'runtime';
              const stage = (() => {
                switch (phase) {
                case 'model': return 'model-load' as const;
                case 'runtime': return 'runtime-init' as const;
                case 'sampling': case 'decoding': case 'encoding': return phase;
                default: { const exhaustive: never = phase; throw new Error(String(exhaustive)); }
                }
              })();
              emitCurrent({ event: 'failed', stage, message: typeof reason === 'string' ? reason : 'Image native runtime aborted', fields: { kind: 'native-abort', phase } });
            },
            // eslint-disable-next-line local-rules-named-args/require-named-args -- Emscripten callback signature.
            print(message) {
              current?.log({ message });
            },
            // eslint-disable-next-line local-rules-named-args/require-named-args -- Emscripten callback signature.
            printErr(message) {
              current?.log({ message });
            },
          });
          trace.emit({ event: 'complete', stage: 'runtime-init', message: undefined, fields: { wasmBytes: module.HEAPU8?.byteLength ?? 0, ioCapabilities: module._sdc_model_io_capabilities?.() ?? 0 } });
          if (module._sdc_abi_version() !== 2) throw new Error('Image core ABI 2 is required for unsplit GGUF');
          const profile = getProfileConfiguration({ profile: request.artifact.profile });
          const core = helpers.attachCore(module, helpers.schema, { suspension: profile.suspension });
          if (core.pointerBytes !== profile.pointerBytes) throw new Error('Image profile pointer width mismatch');
          session = createImageGenerationSession({ core, helpers, reader: new FileReaderSync() });
        }
        const pendingGeneration = session.generate({ request, onProgress: notify, onLog: log, onDiagnostic: trace.emit,
          onPreview({ capture }) {
            previews.push({ capture: { image: capture.image, maxEdge: capture.maxEdge,
              frame: { type: 'naidan-image-preview-v1', runId: request.runId, revision: capture.revision, step: capture.step, steps: capture.steps, mode: capture.mode },
            } });
          },
        });
        if (operation.cancelRequested) session.cancel({ control: { type: 'naidan-image-cancel-v1', runId: request.runId } });
        const generated = await pendingGeneration;
        if (failed) throw new Error('Image runtime aborted during generation');
        if ('cancelled' in generated || operation.cancelRequested) {
          trace.emit({ event: 'cancelled', stage: 'worker', message: 'Generation stopped; native context retained after cleanup', fields: { modelResident: true } });
          return cancelledResultSchema.parse({ cancelled: true, modelResident: true });
        }
        const { modelVersion, uniformOutput, ...image } = generated;
        await previews.finish();
        if (failed) throw new Error('Image runtime aborted during preview encoding');
        if (previews.dropped()) trace.emit({ event: 'native', stage: 'encoding', message: 'Preview encoder dropped superseded frames to bound memory', fields: { previewFramesDropped: previews.dropped() } });
        notify({ event: { phase: 'encoding', step: 0, steps: 0 } });
        const output = await encodeImagePixels({ image, maxEdge: 0 });
        if (failed) throw new Error('Image runtime aborted during output encoding');
        trace.emit({ event: 'complete', stage: 'encoding', message: undefined, fields: { pngBytes: output.png.size, retainedContext: true, uniformOutput } });
        if (operation.cancelRequested) return cancelledResultSchema.parse({ cancelled: true, modelResident: true });
        return responseSchema.parse({ ...output, modelVersion, uniformOutput });
      } catch (error) {
        failed = true;
        // Never call session.close()/free_sd_ctx here: the native call may have
        // been interrupted. The window unconditionally terminates this Worker.
        const message = sanitizeImageLog({ message: error instanceof Error ? error.message : String(error), secrets }), details = imageErrorContext({ error });
        trace.emit({ event: 'failed', stage: 'worker', message, fields: { phase: operation.phase, ...details } });
        boundary?.dispose(); observed?.dispose();
        throw new Error([`Image generation failed: phase=${operation.phase}, profile=${request.artifact.profile}, source=${request.artifact.modulePath.split('/')[1]}`,
          message, ...(details.wasmFrames ? [`Wasm frames: ${details.wasmFrames}`] : []), ...diagnostics].join('\n'));
      } finally {
        previews.close(); current = undefined; busy = false;
        // Explicitly close the per-run Comlink callback port without awaiting a
        // renderer acknowledgement. It must not accumulate in a retained worker.
        try {
          Promise.resolve(releaseWorkerRemote({ remote: report as WorkerRemote<Report> })).catch(() => undefined);
        } catch { /* callback mock or renderer gone */ }
      }
    },
    cancel({ control }) {
      const parsed = cancelControlSchema.safeParse(control);
      if (!parsed.success || !current || failed || control.runId !== current.request.runId) return;
      current.cancelRequested = true;
      try {
        session?.cancel({ control: parsed.data });
      } catch (error) {
        failed = true;
        emitCurrent({ event: 'failed', stage: 'worker', message: 'Cooperative cancellation failed; release the runtime', fields: { kind: 'cancel-control', workerTerminationRequired: true, ...imageErrorContext({ error }) } });
      }
    },
    updatePreview({ control }) {
      const parsed = previewControlSchema.safeParse(control);
      if (!parsed.success || !current || current.cancelRequested || failed || control.runId !== current.request.runId || control.revision <= current.latest.revision || control.settings.mode !== current.request.preview.mode) return;
      // The only setter legal during native work is reviewed in preview-control.ts.
      try {
        session?.updatePreview({ control }); current.latest = control;
      } catch (error) {
        failed = true;
        emitCurrent({ event: 'failed', stage: 'worker', message: 'Live preview control failed; the runtime must be released', fields: { kind: 'preview-control', workerTerminationRequired: true, ...imageErrorContext({ error }) } });
      }
    },
  };
  return api;
}
export const TEST_ONLY = {
};
