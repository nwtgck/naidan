import { isModelSourceSegment } from '@/01-models/llama-cpp-browser-model-id';
import type { TemporaryModelDirectoryInput } from '@/01-models/temporary-model-files';

/** Preserve the selected root separately from paths inside it. Both engines
 * share this input boundary; neither gets to filter the other's model files. */
export function modelDirectoryFromFiles({ files }: { files: File[] }): TemporaryModelDirectoryInput {
  const name = files[0]?.webkitRelativePath?.split('/')[0];
  if (!name) {
    throw new Error('Choose a model folder');
  }
  const prefix = `${name}/`;
  return {
    rootName: name,
    files: files.map(file => {
      if (!file.webkitRelativePath.startsWith(prefix)) {
        throw new Error('Folder selection contains different roots');
      }
      return { relativePath: file.webkitRelativePath.slice(prefix.length), file };
    }).filter(entry => !entry.relativePath.split('/').includes('.git')),
  };
}

export async function droppedModelFiles({ transfer, signal }: { transfer: DataTransfer, signal: AbortSignal | undefined }): Promise<{ directories: TemporaryModelDirectoryInput[], files: File[] }> {
  // The drag data store becomes protected after dispatch. Capture every entry
  // and fallback File now, before the first asynchronous directory callback.
  const entries = Array.from(transfer.items ?? []).filter(item => item.kind === 'file').map(item => item.webkitGetAsEntry?.());
  const fallback = Array.from(transfer.files ?? []);
  signal?.throwIfAborted();
  const directories: TemporaryModelDirectoryInput[] = [], files: File[] = [];
  if (!entries.length || entries.every(entry => !entry)) {
    const groups = new Map<string, File[]>();
    for (const file of fallback) {
      const root = file.webkitRelativePath?.split('/')[0];
      if (root) {
        const group = groups.get(root) ?? [];
        group.push(file);
        groups.set(root, group);
      } else {
        files.push(file);
      }
    }
    return { directories: [...groups.values()].map(files => modelDirectoryFromFiles({ files })), files };
  }
  if (entries.some(entry => !entry)) {
    throw new Error('The browser could not expose the entire dropped directory');
  }
  async function readFile({ entry }: { entry: FileSystemEntry }): Promise<File> {
    if (!entry.isFile) {
      throw new Error('Unsupported entry in dropped directory');
    }
    const file = await new Promise<File>((resolve, reject) => (entry as FileSystemFileEntry).file(resolve, reject));
    signal?.throwIfAborted();
    return file;
  }
  async function walk({ entry, prefix, depth, files }: { entry: FileSystemDirectoryEntry, prefix: string, depth: number, files: TemporaryModelDirectoryInput['files'] }): Promise<void> {
    signal?.throwIfAborted();
    if (depth >= 64) {
      throw new Error('Dropped directory is too deeply nested');
    }
    const reader = entry.createReader();
    while (true) {
      signal?.throwIfAborted();
      const batch = await new Promise<FileSystemEntry[]>((resolve, reject) => reader.readEntries(resolve, reject));
      signal?.throwIfAborted();
      if (!batch.length) {
        break;
      }
      for (const child of batch) {
        if (child.name === '.git') {
          continue;
        }
        if (child.isDirectory) {
          await walk({ entry: child as FileSystemDirectoryEntry, prefix: `${prefix}${child.name}/`, depth: depth + 1, files });
        } else {
          if (files.length >= 20_000) {
            throw new Error('Dropped repository contains too many files');
          }
          files.push({ relativePath: prefix + child.name, file: await readFile({ entry: child }) });
        }
      }
    }
  }
  for (const entry of entries) {
    signal?.throwIfAborted();
    if (!entry) {
      throw new Error('Unsupported dropped entry');
    }
    if (entry.isDirectory) {
      const children: TemporaryModelDirectoryInput['files'] = [];
      await walk({ entry: entry as FileSystemDirectoryEntry, prefix: '', depth: 0, files: children });
      directories.push({ rootName: entry.name, files: children });
    } else {
      files.push(await readFile({ entry }));
    }
  }
  return { directories, files };
}

/** Linking is not an import: only root/owner/repository/... is interpreted.
 * Ignore readmes/metadata at the structural levels and allow empty destinations,
 * but never silently reinterpret a loose model folder as a repository root. */
export async function validateLinkedModelRoot({ directory, signal }: { directory: FileSystemDirectoryHandle, signal: AbortSignal | undefined }): Promise<void> {
  signal?.throwIfAborted();
  const isWeight = ({ name }: { name: string }) => /\.(gguf|safetensors|sft)$/i.test(name);
  for await (const [name, entry] of directory.entries()) {
    signal?.throwIfAborted();
    switch (entry.kind) {
    case 'file':
      if (isWeight({ name })) {
        throw new Error('Choose the parent folder containing owner/repository folders');
      }
      break;
    case 'directory':
      for await (const [name, child] of entry.entries()) {
        signal?.throwIfAborted();
        if (child.kind === 'file' && isWeight({ name })) {
          throw new Error('Choose the parent folder containing owner/repository folders');
        }
      }
      break;
    default: {
      const exhaustive: never = entry;
      throw new Error(String(exhaustive));
    }
    }
  }
}

/** Keep loose GGUF directory naming identical in both engines and both lifetimes. */
export function directoryForGgufFile({ file }: { file: File }): TemporaryModelDirectoryInput {
  if (!/^.+\.gguf$/i.test(file.name) || !isModelSourceSegment({ name: file.name })) {
    throw new Error('Choose a GGUF model file');
  }
  return { rootName: `${file.name.slice(0, -5)}-GGUF`, files: [{ relativePath: file.name, file }] };
}

export const TEST_ONLY = {
};
