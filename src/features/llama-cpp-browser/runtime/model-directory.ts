import { localRepositoryInput, modelImportPendingName, normalizeModelDirectoryInput } from './model-directory-input';
import { isModelSourceSegment, localRepositoryReference } from '@/01-models/llama-cpp-browser-model-id';
import { readStoredModelFile, type ModelFile, type StoredModelFile } from '@/logic/model-file-system';
import { resolveModelFiles } from './model-file-selection';
export { resolveModelFiles } from './model-file-selection';
import { modelFileIsPending } from '@/logic/model-file-publication';
import { OPFS_MODELS_DIR } from '@/constants';
import { executeDeletionPlan, scanDeletionTree } from './deletion-plan';
import { isProjector } from '@/features/llama-cpp-browser/hugging-face/model-variants';
import { logDiagnostic } from '@/features/llama-cpp-browser/debug-log';
import { errorCode, LlamaCppBrowserError, modelSchema, type LocalModel, type ModelDirectoryInput, type Progress } from '@/features/llama-cpp-browser/types';
import { withModelMutationLock } from './model-mutation-lock';
import { localRepositoryDirectories } from './local-repository-layout';

const pendingName = modelImportPendingName;
export type { ModelFile, StoredModelFile } from '@/logic/model-file-system';
export type ModelDirectory = { files: ModelFile[], primaryFile: ModelFile, projectorFile: ModelFile | undefined };
export type ModelRootLocation =
  | { kind: 'opfs-user', rootName: string }
  | { kind: 'hugging-face', repository: string }
  | { kind: 'host', directoryId: string, repository: string }
  | { kind: 'local-files', rootPath: string, sourceId: string, rootName: string, savedRootName?: string }
  | { kind: 'temp', rootPath: string };
export type ResolvedModel = { modelId: string, location: ModelRootLocation, directory: ModelDirectory };

export function validSegment({ name }: { name: string }): boolean {
  return isModelSourceSegment({ name });
}

export function allowedModelDirectory({ name }: { name: string }): boolean {
  return validSegment({ name }) && !name.startsWith('.');
}

export async function opfsRoot(): Promise<FileSystemDirectoryHandle> {
  if (!navigator.storage?.getDirectory) {
    throw new LlamaCppBrowserError({ code: 'unavailable' });
  }
  return navigator.storage.getDirectory();
}

export async function userModelDirectory(): Promise<FileSystemDirectoryHandle> {
  const models = await (await opfsRoot()).getDirectoryHandle(OPFS_MODELS_DIR, { create: true });
  return models.getDirectoryHandle('user', { create: true });
}

/** Read-only lookup. Listing or opening a model must never create storage. */
export async function existingUserModelDirectory(): Promise<FileSystemDirectoryHandle | undefined> {
  try {
    const models = await (await opfsRoot()).getDirectoryHandle(OPFS_MODELS_DIR);
    return await models.getDirectoryHandle('user');
  } catch (error) {
    if (missing({ error })) {
      return undefined;
    }
    throw error;
  }
}

function missing({ error }: { error: unknown }): boolean {
  return error instanceof DOMException && (error.name === 'NotFoundError' || error.name === 'TypeMismatchError');
}

export async function hasPendingImport({ folder }: { folder: FileSystemDirectoryHandle }): Promise<boolean> {
  try {
    await folder.getFileHandle(pendingName);
    return true;
  } catch (error) {
    if (missing({ error })) {
      return false;
    }
    throw error;
  }
}

export async function validGguf({ file }: { file: File }): Promise<boolean> {
  if (file.size < 24 || !Number.isSafeInteger(file.size)) {
    return false;
  }
  const bytes = new Uint8Array(await file.slice(0, 8).arrayBuffer());
  return bytes.length === 8 && bytes[0] === 71 && bytes[1] === 71 && bytes[2] === 85 && bytes[3] === 70 && [2, 3].includes(new DataView(bytes.buffer).getUint32(4, true));
}

