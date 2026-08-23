import {
  createCommitSequence,
  createFeatureBits,
  createUnlockSequence,
  type FeatureBits,
  type FileSystemCommitPayload,
  type FileSystemId,
  type PhysicalRecordReference,
} from "@/00-storage/service/hizofs/00-format";
import type { AuthenticatedHizoFSInspectionPort } from "@/00-storage/service/hizofs/authenticated-store/inspection-port";
import type { FileSystemRootKey } from "@/00-storage/service/hizofs/01-crypto";

export type HizoFSInspectionAuthorityMode = "active" | "fallback_read_only";

export type HizoFSOpenedInspectionAuthority = Readonly<{
  commit: FileSystemCommitPayload;
  fileSystemId: FileSystemId;
  mode: HizoFSInspectionAuthorityMode;
  relocationIndexRootPhysicalRef: PhysicalRecordReference | null;
  rootKey: FileSystemRootKey;
}>;

/**
 * Borrows a caller-owned root-key capability for one bounded inspection
 * operation without transferring or destroying that capability. The root key
 * stays inside HizoFS core composition and is never returned in inspection data.
 */
export async function withBorrowedHizoFSInspectionAuthority<T>({
  fileSystemId,
  operation,
  physical,
  rootKey,
  supportedFeatureBits = createFeatureBits({ value: 0n }),
}: {
  fileSystemId: FileSystemId;
  operation: ({ authority }: { authority: HizoFSOpenedInspectionAuthority }) => Promise<T>;
  physical: AuthenticatedHizoFSInspectionPort;
  rootKey: FileSystemRootKey;
  supportedFeatureBits?: FeatureBits;
}): Promise<T> {
  const openedSuperblock = await physical.openSuperblockCopies({
    fileSystemId,
    rootKey,
    supportedFeatureBits,
  });
  await physical.openUnlockAuthority({
    fileSystemId,
    minimumUnlockSequence: openedSuperblock.logicalState.minimumUnlockSequence,
    rootKey,
  });

  const common = {
    fileSystemId,
    relocationIndexRootPhysicalRef: openedSuperblock.logicalState.relocationIndexRootPhysicalRef,
    rootKey,
  };
  try {
    const opened = await physical.readBootstrapRoot({
      authority: {
        commitHomeRef: openedSuperblock.logicalState.activeCommitHomeRef,
        commitSequence: openedSuperblock.logicalState.activeCommitSequence,
        mutationId: openedSuperblock.logicalState.activeMutationId,
        type: "active",
      },
      ...common,
    });
    return await operation({
      authority: {
        ...common,
        commit: opened.commit,
        mode: "active",
      },
    });
  } catch (activeCause: unknown) {
    const fallback = openedSuperblock.logicalState.fallbackCommitHomeRef;
    if (fallback === null) throw activeCause;
    const opened = await physical.readBootstrapRoot({
      authority: {
        commitHomeRef: fallback,
        commitSequence: createCommitSequence({
          value: openedSuperblock.logicalState.activeCommitSequence - 1n,
        }),
        type: "fallback",
      },
      ...common,
    });
    return await operation({
      authority: {
        ...common,
        commit: opened.commit,
        mode: "fallback_read_only",
      },
    });
  }
}

/**
 * Opens a passphrase-backed inspection authority and destroys the temporary
 * root-key capability before returning to the caller.
 */
export async function withHizoFSInspectionAuthority<T>({
  operation,
  passphrase,
  physical,
  supportedFeatureBits = createFeatureBits({ value: 0n }),
}: {
  operation: ({ authority }: { authority: HizoFSOpenedInspectionAuthority }) => Promise<T>;
  passphrase: string;
  physical: AuthenticatedHizoFSInspectionPort;
  supportedFeatureBits?: FeatureBits;
}): Promise<T> {
  const openedUnlock = await physical.openUnlockCopies({
    minimumUnlockSequence: createUnlockSequence({ value: 1n }),
    passphrase,
  });
  const rootKey = openedUnlock.rootKey;
  try {
    return await withBorrowedHizoFSInspectionAuthority({
      fileSystemId: openedUnlock.fileSystemId,
      operation,
      physical,
      rootKey,
      supportedFeatureBits,
    });
  } finally {
    rootKey.destroy();
  }
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
