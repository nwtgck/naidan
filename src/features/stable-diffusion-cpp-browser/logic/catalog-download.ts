import { z } from 'zod';
import { acquireHuggingFaceFiles } from '@/logic/hugging-face-download/acquire';
import type { CatalogFetch } from '@/features/stable-diffusion-cpp-browser/download-worker/fetch-types';
import { imageDownloadSourceSchema, type ImageDownloadSource } from './catalog-source';
import type { CatalogDownloadProgress } from '@/features/stable-diffusion-cpp-browser/download-worker/progress';
export type { CatalogDownloadProgress } from '@/features/stable-diffusion-cpp-browser/download-worker/progress';
export type { DownloadDestination as ImageDownloadDestination } from '@/01-models/download';
import type { DownloadDestination } from '@/01-models/download';
export type ImageRecipeDownloadRequest = {
  files: readonly ImageDownloadSource[], signal: AbortSignal,
  onProgress: ({ progress }: { progress: CatalogDownloadProgress }) => void,
  destination?: DownloadDestination, expectedRoot?: FileSystemDirectoryHandle,
};
export type ImageRecipeDownloader = ({ files, signal, onProgress, destination, expectedRoot }: {
  files: ImageRecipeDownloadRequest['files'], signal: AbortSignal, onProgress: ImageRecipeDownloadRequest['onProgress'], destination?: DownloadDestination, expectedRoot?: FileSystemDirectoryHandle,
}) => Promise<void>;

export async function downloadImageRecipe({ files, signal, onProgress, fetch, destination, expectedRoot }: {
  files: ImageRecipeDownloadRequest['files'], signal: AbortSignal, onProgress: ImageRecipeDownloadRequest['onProgress'], fetch: CatalogFetch, destination?: DownloadDestination, expectedRoot?: FileSystemDirectoryHandle,
}): Promise<void> {
  z.array(imageDownloadSourceSchema).min(1).max(16).parse(files);
  await acquireHuggingFaceFiles({ files, signal, onProgress, fetch, destination, expectedRoot, validation: 'model-weight' });
}

export const TEST_ONLY = {
};
