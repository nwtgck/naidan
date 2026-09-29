import { receivePrivacyStream } from '@/features/privacy-fetch/stream-port';
import { downloadImageRecipe } from '@/features/stable-diffusion-cpp-browser/logic/catalog-download';
import type { WorkerServerApi } from '@/utils/worker-transport';
import type { ImageDownloadWorker } from './types';
export function createImageDownloadWorker(): WorkerServerApi<ImageDownloadWorker> {
  let active: AbortController | undefined;
  return {
    // eslint-disable-next-line local-rules-named-args/require-named-args -- Worker transport passes its proxied callback as a separate argument.
    async download({ files }, onProgress, fetch) {
      if (active) throw new Error('Image download Worker is busy');
      const controller = new AbortController(); active = controller;
      try {
        await downloadImageRecipe({ files, signal: controller.signal, fetch: async ({ request }) => {
          controller.signal.throwIfAborted();
          const port = await fetch({ request: { url: request.url, headers: request.headers } });
          const received = receivePrivacyStream({ port, signal: controller.signal, onFinish() {} });
          return received.response;
        }, onProgress: ({ progress }) => {
          try {
            void Promise.resolve(onProgress({ progress })).catch(() => undefined);
          } catch { /* notification only */ }
        } });
      } finally {
        active = undefined;
      }
    },
    cancel() {
      active?.abort();
    },
  };
}
export const TEST_ONLY = {
};
