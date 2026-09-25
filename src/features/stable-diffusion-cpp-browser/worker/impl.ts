import { createImageTrace, sanitizeImageLog, type ImageDiagnosticListener } from '@/features/stable-diffusion-cpp-browser/diagnostics';
import { observeImageGpu } from './gpu-diagnostics';
import type { WorkerServerApi } from '@/utils/worker-transport';
import { getProfileConfiguration, requestSchema, responseSchema, progressSchema, type Progress } from '@/features/stable-diffusion-cpp-browser/types';
import type { ImageWorker } from './types';
import { runImageGeneration } from './session';
import { loadCoreFactory } from './core-loader';
import type { SyncBlobReader } from './gguf-file';
// Worker-only standard API; keep its declaration scoped to this module.
declare const FileReaderSync: { new (): SyncBlobReader };

/** One call per dedicated Worker. Cancelling terminates the Worker, not a second C call. */
export function createImageWorker({ reportDiagnostic }: { reportDiagnostic: ImageDiagnosticListener | undefined }): WorkerServerApi<ImageWorker> {
  let used = false;
  return {
    // eslint-disable-next-line local-rules-named-args/require-named-args -- Top-level callback transfer is required by the Comlink wire contract.
    async generate(rawRequest, report) {
      if (used) throw new Error('Image workers are single-use');
      used = true;
      const request = requestSchema.parse(rawRequest);
      const diagnostics: string[] = [];
      const secrets = [request.parameters.prompt, request.parameters.negativePrompt, request.parameters.modelArguments];
      const trace = createImageTrace({ debug: request.debug ?? 'off', secrets, listener: reportDiagnostic, now: () => performance.now() });
      const observed = (() => {
        switch (request.debug) {
        case 'on': return observeImageGpu({ emit: trace.emit });
        case 'off': case undefined: return undefined;
        default: { const exhaustive: never = request.debug; throw new Error(String(exhaustive)); }
        }
      })();
      trace.emit({ event: 'request', stage: 'worker', message: undefined, fields: {
        profile: request.artifact.profile, source: request.artifact.modulePath.split('/')[1]!, schema: request.artifact.schemaSha256,
        debug: request.debug ?? 'off', models: request.models.length, modelBytes: request.models.reduce((n, model) => n + model.file.size + (model.companions ?? []).reduce((m, file) => m + file.file.size, 0), 0),
        width: request.parameters.width, height: request.parameters.height, steps: request.parameters.steps, gpuBudgetMiB: request.gpuBudgetMiB ?? 'unset', weightResidency: request.weightResidency,
        guidance: request.parameters.guidance, sampler: request.parameters.sampler, scheduler: request.parameters.scheduler, seed: request.parameters.seed,
        flashAttention: request.parameters.flashAttention, vaeTiling: request.parameters.vaeTiling, vaeTileSize: request.parameters.vaeTileSize,
      } });
      let phase: Progress['phase'] = 'runtime';
      const log = ({ message, level }: { message: string, level?: number }) => {
        trace.native({ message, level });
        diagnostics.push(sanitizeImageLog({ message, secrets }).slice(0, 1024));
        if (diagnostics.length > 24) diagnostics.shift();
      };
      const notify = ({ event }: { event: Progress }) => {
        phase = event.phase;
        switch (phase) {
        case 'sampling': trace.emit({ event: 'progress', stage: 'sampling', message: undefined, fields: { step: event.step, steps: event.steps } }); break;
        case 'runtime': case 'model': case 'encoding': break;
        default: { const exhaustive: never = phase; throw new Error(String(exhaustive)); }
        }
        // The renderer may disappear during native work. Progress is not a control channel.
        try {
          Promise.resolve(report({ event: progressSchema.parse(event) })).catch(() => undefined);
        } catch { /* disposed */ }
      };
      try {
        if (typeof FileReaderSync !== 'function') throw new Error('Synchronous file reading is unavailable in this Worker');
        if (!('gpu' in navigator)) throw new Error('WebGPU is unavailable in this Worker');
        notify({ event: { phase: 'runtime', step: 0, steps: 0 } });
        trace.emit({ event: 'start', stage: 'runtime-fetch', message: undefined, fields: {} });
        const { create, wasmBinary, moduleUrl, helpers } = await loadCoreFactory({ artifact: request.artifact, baseUrl: request.baseUrl });
        trace.emit({ event: 'complete', stage: 'runtime-fetch', message: undefined, fields: { bytes: wasmBinary.length } });
        trace.emit({ event: 'start', stage: 'runtime-init', message: undefined, fields: {} });
        const module = await create({
          wasmBinary,
          // eslint-disable-next-line local-rules-named-args/require-named-args -- External Emscripten callback signature.
          locateFile(name) {
            if (name !== 'core.wasm') throw new Error('Unexpected image runtime side file');
            return new URL(name, moduleUrl).href;
          },
          // eslint-disable-next-line local-rules-named-args/require-named-args -- External Emscripten callback signature.
          print(message) {
            log({ message });
          },
          // eslint-disable-next-line local-rules-named-args/require-named-args -- External Emscripten callback signature.
          printErr(message) {
            log({ message });
          },
        });
        trace.emit({ event: 'complete', stage: 'runtime-init', message: undefined, fields: { wasmBytes: module.HEAPU8?.byteLength ?? 0, ioCapabilities: module._sdc_model_io_capabilities?.() ?? 0 } });
        if (module._sdc_abi_version() !== 2) throw new Error('Image core ABI 2 is required for unsplit GGUF');
        const profile = getProfileConfiguration({ profile: request.artifact.profile });
        const core = helpers.attachCore(module, helpers.schema, { suspension: profile.suspension });
        const expectedWidth = profile.pointerBytes;
        if (core.pointerBytes !== expectedWidth) throw new Error('Image profile pointer width mismatch');
        const { pixels, width, height, modelVersion } = await runImageGeneration({
          core, helpers, request, reader: new FileReaderSync(), onProgress: notify, onLog: log, onDiagnostic: trace.emit,
        });
        notify({ event: { phase: 'encoding', step: 0, steps: 0 } });
        trace.emit({ event: 'start', stage: 'encoding', message: undefined, fields: {} });
        const canvas = new OffscreenCanvas(width, height);
        const context = canvas.getContext('2d');
        if (!context) throw new Error('Cannot encode the generated image');
        context.putImageData(new ImageData(pixels, width, height), 0, 0);
        const png = await canvas.convertToBlob({ type: 'image/png' });
        trace.emit({ event: 'complete', stage: 'encoding', message: undefined, fields: { pngBytes: png.size } });
        return responseSchema.parse({ png, width, height, modelVersion });
      } catch (error) {
        const message = sanitizeImageLog({ message: error instanceof Error ? error.message : String(error), secrets });
        trace.emit({ event: 'failed', stage: 'worker', message, fields: { phase } });
        const source = request.artifact.modulePath.split('/')[1];
        throw new Error([
          `Image generation failed: phase=${phase}, profile=${request.artifact.profile}, source=${source}`,
          message, ...diagnostics,
        ].join('\n'));
      } finally {
        observed?.dispose();
      }
    },
  };
}
export const TEST_ONLY = {
};
