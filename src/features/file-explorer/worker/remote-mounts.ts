import { createManagedVolumeRemoteAccess, type ManagedVolumeRemoteAccess } from '@/features/wesh/worker/managed-volume-access';
import { getFileExplorerRootMounts } from './root-transport';
import type { FileExplorerRemoteMount, FileExplorerRootDescriptor } from './types';

export async function connectFileExplorerRemoteMounts({ root, remoteMounts }: {
  root: FileExplorerRootDescriptor, remoteMounts: readonly FileExplorerRemoteMount[] | undefined,
}): Promise<{ remote: ManagedVolumeRemoteAccess | undefined, dispose(): Promise<void> }> {
  const managed = await createManagedVolumeRemoteAccess({ mounts: getFileExplorerRootMounts({ root }) });
  if (!remoteMounts?.length) {
    return managed;
  }
  const sources = new Map(remoteMounts.map(mount => [mount.path, mount]));
  let disposed = false;
  return {
    remote: {
      async getRoot({ path }) {
        const local = sources.get(path);
        if (disposed || (local === undefined && managed.remote === undefined)) {
          throw new DOMException('The directory is not mounted', 'NotAllowedError');
        }
        return local?.root ?? managed.remote!.getRoot({ path });
      },
      async request({ path, request }) {
        const local = sources.get(path);
        if (disposed || (local === undefined && managed.remote === undefined)) {
          throw new DOMException('The directory is not mounted', 'NotAllowedError');
        }
        return local ? local.access.request({ request }) : managed.remote!.request({ path, request });
      },
    },
    async dispose() {
      disposed = true;
      sources.clear();
      await managed.dispose();
    },
  };
}

export const TEST_ONLY = {
};
