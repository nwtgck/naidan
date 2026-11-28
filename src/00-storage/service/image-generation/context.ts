import { opfsFormat } from '@/00-format/01-layout/layout';
import { z } from 'zod';
import { generateId } from '@/01-models/id';
import { type ImageGenerationStoreId } from '@/01-models/ids';
import type { StorageType } from '@/01-models/types';
import { SYNC_LOCK_KEY } from '@/constants';
import { validateImageGenerationId, type ImageGenerationIo, type ImageGenerationSnapshot } from '@/00-format/image-generation-record';
import type { ImageGenerationCatalog } from '@/01-models/image-generation';
import { imageGenerationDirectory, imageGenerationIo } from './files';

export type ImageGenerationStoreAccess = { storageType: StorageType, storeId: ImageGenerationStoreId };
const generationLock = 'naidan-experimental-image-generation';
const revisionSchema = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER - 1);

export async function withImageGenerationLock<T>({ storageType, operation }: { storageType: StorageType, operation: () => Promise<T> }): Promise<T> {
  // Image storage belongs to the caller. Build mode does not decide whether
  // its original OPFS store and Web Locks are available.
  switch (storageType) {
  case 'opfs': break;
  case 'memory': case 'local': throw new Error('Image Generation requires OPFS storage.');
  default: {
    const exhaustive: never = storageType;
    throw new Error(String(exhaustive));
  }
  }
  if (!navigator.locks?.request) {
    throw new Error('Image Generation requires Web Locks.');
  }
  // Binary publication may enter with LOCK_METADATA already held. Never acquire
  // LOCK_METADATA here or call storageService recursively from these callbacks.
  return navigator.locks.request(SYNC_LOCK_KEY, () => navigator.locks.request(generationLock, operation));
}

export async function imageGenerationRoot({ create }: { create: boolean }): Promise<FileSystemDirectoryHandle | undefined> {
  let directory = await navigator.storage.getDirectory();
  for (const name of opfsFormat.storage.experimental.imageGeneration.path) {
    const next = await imageGenerationDirectory({ parent: directory, name, create });
    if (!next) {
      return undefined;
    }
    directory = next;
  }
  return directory;
}

export function imageGenerationRootIo({ directory }: { directory: FileSystemDirectoryHandle }) {
  return imageGenerationIo({ directory, path: opfsFormat.storage.experimental.imageGeneration.path });
}

type CatalogReader<T> = ({ io }: { io: ImageGenerationIo }) => Promise<T | undefined>;

async function readImageGenerationCatalog<T>({ directory, read }: { directory: FileSystemDirectoryHandle, read: CatalogReader<T> }): Promise<T | undefined> {
  const catalog = await read({ io: imageGenerationRootIo({ directory }) });
  if (catalog !== undefined) {
    return catalog;
  }
  // An empty newly created directory can be retried. Existing metadata without
  // its catalog is not an empty Workspace and must never be silently initialized.
  for await (const _entry of directory.entries()) {
    throw new Error('Image Generation catalog is missing; preserve the directory for raw export.');
  }
  return undefined;
}

export async function openImageGenerationCatalog({ storageType, creation }: { storageType: StorageType, creation: 'allow' | 'forbid' }): Promise<ImageGenerationCatalog | undefined> {
  return withImageGenerationLock({
    storageType,
    operation: async () => {
      let directory = await imageGenerationRoot({ create: false });
      if (directory) {
        const existing = await readImageGenerationCatalog({
          directory,
          read: opfsFormat.storage.experimental.imageGeneration.catalog.read,
        });
        if (existing) {
          return existing.value;
        }
      }
      switch (creation) {
      case 'forbid': return undefined;
      case 'allow': break;
      default: {
        const exhaustive: never = creation;
        throw new Error(String(exhaustive));
      }
      }
      directory ??= await imageGenerationRoot({ create: true });
      if (!directory) {
        throw new Error('Image Generation directory is unavailable.');
      }
      const prepared = opfsFormat.storage.experimental.imageGeneration.catalog.prepareInitial({ id: generateId<ImageGenerationStoreId>(), createdAt: Date.now() });
      await prepared.write({ io: imageGenerationRootIo({ directory }) });
      return prepared.snapshot.value;
    },
  });
}

function withStoreCatalog<C, T>({ store, read, operation }: {
  store: ImageGenerationStoreAccess,
  read: CatalogReader<{ id: ImageGenerationStoreId, catalog: C }>,
  operation({ directory, catalog }: { directory: FileSystemDirectoryHandle, catalog: C }): Promise<T>,
}): Promise<T> {
  const id = validateImageGenerationId({ id: store.storeId });
  return withImageGenerationLock({
    storageType: store.storageType,
    operation: async () => {
      const directory = await imageGenerationRoot({ create: false });
      const result = directory && await readImageGenerationCatalog({ directory, read });
      if (!directory || !result || result.id !== id) {
        throw new Error('Image Generation store changed or was removed. Reopen it before writing.');
      }
      return operation({ directory, catalog: result.catalog });
    },
  });
}

export function withImageGenerationStore<T>({ store, operation }: {
  store: ImageGenerationStoreAccess,
  operation({ directory, catalog }: { directory: FileSystemDirectoryHandle, catalog: ImageGenerationSnapshot<ImageGenerationCatalog> }): Promise<T>,
}): Promise<T> {
  return withStoreCatalog({
    store,
    async read({ io }) {
      const catalog = await opfsFormat.storage.experimental.imageGeneration.catalog.read({ io });
      return catalog && { id: catalog.value.id, catalog };
    },
    operation,
  });
}

type SessionExportCatalog = NonNullable<Awaited<ReturnType<typeof opfsFormat.storage.experimental.imageGeneration.catalog.readForExport>>>['catalog'];

export function withImageGenerationStoreForExport<T>({ store, operation }: {
  store: ImageGenerationStoreAccess,
  operation({ directory, catalog }: { directory: FileSystemDirectoryHandle, catalog: SessionExportCatalog }): Promise<T>,
}): Promise<T> {
  return withStoreCatalog({ store, read: opfsFormat.storage.experimental.imageGeneration.catalog.readForExport, operation });
}

/** A lost acknowledgement may retry the identical successor, not repeat a mutation. */
export function assertImageGenerationReplacement<T extends { revision: number }>({ current, next, expectedRevision }: {
  current: ImageGenerationSnapshot<T> | undefined, next: ImageGenerationSnapshot<T>, expectedRevision: number | undefined,
}): void {
  if (expectedRevision !== undefined) {
    revisionSchema.parse(expectedRevision);
  }
  const nextRevision = expectedRevision === undefined ? 0 : expectedRevision + 1;
  revisionSchema.parse(nextRevision);
  if (next.revision !== nextRevision) {
    throw new Error('Invalid Image Generation successor revision.');
  }
  if (current && next.matches({ other: current })) {
    return;
  }
  if (expectedRevision === undefined ? current !== undefined : current === undefined || current.revision !== expectedRevision) {
    throw new Error('Image Generation revision conflict. Reload instead of overwriting another edit.');
  }
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
export const TEST_ONLY = {
};
