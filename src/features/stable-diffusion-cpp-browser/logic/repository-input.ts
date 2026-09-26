import type { RepositoryInput } from './repository-store';

/** A local repo means its working tree, not Git's object database. */
export function imageDirectoryFromFiles({ files }: { files: File[] }): RepositoryInput {
  const name = files[0]?.webkitRelativePath.split('/')[0];
  if (!name) throw new Error('Choose a local model repository folder');
  const prefix = `${name}/`;
  const entries = files.map(file => {
    if (!file.webkitRelativePath.startsWith(prefix)) throw new Error('Folder selection contains different roots');
    return { path: file.webkitRelativePath.slice(prefix.length), file };
  }).filter(entry => !entry.path.split('/').includes('.git'));
  return { name, files: entries };
}
export async function imageDirectoriesFromDrop({ transfer, signal }: { transfer: DataTransfer, signal: AbortSignal | undefined }): Promise<RepositoryInput[]> {
  // Capture ALL entries/files during the drop event, before awaiting callbacks.
  const entries = Array.from(transfer.items ?? []).filter(item => item.kind === 'file').map(item => item.webkitGetAsEntry?.());
  const fallback = Array.from(transfer.files ?? []);
  signal?.throwIfAborted();
  const result: RepositoryInput[] = [];
  if (entries.length === 0 || entries.every(entry => !entry)) {
    const groups = new Map<string, File[]>(); const loose: File[] = [];
    for (const file of fallback) {
      const root = file.webkitRelativePath?.split('/')[0];
      if (!root) loose.push(file);
      else {
        const group = groups.get(root) ?? []; group.push(file); groups.set(root, group);
      }
    }
    for (const files of groups.values()) result.push(imageDirectoryFromFiles({ files }));
    if (loose.length) throw new Error('Use Choose files for individual weights, or drop a repository folder');
    return result;
  }
  if (entries.some(entry => !entry)) throw new Error('The browser could not expose the entire dropped directory');
  async function walk({ entry, prefix, depth, files }: { entry: FileSystemDirectoryEntry, prefix: string, depth: number, files: RepositoryInput['files'] }): Promise<void> {
    signal?.throwIfAborted();
    if (depth > 64) throw new Error('Dropped directory is too deeply nested');
    const reader = entry.createReader();
    while (true) {
      signal?.throwIfAborted();
      const batch = await new Promise<FileSystemEntry[]>((resolve, reject) => reader.readEntries(resolve, reject));
      signal?.throwIfAborted();
      if (!batch.length) break;
      for (const child of batch) {
        if (child.name === '.git') continue;
        if (child.isDirectory) await walk({ entry: child as FileSystemDirectoryEntry, prefix: `${prefix}${child.name}/`, depth: depth + 1, files });
        else if (child.isFile) {
          if (files.length >= 20_000) throw new Error('Dropped repository contains too many files');
          const file = await new Promise<File>((resolve, reject) => (child as FileSystemFileEntry).file(resolve, reject));
          signal?.throwIfAborted(); files.push({ path: prefix + child.name, file });
        } else throw new Error('Unsupported entry in dropped directory');
      }
    }
  }
  for (const entry of entries) {
    if (!entry?.isDirectory) throw new Error('Drop repository folders; use Choose files for individual weights');
    const files: RepositoryInput['files'] = [];
    await walk({ entry: entry as FileSystemDirectoryEntry, prefix: '', depth: 0, files });
    result.push({ name: entry.name, files });
  }
  signal?.throwIfAborted(); return result;
}
export const TEST_ONLY = {
};
