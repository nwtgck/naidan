import { z } from 'zod';
import type { ImageGenerationHistoryPage, ImageGenerationHistoryQuery, ImageGenerationRecord } from '@/01-models/image-generation-history';
import { idToRaw, type ImageGenerationId } from '@/01-models/ids';
import type { StorageType } from '@/01-models/types';
import { SYNC_LOCK_KEY } from '@/constants';
import {
  ExperimentalImageGenerationSchemaDto,
  ExperimentalImageGenerationIndexSchemaDto,
  type ExperimentalImageGenerationDto,
  type ExperimentalImageGenerationIndexDto,
  type ExperimentalImageGenerationSummaryDto,
} from '@/00-storage/00-dto/experimental.dto';
import { imageGenerationSummaryToDomain, imageGenerationToDomain, imageGenerationToDto } from '@/00-storage/mapper/image-generation-history';

const historyLock = 'naidan-experimental-image-generation-history';
const rawIdSchema = z.string().regex(/^[a-zA-Z0-9_-]{2,128}$/);
const querySchema = z.object({ text: z.string().max(4096), offset: z.number().int().nonnegative(), limit: z.number().int().min(1).max(100) }).strict();

function assertStorage({ storageType }: { storageType: StorageType }): void {
  switch (storageType) {
  case 'opfs': return;
  case 'local': case 'memory': throw new Error('Image generation history requires OPFS storage');
  default: { const exhaustive: never = storageType; throw new Error(String(exhaustive)); }
  }
}

async function withHistoryLock<T>({ operation }: { operation: () => Promise<T> }): Promise<T> {
  // Index read/modify/write and recovery must be serialized across tabs and
  // Workers. An unlocked fallback could silently drop another tab's history.
  if (!navigator.locks?.request) throw new Error('Image generation history requires Web Locks');
  // The same outer lock serializes storage replacement/reset. Image writes
  // may additionally hold LOCK_METADATA before entering this function; this
  // service never acquires that lock in the reverse order.
  return navigator.locks.request(SYNC_LOCK_KEY, () => navigator.locks.request(historyLock, operation));
}

function isNotFound({ error }: { error: unknown }): boolean {
  return (error instanceof DOMException || error instanceof Error) && error.name === 'NotFoundError';
}

async function getDirectory({ create }: { create: boolean }): Promise<FileSystemDirectoryHandle | undefined> {
  let directory = await navigator.storage.getDirectory();
  for (const name of ['naidan-storage', 'experimental', 'image-generation', 'generations']) {
    try {
      directory = await directory.getDirectoryHandle(name, { create });
    } catch (error) {
      if (!create && isNotFound({ error })) return undefined; throw error;
    }
  }
  return directory;
}

async function readText({ directory, name }: { directory: FileSystemDirectoryHandle, name: string }): Promise<string | undefined> {
  let handle: FileSystemFileHandle;
  try {
    handle = await directory.getFileHandle(name);
  } catch (error) {
    if (isNotFound({ error })) return undefined; throw error;
  }
  // Once a handle exists, a failed read is not an absent record.
  return (await handle.getFile()).text();
}

async function writeText({ directory, name, text }: { directory: FileSystemDirectoryHandle, name: string, text: string }): Promise<void> {
  let handle: FileSystemFileHandle;
  let created = false;
  try {
    handle = await directory.getFileHandle(name);
  } catch (error) {
    if (!isNotFound({ error })) throw error;
    handle = await directory.getFileHandle(name, { create: true });
    created = true;
  }
  let writable: FileSystemWritableFileStream | undefined;
  try {
    writable = await handle.createWritable();
    await writable.write(text);
    await writable.close();
  } catch (error) {
    try {
      await writable?.abort();
    } catch { /* Retain the original write failure. */ }
    if (created) {
      try {
        await directory.removeEntry(name);
      } catch { /* Report the failed save, including when cleanup cannot finish. */ }
    }
    throw error;
  }
}

function summarize({ record }: { record: ExperimentalImageGenerationDto }): ExperimentalImageGenerationSummaryDto {
  return {
    id: record.id, createdAt: record.createdAt, prompt: record.request.parameters.prompt,
    modelName: record.request.models.find(model => model.slot === 'model' || model.slot === 'diffusion')?.file.name ?? '',
    binaryObjectId: record.result.binaryObjectId, width: record.result.width, height: record.result.height,
    previewCount: record.previews.length,
  };
}

