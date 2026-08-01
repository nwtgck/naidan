import type { NaidanPersistenceModeV1 } from '@/00-storage/service/naidan-persistence-control/00-format';
import { naidanOpfsContainerOriginRelativePathComponents } from './opfs-storage-location';

type HizoFSMode = Extract<NaidanPersistenceModeV1, { readonly type: 'hizofs' }>;
type FileSystemId = HizoFSMode['activeFileSystemId'];

export interface ActiveHizoFSContainerLocationLease {
  readonly physicalPath: readonly string[];
  assertCurrent(): void;
  dispose(): Promise<void>;
}

type ActiveLocation = {
  active: boolean;
  readonly physicalPath: readonly string[];
};

let activeLocation: ActiveLocation | undefined;

function assertActiveLocation({ location }: { location: ActiveLocation }): void {
  if (!location.active || activeLocation !== location) {
    throw new Error('authenticated HizoFS container location is no longer current');
  }
}

/**
 * Publishes only an authenticated container location for the active provider generation.
 *
 * The registry deliberately carries no passphrase, root key, backend, or opened
 * container authority. Exact object identity prevents late cleanup from an old
 * provider generation from removing a newer location.
 */
export function installActiveAuthenticatedHizoFSContainerLocation({ fileSystemId }: {
  fileSystemId: FileSystemId;
}): () => void {
  const location: ActiveLocation = {
    active: true,
    physicalPath: naidanOpfsContainerOriginRelativePathComponents({ fileSystemId }),
  };
  const previous = activeLocation;
  activeLocation = location;
  if (previous !== undefined) previous.active = false;

  return () => {
    location.active = false;
    if (activeLocation === location) activeLocation = undefined;
  };
}

export async function openActiveAuthenticatedHizoFSContainerLocationLease(): Promise<ActiveHizoFSContainerLocationLease> {
  const location = activeLocation;
  if (location === undefined) {
    throw new Error('authenticated HizoFS container location is unavailable');
  }
  assertActiveLocation({ location });
  let disposed = false;

  return {
    assertCurrent() {
      if (disposed) throw new Error('authenticated HizoFS container location lease is disposed');
      assertActiveLocation({ location });
    },
    async dispose() {
      disposed = true;
    },
    physicalPath: [...location.physicalPath],
  };
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
  reset() {
    if (activeLocation !== undefined) activeLocation.active = false;
    activeLocation = undefined;
  },
};
