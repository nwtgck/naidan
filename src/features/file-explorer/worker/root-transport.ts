import type {
  FileExplorerRootDescriptor,
  FileExplorerWorkerRootDescriptor,
} from './types';
import { createOpfsDirectoryHandleLocator } from '@/utils/file-system-handle-transport';
import {
  mapWeshMountsToWorkerMounts,
  type WeshWorkerMount,
} from '@/features/wesh/worker/types';

export function hasFileExplorerFileSystemHandles({
  root,
}: {
  root: FileExplorerRootDescriptor,
}): boolean {
  switch (root.kind) {
  case 'opfs-root':
  case 'storage-directory':
    return false;
  case 'native-directory':
    return true;
  case 'wesh-mounts':
    return root.mounts.some(mount => mount.type === 'directory');
  default: {
    const _ex: never = root;
    throw new Error(`Unhandled File Explorer root kind: ${String(_ex)}`);
  }
  }
}

export async function mapFileExplorerRootToOpfsLocators({
  root,
}: {
  root: FileExplorerRootDescriptor,
}): Promise<FileExplorerWorkerRootDescriptor> {
  switch (root.kind) {
  case 'opfs-root': {
    const { kind, rootName, ...unhandledRoot } = root;
    unhandledRoot satisfies Record<PropertyKey, never>;
    return { kind, rootName };
  }
  case 'native-directory': {
    const { kind, rootName, handle, readOnly, ...unhandledRoot } = root;
    unhandledRoot satisfies Record<PropertyKey, never>;
    const opfsRoot = await navigator.storage.getDirectory();
    return {
      kind,
      rootName,
      handle: await createOpfsDirectoryHandleLocator({ opfsRoot, handle }),
      readOnly,
    };
  }
  case 'storage-directory': {
    const { kind, rootName, handle: _handle, readOnly, ...unhandledRoot } = root;
    unhandledRoot satisfies Record<PropertyKey, never>;
    return { kind, rootName, readOnly };
  }
  case 'wesh-mounts': {
    const { kind, rootName, mounts, ...unhandledRoot } = root;
    unhandledRoot satisfies Record<PropertyKey, never>;
    const workerMounts = await mapWeshMountsToWorkerMounts({
      mounts,
      storageDirectoryExecution: 'ui_remote',
    });
    const opfsRoot = await navigator.storage.getDirectory();
    const mappedMounts: WeshWorkerMount[] = [];
    for (const mount of workerMounts) {
      switch (mount.type) {
      case 'directory': {
        const { type, path, handle, readOnly, ...unhandledMount } = mount;
        unhandledMount satisfies Record<PropertyKey, never>;
        const mappedHandle = await (async () => {
          switch (handle.kind) {
          case 'directory':
            return createOpfsDirectoryHandleLocator({ opfsRoot, handle });
          case 'opfs-directory':
            return handle;
          default: {
            const _ex: never = handle;
            throw new Error(`Unhandled directory handle reference: ${String(_ex)}`);
          }
          }
        })();
        mappedMounts.push({
          type,
          path,
          handle: mappedHandle,
          readOnly,
        });
        break;
      }
      case 'storage_directory':
      case 'naidan_sysfs':
        mappedMounts.push(mount);
        break;
      default: {
        const _ex: never = mount;
        throw new Error(`Unhandled Wesh mount type: ${String(_ex)}`);
      }
      }
    }
    return { kind, rootName, mounts: mappedMounts };
  }
  default: {
    const _ex: never = root;
    throw new Error(`Unhandled File Explorer root kind: ${String(_ex)}`);
  }
  }
}

export const TEST_ONLY = {
};
