import { z } from 'zod';
import { modelFileMarker, optionalModelFile } from '@/logic/model-file-publication';
import { temporaryFileName } from '@/utils/file-system-publication';
import { readPendingDownload } from './pending';

/** Only a matching journal grants ownership of a .tmp. A filename suffix alone
 * must never add unrelated host files to a confirmed deletion plan. */
export async function pendingDownloadDeletionFiles({ folder, repository, signal }: {
  folder: FileSystemDirectoryHandle, repository: string, signal: AbortSignal | undefined,
}): Promise<{ path: string, paths: string[] }[]> {
  const result: { path: string, paths: string[] }[] = [];
  async function walk({ directory, prefix, depth }: { directory: FileSystemDirectoryHandle, prefix: string, depth: number }): Promise<void> {
    signal?.throwIfAborted();
    if (depth > 64) {
      throw new Error('Model directory is too deeply nested');
    }
    for await (const [entryName, entry] of directory.entries()) {
      signal?.throwIfAborted();
      switch (entry.kind) {
      case 'directory':
        await walk({ directory: entry, prefix: `${prefix}${entryName}/`, depth: depth + 1 });
        continue;
      case 'file': break;
      default: {
        const exhaustive: never = entry;
        throw new Error(String(exhaustive));
      }
      }
      const name = /^\.(.+)\.pending$/.exec(entryName)?.[1];
      if (!name) {
        continue;
      }
      const marker = await entry.getFile();
      if (marker.size > 64 * 1024) {
        continue; // Outside the base journal size limit: not recognized as ours.
      }
      let pending;
      try {
        pending = readPendingDownload({ value: JSON.parse(await marker.text()) });
      } catch (error) {
        if (error instanceof SyntaxError || error instanceof z.ZodError) {
          continue; // An unrecognized marker is not ours to delete.
        }
        throw error;
      }
      const path = prefix + name;
      if (pending.source.repository !== repository || pending.source.path !== path) {
        continue;
      }
      const paths = [prefix + modelFileMarker({ name, state: 'pending' })];
      const final = await optionalModelFile({ directory, name });
      const temporaryName = temporaryFileName({ name });
      const temporary = await optionalModelFile({ directory, name: temporaryName });
      if (temporary && final) {
        throw new Error('Conflicting staged and final files; neither was selected for deletion');
      }
      if (temporary) {
        paths.push(prefix + temporaryName);
      } else if (final) {
        paths.push(path);
      }
      result.push({ path, paths });
    }
  }
  await walk({ directory: folder, prefix: '', depth: 0 });
  return result;
}

export const TEST_ONLY = {
};