export async function readModelFiles({ folder, prefix, storageKind, signal }: { folder: FileSystemDirectoryHandle, prefix: string, storageKind: 'opfs' | 'host', signal: AbortSignal | undefined }): Promise<StoredModelFile[]> {
  const result: StoredModelFile[] = [];
  for await (const [name, entry] of folder.entries()) {
    signal?.throwIfAborted();
    if (!validSegment({ name })) {
      throw new LlamaCppBrowserError({ code: 'invalid-gguf' });
    }
    const relativePath = prefix + name;
    switch (entry.kind) {
    case 'directory': result.push(...await readModelFiles({ folder: entry, prefix: `${relativePath}/`, storageKind, signal }));
      break;
    case 'file':
      if (/\.gguf$/i.test(name) && !await modelFileIsPending({ directory: folder, name })) {
        result.push(await readStoredModelFile({ relativePath, handle: entry, storageKind, signal }));
      }
      break;
    default: {
      const exhaustive: never = entry;
      throw new Error(`Unexpected entry: ${exhaustive}`);
    }
    }
  }
  signal?.throwIfAborted();
  return result.sort((a, b) => a.relativePath.localeCompare(b.relativePath));
}


export function modelDirectory({ files }: { files: ModelFile[] }): ModelDirectory {
  const { primaryRelativePath, projectorRelativePath } = resolveModelFiles({ files });
  return {
    files: files.filter(file => !isProjector({ path: file.relativePath }) || file.relativePath === projectorRelativePath),
    primaryFile: files.find(file => file.relativePath === primaryRelativePath)!,
    projectorFile: files.find(file => file.relativePath === projectorRelativePath),
  };
}

export async function resolveDirectory({ folder, signal }: { folder: FileSystemDirectoryHandle, signal: AbortSignal | undefined }): Promise<ModelDirectory> {
  if (await hasPendingImport({ folder })) {
    throw new LlamaCppBrowserError({ code: 'missing-model' });
  }
  const files = await readModelFiles({ folder, prefix: '', storageKind: 'opfs', signal });
  for (const entry of files) {
    signal?.throwIfAborted();
    if (!await validGguf({ file: entry.file })) {
      throw new LlamaCppBrowserError({ code: 'invalid-gguf' });
    }
  }
  signal?.throwIfAborted();
  return modelDirectory({ files });
}

export async function resolveLocalRepositoryDirectories({ folder, rootName, signal }: {
  folder: FileSystemDirectoryHandle, rootName: string, signal: AbortSignal | undefined,
}): Promise<{ selector: string, directory: ModelDirectory }[]> {
  if (!allowedModelDirectory({ name: rootName })) {
    throw new LlamaCppBrowserError({ code: 'invalid-gguf' });
  }
  if (await hasPendingImport({ folder })) {
    throw new LlamaCppBrowserError({ code: 'missing-model' });
  }
  const files = await readModelFiles({ folder, prefix: '', storageKind: 'opfs', signal });
  for (const entry of files) {
    signal?.throwIfAborted();
    if (!await validGguf({ file: entry.file })) {
      throw new LlamaCppBrowserError({ code: 'invalid-gguf' });
    }
  }
  return localRepositoryDirectories({ files });
}

export function describeDirectory({ directory, modelId }: { directory: ModelDirectory, modelId: string }): LocalModel {
  return modelSchema.parse({ modelId, size: directory.files.reduce((sum, entry) => sum + entry.file.size, 0), importedAt: Math.max(...directory.files.map(entry => entry.file.lastModified)) });
}

async function clearEmptyInterruptedImport({ parent, folder, name, paths, signal }: {
  parent: FileSystemDirectoryHandle, folder: FileSystemDirectoryHandle, name: string, paths: Set<string>, signal: AbortSignal | undefined,
}): Promise<boolean> {
  // Older single-file cancellation terminated the Worker before rollback. Async
  // writable streams publish on close, so those interrupted copies can leave
  // only an empty marker and empty destination files. An explicit retry may
  // reclaim exactly those placeholders, never real data or an unrelated tree.
  // Nonempty/ambiguous leftovers still require explicit planned deletion.
  if (!await hasPendingImport({ folder })) {
    return false;
  }
  const { files, directories } = await scanDeletionTree({ folder });
  if (!files.some(file => file.relativePath === pendingName && file.size === 0)
    || files.some(file => file.size !== 0 || (file.relativePath !== pendingName && !paths.has(file.relativePath)))
    || directories.some(directory => !Array.from(paths).some(path => path.startsWith(`${directory}/`)))) {
    return false;
  }
  if (signal?.aborted) {
    throw new LlamaCppBrowserError({ code: 'aborted' });
  }
  // Recheck file metadata and delete non-recursively: an external file editor
  // need not honor the model-store lock, and new content must not be swept away.
  const result = await executeDeletionPlan({ folder, files, selectedRelativePaths: undefined });
  switch (result) {
  case 'changed': return false;
  case 'deleted': break;
  default: {
    const exhaustive: never = result;
    throw new Error(String(exhaustive));
  }
  }
  try {
    await parent.removeEntry(name);
    return true;
  } catch (error) {
    if (error instanceof DOMException && error.name === 'InvalidModificationError') {
      return false;
    }
    throw error;
  }
}

