import {
  createCommitSequence,
  createFeatureBits,
  createUnlockSequence,
  type CredentialSlotId,
  type FeatureBits,
  type FileSystemId,
  type UnlockSequence,
} from "@/00-storage/service/hizofs/00-format";
import type { FileSystemRootKey, RandomByteSource } from "@/00-storage/service/hizofs/01-crypto";
import type { HizoFSWritableBackend, HizoFSReadableBackend } from "@/00-storage/service/hizofs/physical-store/backend";
import {
  createInitialBootstrapSegment,
  readBootstrapRoot,
  type OpenedInitialBootstrapRoot,
} from "./bootstrap-segment-store";
import { AuthenticatedStoreError, authenticatedStoreError } from "./errors";
import { validateAuthenticatedRelocationIndexTree } from "./relocation-index-reader";
import type { AuthenticatedHizoFSPhysicalBytes } from "./physical-bytes";
import type { AuthenticatedStoreDiagnosticsPort } from "@/00-storage/service/hizofs/authenticated-store/diagnostics-hooks";
import {
  createInitialSuperblockCopies,
  openSuperblockCopies,
  type SuperblockCopyState,
  type SuperblockLogicalState,
} from "./superblock-store";
import {
  openAuthenticatedUnlockEnvelopeAuthority,
  openUnlockEnvelopeCopies,
  prepareInitialUnlockEnvelopeCopies,
  prepareInitialUnlockEnvelopeCredentialSet,
  publishInitialUnlockEnvelopeCopies,
  publishInitialUnlockEnvelopeCredentialSet,
  type CredentialCopyState,
} from "./unlock-envelope-store";

const INITIAL_UNLOCK_SEQUENCE = createUnlockSequence({ value: 1n });
const NO_REQUIRED_FEATURES = createFeatureBits({ value: 0n });

export type OpenedEmptyEncryptedContainer = OpenedInitialBootstrapRoot & Readonly<{
  credentialCopyState: CredentialCopyState;
  dataOpenMode: "fallback_read_only" | "normal";
  fileSystemId: FileSystemId;
  rootKey: FileSystemRootKey;
  superblock: import("./superblock-store").OpenedSuperblockCopies;
  superblockCopyState: SuperblockCopyState;
  superblockLogicalState: SuperblockLogicalState;
  unlockingSlotId: CredentialSlotId;
  unlockSequence: UnlockSequence;
}>;

export async function openEmptyEncryptedContainer({
  backend,
  diagnostics,
  passphrase,
  supportedFeatureBits,
}: {
  backend: HizoFSReadableBackend;
  diagnostics?: AuthenticatedStoreDiagnosticsPort;
  passphrase: string;
  supportedFeatureBits: FeatureBits;
}): Promise<OpenedEmptyEncryptedContainer> {
  const unlocked = await openUnlockEnvelopeCopies({
    backend,
    diagnostics,
    minimumUnlockSequence: INITIAL_UNLOCK_SEQUENCE,
    passphrase,
  });
  try {
    const superblock = await openSuperblockCopies({
      backend,
      diagnostics,
      fileSystemId: unlocked.fileSystemId,
      rootKey: unlocked.rootKey,
      supportedFeatureBits,
    });
    if (unlocked.unlockSequence < superblock.logicalState.minimumUnlockSequence) {
      throw authenticatedStoreError({
        code: "control_plane_corrupt",
        message: "authoritative Superblock requires a newer Unlock Envelope sequence",
      });
    }
    const relocationIndexRootPhysicalRef = superblock.logicalState.relocationIndexRootPhysicalRef;
    if (relocationIndexRootPhysicalRef !== null) {
      await validateAuthenticatedRelocationIndexTree({
        backend,
        diagnostics,
        fileSystemId: unlocked.fileSystemId,
        rootKey: unlocked.rootKey,
        rootPhysicalReference: relocationIndexRootPhysicalRef,
      });
    }
    let bootstrap: OpenedInitialBootstrapRoot;
    let dataOpenMode: OpenedEmptyEncryptedContainer["dataOpenMode"] = "normal";
    try {
      bootstrap = await readBootstrapRoot({
        authority: {
          commitHomeRef: superblock.logicalState.activeCommitHomeRef,
          commitSequence: superblock.logicalState.activeCommitSequence,
          mutationId: superblock.logicalState.activeMutationId,
          type: "active",
        },
        backend,
        diagnostics,
        fileSystemId: unlocked.fileSystemId,
        relocationIndexRootPhysicalRef: superblock.logicalState.relocationIndexRootPhysicalRef,
        rootKey: unlocked.rootKey,
      });
    } catch (cause: unknown) {
      const fallback = superblock.logicalState.fallbackCommitHomeRef;
      if (!(cause instanceof AuthenticatedStoreError)
        || cause.code !== "control_plane_corrupt"
        || fallback === null) {
        throw cause;
      }
      bootstrap = await readBootstrapRoot({
        authority: {
          commitHomeRef: fallback,
          commitSequence: createCommitSequence({ value: superblock.logicalState.activeCommitSequence - 1n }),
          type: "fallback",
        },
        backend,
        diagnostics,
        fileSystemId: unlocked.fileSystemId,
        relocationIndexRootPhysicalRef: superblock.logicalState.relocationIndexRootPhysicalRef,
        rootKey: unlocked.rootKey,
      });
      dataOpenMode = "fallback_read_only";
    }
    return {
      ...bootstrap,
      credentialCopyState: unlocked.copyState,
      dataOpenMode,
      fileSystemId: unlocked.fileSystemId,
      rootKey: unlocked.rootKey,
      superblock,
      superblockCopyState: superblock.copyState,
      superblockLogicalState: superblock.logicalState,
      unlockingSlotId: unlocked.unlockingSlotId,
      unlockSequence: unlocked.unlockSequence,
    };
  } catch (cause: unknown) {
    unlocked.rootKey.destroy();
    throw cause;
  }
}

