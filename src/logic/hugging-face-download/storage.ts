import type { DownloadDestination } from '@/01-models/download';
import { hostModelHandles } from '@/00-storage/service/host-model-handles';
import { toHostModelDirectoryId } from '@/01-models/ids';
import { hostModelDirectoryLock, hostModelPermissionGranted } from '@/logic/host-model-directories';

/** Retain historical lock names to interoperate with readers, importers, deletion
 * and older open tabs. The owner of these locks is now the shared file service. */
export async function withDownloadRepository<T>({ repository, destination, expectedRoot, signal, run }: {
  repository: string, destination: DownloadDestination, expectedRoot: FileSystemDirectoryHandle | undefined, signal: AbortSignal,
  run: ({ folder }: { folder: FileSystemDirectoryHandle }) => Promise<T>,
}): Promise<T> {
  const mutationLock = (() => {
    switch (destination.kind) {
    case 'host': return hostModelDirectoryLock({ id: toHostModelDirectoryId({ raw: destination.directoryId }) });
    case 'opfs': return 'naidan-llama-cpp-browser-model-mutation';
    default: {
      const exhaustive: never = destination;
      throw new Error(String(exhaustive));
    }
    }
  })();
  return navigator.locks.request(mutationLock, { mode: 'exclusive', signal }, () => navigator.locks.request(`naidan-llama-cpp-browser-hf:${repository}`, { mode: 'exclusive', signal }, async () => {
    signal.throwIfAborted();
    let folder: FileSystemDirectoryHandle;
    let path: string[];
    switch (destination.kind) {
    case 'opfs':
      folder = await navigator.storage.getDirectory();
      path = ['models', 'huggingface.co', ...repository.split('/'), 'resolve', 'main'];
      break;
    case 'host': {
      const handle = await hostModelHandles.get({ id: toHostModelDirectoryId({ raw: destination.directoryId }) });
      if (!handle) {
        throw new Error('Reconnect the linked model directory before downloading');
      }
      if (!hostModelPermissionGranted({ permission: await handle.queryPermission({ mode: 'readwrite' }) })) {
        throw new Error('Linked model directory needs read and write permission');
      }
      if (expectedRoot && !await handle.isSameEntry(expectedRoot)) {
        throw new Error('Linked model folder changed after this download was queued');
      }
      folder = handle;
      path = repository.split('/');
      break;
    }
    default: {
      const exhaustive: never = destination;
      throw new Error(String(exhaustive));
    }
    }
    for (const part of path) {
      signal.throwIfAborted();
      folder = await folder.getDirectoryHandle(part, { create: true });
    }
    signal.throwIfAborted();
    return run({ folder });
  }));
}

export const TEST_ONLY = {
};
