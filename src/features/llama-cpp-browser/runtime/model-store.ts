import { z } from 'zod';
import { LlamaCppBrowserError, modelSchema, type LocalModel, type Progress } from '@/features/llama-cpp-browser/types';
import { logDiagnostic } from '@/features/llama-cpp-browser/debug-log';

const directoryName = 'llama-cpp-browser-models';
const legacyDirectoryName = 'llama-cpp-browser-models-v1';
const lockName = 'naidan-llama-cpp-browser-model-store';

async function directory(): Promise<FileSystemDirectoryHandle> {
  if (!navigator.storage?.getDirectory) throw new LlamaCppBrowserError({ code: 'unavailable' });
  const storageRoot = await navigator.storage.getDirectory();
  const root = await storageRoot.getDirectoryHandle(directoryName, { create: true });
  await migrateLegacyModels({ storageRoot, root });
  return root;
}
function isNotFound({ error }: { error: unknown }): boolean {
  return error instanceof DOMException && error.name === 'NotFoundError';
}
async function readMetadata({ folder }: { folder: FileSystemDirectoryHandle }): Promise<LocalModel | undefined> {
  try {
    const file = await (await folder.getFileHandle('metadata.json')).getFile();
    if (file.size === 0 || file.size > 4096) return undefined;
    const parsed = modelSchema.safeParse(JSON.parse(await file.text()));
    return parsed.success ? parsed.data : undefined;
  } catch (error) {
    if (isNotFound({ error }) || error instanceof SyntaxError) return undefined;
    throw error;
  }
}
async function writeMetadata({ folder, model }: { folder: FileSystemDirectoryHandle, model: LocalModel }): Promise<void> {
  const writer = await (await folder.getFileHandle('metadata.json', { create: true })).createWritable();
  try {
    await writer.write(JSON.stringify(model)); await writer.close();
  } catch (error) {
    await writer.abort().catch(() => {}); throw error;
  }
}
async function copyModelFile({ source, destination }: { source: File, destination: FileSystemFileHandle }): Promise<void> {
  const writer = await destination.createWritable();
  const reader = source.stream().getReader(); let completed = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      await writer.write(value); completed += value.byteLength;
    }
    if (completed !== source.size) throw new LlamaCppBrowserError({ code: 'storage-error' });
    await writer.close();
  } catch (error) {
    await reader.cancel().catch(() => {}); await writer.abort().catch(() => {}); throw error;
  } finally {
    reader.releaseLock();
  }
}
/** Migrate under the same exclusive lock used by readers, imports and inference.
 * Publish metadata before transferring a legacy file, so an interrupted move is
 * recoverable from either side. Never delete the source before the target is valid.
 */
