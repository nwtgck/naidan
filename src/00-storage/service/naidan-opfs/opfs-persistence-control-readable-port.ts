import {
  NAIDAN_PERSISTENCE_CONTROL_FORMAT_CONSTANTS,
  type PersistenceControlCopy,
} from "@/00-storage/service/naidan-persistence-control/00-format";
import type {
  PersistenceControlPhysicalPort,
  PersistenceControlReadablePhysicalPort,
} from "@/00-storage/service/naidan-persistence-control/store";
import type {
  NaidanPersistenceControlExclusiveGate,
} from "@/00-storage/service/naidan-opfs/persistence-control-exclusive-gate";

function isNotFoundError({ cause }: { cause: unknown }): boolean {
  return cause instanceof DOMException
    ? cause.name === "NotFoundError"
    : cause instanceof Error
      && (cause.name === "NotFoundError" || cause.message.startsWith("NotFoundError"));
}

function controlFileName({ copy }: { copy: PersistenceControlCopy }): string {
  return NAIDAN_PERSISTENCE_CONTROL_FORMAT_CONSTANTS.storage.controlFiles[copy];
}

async function getControlCollection({ create, storageRoot }: {
  create: boolean;
  storageRoot: FileSystemDirectoryHandle;
}): Promise<FileSystemDirectoryHandle | undefined> {
  try {
    return await storageRoot.getDirectoryHandle(
      NAIDAN_PERSISTENCE_CONTROL_FORMAT_CONSTANTS.storage.collectionDirectoryName,
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
    throw new RangeError("Persistence Control read bound must be a non-negative safe integer");
  }
  const snapshot = await fileHandle.getFile();
  if (!Number.isSafeInteger(snapshot.size) || snapshot.size < 0 || snapshot.size > maximumByteLength) {
    throw new RangeError("Persistence Control file exceeds the requested bounded read limit");
  }
  const bytes = new Uint8Array(await snapshot.arrayBuffer());
  if (bytes.byteLength !== snapshot.size || bytes.byteLength > maximumByteLength) {
    throw new RangeError("Persistence Control file changed during bounded snapshot materialization");
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

/**
 * Reads only the fixed Persistence Control A/B files from Naidan's native OPFS
 * storage root. The adapter never creates missing entries and never selects or
 * interprets authority; format decoding and proof remain with the Persistence
 * Control owner.
 */
export function createOpfsPersistenceControlReadablePhysicalPort({ storageRoot }: {
  storageRoot: FileSystemDirectoryHandle;
}): PersistenceControlReadablePhysicalPort {
  return {
    async readFileBounded({ copy, maximumByteLength }) {
      const collection = await getControlCollection({ create: false, storageRoot });
      if (collection === undefined) return undefined;

      let fileHandle: FileSystemFileHandle;
      try {
        fileHandle = await collection.getFileHandle(controlFileName({ copy }), { create: false });
      } catch (cause: unknown) {
        if (isNotFoundError({ cause })) return undefined;
        throw cause;
      }
      return await readFileSnapshotBounded({ fileHandle, maximumByteLength });
    },
  };
}

/**
 * Adds fixed-path whole-file publication under the same cross-realm gate used
 * by transition progress. The owner still performs canonical encoding,
 * authenticated read-back, A/B ordering, and authority selection. OPFS exposes
 * no parent-directory fsync, so this adapter does not claim crash durability.
 */
export function createOpfsPersistenceControlPhysicalPort({ exclusiveGate, storageRoot }: {
  exclusiveGate: NaidanPersistenceControlExclusiveGate;
  storageRoot: FileSystemDirectoryHandle;
}): PersistenceControlPhysicalPort {
  const readable = createOpfsPersistenceControlReadablePhysicalPort({ storageRoot });
  return {
    ...readable,
    async publishWholeFileDurably({ bytes, copy }) {
      const collection = await getControlCollection({ create: true, storageRoot });
      if (collection === undefined) throw new Error("Persistence Control collection creation did not return a handle");
      const fileHandle = await collection.getFileHandle(controlFileName({ copy }), { create: true });
      const writable = await fileHandle.createWritable({ keepExistingData: false });
      try {
        await writable.write(Uint8Array.from(bytes));
        await writable.close();
      } catch (cause: unknown) {
        await abortAfterWriteFailure({ cause, writable });
        throw cause;
      }
    },
    async runExclusive<T>({ operation }: { operation: () => Promise<T> }): Promise<T> {
      return await exclusiveGate.runExclusive({ operation });
    },
  };
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
