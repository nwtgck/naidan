import { openHizoFSWorkerMountGrant } from '@/00-storage/service/hizofs/worker-entry';
import type {
  StorageDirectoryWorkerMountOpener,
} from '@/00-storage/service/storage-file-system/types';
import {
  naidanOpfsContainerOriginRelativePath,
  openNaidanOpfsContainerDirectory,
} from './opfs-storage-location';

async function resolveHizoFSWorkerMountBackingDirectory({
  canonicalBackingLocation,
  fileSystemId,
  storageRoot,
}: {
  canonicalBackingLocation: string;
  fileSystemId: Parameters<typeof naidanOpfsContainerOriginRelativePath>[0]['fileSystemId'];
  storageRoot: FileSystemDirectoryHandle;
}): Promise<FileSystemDirectoryHandle> {
  const expectedLocation = naidanOpfsContainerOriginRelativePath({ fileSystemId });
  if (canonicalBackingLocation !== expectedLocation) {
    throw new TypeError('HizoFS Worker grant canonical backing location does not match its File System ID');
  }
  return await openNaidanOpfsContainerDirectory({ fileSystemId, storageRoot });
}

/**
 * Worker-side implementation dispatch belongs to this exact Naidan storage
 * composition boundary. Generic storage and feature Workers transport opaque
 * grants but never import HizoFS internals or inspect implementation payloads.
 */
export const openNaidanStorageDirectoryWorkerMount: StorageDirectoryWorkerMountOpener = async ({ grant }) => {
  switch (grant.implementation) {
  case 'hizofs': return await openHizoFSWorkerMountGrant({
    grant,
    resolveBackingDirectory: async ({ canonicalBackingLocation, fileSystemId }) => await resolveHizoFSWorkerMountBackingDirectory({
      canonicalBackingLocation,
      fileSystemId,
      storageRoot: await navigator.storage.getDirectory(),
    }),
  });
  default: {
    const _ex: never = grant.implementation;
    throw new Error(`Unhandled storage directory Worker mount: ${String(_ex)}`);
  }
  }
};

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
  resolveHizoFSWorkerMountBackingDirectory,
};
