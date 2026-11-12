import type { WorkerModelFile as ModelFile } from './model-transport-schema';

// This is resident-cache invalidation, not public identity protection. Reusing a
// temporary name must load its current files, even when size/mtime are identical.
export async function sameModelFile({ previous, next }: { previous: ModelFile, next: ModelFile }): Promise<boolean> {
  if ('snapshotId' in previous || 'snapshotId' in next) {
    return 'snapshotId' in previous && 'snapshotId' in next && previous.storageKind === next.storageKind && previous.snapshotId === next.snapshotId;
  }
  if (previous.storageKind === 'temp' || next.storageKind === 'temp') {
    return previous.storageKind === 'temp' && next.storageKind === 'temp' && previous.registrationRevision === next.registrationRevision;
  }
  return previous.storageKind === next.storageKind && previous.handle.isSameEntry(next.handle);
}


export const TEST_ONLY = {
};
