import { rankedProjectors } from '@/features/llama-cpp-browser/hugging-face/presentation';
import { isProjector } from '@/features/llama-cpp-browser/hugging-face/model-variants';
import { logDiagnostic } from '@/features/llama-cpp-browser/debug-log';
import { errorCode, LlamaCppBrowserError, modelSchema, type LocalModel, type ModelDirectoryInput, type Progress } from '@/features/llama-cpp-browser/types';

const pendingName = '.llama-cpp-import-pending';
export type ModelFile = { path: string, handle: FileSystemFileHandle, file: File };
export type ModelDirectory = { id: string, name: string, files: ModelFile[], modelPath: string, projectorPath: string | undefined };

export function validSegment({ name }: { name: string }): boolean {
  return name.length > 0 && name !== '.' && name !== '..' && !/[\\/]/.test(name) && !Array.from(name).some(character => character.charCodeAt(0) < 32) && new TextEncoder().encode(name).length <= 255;
}
export function allowedModelDirectory({ name }: { name: string }): boolean {
  return validSegment({ name }) && !name.startsWith('.');
}
export async function opfsRoot(): Promise<FileSystemDirectoryHandle> {
  if (!navigator.storage?.getDirectory) throw new LlamaCppBrowserError({ code: 'unavailable' });
  return navigator.storage.getDirectory();
}
export async function userModelDirectory(): Promise<FileSystemDirectoryHandle> {
  const models = await (await opfsRoot()).getDirectoryHandle('llama-cpp-browser-models', { create: true });
  return models.getDirectoryHandle('user', { create: true });
}
function missing({ error }: { error: unknown }): boolean {
  return error instanceof DOMException && (error.name === 'NotFoundError' || error.name === 'TypeMismatchError');
}
export async function hasPendingImport({ folder }: { folder: FileSystemDirectoryHandle }): Promise<boolean> {
  try {
    await folder.getFileHandle(pendingName); return true;
  } catch (error) {
    if (missing({ error })) return false; throw error;
  }
}
export async function validGguf({ file }: { file: File }): Promise<boolean> {
  if (file.size < 24 || !Number.isSafeInteger(file.size)) return false;
  const bytes = new Uint8Array(await file.slice(0, 8).arrayBuffer());
  return bytes.length === 8 && bytes[0] === 71 && bytes[1] === 71 && bytes[2] === 85 && bytes[3] === 70 && [2, 3].includes(new DataView(bytes.buffer).getUint32(4, true));
}
export async function readModelFiles({ folder, prefix }: { folder: FileSystemDirectoryHandle, prefix: string }): Promise<ModelFile[]> {
  const result: ModelFile[] = [];
  for await (const [name, entry] of folder.entries()) {
    if (!validSegment({ name })) throw new LlamaCppBrowserError({ code: 'invalid-gguf' });
    const path = prefix + name;
    switch (entry.kind) {
    case 'directory': result.push(...await readModelFiles({ folder: entry, prefix: `${path}/` })); break;
    case 'file':
      if (/\.gguf$/i.test(name)) result.push({ path, handle: entry, file: await entry.getFile() });
      break;
    default: { const exhaustive: never = entry; throw new Error(`Unexpected entry: ${exhaustive}`); }
    }
  }
  return result.sort((a, b) => a.path.localeCompare(b.path));
}
export function resolveModelFiles({ files }: { files: { path: string }[] }): { modelPath: string, projectorPath: string | undefined } {
  // Match upstream directory discovery without requiring a particular marker position.
  // External file edits may leave several projectors. Select one deterministically;
  // this preference does not claim model/projector compatibility.
  const projectors = rankedProjectors({ files: files.filter(entry => isProjector({ path: entry.path })) });
  const bases = files.filter(entry => !projectors.includes(entry));
  if (bases.length === 0) throw new LlamaCppBrowserError({ code: 'unsupported-input' });
  const first = bases[0]!;
  const split = /^(.*)-(\d{5})-of-(\d{5})(\.gguf)$/i.exec(first.path);
  if (!split) {
    if (bases.length !== 1) throw new LlamaCppBrowserError({ code: 'unsupported-input' });
  } else {
    const count = Number(split[3]);
    if (count < 1 || count !== bases.length) throw new LlamaCppBrowserError({ code: 'invalid-gguf' });
    const expected = new Set(Array.from({ length: count }, (_, index) => `${split[1]}-${String(index + 1).padStart(5, '0')}-of-${split[3]}${split[4]}`));
    if (bases.some(entry => !expected.delete(entry.path)) || expected.size) throw new LlamaCppBrowserError({ code: 'invalid-gguf' });
  }
  return { modelPath: first.path, projectorPath: projectors[0]?.path };
}
export async function resolveDirectory({ folder, id, name }: { folder: FileSystemDirectoryHandle, id: string, name: string }): Promise<ModelDirectory> {
  if (await hasPendingImport({ folder })) throw new LlamaCppBrowserError({ code: 'missing-model' });
  const files = await readModelFiles({ folder, prefix: '' });
  for (const entry of files) if (!await validGguf({ file: entry.file })) throw new LlamaCppBrowserError({ code: 'invalid-gguf' });
  const resolved = resolveModelFiles({ files });
  return { id, name, files: files.filter(file => !isProjector({ path: file.path }) || file.path === resolved.projectorPath), ...resolved };
}
export function describeDirectory({ directory }: { directory: ModelDirectory }): LocalModel {
  return modelSchema.parse({ id: directory.id, name: directory.name, size: directory.files.reduce((sum, entry) => sum + entry.file.size, 0), importedAt: Math.max(...directory.files.map(entry => entry.file.lastModified)) });
}
/** A source-neutral import boundary shared by dropped folders and future downloads. */
export async function importModelDirectory({ directory, onProgress, signal }: { signal: AbortSignal | undefined, directory: ModelDirectoryInput, onProgress: ({ progress }: { progress: Progress }) => void }): Promise<LocalModel> {
  const checkCancelled = (): void => {
    if (signal?.aborted) throw new LlamaCppBrowserError({ code: 'aborted' });
  };
  checkCancelled();
  const rootName = directory.name.replaceAll(':', '_');
  if (!allowedModelDirectory({ name: rootName }) || directory.files.length === 0) throw new LlamaCppBrowserError({ code: 'invalid-gguf' });
  const paths = new Set<string>();
  for (const { path } of directory.files) {
    if (!path.split('/').every(name => validSegment({ name })) || path.split('/')[0] === pendingName || paths.has(path)) throw new LlamaCppBrowserError({ code: 'invalid-gguf' });
    paths.add(path);
  }
  for (const path of paths) {
    const parts = path.split('/'); parts.pop();
    while (parts.length) {
      if (paths.has(parts.join('/'))) throw new LlamaCppBrowserError({ code: 'invalid-gguf' }); parts.pop();
    }
  }
  const ggufs = directory.files.filter(entry => /\.gguf$/i.test(entry.path));
  try {
    resolveModelFiles({ files: ggufs });
  } catch (error) {
    logDiagnostic({ diagnostic: { event: 'failed', stage: 'model-resolve', reason: 'model-directory-layout', code: errorCode({ error }) } });
    throw error;
  }
  for (const { file } of ggufs) if (!await validGguf({ file })) throw new LlamaCppBrowserError({ code: 'invalid-gguf' });
  const parent = await userModelDirectory();
  for await (const [name] of parent.entries()) if (name === rootName) throw new LlamaCppBrowserError({ code: 'duplicate-model' });
  let completed = 0; const total = directory.files.reduce((sum, entry) => sum + entry.file.size, 0);
  if (!Number.isSafeInteger(total)) throw new LlamaCppBrowserError({ code: 'storage-error' });
  const folder = await parent.getDirectoryHandle(rootName, { create: true });
  try {
    await folder.getFileHandle(pendingName, { create: true });
    for (const { path, file } of directory.files) {
      checkCancelled();
      const parts = path.split('/'); const name = parts.pop()!; let parent = folder;
      for (const segment of parts) parent = await parent.getDirectoryHandle(segment, { create: true });
      const destination = await parent.getFileHandle(name, { create: true });
      const writer = await destination.createWritable(); const reader = file.stream().getReader(); let written = 0;
      try {
        while (true) {
          checkCancelled();
          const { done, value } = await reader.read(); checkCancelled(); if (done) break;
          written += value.byteLength;
          if (written > file.size) throw new LlamaCppBrowserError({ code: 'storage-error' });
          await writer.write(value); completed += value.byteLength;
          onProgress({ progress: { phase: 'importing', completed, total } });
        }
        checkCancelled();
        if (written !== file.size) throw new LlamaCppBrowserError({ code: 'storage-error' });
        await writer.close();
        if ((await destination.getFile()).size !== file.size) throw new LlamaCppBrowserError({ code: 'storage-error' });
      } catch (error) {
        await reader.cancel().catch(() => {}); await writer.abort().catch(() => {}); throw error;
      } finally {
        reader.releaseLock();
      }
    }
    // Only the transient pending marker guards publication; each load resolves the files anew.
    checkCancelled();
    await folder.removeEntry(pendingName);
    const model = describeDirectory({ directory: await resolveDirectory({ folder, id: `user/${rootName}`, name: rootName }) });
    checkCancelled();
    return model;
  } catch (error) {
    await parent.removeEntry(rootName, { recursive: true }).catch(() => {});
    throw error;
  }
}
export const TEST_ONLY = {
};
