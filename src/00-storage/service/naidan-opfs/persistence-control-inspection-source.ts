import {
  runWithStorageBinaryObjectReadHandleClose,
  type StorageBinaryObjectReadHandle,
} from '@/00-storage/service/binary-object-io';
import type { StorageFileStat } from '@/00-storage/service/storage-file-system/types';
import { inspectPersistenceControl, type PersistenceControlInspection } from '@/00-storage/service/naidan-persistence-control/inspection';
import {
  type PersistenceControlProofAuthority,
  type PersistenceControlReadablePhysicalPort,
} from '@/00-storage/service/naidan-persistence-control/store';
import { NAIDAN_PERSISTENCE_CONTROL_FORMAT_CONSTANTS, type PersistenceControlCopy } from '@/00-storage/service/naidan-persistence-control/00-format';

interface ReadableStorageFile {
  stat(): Promise<StorageFileStat>;
  openReadable({ mimeType }: { mimeType: string }): Promise<StorageBinaryObjectReadHandle>;
}

interface ReadableStorageDirectory {
  getDirectoryHandle({ name, create }: { name: string; create: boolean }): Promise<ReadableStorageDirectory>;
  getFileHandle({ name, create }: { name: string; create: boolean }): Promise<ReadableStorageFile>;
}

export interface NaidanPersistenceControlInspectionSource {
  inspectPersistenceControl(): Promise<PersistenceControlInspection>;
}

function isNotFoundError({ cause }: { cause: unknown }): boolean {
  return cause instanceof DOMException
    ? cause.name === 'NotFoundError'
    : cause instanceof Error
      && (cause.name === 'NotFoundError' || cause.message.startsWith('NotFoundError'));
}

async function readHandleBounded({ file, maximumByteLength }: {
  file: ReadableStorageFile;
  maximumByteLength: number;
}): Promise<Uint8Array> {
  const stat = await file.stat();
  if (!Number.isSafeInteger(stat.size) || stat.size < 0 || stat.size > maximumByteLength) {
    throw new RangeError(`Persistence Control file exceeds the bounded inspection limit: ${String(stat.size)}`);
  }
  const readable = await file.openReadable({ mimeType: 'application/json' });
  return await runWithStorageBinaryObjectReadHandleClose({
    operation: async () => {
      if (readable.size !== stat.size || readable.size > maximumByteLength) {
        throw new RangeError('Persistence Control file size changed during bounded inspection');
      }
      const bytes = new Uint8Array(readable.size);
      let position = 0;
      while (position < bytes.byteLength) {
        const { bytesRead } = await readable.read({
          buffer: bytes,
          length: bytes.byteLength - position,
          offset: position,
          position,
          signal: undefined,
        });
        if (bytesRead <= 0) {
          throw new Error('Persistence Control file ended before the observed size');
        }
        position += bytesRead;
      }
      return bytes;
    },
    handle: readable,
  });
}

function controlFileName({ copy }: { copy: PersistenceControlCopy }): string {
  return NAIDAN_PERSISTENCE_CONTROL_FORMAT_CONSTANTS.storage.controlFiles[copy];
}

export function createNaidanOpfsPersistenceControlInspectionSource({
  proofAuthority,
  storageRoot,
}: {
  proofAuthority: PersistenceControlProofAuthority;
  storageRoot: ReadableStorageDirectory;
}): NaidanPersistenceControlInspectionSource {
  const physical: PersistenceControlReadablePhysicalPort = {
    async readFileBounded({ copy, maximumByteLength }) {
      let collection: ReadableStorageDirectory;
      try {
        collection = await storageRoot.getDirectoryHandle({
          create: false,
          name: NAIDAN_PERSISTENCE_CONTROL_FORMAT_CONSTANTS.storage.collectionDirectoryName,
        });
      } catch (cause: unknown) {
        if (isNotFoundError({ cause })) return undefined;
        throw cause;
      }
      let file: ReadableStorageFile;
      try {
        file = await collection.getFileHandle({ create: false, name: controlFileName({ copy }) });
      } catch (cause: unknown) {
        if (isNotFoundError({ cause })) return undefined;
        throw cause;
      }
      return await readHandleBounded({ file, maximumByteLength });
    },
  };
  return {
    async inspectPersistenceControl() {
      return await inspectPersistenceControl({ physical, proofAuthority });
    },
  };
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