/** A source-neutral import boundary shared by dropped folders and future downloads. */
export type CapturedModelImport = { model: LocalModel, parent: FileSystemDirectoryHandle, folder: FileSystemDirectoryHandle, directory: ModelDirectory };
export type CapturedRepositoryImport = { rootName: string, models: CapturedModelImport[] };

export async function importModelDirectory({ directory, onProgress, signal }: { signal: AbortSignal | undefined, directory: ModelDirectoryInput, onProgress: ({ progress }: { progress: Progress }) => void }): Promise<LocalModel> {
  return (await importCapturedModelDirectory({ directory, onProgress, signal, collision: 'reject' })).model;
}

export async function importCapturedModelDirectory({ directory, onProgress, signal, collision, onCommitted }: { signal: AbortSignal | undefined, directory: ModelDirectoryInput, collision: 'reject' | 'rename', onProgress: ({ progress }: { progress: Progress }) => void, onCommitted?: ({ captured }: { captured: CapturedModelImport }) => void }): Promise<CapturedModelImport> {
  return withModelMutationLock({
    signal,
    operation: async () => {
      const repository = await writeModelDirectory({ directory, onProgress, signal, collision, layout: 'single' });
      const captured = repository.models[0]!;
      onCommitted?.({ captured });
      return captured;
    },
  });
}

export async function importCapturedModelRepository({ directory, onProgress, signal, onCommitted }: {
  signal: AbortSignal | undefined, directory: ModelDirectoryInput, onProgress: ({ progress }: { progress: Progress }) => void, onCommitted({ captured }: { captured: CapturedRepositoryImport }): void,
}): Promise<CapturedRepositoryImport> {
  return withModelMutationLock({
    signal,
    operation: async () => {
      const captured = await writeModelDirectory({ directory: localRepositoryInput({ directory }), onProgress, signal, collision: 'rename', layout: 'repository' });
      onCommitted({ captured });
      return captured;
    },
  });
}

