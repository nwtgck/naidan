import { UnavailableRpcRecordError } from './unavailable-record';
import { z } from 'zod';
import type { ImageGenerationReadResult, ImageGenerationReadWarning } from '@/01-models/image-generation';

export const imageGenerationRawIdSchema = z.string().regex(/^[a-zA-Z0-9_-]{2,128}$/);
const MAX_JSON_BYTES = 16 * 1024 * 1024;

export function imageGenerationIsNotFound({ error }: { error: unknown }): boolean {
  return (error instanceof DOMException || error instanceof Error) && error.name === 'NotFoundError';
}

export async function imageGenerationDirectory({ parent, name, create }: {
  parent: FileSystemDirectoryHandle, name: string, create: boolean,
}): Promise<FileSystemDirectoryHandle | undefined> {
  try {
    return await parent.getDirectoryHandle(name, { create });
  } catch (error) {
    if (!create && imageGenerationIsNotFound({ error })) return undefined;
    throw error;
  }
}

export async function readImageGenerationText({ directory, name }: { directory: FileSystemDirectoryHandle, name: string }): Promise<string | undefined> {
  let handle: FileSystemFileHandle;
  try {
    handle = await directory.getFileHandle(name);
  } catch (error) {
    if (imageGenerationIsNotFound({ error })) return undefined;
    throw error;
  }
  const file = await handle.getFile();
  if (file.size > MAX_JSON_BYTES) throw new Error(`Image Generation metadata exceeds the read limit: ${name}`);
  return file.text();
}

export async function writeImageGenerationText({ directory, name, text }: { directory: FileSystemDirectoryHandle, name: string, text: string }): Promise<void> {
  if (new TextEncoder().encode(text).byteLength > MAX_JSON_BYTES) throw new Error('Image Generation metadata exceeds the write limit.');
  let handle: FileSystemFileHandle;
  let created = false;
  try {
    handle = await directory.getFileHandle(name);
  } catch (error) {
    if (!imageGenerationIsNotFound({ error })) throw error;
    handle = await directory.getFileHandle(name, { create: true }); created = true;
  }
  let writable: FileSystemWritableFileStream | undefined;
  try {
    writable = await handle.createWritable();
    await writable.write(text);
    await writable.close();
  } catch (error) {
    try {
      await writable?.abort();
    } catch { /* Keep the original failure. */ }
    if (created) {
      try {
        await directory.removeEntry(name);
      } catch { /* Preserve unreadable bytes for raw export if cleanup fails. */ }
    }
    throw error;
  }
}

