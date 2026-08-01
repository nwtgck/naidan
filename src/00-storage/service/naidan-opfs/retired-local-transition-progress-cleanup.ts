import { NAIDAN_PERSISTENCE_CONTROL_FORMAT_CONSTANTS } from '@/00-storage/service/naidan-persistence-control/00-format';
import type { NaidanPersistenceControlExclusiveGate } from './persistence-control-exclusive-gate';

const RETIRED_LOCAL_PROGRESS_DIRECTORY_NAME = 'transition-progress';
const RETIRED_LOCAL_PROGRESS_FILE_NAMES = ['state-0.json', 'state-1.json'] as const;

function isNotFoundError({ cause }: { cause: unknown }): boolean {
  return cause instanceof DOMException
    ? cause.name === 'NotFoundError'
    : cause instanceof Error
      && (cause.name === 'NotFoundError' || cause.message.startsWith('NotFoundError'));
}

async function removeKnownRetiredFiles({ storageRoot }: {
  storageRoot: FileSystemDirectoryHandle;
}): Promise<void> {
  let collection: FileSystemDirectoryHandle;
  let progressDirectory: FileSystemDirectoryHandle;
  try {
    collection = await storageRoot.getDirectoryHandle(
      NAIDAN_PERSISTENCE_CONTROL_FORMAT_CONSTANTS.storage.collectionDirectoryName,
      { create: false },
    );
    progressDirectory = await collection.getDirectoryHandle(
      RETIRED_LOCAL_PROGRESS_DIRECTORY_NAME,
      { create: false },
    );
  } catch (cause: unknown) {
    if (isNotFoundError({ cause })) return;
    throw cause;
  }

  for (const fileName of RETIRED_LOCAL_PROGRESS_FILE_NAMES) {
    try {
      await progressDirectory.removeEntry(fileName);
    } catch (cause: unknown) {
      if (!isNotFoundError({ cause })) throw cause;
    }
  }
}

/**
 * Removes only the fixed files written by the retired Naidan-local progress
 * companion. Their contents are never decoded or used as authority. Cleanup
 * is best-effort so these obsolete work files cannot block normal use.
 */
export async function cleanupRetiredLocalTransitionProgress({ exclusiveGate, storageRoot }: {
  exclusiveGate: NaidanPersistenceControlExclusiveGate;
  storageRoot: FileSystemDirectoryHandle;
}): Promise<void> {
  try {
    await exclusiveGate.runExclusive({
      operation: async () => await removeKnownRetiredFiles({ storageRoot }),
    });
  } catch {
    // Stable Persistence Control authority remains sufficient for normal use.
  }
}

// Export fixed retired paths for focused cleanup tests only.
export const TEST_ONLY = {
  directoryName: RETIRED_LOCAL_PROGRESS_DIRECTORY_NAME,
  fileNames: RETIRED_LOCAL_PROGRESS_FILE_NAMES,
  removeKnownRetiredFiles,
};
