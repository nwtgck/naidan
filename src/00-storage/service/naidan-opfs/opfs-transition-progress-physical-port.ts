import {
  NAIDAN_PERSISTENCE_CONTROL_FORMAT_CONSTANTS,
  NAIDAN_TRANSITION_PROGRESS_FORMAT_CONSTANTS,
  type TransitionProgressCopy,
} from '@/00-storage/service/naidan-persistence-control/00-format';
import type {
  TransitionProgressPhysicalPort,
} from '@/00-storage/service/naidan-persistence-control/store';

const PERSISTENCE_CONTROL_AUTHORITY_LOCK_NAME = 'naidan:persistence-control:authority';

export interface NaidanPersistenceControlExclusiveGate {
  runExclusive<T>({ operation }: { operation: () => Promise<T> }): Promise<T>;
}

function isNotFoundError({ cause }: { cause: unknown }): boolean {
  return cause instanceof DOMException
    ? cause.name === 'NotFoundError'
    : cause instanceof Error
      && (cause.name === 'NotFoundError' || cause.message.startsWith('NotFoundError'));
}

function transitionProgressFileName({ copy }: { copy: TransitionProgressCopy }): string {
  return NAIDAN_TRANSITION_PROGRESS_FORMAT_CONSTANTS.storage.files[copy];
}

async function getTransitionProgressDirectory({ create, storageRoot }: {
  create: boolean;
  storageRoot: FileSystemDirectoryHandle;
}): Promise<FileSystemDirectoryHandle | undefined> {
  try {
    const collection = await storageRoot.getDirectoryHandle(
      NAIDAN_PERSISTENCE_CONTROL_FORMAT_CONSTANTS.storage.collectionDirectoryName,
      { create },
    );
    return await collection.getDirectoryHandle(
      NAIDAN_TRANSITION_PROGRESS_FORMAT_CONSTANTS.storage.directoryName,
      { create },
    );
  } catch (cause: unknown) {
    if (!create && isNotFoundError({ cause })) return undefined;
    throw cause;
  }
}

async function readFileSnapshotBounded({ fileHandle, maximumByteLength }: {
  fileHandle: FileSystemFileHandle;
  maximumByteLength: number;
}): Promise<Uint8Array> {
  if (!Number.isSafeInteger(maximumByteLength) || maximumByteLength < 0) {
    throw new RangeError('transition-progress read bound must be a non-negative safe integer');
  }
  const snapshot = await fileHandle.getFile();
  if (!Number.isSafeInteger(snapshot.size) || snapshot.size < 0 || snapshot.size > maximumByteLength) {
    throw new RangeError('transition-progress file exceeds the requested bounded read limit');
  }
  const bytes = new Uint8Array(await snapshot.arrayBuffer());
  if (bytes.byteLength !== snapshot.size || bytes.byteLength > maximumByteLength) {
    throw new RangeError('transition-progress file changed during bounded snapshot materialization');
  }
  return bytes;
}

async function abortAfterWriteFailure({ cause, writable }: {
  cause: unknown;
  writable: FileSystemWritableFileStream;
}): Promise<void> {
  try {
    await writable.abort(cause);
  } catch {
    // Preserve the original write or close failure.
  }
}

export function createBrowserNaidanPersistenceControlExclusiveGate({ lockManager }: {
  lockManager: Pick<LockManager, 'request'>;
}): NaidanPersistenceControlExclusiveGate {
  return {
    async runExclusive<T>({ operation }: { operation: () => Promise<T> }): Promise<T> {
      return await lockManager.request(
        PERSISTENCE_CONTROL_AUTHORITY_LOCK_NAME,
        { mode: 'exclusive' },
        async lock => {
          if (lock === null) throw new Error('Persistence Control authority lock was not acquired');
          return await operation();
        },
      );
    },
  };
}

/**
 * Performs fixed-path OPFS I/O only. The Persistence Control owner retains
 * canonical decoding, cryptographic proof, A/B selection, and publication
 * ordering. Writable-stream close is followed by owner-level authenticated
 * read-back; OPFS exposes no parent-directory fsync, so this adapter does not
 * promote namespace observability into an unproven crash-durability claim.
 */
export function createOpfsTransitionProgressPhysicalPort({ exclusiveGate, storageRoot }: {
  exclusiveGate: NaidanPersistenceControlExclusiveGate;
  storageRoot: FileSystemDirectoryHandle;
}): TransitionProgressPhysicalPort {
  return {
    async publishWholeFileDurably({ bytes, copy }) {
      const directory = await getTransitionProgressDirectory({ create: true, storageRoot });
      if (directory === undefined) throw new Error('transition-progress directory creation did not return a handle');
      const fileHandle = await directory.getFileHandle(transitionProgressFileName({ copy }), { create: true });
      const writable = await fileHandle.createWritable({ keepExistingData: false });
      try {
        await writable.write(Uint8Array.from(bytes));
        await writable.close();
      } catch (cause: unknown) {
        await abortAfterWriteFailure({ cause, writable });
        throw cause;
      }
    },

    async readFileBounded({ copy, maximumByteLength }) {
      const directory = await getTransitionProgressDirectory({ create: false, storageRoot });
      if (directory === undefined) return undefined;
      let fileHandle: FileSystemFileHandle;
      try {
        fileHandle = await directory.getFileHandle(transitionProgressFileName({ copy }), { create: false });
      } catch (cause: unknown) {
        if (isNotFoundError({ cause })) return undefined;
        throw cause;
      }
      return await readFileSnapshotBounded({ fileHandle, maximumByteLength });
    },

    async removeFile({ copy }) {
      const directory = await getTransitionProgressDirectory({ create: false, storageRoot });
      if (directory === undefined) return;
      try {
        await directory.removeEntry(transitionProgressFileName({ copy }));
      } catch (cause: unknown) {
        if (isNotFoundError({ cause })) return;
        throw cause;
      }
    },

    async runExclusive<T>({ operation }: { operation: () => Promise<T> }): Promise<T> {
      return await exclusiveGate.runExclusive({ operation });
    },
  };
}

export const TEST_ONLY = {
  persistenceControlAuthorityLockName: PERSISTENCE_CONTROL_AUTHORITY_LOCK_NAME,
};