export async function openEmptyEncryptedContainerWithRootKey({
  backend,
  diagnostics,
  expectedUnlockSequence,
  fileSystemId,
  rootKey,
  supportedFeatureBits,
  unlockingSlotId,
}: {
  backend: HizoFSReadableBackend;
  diagnostics?: AuthenticatedStoreDiagnosticsPort;
  expectedUnlockSequence: UnlockSequence;
  fileSystemId: FileSystemId;
  rootKey: FileSystemRootKey;
  supportedFeatureBits: FeatureBits;
  unlockingSlotId: CredentialSlotId;
}): Promise<OpenedEmptyEncryptedContainer> {
  try {
    const superblock = await openSuperblockCopies({
      backend,
      diagnostics,
      fileSystemId,
      rootKey,
      supportedFeatureBits,
    });
    const unlocked = await openAuthenticatedUnlockEnvelopeAuthority({
      backend,
      diagnostics,
      fileSystemId,
      minimumUnlockSequence: superblock.logicalState.minimumUnlockSequence,
      rootKey,
    });
    if (unlocked.unlockSequence !== expectedUnlockSequence) {
      throw authenticatedStoreError({
        code: "credential_rejected",
        message: "Worker mount grant was issued for a stale Unlock Envelope generation",
      });
    }
    if (!unlocked.credentialSlots.some(slot => slot.slotId === unlockingSlotId)) {
      throw authenticatedStoreError({
        code: "credential_rejected",
        message: "Worker mount grant credential slot is no longer authoritative",
      });
    }
    const relocationIndexRootPhysicalRef = superblock.logicalState.relocationIndexRootPhysicalRef;
    if (relocationIndexRootPhysicalRef !== null) {
      await validateAuthenticatedRelocationIndexTree({
        backend,
        diagnostics,
        fileSystemId,
        rootKey,
        rootPhysicalReference: relocationIndexRootPhysicalRef,
      });
    }
    let bootstrap: OpenedInitialBootstrapRoot;
    let dataOpenMode: OpenedEmptyEncryptedContainer["dataOpenMode"] = "normal";
    try {
      bootstrap = await readBootstrapRoot({
        authority: {
          commitHomeRef: superblock.logicalState.activeCommitHomeRef,
          commitSequence: superblock.logicalState.activeCommitSequence,
          mutationId: superblock.logicalState.activeMutationId,
          type: "active",
        },
        backend,
        diagnostics,
        fileSystemId,
        relocationIndexRootPhysicalRef: superblock.logicalState.relocationIndexRootPhysicalRef,
        rootKey,
      });
    } catch (cause: unknown) {
      const fallback = superblock.logicalState.fallbackCommitHomeRef;
      if (!(cause instanceof AuthenticatedStoreError)
        || cause.code !== "control_plane_corrupt"
        || fallback === null) {
        throw cause;
      }
      bootstrap = await readBootstrapRoot({
        authority: {
          commitHomeRef: fallback,
          commitSequence: createCommitSequence({ value: superblock.logicalState.activeCommitSequence - 1n }),
          type: "fallback",
        },
        backend,
        diagnostics,
        fileSystemId,
        relocationIndexRootPhysicalRef: superblock.logicalState.relocationIndexRootPhysicalRef,
        rootKey,
      });
      dataOpenMode = "fallback_read_only";
    }
    return {
      ...bootstrap,
      credentialCopyState: unlocked.copyState,
      dataOpenMode,
      fileSystemId,
      rootKey,
      superblock,
      superblockCopyState: superblock.copyState,
      superblockLogicalState: superblock.logicalState,
      unlockingSlotId,
      unlockSequence: unlocked.unlockSequence,
    };
  } catch (cause: unknown) {
    rootKey.destroy();
    throw cause;
  }
}

