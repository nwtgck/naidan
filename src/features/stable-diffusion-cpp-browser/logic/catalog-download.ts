import type { CatalogFetch } from '@/features/stable-diffusion-cpp-browser/download-worker/fetch-types';
import { z } from 'zod';
import { imageFileIdentity, imageDownloadSourceSchema, type ImageDownloadSource } from './catalog-source';
import { saveImageCatalogFile } from './catalog-file-download';

import type { CatalogDownloadProgress } from '@/features/stable-diffusion-cpp-browser/download-worker/progress';
export type { CatalogDownloadProgress } from '@/features/stable-diffusion-cpp-browser/download-worker/progress';
type Report = ({ progress }: { progress: CatalogDownloadProgress }) => void;
export type ImageDownloadDestination = { kind: 'opfs' } | { kind: 'host', directoryId: string };
export type ImageRecipeDownloadRequest = { files: readonly ImageDownloadSource[], signal: AbortSignal, onProgress: Report, destination?: ImageDownloadDestination };
export type ImageRecipeDownloader = ({ files, signal, onProgress }: { files: ImageRecipeDownloadRequest['files'], signal: ImageRecipeDownloadRequest['signal'], onProgress: ImageRecipeDownloadRequest['onProgress'], destination?: ImageRecipeDownloadRequest['destination'] }) => Promise<void>;

function notify({ report, progress }: { report: Report, progress: CatalogDownloadProgress }): void {
  try {
    report({ progress });
  } catch { /* Presentation cannot control storage. */ }
}

/** Explicit acquisition only. Metadata discovery, transfer, verification and
 * publication run in a Worker. A completed file survives failures in later
 * components; pending files can only be resumed by another explicit action.
 * File acquisition is role-independent, including optional adapter downloads.
 */
export async function downloadImageRecipe({ files, signal, onProgress, fetch, destination }: { files: ImageRecipeDownloadRequest['files'], signal: ImageRecipeDownloadRequest['signal'], onProgress: ImageRecipeDownloadRequest['onProgress'], fetch: CatalogFetch, destination?: ImageRecipeDownloadRequest['destination'] }): Promise<void> {
  z.array(imageDownloadSourceSchema).min(1).max(16).parse(files);
  if (new Set(files.map(file => `${file.repository}/${file.path}`)).size !== files.length) throw new Error('Duplicate catalog file');
  if (!navigator.locks || (destination?.kind !== 'host' && !navigator.storage?.getDirectory)) throw new Error('Safe model download storage is unavailable');
  const planned = [];
  for (const [index, file] of files.entries()) {
    notify({
      report: onProgress,
      progress: {
        phase: 'checking',
        index,
        count: files.length,
        path: file.path,
        repository: file.repository,
        completed: 0,
        total: 0,
        processed: 0,
        fileCompleted: 0,
        fileTotal: 0,
      },
    });
    planned.push(await imageFileIdentity({ file, signal, fetch }));
  }
  const total = planned.reduce((sum, file) => sum + file.size, 0);
  if (!Number.isSafeInteger(total)) throw new Error('Catalog total exceeds exact byte accounting');
  let completed = 0, processed = 0;
  for (const [index, file] of planned.entries()) {
    let reported = -Infinity, fileProcessed = 0;
    await saveImageCatalogFile({
      file,
      signal,
      fetch,
      destination,
      report: ({ progress }) => {
        fileProcessed = progress.processed;
        if (performance.now() - reported < 150 && progress.bytes !== file.size) return;
        reported = performance.now();
        notify({
          report: onProgress,
          progress: {
            phase: progress.phase,
            index,
            count: files.length,
            path: file.path,
            repository: file.repository,
            completed: completed + progress.bytes,
            total,
            processed: processed + progress.processed,
            fileCompleted: progress.bytes,
            fileTotal: file.size,
          },
        });
      },
    });
    completed += file.size; processed += fileProcessed;
    notify({
      report: onProgress,
      progress: {
        phase: index === planned.length - 1 ? 'complete' : 'verifying',
        index,
        count: files.length,
        path: file.path,
        repository: file.repository,
        completed,
        total,
        processed,
        fileCompleted: file.size,
        fileTotal: file.size,
      },
    });
  }
}

export const TEST_ONLY = {
};
