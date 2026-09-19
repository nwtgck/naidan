import { z } from 'zod';
import { LlamaCppBrowserError, modelSchema, type LocalModel, type Progress } from '@/features/llama-cpp-browser/types';
import { logDiagnostic } from '@/features/llama-cpp-browser/debug-log';

const directoryName = 'llama-cpp-browser-models-v1';
const lockName = 'naidan-llama-cpp-browser-model-store';

async function directory(): Promise<FileSystemDirectoryHandle> {
  if (!navigator.storage?.getDirectory) throw new LlamaCppBrowserError({ code: 'unavailable' });
  return (await navigator.storage.getDirectory()).getDirectoryHandle(directoryName, { create: true });
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
    const metadata = await (await target.getFileHandle('metadata.json', { create: true })).createWritable();
    try {
      await metadata.write(JSON.stringify(model)); await metadata.close();
    } catch (error) {
      await metadata.abort().catch(() => {}); throw error;
    }
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
