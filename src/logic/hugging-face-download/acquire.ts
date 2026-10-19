import type { DownloadFetch } from './fetch-types';
import { z } from 'zod';
import { resolveHuggingFaceFile, huggingFaceSourceSchema, type HuggingFaceSource } from './source';
import { saveHuggingFaceFile } from './file';
import { migrateLegacyDownloads } from './legacy';

import type { FileDownloadProgress } from './progress';
export type { FileDownloadProgress } from './progress';
type Report = ({ progress }: { progress: FileDownloadProgress }) => void;
import type { DownloadDestination } from '@/01-models/download';
export type { DownloadDestination } from '@/01-models/download';
export type HuggingFaceDownloadRequest = { files: readonly (HuggingFaceSource & { expectedSize?: number })[], signal: AbortSignal, onProgress: Report, destination?: DownloadDestination };
export type HuggingFaceDownloader = ({ files, signal, onProgress }: { files: HuggingFaceDownloadRequest['files'], signal: HuggingFaceDownloadRequest['signal'], onProgress: HuggingFaceDownloadRequest['onProgress'], destination?: HuggingFaceDownloadRequest['destination'] }) => Promise<void>;

function notify({ report, progress }: { report: Report, progress: FileDownloadProgress }): void {
  try {
    report({ progress });
  } catch { /* Presentation cannot control storage. */ }
}

/** Explicit acquisition only. Metadata discovery, transfer, verification and
 * publication run in a Worker. A completed file survives failures in later
 * components; pending files can only be resumed by another explicit action.
 * File acquisition is role-independent, including optional adapter downloads.
 */
export async function acquireHuggingFaceFiles({ files, signal, onProgress, fetch, destination, expectedRoot, validation }: { files: HuggingFaceDownloadRequest['files'], signal: HuggingFaceDownloadRequest['signal'], onProgress: HuggingFaceDownloadRequest['onProgress'], fetch: DownloadFetch, destination?: HuggingFaceDownloadRequest['destination'], expectedRoot: FileSystemDirectoryHandle | undefined, validation: 'model-weight' | 'none' }): Promise<void> {
  z.array(huggingFaceSourceSchema).min(1).max(4096).parse(files);
  if (new Set(files.map(file => `${file.repository}/${file.path}`)).size !== files.length) {
    throw new Error('Duplicate catalog file');
  }
  if (!navigator.locks || (destination?.kind !== 'host' && !navigator.storage?.getDirectory)) {
    throw new Error('Safe model download storage is unavailable');
  }
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
        revision: file.revision,
        completed: 0,
        total: 0,
        processed: 0,
        fileCompleted: 0,
        fileTotal: 0,
      },
    });
    const identity = await resolveHuggingFaceFile({ file, signal, fetch });
    if (file.expectedSize !== undefined && identity.size !== file.expectedSize) {
      throw new Error('Download metadata differs from the selected file size');
    }
    planned.push(identity);
  }
  const total = planned.reduce((sum, file) => sum + file.size, 0);
  if (!Number.isSafeInteger(total)) {
    throw new Error('Catalog total exceeds exact byte accounting');
  }
  await migrateLegacyDownloads({ files: planned, destination: destination ?? { kind: 'opfs' }, expectedRoot, signal });
  let completed = 0, processed = 0;
  for (const [index, file] of planned.entries()) {
    let reported = -Infinity, fileProcessed = 0;
    await saveHuggingFaceFile({
      file,
      signal,
      fetch,
      destination,
      expectedRoot,
      validation,
      report: ({ progress }) => {
        fileProcessed = progress.processed;
        if (performance.now() - reported < 150 && progress.bytes !== file.size) {
          return;
        }
        reported = performance.now();
        notify({
          report: onProgress,
          progress: {
            phase: progress.phase,
            index,
            count: files.length,
            path: file.path,
            repository: file.repository,
            revision: file.revision,
            completed: completed + progress.bytes,
            total,
            processed: processed + progress.processed,
            fileCompleted: progress.bytes,
            fileTotal: file.size,
          },
        });
      },
    });
    completed += file.size;
    processed += fileProcessed;
    notify({
      report: onProgress,
      progress: {
        phase: 'complete',
        index,
        count: files.length,
        path: file.path,
        repository: file.repository,
        revision: file.revision,
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