async function readRecord({ directory, rawId }: { directory: FileSystemDirectoryHandle, rawId: string }): Promise<ExperimentalImageGenerationDto | undefined> {
  const text = await readText({ directory, name: `${rawId}.json` });
  if (text === undefined) return undefined;
  const record = ExperimentalImageGenerationSchemaDto.parse(JSON.parse(text));
  if (record.id !== rawId) throw new Error('Image generation record identity does not match its filename');
  return record;
}

async function readIndex({ directory, shard }: { directory: FileSystemDirectoryHandle, shard: string }): Promise<ExperimentalImageGenerationIndexDto> {
  const text = await readText({ directory, name: 'index.json' });
  // A corrupt index remains an explicit error. It is never replaced with an
  // empty index, even when individual records could otherwise be read.
  const index = text === undefined ? { generations: {} } : ExperimentalImageGenerationIndexSchemaDto.parse(JSON.parse(text));
  const files = new Set<string>();
  for await (const [name, handle] of directory.entries()) {
    if (handle.kind !== 'file' || name === 'index.json' || !name.endsWith('.json')) continue;
    const rawId = rawIdSchema.parse(name.slice(0, -5));
    if (rawId.slice(-2).toLowerCase() !== shard) throw new Error('Image generation record is in the wrong shard');
    files.add(rawId);
  }
  let changed = false;
  for (const [rawId, summary] of Object.entries(index.generations)) {
    if (summary.id !== rawId || rawId.slice(-2).toLowerCase() !== shard) throw new Error('Image generation index identity mismatch');
    if (!files.has(rawId)) {
      delete index.generations[rawId]; changed = true;
    }
  }
  for (const rawId of files) {
    if (Object.hasOwn(index.generations, rawId)) continue;
    const record = await readRecord({ directory, rawId });
    if (!record) throw new Error('Image generation record disappeared during index recovery');
    Object.defineProperty(index.generations, rawId, { value: summarize({ record }), configurable: true, enumerable: true, writable: true });
    changed = true;
  }
  // Immutable records allow filename reconciliation without reopening every
  // healthy JSON record. This recovers record-first saves and file-first deletes
  // interrupted before their derived index was committed.
  if (changed) await writeText({ directory, name: 'index.json', text: JSON.stringify(index) });
  return index;
}

export async function saveImageGenerationRecord({ storageType, record, writeImages }: {
  storageType: StorageType,
  record: ImageGenerationRecord,
  writeImages: () => Promise<void>,
}): Promise<void> {
  assertStorage({ storageType });
  const dto = ExperimentalImageGenerationSchemaDto.parse(imageGenerationToDto({ record }));
  await withHistoryLock({ operation: async () => {
    const parent = await getDirectory({ create: true });
    if (!parent) throw new Error('Image generation directory unavailable');
    const shard = dto.id.slice(-2).toLowerCase();
    const directory = await parent.getDirectoryHandle(shard, { create: true });
    const index = await readIndex({ directory, shard });
    const existing = await readRecord({ directory, rawId: dto.id });
    if (existing && JSON.stringify(existing) !== JSON.stringify(dto)) throw new Error('Image generation records are immutable');
    await writeImages();
    if (!existing) await writeText({ directory, name: `${dto.id}.json`, text: JSON.stringify(dto) });
    Object.defineProperty(index.generations, dto.id, { value: summarize({ record: dto }), configurable: true, enumerable: true, writable: true });
    await writeText({ directory, name: 'index.json', text: JSON.stringify(index) });
  } });
}

export async function loadImageGenerationRecord({ storageType, id }: { storageType: StorageType, id: ImageGenerationId }): Promise<ImageGenerationRecord | undefined> {
  assertStorage({ storageType });
  const rawId = rawIdSchema.parse(idToRaw({ id }));
  return withHistoryLock({ operation: async () => {
    const parent = await getDirectory({ create: false });
    if (!parent) return undefined;
    let directory: FileSystemDirectoryHandle;
    try {
      directory = await parent.getDirectoryHandle(rawId.slice(-2).toLowerCase());
    } catch (error) {
      if (isNotFound({ error })) return undefined; throw error;
    }
    const dto = await readRecord({ directory, rawId });
    return dto && imageGenerationToDomain({ dto });
  } });
}

