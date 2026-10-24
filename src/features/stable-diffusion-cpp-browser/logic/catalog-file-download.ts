import { saveHuggingFaceFile } from '@/logic/hugging-face-download/file';
import type { ImageFileIdentity } from './catalog-source';
import type { CatalogFetch } from '@/features/stable-diffusion-cpp-browser/download-worker/fetch-types';
import type { ImageDownloadDestination } from './catalog-download';
export type { FileTransferProgress } from '@/logic/hugging-face-download/file';
import type { FileTransferProgress } from '@/logic/hugging-face-download/file';

export function saveImageCatalogFile({ file, signal, report, fetch, destination }: {
  file: ImageFileIdentity, signal: AbortSignal, report: ({ progress }: { progress: FileTransferProgress }) => void, fetch: CatalogFetch, destination?: ImageDownloadDestination,
}): Promise<void> {
  return saveHuggingFaceFile({ file, signal, report, fetch, destination, expectedRoot: undefined, validation: 'model-weight' });
}

export const TEST_ONLY = {
};
