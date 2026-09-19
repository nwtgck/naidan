import { exposeWorkerRemote } from '@/utils/worker-transport';
import type { DownloadSizeWorkerApi } from './types';
import { collectDownloadSizes } from './collect';

let used = false;
exposeWorkerRemote<DownloadSizeWorkerApi>({ endpoint: undefined, api: {
  // eslint-disable-next-line local-rules-named-args/require-named-args -- Exposed Comlink method preserves its positional request boundary.
  async collect(request) {
    if (used) return { sizes: [], quotaLimited: false };
    used = true;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5_000);
    try {
      return await collectDownloadSizes({ request, repositoryFetch: fetch, signal: controller.signal });
    } finally {
      clearTimeout(timer); controller.abort();
    }
  },
} });
export const TEST_ONLY = {
};
