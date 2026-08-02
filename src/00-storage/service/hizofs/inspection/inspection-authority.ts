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
 * Keeps the root-key capability inside one operation and destroys it before
 * returning. Inspection callers receive authenticated values, never the
 * secret-bearing capability itself.
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
    const openedSuperblock = await physical.openSuperblockCopies({
      fileSystemId: openedUnlock.fileSystemId,
      rootKey,
      supportedFeatureBits,
    });
    await physical.openUnlockAuthority({
      fileSystemId: openedUnlock.fileSystemId,
      minimumUnlockSequence: openedSuperblock.logicalState.minimumUnlockSequence,
      rootKey,
    });

    const common = {
      fileSystemId: openedUnlock.fileSystemId,
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
  } finally {
    rootKey.destroy();
  }
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
