import type {
  FeatureBits,
  HomeRecordReference,
  FileSystemId,
  PhysicalRecordReference,
  SegmentClass,
  SegmentId,
  UnlockSequence,
} from '@/00-storage/service/hizofs/00-format';
import type { FileSystemRootKey } from '@/00-storage/service/hizofs/01-crypto';
import type {
  HizoFSReadableBackend,
  PhysicalEntry,
} from '@/00-storage/service/hizofs/physical-store/backend';
import {
  canonicalContainerDirectory,
  canonicalContainerPath,
} from '@/00-storage/service/hizofs/physical-store/paths';
import {
  readBootstrapRoot,
  type BootstrapCommitAuthority,
} from './bootstrap-segment-store';
import {
  readAuthenticatedPhysicalRecord,
  readAuthenticatedPhysicalRecordWithFrame,
} from './record-reader';
import { resolveAuthenticatedHomeRecord } from './relocation-index-reader';
import { readAuthenticatedSegmentIndex } from './segment-footer-store';
import { openSuperblockCopies } from './superblock-store';
import {
  openAuthenticatedUnlockEnvelopeAuthority,
  openUnlockEnvelopeCopies,
} from './unlock-envelope-store';

export type HizoFSInspectionPhysicalEntry = PhysicalEntry;

export interface AuthenticatedHizoFSInspectionPort {
  list({ directory }: { directory: string }): Promise<readonly HizoFSInspectionPhysicalEntry[]>;
  openSuperblockCopies({ fileSystemId, rootKey, supportedFeatureBits }: {
    fileSystemId: FileSystemId;
    rootKey: FileSystemRootKey;
    supportedFeatureBits: FeatureBits;
  }): ReturnType<typeof openSuperblockCopies>;
  openUnlockAuthority({ fileSystemId, minimumUnlockSequence, rootKey }: {
    fileSystemId: FileSystemId;
    minimumUnlockSequence: UnlockSequence;
    rootKey: FileSystemRootKey;
  }): ReturnType<typeof openAuthenticatedUnlockEnvelopeAuthority>;
  openUnlockCopies({ minimumUnlockSequence, passphrase }: {
    minimumUnlockSequence: UnlockSequence;
    passphrase: string;
  }): ReturnType<typeof openUnlockEnvelopeCopies>;
  readBootstrapRoot({ authority, fileSystemId, relocationIndexRootPhysicalRef, rootKey }: {
    authority: BootstrapCommitAuthority;
    fileSystemId: FileSystemId;
    relocationIndexRootPhysicalRef: PhysicalRecordReference | null;
    rootKey: FileSystemRootKey;
  }): ReturnType<typeof readBootstrapRoot>;
  readFileBounded({ maximumByteLength, path }: {
    maximumByteLength: number;
    path: string;
  }): Promise<Uint8Array | undefined>;
  readHomeRecord({ fileSystemId, homeReference, relocationIndexRootPhysicalRef, rootKey }: {
    fileSystemId: FileSystemId;
    homeReference: HomeRecordReference;
    relocationIndexRootPhysicalRef: PhysicalRecordReference | null;
    rootKey: FileSystemRootKey;
  }): ReturnType<typeof resolveAuthenticatedHomeRecord>;
  readPhysicalRecord({ fileSystemId, homeReference, physicalReference, rootKey }: {
    fileSystemId: FileSystemId;
    homeReference: HomeRecordReference | undefined;
    physicalReference: PhysicalRecordReference;
    rootKey: FileSystemRootKey;
  }): ReturnType<typeof readAuthenticatedPhysicalRecord>;
  readPhysicalRecordWithFrame({ fileSystemId, homeReference, physicalReference, rootKey }: {
    fileSystemId: FileSystemId;
    homeReference: HomeRecordReference | undefined;
    physicalReference: PhysicalRecordReference;
    rootKey: FileSystemRootKey;
  }): ReturnType<typeof readAuthenticatedPhysicalRecordWithFrame>;
  readSegmentIndex({ fileSystemId, physicalSegmentId, rootKey, segmentClass }: {
    fileSystemId: FileSystemId;
    physicalSegmentId: SegmentId;
    rootKey: FileSystemRootKey;
    segmentClass: SegmentClass;
  }): ReturnType<typeof readAuthenticatedSegmentIndex>;
}

export function createAuthenticatedHizoFSInspectionPort({ backend }: {
  backend: HizoFSReadableBackend;
}): AuthenticatedHizoFSInspectionPort {
  return {
    list: async ({ directory }) => await backend.list({
      directory: canonicalContainerDirectory({ value: directory }),
    }),
    openSuperblockCopies: async ({ fileSystemId, rootKey, supportedFeatureBits }) => await openSuperblockCopies({
      backend,
      fileSystemId,
      rootKey,
      supportedFeatureBits,
    }),
    openUnlockAuthority: async ({ fileSystemId, minimumUnlockSequence, rootKey }) => await openAuthenticatedUnlockEnvelopeAuthority({
      backend,
      fileSystemId,
      minimumUnlockSequence,
      rootKey,
    }),
    openUnlockCopies: async ({ minimumUnlockSequence, passphrase }) => await openUnlockEnvelopeCopies({
      backend,
      minimumUnlockSequence,
      passphrase,
    }),
    readBootstrapRoot: async ({ authority, fileSystemId, relocationIndexRootPhysicalRef, rootKey }) => await readBootstrapRoot({
      authority,
      backend,
      fileSystemId,
      relocationIndexRootPhysicalRef,
      rootKey,
    }),
    readFileBounded: async ({ maximumByteLength, path }) => await backend.readFileBounded({
      maximumByteLength,
      path: canonicalContainerPath({ value: path }),
    }),
    readHomeRecord: async ({ fileSystemId, homeReference, relocationIndexRootPhysicalRef, rootKey }) => await resolveAuthenticatedHomeRecord({
      backend,
      fileSystemId,
      homeReference,
      relocationIndexRootPhysicalRef,
      rootKey,
    }),
    readPhysicalRecord: async ({ fileSystemId, homeReference, physicalReference, rootKey }) => await readAuthenticatedPhysicalRecord({
      backend,
      expectedIdentity: homeReference === undefined
        ? { type: "physical_only" }
        : { homeReference, type: "logical" },
      fileSystemId,
      physicalReference,
      rootKey,
    }),
    readPhysicalRecordWithFrame: async ({ fileSystemId, homeReference, physicalReference, rootKey }) => await readAuthenticatedPhysicalRecordWithFrame({
      backend,
      expectedIdentity: homeReference === undefined
        ? { type: "physical_only" }
        : { homeReference, type: "logical" },
      fileSystemId,
      physicalReference,
      rootKey,
    }),
    readSegmentIndex: async ({ fileSystemId, physicalSegmentId, rootKey, segmentClass }) => await readAuthenticatedSegmentIndex({
      backend,
      fileSystemId,
      physicalSegmentId,
      rootKey,
      segmentClass,
    }),
  };
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
