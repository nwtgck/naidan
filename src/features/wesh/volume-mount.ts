import type { Mount } from '@/01-models/types';
import type { VolumeAccess } from '@/01-models/volume-access';
import type { WeshDirectoryMount, WeshManagedDirectoryMount } from './types';

/** Incomplete stored copies never become ordinary writable mounts. */
export function volumeAccessToWeshMount({ mount, access }: {
  mount: Mount,
  access: VolumeAccess,
}): WeshDirectoryMount | WeshManagedDirectoryMount | undefined {
  switch (access.kind) {
  case 'native':
    return { type: 'directory', path: mount.mountPath, handle: access.handle, readOnly: mount.readOnly };
  case 'managed':
    return { type: 'managed_directory', path: mount.mountPath, reference: access.reference, readOnly: mount.readOnly };
  case 'missing':
  case 'incomplete':
    return undefined;
  default: {
    const exhaustive: never = access;
    throw new Error(`Unhandled volume access: ${String(exhaustive)}`);
  }
  }
}

export const TEST_ONLY = {
};
