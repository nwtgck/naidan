import type { WorkerServerApi } from '@/utils/worker-transport';
import { getProfileConfiguration, requestSchema, responseSchema, progressSchema, type Progress } from '@/features/stable-diffusion-cpp-browser/types';
import type { ImageWorker } from './types';
import { runImageGeneration } from './session';
import { loadCoreFactory } from './core-loader';
import type { SyncBlobReader } from './gguf-file';
// Worker-only standard API; keep its declaration scoped to this module.
declare const FileReaderSync: { new (): SyncBlobReader };

/** One call per dedicated Worker. Cancelling terminates the Worker, not a second C call. */
export function createImageWorker(): WorkerServerApi<ImageWorker> {
  let used = false;
  return {
    // eslint-disable-next-line local-rules-named-args/require-named-args -- Top-level callback transfer is required by the Comlink wire contract.
    async generate(rawRequest, report) {
      if (used) throw new Error('Image workers are single-use');
      used = true;
      const request = requestSchema.parse(rawRequest);
      const diagnostics: string[] = [];
      let phase: Progress['phase'] = 'runtime';
      const log = ({ message }: { message: string }) => {
        diagnostics.push(message.slice(0, 1024));
        if (diagnostics.length > 24) diagnostics.shift();
      };
      const notify = ({ event }: { event: Progress }) => {
        phase = event.phase;
        // The renderer may disappear during native work. Progress is not a control channel.
        try {
          Promise.resolve(report({ event: progressSchema.parse(event) })).catch(() => undefined);
        } catch { /* disposed */ }
      };
      try {
        if (typeof FileReaderSync !== 'function') throw new Error('Synchronous file reading is unavailable in this Worker');
        if (!('gpu' in navigator)) throw new Error('WebGPU is unavailable in this Worker');
        notify({ event: { phase: 'runtime', step: 0, steps: 0 } });
        const { create, wasmBinary, moduleUrl, helpers } = await loadCoreFactory({ artifact: request.artifact, baseUrl: request.baseUrl });
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
        if (module._sdc_abi_version() !== 2) throw new Error('Image core ABI 2 is required for unsplit GGUF');
        const profile = getProfileConfiguration({ profile: request.artifact.profile });
        const core = helpers.attachCore(module, helpers.schema, { suspension: profile.suspension });
        const expectedWidth = profile.pointerBytes;
        if (core.pointerBytes !== expectedWidth) throw new Error('Image profile pointer width mismatch');
        const { pixels, width, height, modelVersion } = await runImageGeneration({
          core, helpers, request, reader: new FileReaderSync(), onProgress: notify, onLog: log,
        });
        notify({ event: { phase: 'encoding', step: 0, steps: 0 } });
        const canvas = new OffscreenCanvas(width, height);
        const context = canvas.getContext('2d');
        if (!context) throw new Error('Cannot encode the generated image');
        context.putImageData(new ImageData(pixels, width, height), 0, 0);
        const png = await canvas.convertToBlob({ type: 'image/png' });
        return responseSchema.parse({ png, width, height, modelVersion });
      } catch (error) {
        const message = (error instanceof Error ? error.message : String(error)).slice(0, 4096);
        const source = request.artifact.modulePath.split('/')[1];
        throw new Error([
          `Image generation failed: phase=${phase}, profile=${request.artifact.profile}, source=${source}`,
          message, ...diagnostics,
        ].join('\n'));
      }
    },
  };
}
export const TEST_ONLY = {
};