/** Storage-local helper. Callers must hold the Image Generation lock for every method. */
export function createImageGenerationTable<R, S>({ directory, layout, recordSchema, indexSchema, recordId, summaryId, summarize, validateRecord, validateSummary, unavailableRecord }: {
  directory: FileSystemDirectoryHandle | undefined,
  layout: 'files' | 'session-directories',
  recordSchema: Pick<z.ZodType<R>, 'parse'>,
  indexSchema: Pick<z.ZodType<{ items: S[] }>, 'parse'>,
  recordId: ({ record }: { record: R }) => string,
  summaryId: ({ summary }: { summary: S }) => string,
  summarize: ({ record }: { record: R }) => S,
  validateRecord: ({ record }: { record: R }) => void,
  validateSummary: ({ summary }: { summary: S }) => void,
  unavailableRecord: (({ raw }: { raw: unknown }) => { id: string } | undefined) | undefined,
}) {
  async function readRecord({ shardDirectory, id }: { shardDirectory: FileSystemDirectoryHandle, id: string }): Promise<R | undefined> {
    let text: string | undefined;
    switch (layout) {
    case 'files': text = await readImageGenerationText({ directory: shardDirectory, name: `${id}.json` }); break;
    case 'session-directories': {
      const parent = await imageGenerationDirectory({ parent: shardDirectory, name: id, create: false });
      if (!parent) return undefined;
      text = await readImageGenerationText({ directory: parent, name: 'session.json' }); break;
    }
    default: { const exhaustive: never = layout; throw new Error(String(exhaustive)); }
    }
    if (text === undefined) return undefined;
    const raw: unknown = JSON.parse(text);
    const unavailable = unavailableRecord?.({ raw });
    if (unavailable !== undefined) {
      if (unavailable.id !== id) throw new Error('Image Generation record identity does not match its location.');
      throw new UnavailableRpcRecordError({ id: id });
    }
    const record = recordSchema.parse(raw);
    if (recordId({ record }) !== id) throw new Error('Image Generation record identity does not match its location.');
    validateRecord({ record });
    return record;
  }

  async function recordIds({ shardDirectory, shard }: { shardDirectory: FileSystemDirectoryHandle, shard: string }): Promise<string[]> {
    const ids: string[] = [];
    for await (const [name, handle] of shardDirectory.entries()) {
      let id: string;
      switch (layout) {
      case 'files':
        if (handle.kind !== 'file' || name === 'index.json' || !name.endsWith('.json')) continue;
        id = imageGenerationRawIdSchema.parse(name.slice(0, -5)); break;
      case 'session-directories':
        switch (handle.kind) {
        case 'directory': break;
        case 'file': continue;
        default: { const exhaustive: never = handle; throw new Error(String(exhaustive)); }
        }
        id = imageGenerationRawIdSchema.parse(name); break;
      default: { const exhaustive: never = layout; throw new Error(String(exhaustive)); }
      }
      if (id.slice(-2).toLowerCase() !== shard) throw new Error('Image Generation record is in the wrong shard.');
      ids.push(id);
    }
    return ids;
  }

  async function readIndex({ shardDirectory, shard, purpose }: { shardDirectory: FileSystemDirectoryHandle, shard: string, purpose: 'presentation' | 'mutation' }): Promise<{ items: S[], unavailable: string[] }> {
    const text = await readImageGenerationText({ directory: shardDirectory, name: 'index.json' });
    // Even dirty indexes must parse before mutation. Never replace corrupt bytes
    // with an empty "healthy" index. Read-only listing can fall back to records.
    const index = text === undefined ? { items: [] } : indexSchema.parse(JSON.parse(text));
    const indexed = new Map<string, S>();
    for (const summary of index.items) {
      const id = imageGenerationRawIdSchema.parse(summaryId({ summary }));
      if (indexed.has(id) || id.slice(-2).toLowerCase() !== shard) throw new Error('Image Generation index identity mismatch.');
      validateSummary({ summary }); indexed.set(id, summary);
    }
    const dirty = await readImageGenerationText({ directory: shardDirectory, name: 'index.dirty' }) !== undefined;
    const ids = await recordIds({ shardDirectory, shard });
    const items: S[] = [], unavailable: string[] = [];
    // Clean summaries are presentation-only. Mutation must validate canonical
    // RPC records so stale summaries cannot authorize writes or erase opaque data.
    for (const id of ids) {
      const cached = indexed.get(id);
      if (!dirty && cached !== undefined) {
        switch (purpose) {
        case 'presentation': items.push(cached); continue;
        case 'mutation':
          if (unavailableRecord === undefined) {
            items.push(cached); continue;
          }
          break;
        default: { const exhaustive: never = purpose; throw new Error(String(exhaustive)); }
        }
      }
      try {
        const record = await readRecord({ shardDirectory, id });
        if (record === undefined) throw new Error('Image Generation record is incomplete or disappeared.');
        items.push(summarize({ record }));
      } catch (error) {
        if (!(error instanceof UnavailableRpcRecordError)) throw error;
        unavailable.push(id);
      }
    }
    return { items, unavailable };
  }

  async function load({ id }: { id: string }): Promise<R | undefined> {
    imageGenerationRawIdSchema.parse(id);
    if (!directory) return undefined;
    const shardDirectory = await imageGenerationDirectory({ parent: directory, name: id.slice(-2).toLowerCase(), create: false });
    return shardDirectory && readRecord({ shardDirectory, id });
  }

  async function list(): Promise<ImageGenerationReadResult<S>> {
    const items: S[] = [], warnings: ImageGenerationReadWarning[] = [];
    let warningCount = 0;
    function warn({ path, error }: { path: string, error: unknown }): void {
      warningCount++;
      if (warnings.length < 100) warnings.push({ path: path.slice(0, 1024), message: (error instanceof Error ? error.message : String(error)).slice(0, 1024) });
    }
    if (!directory) return { items, warnings, warningCount };
    for await (const [shard, handle] of directory.entries()) {
      if (handle.kind !== 'directory' || !/^[a-z0-9_-]{2}$/.test(shard)) continue;
      try {
        const index = await readIndex({ shardDirectory: handle, shard, purpose: 'presentation' });
        items.push(...index.items);
        for (const id of index.unavailable) warn({ path: `${shard}/${id}`, error: new UnavailableRpcRecordError({ id: id }) });
        continue;
      } catch (error) {
        warn({ path: `${shard}/index.json`, error });
      }
      // Do not write a repaired index during browsing, and do not conceal a
      // partial result as an exact empty collection. Preserve every bad file.
      try {
        for await (const [name, entry] of handle.entries()) {
          let id: string;
          switch (layout) {
          case 'files':
            if (entry.kind !== 'file' || name === 'index.json' || !name.endsWith('.json')) continue;
            id = name.slice(0, -5); break;
          case 'session-directories':
            switch (entry.kind) {
            case 'directory': break;
            case 'file': continue;
            default: { const exhaustive: never = entry; throw new Error(String(exhaustive)); }
            }
            id = name; break;
          default: { const exhaustive: never = layout; throw new Error(String(exhaustive)); }
          }
          try {
            imageGenerationRawIdSchema.parse(id);
            if (id.slice(-2).toLowerCase() !== shard) throw new Error('Image Generation record is in the wrong shard.');
            const record = await readRecord({ shardDirectory: handle, id });
            if (record === undefined) throw new Error('Image Generation record is incomplete.');
            items.push(summarize({ record }));
          } catch (error) {
            warn({ path: `${shard}/${name}`, error });
          }
        }
      } catch (error) {
        warn({ path: shard, error });
      }
    }
    return { items, warnings, warningCount };
  }

  /** Read-only shard validation before a caller publishes inputs or reserves activity.
   * The actual write revalidates under the same store lock; no cache/token escapes. */
  async function preflightWrite({ id }: { id: string }): Promise<void> {
    const rawId = imageGenerationRawIdSchema.parse(id);
    if (!directory) throw new Error('Image Generation table is unavailable.');
    const shard = rawId.slice(-2).toLowerCase();
    const shardDirectory = await imageGenerationDirectory({ parent: directory, name: shard, create: false });
    if (shardDirectory) await readIndex({ shardDirectory, shard, purpose: 'mutation' });
  }

  async function write({ record, assertCurrent, beforeCommit }: {
    record: R,
    assertCurrent: ({ current }: { current: R | undefined }) => void,
    beforeCommit: () => Promise<void>,
  }): Promise<void> {
    const snapshot = recordSchema.parse(record);
    validateRecord({ record: snapshot });
    const text = JSON.stringify(snapshot);
    const id = imageGenerationRawIdSchema.parse(recordId({ record: snapshot }));
    if (!directory) throw new Error('Image Generation table is unavailable.');
    const shard = id.slice(-2).toLowerCase();
    const shardDirectory = await directory.getDirectoryHandle(shard, { create: true });
    const index = await readIndex({ shardDirectory, shard, purpose: 'mutation' });
    const current = await readRecord({ shardDirectory, id });
    assertCurrent({ current });
    await beforeCommit();
    await writeImageGenerationText({ directory: shardDirectory, name: 'index.dirty', text: 'record-first' });
    if (current === undefined || JSON.stringify(current) !== text) {
      switch (layout) {
      case 'files': await writeImageGenerationText({ directory: shardDirectory, name: `${id}.json`, text }); break;
      case 'session-directories': {
        const parent = await shardDirectory.getDirectoryHandle(id, { create: true });
        try {
          await writeImageGenerationText({ directory: parent, name: 'session.json', text });
        } catch (error) {
          if (current === undefined) {
            // Remove only a directory this failed creation left empty. Unknown
            // bytes must survive for raw export; never recurse during cleanup.
            try {
              let empty = true;
              for await (const _entry of parent.entries()) {
                empty = false; break;
              }
              if (empty) await shardDirectory.removeEntry(id);
            } catch { /* Preserve the original write failure. */ }
          }
          throw error;
        }
        break;
      }
      default: { const exhaustive: never = layout; throw new Error(String(exhaustive)); }
      }
    }
    const summaries = index.items.filter(summary => summaryId({ summary }) !== id);
    summaries.push(summarize({ record: snapshot }));
    await writeImageGenerationText({ directory: shardDirectory, name: 'index.json', text: JSON.stringify(indexSchema.parse({ items: summaries })) });
    await shardDirectory.removeEntry('index.dirty');
  }

  return { load, list, write, preflightWrite };
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
export const TEST_ONLY = {
};
