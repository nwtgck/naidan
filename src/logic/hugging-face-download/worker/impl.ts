import { receivePrivacyStream } from '@/features/privacy-fetch/stream-port';
import { acquireHuggingFaceFiles } from '@/logic/hugging-face-download/acquire';
import { verifyStorage } from '@/features/llama-cpp-browser/runtime/shared-storage-probe';
import type { WorkerServerApi } from '@/utils/worker-transport';
import type { FileDownloadWorker } from './types';

export function createFileDownloadWorker(): WorkerServerApi<FileDownloadWorker> {
  let active: AbortController | undefined;
  return {
    // eslint-disable-next-line local-rules-named-args/require-named-args -- Worker transport callbacks are separate proxied arguments.
    async download({ files, destination, expectedRoot, validation }, onProgress, fetch) {
      if (active) {
        throw new Error('File download Worker is busy');
      }
      const controller = new AbortController();
      active = controller;
      try {
        await acquireHuggingFaceFiles({
          files,
          destination,
          expectedRoot,
          validation,
          signal: controller.signal,
          fetch: async ({ request }) => {
            controller.signal.throwIfAborted();
            const port = await fetch({ request: { url: request.url, headers: request.headers } });
            return receivePrivacyStream({ port, signal: controller.signal, onFinish() {} }).response;
          },
          onProgress: ({ progress }) => {
            try {
              void Promise.resolve(onProgress({ progress })).catch(() => undefined);
            } catch { /* Notifications do not control publication. */ }
          },
        });
      } finally {
        active = undefined;
      }
    },
    cancel() {
      active?.abort();
    },
    verifyStorage,
  };
}

export const TEST_ONLY = {
};