export async function createEmptyEncryptedContainer({
  backend,
  diagnostics,
  fileSystemId,
  passphrase,
  randomSource,
  supportedFeatureBits,
}: {
  backend: HizoFSWritableBackend<AuthenticatedHizoFSPhysicalBytes>;
  diagnostics?: AuthenticatedStoreDiagnosticsPort;
  fileSystemId?: FileSystemId;
  passphrase: string;
  randomSource?: RandomByteSource;
  supportedFeatureBits: FeatureBits;
}): Promise<OpenedEmptyEncryptedContainer> {
  const prepared = await prepareInitialUnlockEnvelopeCopies({ diagnostics, fileSystemId, passphrase, randomSource });
  try {
    const bootstrap = await createInitialBootstrapSegment({
      backend,
      diagnostics,
      fileSystemId: prepared.fileSystemId,
      randomSource,
      rootKey: prepared.rootKey,
    });
    await publishInitialUnlockEnvelopeCopies({ backend, diagnostics, prepared });
    const logicalState: SuperblockLogicalState = {
      ...bootstrap,
      fallbackCommitHomeRef: null,
      minimumUnlockSequence: prepared.unlockSequence,
      relocationIndexRootPhysicalRef: null,
      requiredFeatureBits: NO_REQUIRED_FEATURES,
    };
    await createInitialSuperblockCopies({
      backend,
      diagnostics,
      fileSystemId: prepared.fileSystemId,
      logicalState,
      randomSource,
      rootKey: prepared.rootKey,
      supportedFeatureBits,
    });
    // Success is acknowledged only after discarding the creator-held secret
    // and reopening through the same path used by later sessions.
    prepared.rootKey.destroy();
    return await openEmptyEncryptedContainer({ backend, diagnostics, passphrase, supportedFeatureBits });
  } catch (cause: unknown) {
    prepared.rootKey.destroy();
    throw cause;
  }
}


export type CreatedEmptyEncryptedContainerCredentialSet = Readonly<{
  credentialSlotIds: readonly CredentialSlotId[];
  fileSystemId: FileSystemId;
}>;

export async function createEmptyEncryptedContainerWithPassphrases({
  backend,
  diagnostics,
  fileSystemId,
  passphrases,
  randomSource,
  supportedFeatureBits,
}: {
  backend: HizoFSWritableBackend<AuthenticatedHizoFSPhysicalBytes>;
  diagnostics?: AuthenticatedStoreDiagnosticsPort;
  fileSystemId?: FileSystemId;
  passphrases: readonly string[];
  randomSource?: RandomByteSource;
  supportedFeatureBits: FeatureBits;
}): Promise<CreatedEmptyEncryptedContainerCredentialSet> {
  const prepared = await prepareInitialUnlockEnvelopeCredentialSet({
    diagnostics,
    fileSystemId,
    passphrases,
    randomSource,
  });
  try {
    const bootstrap = await createInitialBootstrapSegment({
      backend,
      diagnostics,
      fileSystemId: prepared.fileSystemId,
      randomSource,
      rootKey: prepared.rootKey,
    });
    await publishInitialUnlockEnvelopeCredentialSet({ backend, diagnostics, prepared });
    const logicalState: SuperblockLogicalState = {
      ...bootstrap,
      fallbackCommitHomeRef: null,
      minimumUnlockSequence: prepared.unlockSequence,
      relocationIndexRootPhysicalRef: null,
      requiredFeatureBits: NO_REQUIRED_FEATURES,
    };
    await createInitialSuperblockCopies({
      backend,
      diagnostics,
      fileSystemId: prepared.fileSystemId,
      logicalState,
      randomSource,
      rootKey: prepared.rootKey,
      supportedFeatureBits,
    });
    prepared.rootKey.destroy();
    for (const passphrase of passphrases) {
      const opened = await openEmptyEncryptedContainer({
        backend,
        diagnostics,
        passphrase,
        supportedFeatureBits,
      });
      try {
        if (opened.fileSystemId !== prepared.fileSystemId) {
          throw new TypeError("initial credential set reopened another File System ID");
        }
      } finally {
        opened.rootKey.destroy();
      }
    }
    return {
      credentialSlotIds: [...prepared.credentialSlotIds],
      fileSystemId: prepared.fileSystemId,
    };
  } catch (cause: unknown) {
    prepared.rootKey.destroy();
    throw cause;
  }
}


// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