async function writeModelDirectory({ directory, onProgress, signal, collision, layout }: { signal: AbortSignal | undefined, directory: ModelDirectoryInput, collision: 'reject' | 'rename', onProgress: ({ progress }: { progress: Progress }) => void, layout: 'single' | 'repository' }): Promise<CapturedRepositoryImport> {
  const checkCancelled = (): void => {
    if (signal?.aborted) {
      throw new LlamaCppBrowserError({ code: 'aborted' });
    }
  };
  checkCancelled();
  directory = normalizeModelDirectoryInput({ directory });
  let rootName = directory.rootName;
  const paths = new Set(directory.files.map(entry => entry.relativePath));
  const ggufs = directory.files.filter(entry => /\.gguf$/i.test(entry.relativePath));
  try {
    switch (layout) {
    case 'single': resolveModelFiles({ files: ggufs });
      break;
    case 'repository': localRepositoryDirectories({ files: ggufs.map(entry => ({ ...entry, storageKind: 'temp', registrationRevision: 1 })) });
      break;
    default: {
      const exhaustive: never = layout;
      throw new Error(String(exhaustive));
    }
    }
  } catch (error) {
    logDiagnostic({ diagnostic: { event: 'failed', stage: 'model-resolve', reason: 'model-directory-layout', code: errorCode({ error }) } });
    throw error;
  }
  for (const { file } of ggufs) {
    if (!await validGguf({ file })) {
      throw new LlamaCppBrowserError({ code: 'invalid-gguf' });
    }
  }
  checkCancelled();
  const parent = await userModelDirectory();
  switch (collision) {
  case 'rename': {
    const occupied = new Set<string>();
    for await (const [name] of parent.entries()) {
      checkCancelled();
      occupied.add(name);
    }
    const base = rootName;
    for (let suffix = 2; occupied.has(rootName); suffix++) {
      const ending = `-${suffix}`;
      const characters = Array.from(base);
      while (new TextEncoder().encode(characters.join('') + ending).length > 255) {
        characters.pop();
      }
      rootName = characters.join('') + ending;
    }
    break;
  }
  case 'reject': break;
  default: {
    const exhaustive: never = collision;
    throw new Error(String(exhaustive));
  }
  }
  for await (const [name, entry] of parent.entries()) {
    if (name !== rootName) {
      continue;
    }
    checkCancelled();
    if (entry.kind !== 'directory' || !await clearEmptyInterruptedImport({ parent, folder: entry, name, paths, signal })) {
      throw new LlamaCppBrowserError({ code: 'duplicate-model' });
    }
    break;
  }
  checkCancelled();
  let completed = 0;
  const total = directory.files.reduce((sum, entry) => sum + entry.file.size, 0);
  if (!Number.isSafeInteger(total)) {
    throw new LlamaCppBrowserError({ code: 'storage-error' });
  }
  const folder = await parent.getDirectoryHandle(rootName, { create: true });
  try {
    await folder.getFileHandle(pendingName, { create: true });
    for (const { relativePath, file } of directory.files) {
      checkCancelled();
      const parts = relativePath.split('/');
      const name = parts.pop()!;
      let parent = folder;
      for (const segment of parts) {
        parent = await parent.getDirectoryHandle(segment, { create: true });
      }
      const destination = await parent.getFileHandle(name, { create: true });
      const writer = await destination.createWritable();
      const reader = file.stream().getReader();
      let written = 0;
      // A chunk read can be pending when Cancel arrives. Wake that await so the
      // worker reaches rollback instead of waiting for another chunk forever.
      const cancelRead = (): void => {
        void reader.cancel().catch(() => {});
      };
      signal?.addEventListener('abort', cancelRead, { once: true });
      try {
        while (true) {
          checkCancelled();
          const { done, value } = await reader.read();
          checkCancelled();
          if (done) {
            break;
          }
          written += value.byteLength;
          if (written > file.size) {
            throw new LlamaCppBrowserError({ code: 'storage-error' });
          }
          await writer.write(value);
          checkCancelled();
          completed += value.byteLength;
          onProgress({ progress: { phase: 'importing', completed, total } });
        }
        checkCancelled();
        if (written !== file.size) {
          throw new LlamaCppBrowserError({ code: 'storage-error' });
        }
        await writer.close();
        if ((await destination.getFile()).size !== file.size) {
          throw new LlamaCppBrowserError({ code: 'storage-error' });
        }
      } catch (error) {
        await reader.cancel().catch(() => {});
        await writer.abort().catch(() => {});
        throw error;
      } finally {
        signal?.removeEventListener('abort', cancelRead);
        reader.releaseLock();
      }
    }
    // Only the transient pending marker guards publication; each load resolves the files anew.
    checkCancelled();
    await folder.removeEntry(pendingName);
    let configurations: { selector: string | undefined, directory: ModelDirectory }[];
    switch (layout) {
    case 'single': configurations = [{ selector: undefined, directory: await resolveDirectory({ folder, signal }) }];
      break;
    case 'repository': configurations = await resolveLocalRepositoryDirectories({ folder, rootName, signal });
      break;
    default: {
      const exhaustive: never = layout;
      throw new Error(String(exhaustive));
    }
    }
    checkCancelled();
    return {
      rootName,
      models: configurations.map(({ selector, directory: capturedDirectory }) => ({
        model: describeDirectory({ directory: capturedDirectory, modelId: localRepositoryReference({ storage: 'saved', rootName, selector }) }),
        parent,
        folder,
        directory: capturedDirectory,
      })),
    };
  } catch (error) {
    await parent.removeEntry(rootName, { recursive: true }).catch(() => {});
    throw error;
  }
}

export const TEST_ONLY = {
};
