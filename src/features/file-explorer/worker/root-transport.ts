import type { FileExplorerRootDescriptor } from './types';
import { createOpfsDirectoryHandleLocator } from '@/utils/file-system-handle-transport';

export function hasFileExplorerFileSystemHandles({
  root,
}: {
  root: FileExplorerRootDescriptor,
}): boolean {
  switch (root.kind) {
  case 'opfs-root':
    return false;
  case 'native-directory': {
    switch (root.handle.kind) {
    case 'directory':
      return true;
    case 'opfs-directory':
      return false;
    default: {
      const _ex: never = root.handle;
      throw new Error(`Unhandled directory handle reference: ${String(_ex)}`);
    }
    }
  }
  case 'wesh-mounts':
    return root.mounts.some(mount => mount.type === 'directory' && mount.handle.kind === 'directory');
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
}): Promise<FileExplorerRootDescriptor> {
  const opfsRoot = await navigator.storage.getDirectory();
  switch (root.kind) {
  case 'opfs-root':
    return root;
  case 'native-directory': {
    const { kind, rootName, handle, readOnly, ...unhandledRoot } = root;
    unhandledRoot satisfies Record<PropertyKey, never>;
    switch (handle.kind) {
    case 'opfs-directory':
      return root;
    case 'directory':
      return {
        kind,
        rootName,
        handle: await createOpfsDirectoryHandleLocator({ opfsRoot, handle }),
        readOnly,
      };
    default: {
      const _ex: never = handle;
      throw new Error(`Unhandled directory handle reference: ${String(_ex)}`);
    }
    }
  }
  case 'wesh-mounts': {
    const { kind, rootName, mounts, ...unhandledRoot } = root;
    unhandledRoot satisfies Record<PropertyKey, never>;
    const mappedMounts: typeof mounts = [];
    for (const mount of mounts) {
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
