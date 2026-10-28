import { z } from 'zod';
import {
  remoteDirectoryEntrySchema,
  remoteDirectoryRequestSchema,
  remoteDirectoryResponseSchema,
  type RemoteDirectoryAccess,
  type RemoteDirectoryEntry,
  type RemoteDirectoryRequest,
  type RemoteDirectoryResponse,
} from '@/utils/remote-directory-handle';
import type { WeshMount } from '@/features/wesh/types';
import type { WeshWorkerMount } from './types';
import { getEffectiveWeshMounts } from '@/features/wesh/mount-policy';

/** One connection per mount keeps read-only grants independent, even when two
 * paths refer to the same volume. Only these explicitly granted paths exist. */
export interface ManagedVolumeRemoteAccess {
  getRoot({ path }: { path: string }): Promise<RemoteDirectoryEntry>,
  request({ path, request }: { path: string, request: RemoteDirectoryRequest }): Promise<RemoteDirectoryResponse>,
}

const pathSchema = z.string().min(1);

export async function createManagedVolumeRemoteAccess({ mounts }: {
  mounts: readonly (WeshMount | WeshWorkerMount)[],
}): Promise<{ remote: ManagedVolumeRemoteAccess | undefined, dispose(): Promise<void> }> {
  const managedMounts = getEffectiveWeshMounts({ mounts }).filter(mount => mount.type === 'managed_directory');
  if (managedMounts.length === 0) {
    return { remote: undefined, async dispose() {} };
  }

  const { storageService } = await import('@/00-storage/service');
  const connections = new Map<string, {
    access: RemoteDirectoryAccess,
    root: RemoteDirectoryEntry,
    dispose(): Promise<void>,
  }>();
  let disposed = false;
  let disposal: Promise<void> | undefined;
  const dispose = (): Promise<void> => {
    if (disposal !== undefined) {
      return disposal;
    }
    disposed = true;
    disposal = Promise.resolve().then(async () => {
      const results = await Promise.allSettled([...connections.values()].map(connection => connection.dispose()));
      connections.clear();
      for (const result of results) {
        switch (result.status) {
        case 'fulfilled':
          break;
        case 'rejected':
          throw result.reason;
        default: {
          const exhaustive: never = result;
          throw new Error(`Unhandled cleanup result: ${String(exhaustive)}`);
        }
        }
      }
    });
    return disposal;
  };
  try {
    for (const mount of managedMounts) {
      connections.set(mount.path, await storageService.createManagedVolumeAccess({ reference: mount.reference, readOnly: mount.readOnly }));
    }
  } catch (error) {
    await dispose().catch(() => undefined);
    throw error;
  }

  function getConnection({ path }: { path: string }) {
    if (disposed) {
      throw new DOMException('Managed volume connection is closed', 'InvalidStateError');
    }
    const connection = connections.get(pathSchema.parse(path));
    if (connection === undefined) {
      throw new DOMException('The directory is not mounted in this worker', 'NotAllowedError');
    }
    return connection;
  }

  return {
    remote: {
      async getRoot({ path }) {
        return remoteDirectoryEntrySchema.parse(getConnection({ path }).root);
      },
      async request({ path, request }) {
        const connection = getConnection({ path });
        return remoteDirectoryResponseSchema.parse(await connection.access.request({ request: remoteDirectoryRequestSchema.parse(request) }));
      },
    },
    dispose,
  };
}

export function observeManagedVolumeWorker({ worker, connection }: {
  worker: Worker,
  connection: { remote: ManagedVolumeRemoteAccess | undefined, dispose(): Promise<void> },
}): () => void {
  if (connection.remote === undefined) {
    return () => {};
  }
  const failed = (): void => {
    void connection.dispose().catch(error => {
      console.error('Failed to release managed volume writers after a worker failure', error);
    });
  };
  worker.addEventListener('error', failed);
  worker.addEventListener('messageerror', failed);
  return () => {
    worker.removeEventListener('error', failed);
    worker.removeEventListener('messageerror', failed);
  };
}

export const TEST_ONLY = {
};
