import { downloadHuggingFaceFiles } from '@/logic/hugging-face-download/client';
import type { ImageRecipeDownloadRequest } from '@/features/stable-diffusion-cpp-browser/logic/catalog-download';

export function downloadImageRecipeInWorker({ files, signal, onProgress, destination, expectedRoot }: {
  files: ImageRecipeDownloadRequest['files'], signal: AbortSignal, onProgress: ImageRecipeDownloadRequest['onProgress'], destination?: ImageRecipeDownloadRequest['destination'], expectedRoot?: FileSystemDirectoryHandle,
}): Promise<void> {
  return downloadHuggingFaceFiles({ files, signal, onProgress, destination, expectedRoot, validation: 'model-weight' });
}

export const TEST_ONLY = {
};
