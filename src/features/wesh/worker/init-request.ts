import {
  mapWeshMountsToOpfsWorkerMounts,
  mapWeshMountsToWorkerMounts,
  mapWeshRootHandleToOpfsReference,
  weshWorkerInitRequestSchema,
  type WeshWorkerInitRequest,
} from './types';
import type { WeshMount } from '@/features/wesh/types';

export type WeshFileSystemHandleTransport = 'direct' | 'opfs-locator';

export function hasWeshFileSystemHandles({
  rootHandle,
  mounts,
}: {
  rootHandle: FileSystemDirectoryHandle | 'readonly',
  mounts: WeshMount[],
}): boolean {
  return rootHandle !== 'readonly' || mounts.some(mount => mount.type === 'directory');
}

export async function createWeshWorkerInitRequest({
  rootHandle,
  mounts,
  user,
  initialEnv,
  initialCwd,
  transport,
}: {
  rootHandle: FileSystemDirectoryHandle | 'readonly',
  mounts: WeshMount[],
  user: string,
  initialEnv: Record<string, string>,
  initialCwd: string | undefined,
  transport: WeshFileSystemHandleTransport,
}): Promise<WeshWorkerInitRequest> {
  switch (transport) {
  case 'direct':
    return weshWorkerInitRequestSchema.parse({
      rootHandle,
      mounts: mapWeshMountsToWorkerMounts({ mounts }),
      user,
      initialEnv,
      initialCwd,
    });
  case 'opfs-locator': {
    const opfsRoot = await navigator.storage.getDirectory();
    return weshWorkerInitRequestSchema.parse({
      rootHandle: await mapWeshRootHandleToOpfsReference({ rootHandle, opfsRoot }),
      mounts: await mapWeshMountsToOpfsWorkerMounts({ mounts, opfsRoot }),
      user,
      initialEnv,
      initialCwd,
    });
  }
  default: {
    const _ex: never = transport;
    throw new Error(`Unsupported Wesh file system handle transport: ${String(_ex)}`);
  }
  }
}

export const TEST_ONLY = {
};
