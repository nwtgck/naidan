import { downloadHuggingFaceFiles } from '@/logic/hugging-face-download/client';
import { withDestinationLock, type ModelDestination } from '@/features/llama-cpp-browser/runtime/model-destination';
import { deleteRepository, withRepositoryLock } from './storage';
import type { DeletionPlan, DeletionResult } from '@/features/llama-cpp-browser/runtime/deletion-plan';
import { DownloadConflictError, selectionSchema, type DownloadSelection, type DownloadProgress } from './types';
export { responseOffset } from './download-response';

/** Selection remains engine-owned; transfer, verification and publication do not. */
export async function downloadRepository({ selection, signal, onProgress, destination, expectedRoot }: {
  selection: DownloadSelection, signal: AbortSignal, onProgress: ({ progress }: { progress: DownloadProgress }) => void,
  destination?: ModelDestination, expectedRoot?: FileSystemDirectoryHandle,
}): Promise<void> {
  selection = selectionSchema.parse(selection);
  const fileProgress: NonNullable<DownloadProgress['fileProgress']> = selection.files.map(file => ({ completed: 0, total: file.size, state: 'queued' }));
  try {
    await downloadHuggingFaceFiles({
      files: selection.files.map(file => ({ repository: selection.repository, revision: selection.revision, path: file.path, expectedSize: file.size })),
      destination,
      expectedRoot,
      validation: 'model-weight',
      signal,
      onProgress: ({ progress }) => {
        const current = fileProgress[progress.index];
        if (!current) {
          throw new Error('Unexpected file progress');
        }
        fileProgress[progress.index] = { completed: progress.fileCompleted, total: progress.fileTotal || current.total, state: progress.phase };
        onProgress({
          progress: {
            phase: (() => {
              switch (progress.phase) {
              case 'transferring': return 'transferring';
              case 'checking': case 'verifying': case 'complete': return 'verifying';
              default: {
                const exhaustive: never = progress.phase;
                throw new Error(String(exhaustive));
              }
              }
            })(),
            currentFileIndex: progress.index,
            processed: progress.processed,
            completed: fileProgress.reduce((sum, file) => sum + file.completed, 0),
            total: fileProgress.reduce((sum, file) => sum + file.total, 0),
            fileProgress: fileProgress.map(file => ({ ...file })),
          },
        });
      },
    });
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('Existing file differs')) {
      throw new DownloadConflictError({ reason: 'existing-files' });
    }
    throw error;
  }
}

export async function cancelDownload({ repository, plan, destination }: { repository: string, plan: DeletionPlan, destination?: ModelDestination }): Promise<DeletionResult> {
  return withDestinationLock({ destination, operation: () => withRepositoryLock({ repository, operation: () => deleteRepository({ repository, plan, destination }) }) });
}

export const TEST_ONLY = {
};
