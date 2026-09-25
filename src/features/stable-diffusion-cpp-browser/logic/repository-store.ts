import { z } from 'zod';
import { validModelPath } from './model-path';

// Use the existing model-import marker and mutation lock. Other model readers
// therefore cannot expose an incomplete repository while the copy is in flight.
const pendingName = '.llama-cpp-import-pending';
const lockName = 'naidan-llama-cpp-browser-model-mutation';
const fileSchema = z.custom<File>(value => typeof File !== 'undefined' && value instanceof File && Number.isSafeInteger(value.size) && value.size >= 0);
const inputSchema = z.object({
  name: z.string().min(1).max(255).refine(value => validModelPath({ path: value }) && !value.includes('/') && !value.startsWith('.')),
  files: z.array(z.object({ path: z.string().refine(path => validModelPath({ path })), file: fileSchema })).min(1).max(20_000),
});
export type RepositoryInput = z.infer<typeof inputSchema>;
export type RepositoryFile = { path: string, file: File };
export type LocalImageRepository = { id: string, name: string, files: RepositoryFile[] };
export type ImportProgress = { completed: number, total: number, path: string };
function missing({ error }: { error: unknown }): boolean {
  return error instanceof DOMException && error.name === 'NotFoundError';
}
async function optionalDirectory({ parent, name }: { parent: FileSystemDirectoryHandle, name: string }): Promise<FileSystemDirectoryHandle | undefined> {
  try {
    return await parent.getDirectoryHandle(name);
  } catch (error) {
    if (missing({ error })) return undefined; throw error;
  }
}
async function pending({ folder }: { folder: FileSystemDirectoryHandle }): Promise<boolean> {
  try {
    await folder.getFileHandle(pendingName); return true;
  } catch (error) {
    if (missing({ error })) return false;
    // A conflicting directory is not a complete published repository either.
    if (error instanceof DOMException && error.name === 'TypeMismatchError') return true;
    throw error;
  }
}
async function readTree({ folder, signal }: { folder: FileSystemDirectoryHandle, signal: AbortSignal | undefined }): Promise<RepositoryFile[]> {
  const files: RepositoryFile[] = [];
  async function walk({ directory, prefix, depth }: { directory: FileSystemDirectoryHandle, prefix: string, depth: number }): Promise<void> {
    signal?.throwIfAborted();
    if (depth > 64) throw new Error('Local model directory is too deeply nested');
    for await (const [name, entry] of directory.entries()) {
      signal?.throwIfAborted();
      if (name === '.git' || name === pendingName) continue;
      const path = prefix + name;
      if (!validModelPath({ path })) throw new Error('Unsafe path in local model repository');
      switch (entry.kind) {
      case 'directory': await walk({ directory: entry, prefix: path + '/', depth: depth + 1 }); break;
      case 'file':
        if (files.length >= 20_000) throw new Error('Local model repository contains too many files');
        files.push({ path, file: await entry.getFile() }); break;
      default: { const exhaustive: never = entry; throw new Error(String(exhaustive)); }
      }
    }
  }
  await walk({ directory: folder, prefix: '', depth: 0 });
  return files.sort((a, b) => a.path.localeCompare(b.path));
}
/** Read the existing model tree only. No Hugging Face/network requests. */
export async function listImageRepositories({ signal }: { signal: AbortSignal | undefined }): Promise<LocalImageRepository[]> {
  signal?.throwIfAborted();
  if (!navigator.storage?.getDirectory) throw new Error('Local model storage is unavailable');
  const root = await optionalDirectory({ parent: await navigator.storage.getDirectory(), name: 'models' });
  if (!root) return [];
  const result: LocalImageRepository[] = [];
  async function append({ folder, id }: { folder: FileSystemDirectoryHandle, id: string }): Promise<void> {
    if (await pending({ folder })) return;
    const files = await readTree({ folder, signal });
    if (files.length) result.push({ id, name: id, files });
  }
  const user = await optionalDirectory({ parent: root, name: 'user' });
  if (user) for await (const [name, entry] of user.entries()) {
    if (entry.kind === 'directory' && !name.startsWith('.')) await append({ folder: entry, id: `user/${name}` });
  }
  // Existing cached repositories are useful as companions. This is storage
  // enumeration, not a downloader or a change to their source paths.
  const hf = await optionalDirectory({ parent: root, name: 'huggingface.co' });
  if (hf) for await (const [owner, ownerDir] of hf.entries()) {
    switch (ownerDir.kind) {
    case 'file': continue;
    case 'directory': break;
    default: { const exhaustive: never = ownerDir; throw new Error(String(exhaustive)); }
    }
    for await (const [repo, repoDir] of ownerDir.entries()) {
      switch (repoDir.kind) {
      case 'file': continue;
      case 'directory': break;
      default: { const exhaustive: never = repoDir; throw new Error(String(exhaustive)); }
      }
      const resolve = await optionalDirectory({ parent: repoDir, name: 'resolve' });
      if (!resolve) continue;
      for await (const [revision, folder] of resolve.entries()) {
        switch (folder.kind) {
        case 'directory': await append({ folder, id: `huggingface.co/${owner}/${repo}/resolve/${revision}` }); break;
        case 'file': break;
        default: { const exhaustive: never = folder; throw new Error(String(exhaustive)); }
        }
      }
    }
  }
  signal?.throwIfAborted(); return result.sort((a, b) => a.id.localeCompare(b.id));
}

