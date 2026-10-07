import { z } from 'zod';
import { generateId } from '@/01-models/id';
import { idToRaw, type ImageGenerationStoreId } from '@/01-models/ids';
import type { StorageType } from '@/01-models/types';
import { SYNC_LOCK_KEY } from '@/constants';
import { ExperimentalImageGenerationCatalogSchemaDto, type ExperimentalImageGenerationCatalogDto } from '@/00-storage/00-dto/experimental-image-generation.dto';
import { imageGenerationDirectory, imageGenerationRawIdSchema, readImageGenerationText, writeImageGenerationText } from './files';

export type ImageGenerationStoreAccess = { storageType: StorageType, storeId: ImageGenerationStoreId };
const generationLock = 'naidan-experimental-image-generation';
const revisionSchema = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER - 1);

export async function withImageGenerationLock<T>({ storageType, operation }: { storageType: StorageType, operation: () => Promise<T> }): Promise<T> {
  // Image storage belongs to the caller. Build mode does not decide whether
  // its original OPFS store and Web Locks are available.
  switch (storageType) {
  case 'opfs': break;
  case 'memory': case 'local': throw new Error('Image Generation requires OPFS storage.');
  default: { const exhaustive: never = storageType; throw new Error(String(exhaustive)); }
  }
  if (!navigator.locks?.request) throw new Error('Image Generation requires Web Locks.');
  // Binary publication may enter with LOCK_METADATA already held. Never acquire
  // LOCK_METADATA here or call storageService recursively from these callbacks.
  return navigator.locks.request(SYNC_LOCK_KEY, () => navigator.locks.request(generationLock, operation));
}

export async function imageGenerationRoot({ create }: { create: boolean }): Promise<FileSystemDirectoryHandle | undefined> {
  let directory = await navigator.storage.getDirectory();
  for (const name of ['naidan-storage', 'experimental', 'image-generation']) {
    const next = await imageGenerationDirectory({ parent: directory, name, create });
    if (!next) return undefined;
    directory = next;
  }
  return directory;
}

export async function readImageGenerationCatalogDto({ directory }: { directory: FileSystemDirectoryHandle }): Promise<ExperimentalImageGenerationCatalogDto | undefined> {
  const text = await readImageGenerationText({ directory, name: 'catalog.json' });
  if (text !== undefined) return ExperimentalImageGenerationCatalogSchemaDto.parse(JSON.parse(text));
  // An empty newly created directory can be retried. Existing metadata without
  // its catalog is not an empty Workspace and must never be silently initialized.
  for await (const _entry of directory.entries()) throw new Error('Image Generation catalog is missing; preserve the directory for raw export.');
  return undefined;
}

export async function openImageGenerationCatalogDto({ storageType, creation }: { storageType: StorageType, creation: 'allow' | 'forbid' }): Promise<ExperimentalImageGenerationCatalogDto | undefined> {
  return withImageGenerationLock({
    storageType,
    operation: async () => {
    let directory = await imageGenerationRoot({ create: false });
    if (directory) {
      const existing = await readImageGenerationCatalogDto({ directory });
      if (existing) return existing;
    }
    switch (creation) {
    case 'forbid': return undefined;
    case 'allow': break;
    default: { const exhaustive: never = creation; throw new Error(String(exhaustive)); }
    }
    directory ??= await imageGenerationRoot({ create: true });
    if (!directory) throw new Error('Image Generation directory is unavailable.');
    const catalog = ExperimentalImageGenerationCatalogSchemaDto.parse({ version: 1, id: idToRaw({ id: generateId<ImageGenerationStoreId>() }), revision: 0, createdAt: Date.now(), tags: [], preferences: { generationMonitorPresentation: 'visual', experimentalNoticeDismissedAt: undefined, assistantLayout: 'floating', assistantVisibility: 'closed', translation: undefined } });
    await writeImageGenerationText({ directory, name: 'catalog.json', text: JSON.stringify(catalog) });
    return catalog;
  },
  });
}

export async function withImageGenerationStore<T>({ store, operation }: {
  store: ImageGenerationStoreAccess,
  operation: ({ directory, catalog }: { directory: FileSystemDirectoryHandle, catalog: ExperimentalImageGenerationCatalogDto }) => Promise<T>,
}): Promise<T> {
  const id = imageGenerationRawIdSchema.parse(idToRaw({ id: store.storeId }));
  return withImageGenerationLock({
    storageType: store.storageType,
    operation: async () => {
    const directory = await imageGenerationRoot({ create: false });
    const catalog = directory && await readImageGenerationCatalogDto({ directory });
    if (!directory || !catalog || catalog.id !== id) throw new Error('Image Generation store changed or was removed. Reopen it before writing.');
    return operation({ directory, catalog });
  },
  });
}

/** A lost acknowledgement may retry the identical successor, not repeat a mutation. */
export function assertImageGenerationReplacement<T extends { revision: number }>({ current, next, expectedRevision }: {
  current: T | undefined, next: T, expectedRevision: number | undefined,
}): void {
  if (expectedRevision !== undefined) revisionSchema.parse(expectedRevision);
  const nextRevision = expectedRevision === undefined ? 0 : expectedRevision + 1;
  revisionSchema.parse(nextRevision);
  if (next.revision !== nextRevision) throw new Error('Invalid Image Generation successor revision.');
  if (current && JSON.stringify(current) === JSON.stringify(next)) return;
  if (expectedRevision === undefined ? current !== undefined : current === undefined || current.revision !== expectedRevision) {
    throw new Error('Image Generation revision conflict. Reload instead of overwriting another edit.');
  }
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
export const TEST_ONLY = {
};
