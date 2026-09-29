import type { ImageDownloadFetch } from './fetch-types';
import type { WorkerProxy } from '@/utils/worker-transport';
import type { ImageRecipeFile } from '@/features/stable-diffusion-cpp-browser/model-recipes';
import type { CatalogDownloadProgress } from '@/features/stable-diffusion-cpp-browser/logic/catalog-download';
export type ImageDownloadWorker = {
  // eslint-disable-next-line local-rules-named-args/require-named-args -- Comlink callbacks must be top-level arguments.
  download(input: { files: ImageRecipeFile[] }, onProgress: WorkerProxy<({ progress }: { progress: CatalogDownloadProgress }) => void>, fetch: WorkerProxy<ImageDownloadFetch>): Promise<void>,
  cancel(): void,
};
export const TEST_ONLY = {
};
