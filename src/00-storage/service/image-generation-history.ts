import { opfsFormat } from '@/00-format/01-layout/layout';
import { validateImageGenerationId } from '@/00-format/image-generation-record';
import { imageGenerationIo, imageGenerationIsNotFound } from './image-generation/files';
import { assertImageGenerationBinariesNotDeleted } from './image-generation/deletions';
import { imageGenerationRoot } from './image-generation/context';
import { z } from 'zod';
import type { ImageGenerationHistoryPage, ImageGenerationHistoryQuery, ImageGenerationRecord, ImageGenerationSummary } from '@/01-models/image-generation-history';
import { idToRaw, type ImageGenerationId } from '@/01-models/ids';
import type { StorageType } from '@/01-models/types';
import { SYNC_LOCK_KEY } from '@/constants';

const historyLock = 'naidan-experimental-image-generation-history';
const querySchema = z.object({ text: z.string().max(4096), offset: z.number().int().nonnegative(), limit: z.number().int().min(1).max(100) }).strict();

function assertStorage({ storageType }: { storageType: StorageType }): void {
  switch (storageType) {
  case 'opfs': return;
  case 'local': case 'memory': throw new Error('Image generation history requires OPFS storage');
  default: {
    const exhaustive: never = storageType;
    throw new Error(String(exhaustive));
  }
  }
}

async function withHistoryLock<T>({ operation }: { operation: () => Promise<T> }): Promise<T> {
  // Index read/modify/write and recovery must be serialized across tabs and
  // Workers. An unlocked fallback could silently drop another tab's history.
  if (!navigator.locks?.request) {
    throw new Error('Image generation history requires Web Locks');
  }
  // The same outer lock serializes storage replacement/reset. Image writes
  // may additionally hold LOCK_METADATA before entering this function; this
  // service never acquires that lock in the reverse order.
  return navigator.locks.request(SYNC_LOCK_KEY, () => navigator.locks.request(historyLock, operation));
}

async function getDirectory({ create }: { create: boolean }): Promise<FileSystemDirectoryHandle | undefined> {
  let directory = await navigator.storage.getDirectory();
  for (const name of opfsFormat.storage.experimental.imageGeneration.generations.path) {
    try {
      directory = await directory.getDirectoryHandle(name, { create });
    } catch (error) {
      if (!create && imageGenerationIsNotFound({ error })) {
        return undefined;
      }
      throw error;
    }
  }
  return directory;
}

function historyIo({ directory }: { directory: FileSystemDirectoryHandle }) {
  return imageGenerationIo({ directory, path: opfsFormat.storage.experimental.imageGeneration.generations.path });
}

/** Called once when a direct-generation save owner is created. */
export async function captureImageGenerationHistoryTarget({ storageType }: { storageType: StorageType }): Promise<FileSystemDirectoryHandle> {
  assertStorage({ storageType });
  return withHistoryLock({
    operation: async () => {
      const directory = await getDirectory({ create: true });
      if (!directory) {
        throw new Error('Image generation directory unavailable');
      }
      return directory;
    },
  });
}

export async function saveImageGenerationRecord({ storageType, record, writeImages, expectedDirectory }: {
  storageType: StorageType,
  record: ImageGenerationRecord,
  writeImages: () => Promise<void>,
  expectedDirectory?: FileSystemDirectoryHandle,
}): Promise<void> {
  assertStorage({ storageType });
  const prepared = opfsFormat.storage.experimental.imageGeneration.generations.prepareWrite({ value: record });
  await withHistoryLock({
    operation: async () => {
      const directory = await getDirectory({ create: expectedDirectory === undefined });
      if (expectedDirectory && (!directory || !await expectedDirectory.isSameEntry(directory))) {
        throw new Error('Image history store changed or was removed');
      }
      if (!directory) {
        throw new Error('Image generation directory unavailable');
      }
      await prepared.write({
        io: historyIo({ directory }),
        async beforeCommit({ binaryIds }) {
          const root = await imageGenerationRoot({ create: false });
          if (!root) {
            throw new Error('Image generation directory unavailable');
          }
          await assertImageGenerationBinariesNotDeleted({ directory: root, ids: binaryIds });
          await writeImages();
        },
      });
    },
  });
}

export async function loadImageGenerationRecord({ storageType, id }: { storageType: StorageType, id: ImageGenerationId }): Promise<ImageGenerationRecord | undefined> {
  assertStorage({ storageType });
  validateImageGenerationId({ id });
  return withHistoryLock({
    operation: async () => {
      const directory = await getDirectory({ create: false });
      return directory && opfsFormat.storage.experimental.imageGeneration.generations.load({ io: historyIo({ directory }), id });
    },
  });
}

export async function deleteImageGenerationRecord({ storageType, id }: { storageType: StorageType, id: ImageGenerationId }): Promise<void> {
  assertStorage({ storageType });
  validateImageGenerationId({ id });
  await withHistoryLock({
    operation: async () => {
      const directory = await getDirectory({ create: true });
      if (directory) {
        // Binary objects can be independently reused by other records.
        await opfsFormat.storage.experimental.imageGeneration.generations.remove({ io: historyIo({ directory }), id });
      }
    },
  });
}

/** Run this from the history Worker: file enumeration, parsing and matching stay off the UI thread. */
export async function queryImageGenerationHistory({ storageType, query }: {
  storageType: StorageType,
  query: ImageGenerationHistoryQuery,
}): Promise<ImageGenerationHistoryPage> {
  assertStorage({ storageType });
  const { text, offset, limit } = querySchema.parse(query);
  const words = text.toLocaleLowerCase().trim().split(/\s+/).filter(Boolean);
  return withHistoryLock({
    operation: async () => {
      const parent = await getDirectory({ create: false });
      if (!parent) {
        return { items: [], total: 0, warnings: [], warningCount: 0 };
      }
      const matches: ImageGenerationSummary[] = [];
      const warnings: ImageGenerationHistoryPage['warnings'] = [];
      let warningCount = 0;
      function warn({ path, cause }: { path: string, cause: unknown }): void {
        warningCount++;
        if (warnings.length < 100) {
          warnings.push({ path: path.slice(0, 1024), message: (cause instanceof Error ? cause.message : String(cause)).slice(0, 1024) });
        }
      }
      for await (const summary of opfsFormat.storage.experimental.imageGeneration.generations.list({ io: historyIo({ directory: parent }), warn })) {
        const haystack = `${summary.prompt}\n${summary.modelName}`.toLocaleLowerCase();
        if (words.every(word => haystack.includes(word))) {
          matches.push(summary);
        }
      }
      matches.sort((left, right) => right.createdAt - left.createdAt || idToRaw({ id: left.id }).localeCompare(idToRaw({ id: right.id })));
      return { items: matches.slice(offset, offset + limit), total: matches.length, warnings, warningCount };
    },
  });
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
export const TEST_ONLY = {
};
