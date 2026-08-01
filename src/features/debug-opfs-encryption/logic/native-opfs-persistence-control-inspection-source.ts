import {
  inspectPersistenceControl,
} from '@/00-storage/service/naidan-persistence-control/inspection';
import type {
  NaidanPersistenceControlV1,
} from '@/00-storage/service/naidan-persistence-control/00-format';
import type {
  PersistenceControlProofAuthority,
  PersistenceControlReadablePhysicalPort,
} from '@/00-storage/service/naidan-persistence-control/store';
import {
  createOpfsPersistenceControlReadablePhysicalPort,
} from '@/00-storage/service/naidan-opfs/opfs-persistence-control-readable-port';
import {
  NAIDAN_OPFS_STORAGE_DIRECTORY_NAME,
} from '@/00-storage/service/naidan-opfs/opfs-storage-location';
import type {
  PersistenceControlInspectionSource,
} from '@/features/debug-opfs-encryption/logic/persistence-control-inspection-source';

function isNotFoundError({ cause }: { cause: unknown }): boolean {
  return cause instanceof DOMException
    ? cause.name === 'NotFoundError'
    : cause instanceof Error
      && (cause.name === 'NotFoundError' || cause.message.startsWith('NotFoundError'));
}

async function getNativeStorageRootIfPresent(): Promise<FileSystemDirectoryHandle | undefined> {
  const opfsRoot = await navigator.storage.getDirectory();
  try {
    return await opfsRoot.getDirectoryHandle(NAIDAN_OPFS_STORAGE_DIRECTORY_NAME, { create: false });
  } catch (cause: unknown) {
    if (isNotFoundError({ cause })) return undefined;
    throw cause;
  }
}

const missingPhysical: PersistenceControlReadablePhysicalPort = {
  async readFileBounded() {
    return undefined;
  },
};

const unresolvedAuditProofAuthority: PersistenceControlProofAuthority = {
  async resolveRootKey() {
    return { state: 'unresolved' };
  },
  async validateEndpointReadiness({ control }: { control: NaidanPersistenceControlV1 }) {
    switch (control.mode.type) {
    case 'plain':
      // The control files were read from the live native namespace root, so a
      // proof-valid stable-plain control has the endpoint it names. HizoFS and
      // transition controls are protected by a container root key and return
      // protection_unresolved before this callback is reached.
      return 'valid';
    case 'hizofs':
    case 'transitioning':
      return 'invalid';
    default:
      return control.mode satisfies never;
    }
  },
};

/**
 * Creates the application-owned native OPFS audit source.
 *
 * Every refresh reopens the current storage root and reads both exact A/B
 * files. The source retains no FileSystem handles, passphrase, root key, or
 * proof capability. Protected candidates remain protection_unresolved until a
 * provider-owned authenticated source is available.
 */
export function createNativeOpfsPersistenceControlInspectionSource({
  getStorageRoot = getNativeStorageRootIfPresent,
}: {
  getStorageRoot?: () => Promise<FileSystemDirectoryHandle | undefined>;
} = {}): PersistenceControlInspectionSource {
  return {
    async inspectPersistenceControl() {
      const storageRoot = await getStorageRoot();
      const physical = storageRoot === undefined
        ? missingPhysical
        : createOpfsPersistenceControlReadablePhysicalPort({ storageRoot });
      return await inspectPersistenceControl({
        physical,
        proofAuthority: unresolvedAuditProofAuthority,
      });
    },
  };
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
