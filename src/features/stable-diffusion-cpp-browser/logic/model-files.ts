import type { ModelSlot, Request } from '@/features/stable-diffusion-cpp-browser/types';
import type { ModelCandidate } from './model-candidates';
import { imageModelLocation } from './model-location';

export function modelForImageCandidate({ slot, candidate }: { slot: ModelSlot, candidate: ModelCandidate }): Request['models'][number] {
  const file = candidate.files.find(entry => entry.relativePath === candidate.primaryRelativePath);
  if (!file) {
    throw new Error('Selected model file disappeared from the inventory');
  }
  // Preserve publication identity and shard membership; never copy weight bytes.
  // Host files can change outside Naidan. Fresh File snapshots deliberately
  // invalidate retained-model identity, even when an old receipt still matches.
  const modelFilesReuseKey = imageModelLocation({ repositoryKey: candidate.repositoryKey, hostSource: candidate.hostSource, relativePath: candidate.primaryRelativePath }).kind === 'opfs' && candidate.repositoryKey.startsWith('huggingface.co/') && candidate.files.every(entry => !entry.receipt || entry.receipt.source.kind === 'hugging-face') ? JSON.stringify({
    repository: candidate.repositoryKey,
    path: candidate.primaryRelativePath,
    files: candidate.files.map(entry => ({ relativePath: entry.relativePath, size: entry.file.size, modified: entry.file.lastModified, receipt: entry.receipt ?? null })),
  }) : undefined;
  return { slot, ...(modelFilesReuseKey ? { modelFilesReuseKey } : {}), file: file.file, relativePath: candidate.primaryRelativePath, companions: candidate.files.filter(entry => entry.relativePath !== candidate.primaryRelativePath).map(({ relativePath, file }) => ({ relativePath, file })) };
}

export const TEST_ONLY = {
};