async function migrateLegacyModels({ storageRoot, root }: {
  storageRoot: FileSystemDirectoryHandle, root: FileSystemDirectoryHandle,
}): Promise<void> {
  let legacy: FileSystemDirectoryHandle;
  try {
    legacy = await storageRoot.getDirectoryHandle(legacyDirectoryName);
  } catch (error) {
    if (isNotFound({ error })) return;
    throw error;
  }
  for await (const [id, entry] of legacy.entries()) {
    if (entry.kind !== 'directory' || !z.uuid().safeParse(id).success) continue;
    const model = await readMetadata({ folder: entry });
    if (!model || model.id !== id) continue; // Do not guess ownership of damaged/foreign entries.
    const target = await root.getDirectoryHandle(id, { create: true });
    const existing = await readMetadata({ folder: target });
    if (existing && (existing.id !== model.id || existing.name !== model.name || existing.size !== model.size || existing.importedAt !== model.importedAt)) {
      throw new LlamaCppBrowserError({ code: 'storage-error' });
    }
    if (!existing) {
      // Only an empty metadata file can be a recoverable previous write here.
      // Do not overwrite populated data with an invalid or missing manifest.
      for await (const [name, child] of target.entries()) {
        if (name !== 'metadata.json' || child.kind !== 'file' || (await child.getFile()).size !== 0) {
          throw new LlamaCppBrowserError({ code: 'storage-error' });
        }
      }
    }
    let transferred = false;
    if (existing) {
      try {
        transferred = (await (await target.getFileHandle('model.gguf')).getFile()).size === model.size;
      } catch (error) {
        if (!isNotFound({ error })) throw error;
      }
    }
    if (!transferred) {
      const sourceHandle = await entry.getFileHandle('model.gguf');
      const source = await sourceHandle.getFile();
      if (source.size !== model.size) throw new LlamaCppBrowserError({ code: 'storage-error' });
      await writeMetadata({ folder: target, model });
      const movable = sourceHandle as FileSystemFileHandle & {
        // eslint-disable-next-line local-rules-named-args/require-named-args -- Optional native OPFS move overload uses positional arguments.
        move?: (destination: FileSystemDirectoryHandle, name: string) => Promise<void>,
      };
      if (movable.move) {
        try {
          // Avoid making a second model-sized copy on implementations with OPFS move.
          await movable.move(target, 'model.gguf'); transferred = true;
        } catch (error) {
          if (!(error instanceof TypeError) && !(error instanceof DOMException && error.name === 'NotSupportedError')) throw error;
        }
      }
      if (!transferred) {
        await copyModelFile({ source, destination: await target.getFileHandle('model.gguf', { create: true }) });
      }
      if ((await (await target.getFileHandle('model.gguf')).getFile()).size !== model.size) {
        throw new LlamaCppBrowserError({ code: 'storage-error' });
      }
    }
    for (const name of ['model.gguf', 'metadata.json']) {
      try {
        await entry.removeEntry(name);
      } catch (error) {
        if (!isNotFound({ error })) throw error;
      }
    }
    // Only remove now-empty legacy containers, never extra user-created entries.
    try {
      await legacy.removeEntry(id);
    } catch (error) {
      if (!(error instanceof DOMException && error.name === 'InvalidModificationError')) throw error;
    }
  }
  try {
    await storageRoot.removeEntry(legacyDirectoryName);
  } catch (error) {
    if (!(error instanceof DOMException && error.name === 'InvalidModificationError')) throw error;
  }
}
export async function withModelStoreLock<T>({ operation }: { operation: () => Promise<T> }): Promise<T> {
  if (!navigator.locks) throw new LlamaCppBrowserError({ code: 'unavailable' });
  return navigator.locks.request(lockName, operation);
}
export async function listStoredModels(): Promise<LocalModel[]> {
  const root = await directory(); const result: LocalModel[] = [];
  for await (const [name, handle] of root.entries()) {
    if (handle.kind !== 'directory' || !z.uuid().safeParse(name).success) continue;
    try {
      let metadataHandle: FileSystemFileHandle;
      try {
        metadataHandle = await handle.getFileHandle('metadata.json');
      } catch (error) {
        // The exclusive model-store lock prevents racing a live import. Without
        // a published manifest this is a terminated import owned by this feature.
        if (!(error instanceof DOMException) || error.name !== 'NotFoundError') throw error;
        await root.removeEntry(name, { recursive: true });
        continue;
      }
      const metadata = await metadataHandle.getFile();
      // createWritable publishes on close. Terminating the Worker between
      // creating the metadata handle and closing it leaves an empty manifest.
      if (metadata.size === 0) {
        await root.removeEntry(name, { recursive: true });
        continue;
      }
      if (metadata.size > 4096) continue;
      const model = modelSchema.parse(JSON.parse(await metadata.text()));
      const file = await (await handle.getFileHandle('model.gguf')).getFile();
      if (model.id === name && file.size === model.size) result.push(model);
    } catch (error) {
      // Corrupt published metadata must not expose an invalid entry or delete data.
      if (error instanceof DOMException && error.name !== 'NotFoundError') throw error;
    }
  }
  return result.sort((a, b) => a.name.localeCompare(b.name));
}
export async function importStoredModel({ file, onProgress }: { file: File, onProgress: ({ progress }: { progress: Progress }) => void }): Promise<LocalModel> {
  if (!Number.isSafeInteger(file.size) || file.size < 24 || file.name.length === 0 || file.name.length > 512) throw new LlamaCppBrowserError({ code: 'invalid-gguf' });
  const header = new Uint8Array(await file.slice(0, 8).arrayBuffer());
  if (header[0] !== 71 || header[1] !== 71 || header[2] !== 85 || header[3] !== 70 || ![2, 3].includes(new DataView(header.buffer).getUint32(4, true))) throw new LlamaCppBrowserError({ code: 'invalid-gguf' });
  if ((await listStoredModels()).some(model => model.name === file.name)) throw new LlamaCppBrowserError({ code: 'duplicate-model' });
  const model = modelSchema.parse({ id: crypto.randomUUID(), name: file.name, size: file.size, importedAt: Date.now() });
  const root = await directory(); const target = await root.getDirectoryHandle(model.id, { create: true });
  let writer: FileSystemWritableFileStream | undefined;
  const started = performance.now();
  logDiagnostic({ diagnostic: { event: 'import-start', bytes: file.size } });
  try {
    writer = await (await target.getFileHandle('model.gguf', { create: true })).createWritable();
    const reader = file.stream().getReader(); let completed = 0; let lastProgress = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        await writer.write(value); completed += value.byteLength;
        if (performance.now() - lastProgress > 150) {
          onProgress({ progress: { phase: 'importing', completed, total: file.size } }); lastProgress = performance.now();
        }
      }
    } finally {
      reader.releaseLock();
    }
    if (completed !== file.size) throw new LlamaCppBrowserError({ code: 'storage-error' });
    await writer.close(); writer = undefined;
    await writeMetadata({ folder: target, model });
    onProgress({ progress: { phase: 'importing', completed, total: file.size } });
    logDiagnostic({ diagnostic: { event: 'import-complete', bytes: completed, elapsedMs: performance.now() - started } });
    return model;
  } catch (error) {
    await writer?.abort().catch(() => {});
    await root.removeEntry(model.id, { recursive: true }).catch(() => {});
    throw error;
  }
}
export async function removeStoredModel({ id }: { id: string }): Promise<void> {
  const safeId = z.uuid().parse(id);
  await (await directory()).removeEntry(safeId, { recursive: true });
}
export async function storedModelHandle({ name }: { name: string }): Promise<FileSystemFileHandle> {
  const model = (await listStoredModels()).find(item => item.name === name);
  if (!model) throw new LlamaCppBrowserError({ code: 'missing-model' });
  const folder = await (await directory()).getDirectoryHandle(model.id);
  return folder.getFileHandle('model.gguf');
}
export const TEST_ONLY = {
};