export async function importImageRepository({ input, signal, onProgress }: {
  input: RepositoryInput, signal: AbortSignal | undefined, onProgress: ({ progress }: { progress: ImportProgress }) => void,
}): Promise<string> {
  const directory = inputSchema.parse(input);
  signal?.throwIfAborted();
  const paths = new Set<string>();
  // Validate BEFORE the first persistent write. A README/config/tokenizer file is
  // retained; unsupported weights are reported by inspection, not discarded.
  for (const entry of directory.files) {
    if (entry.path.split('/')[0] === pendingName || entry.path.split('/').includes('.git') || paths.has(entry.path)) throw new Error('Reserved or duplicate repository path');
    paths.add(entry.path);
  }
  for (const path of paths) {
    const parent = path.split('/'); parent.pop();
    while (parent.length) {
      if (paths.has(parent.join('/'))) throw new Error('File/directory path collision'); parent.pop();
    }
  }
  const total = directory.files.reduce((sum, entry) => sum + entry.file.size, 0);
  if (!Number.isSafeInteger(total)) throw new Error('Repository byte count exceeds the exact offset range');
  if (!navigator.locks || !navigator.storage?.getDirectory) throw new Error('Safe local model import is unavailable');
  return navigator.locks.request(lockName, { mode: 'exclusive', signal }, async () => {
    signal?.throwIfAborted();
    const models = await (await navigator.storage.getDirectory()).getDirectoryHandle('models', { create: true });
    const user = await models.getDirectoryHandle('user', { create: true });
    // Reject files as well as directories with that name; never overwrite, rename
    // or merge a previous import (including incomplete ones) implicitly.
    for await (const [name] of user.entries()) if (name === directory.name) throw new Error(`A local repository named "${name}" already exists`);
    signal?.throwIfAborted();
    const root = await user.getDirectoryHandle(directory.name, { create: true });
    const created: { parent: FileSystemDirectoryHandle, name: string, handle: FileSystemFileHandle, size: number, modified: number }[] = [];
    const folders: { parent: FileSystemDirectoryHandle, name: string }[] = [];
    const known = new Map<string, FileSystemDirectoryHandle>([['', root]]);
    let completed = 0;
    async function makeFile({ parent, name }: { parent: FileSystemDirectoryHandle, name: string }): Promise<(typeof created)[number]> {
      for await (const [existing] of parent.entries()) if (existing === name) throw new Error('Repository destination changed during import');
      const handle = await parent.getFileHandle(name, { create: true });
      const file = await handle.getFile();
      const record = { parent, name, handle, size: file.size, modified: file.lastModified };
      created.push(record); return record;
    }
    try {
      const marker = await makeFile({ parent: root, name: pendingName });
      for (const { path, file } of directory.files) {
        signal?.throwIfAborted();
        const segments = path.split('/'), name = segments.pop()!;
        let parent = root, prefix = '';
        for (const part of segments) {
          const next = prefix ? `${prefix}/${part}` : part;
          let folder = known.get(next);
          if (!folder) {
            folder = await parent.getDirectoryHandle(part, { create: true }); folders.push({ parent, name: part }); known.set(next, folder);
          }
          parent = folder; prefix = next;
        }
        const record = await makeFile({ parent, name });
        const writer = await record.handle.createWritable();
        const reader = file.stream().getReader();
        const cancelRead = (): void => {
          void reader.cancel().catch(() => undefined);
        };
        signal?.addEventListener('abort', cancelRead, { once: true });
        let written = 0;
        try {
          while (true) {
            signal?.throwIfAborted();
            const { value, done } = await reader.read();
            signal?.throwIfAborted();
            if (done) break;
            if (value.byteLength > file.size - written) throw new Error('Source changed during local import');
            await writer.write(value); written += value.byteLength; completed += value.byteLength;
            try {
              onProgress({ progress: { completed, total, path } });
            } catch { /* notification only */ }
          }
          if (written !== file.size) throw new Error('Incomplete local repository copy');
          signal?.throwIfAborted(); await writer.close();
          const published = await record.handle.getFile(); record.size = published.size; record.modified = published.lastModified;
          if (published.size !== file.size) throw new Error('Local copy size mismatch');
        } catch (error) {
          await reader.cancel().catch(() => undefined); await writer.abort().catch(() => undefined); throw error;
        } finally {
          signal?.removeEventListener('abort', cancelRead); reader.releaseLock();
        }
      }
      signal?.throwIfAborted();
      await root.removeEntry(marker.name);
      return `user/${directory.name}`;
    } catch (error) {
      // An unrelated file explorer need not honor our lock. Remove only files
      // still matching this import's handles/metadata, then EMPTY directories.
      // Never recursively sweep the root or remove someone else's changed data.
      for (const record of [...created].reverse().filter(entry => entry.name !== pendingName)) {
        try {
          const current = await record.parent.getFileHandle(record.name);
          const file = await current.getFile();
          if (await current.isSameEntry(record.handle) && file.size === record.size && file.lastModified === record.modified) await record.parent.removeEntry(record.name);
        } catch { /* preserve ambiguous leftovers */ }
      }
      for (const folder of [...folders].reverse()) await folder.parent.removeEntry(folder.name).catch(() => undefined);
      const remaining: string[] = [];
      for await (const [name] of root.entries()) if (name !== pendingName) remaining.push(name);
      if (remaining.length === 0) {
        await root.removeEntry(pendingName).catch(() => undefined); await user.removeEntry(directory.name).catch(() => undefined);
      }
      // Otherwise the marker deliberately keeps this partial import unpublished.
      throw error;
    }
  });
}
export const TEST_ONLY = {
};