export async function deleteImageGenerationRecord({ storageType, id }: { storageType: StorageType, id: ImageGenerationId }): Promise<void> {
  assertStorage({ storageType });
  const rawId = rawIdSchema.parse(idToRaw({ id }));
  await withHistoryLock({ operation: async () => {
    const parent = await getDirectory({ create: false });
    if (!parent) return;
    const shard = rawId.slice(-2).toLowerCase();
    let directory: FileSystemDirectoryHandle;
    try {
      directory = await parent.getDirectoryHandle(shard);
    } catch (error) {
      if (isNotFound({ error })) return; throw error;
    }
    const index = await readIndex({ directory, shard });
    const existing = await readRecord({ directory, rawId });
    if (existing) await directory.removeEntry(`${rawId}.json`);
    delete index.generations[rawId];
    await writeText({ directory, name: 'index.json', text: JSON.stringify(index) });
    // Binary objects may be reused as input images or by chats. Deleting a
    // history record deliberately keeps those immutable bytes available.
  } });
}

async function queryShard({ directory, shard, warn }: {
  directory: FileSystemDirectoryHandle,
  shard: string,
  warn: ({ path, cause }: { path: string, cause: unknown }) => void,
}): Promise<ExperimentalImageGenerationSummaryDto[]> {
  try {
    return Object.values((await readIndex({ directory, shard })).generations);
  } catch (cause) {
    warn({ path: shard, cause });
  }
  // Abrupt termination can leave a newly created empty record/index before
  // its writable stream commits. Keep every original byte untouched and expose
  // readable records with an explicit partial-result warning. Save/delete still
  // refuse corrupt indexes; this fallback never manufactures a replacement.
  const summaries: ExperimentalImageGenerationSummaryDto[] = [];
  try {
    for await (const [name, handle] of directory.entries()) {
      if (handle.kind !== 'file' || name === 'index.json' || !name.endsWith('.json')) continue;
      try {
        const rawId = rawIdSchema.parse(name.slice(0, -5));
        if (rawId.slice(-2).toLowerCase() !== shard) throw new Error('Image generation record is in the wrong shard');
        const record = await readRecord({ directory, rawId });
        if (!record) throw new Error('Image generation record disappeared during history reading');
        summaries.push(summarize({ record }));
      } catch (cause) {
        warn({ path: `${shard}/${name}`, cause });
      }
    }
  } catch (cause) {
    warn({ path: shard, cause });
  }
  return summaries;
}

/** Run this from the history Worker: file enumeration, parsing and matching stay off the UI thread. */
export async function queryImageGenerationHistory({ storageType, query }: {
  storageType: StorageType,
  query: ImageGenerationHistoryQuery,
}): Promise<ImageGenerationHistoryPage> {
  assertStorage({ storageType });
  const { text, offset, limit } = querySchema.parse(query);
  const words = text.toLocaleLowerCase().trim().split(/\s+/).filter(Boolean);
  return withHistoryLock({ operation: async () => {
    const parent = await getDirectory({ create: false });
    if (!parent) return { items: [], total: 0, warnings: [], warningCount: 0 };
    const matches: ExperimentalImageGenerationSummaryDto[] = [];
    const warnings: ImageGenerationHistoryPage['warnings'] = [];
    let warningCount = 0;
    function warn({ path, cause }: { path: string, cause: unknown }): void {
      warningCount++;
      if (warnings.length < 100) warnings.push({ path: path.slice(0, 1024), message: (cause instanceof Error ? cause.message : String(cause)).slice(0, 1024) });
    }
    for await (const [shard, directory] of parent.entries()) {
      if (directory.kind !== 'directory' || !/^[a-z0-9_-]{2}$/.test(shard)) continue;
      for (const summary of await queryShard({ directory, shard, warn })) {
        const haystack = `${summary.prompt}\n${summary.modelName}`.toLocaleLowerCase();
        if (words.every(word => haystack.includes(word))) matches.push(summary);
      }
    }
    matches.sort((left, right) => right.createdAt - left.createdAt || left.id.localeCompare(right.id));
    return { items: matches.slice(offset, offset + limit).map(dto => imageGenerationSummaryToDomain({ dto })), total: matches.length, warnings, warningCount };
  } });
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
export const TEST_ONLY = {
};
