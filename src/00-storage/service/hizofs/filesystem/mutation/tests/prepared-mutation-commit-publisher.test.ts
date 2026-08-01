import { describe, expect, it, vi } from "vitest";
import {
  HIZOFS_V1_FORMAT_CONSTANTS,
  createCommitSequence,
  createFeatureBits,
  createFileSystemCommitPayload,
  createHomeRecordReference,
  createInodeNumber,
  createPublicationSequence,
  createUInt64,
  createSubvolumeId,
  createUnlockSequence,
  parseMutationId,
  parsePublicationId,
  parseSegmentId,
} from "@/00-storage/service/hizofs/00-format";
import type { OpenedSuperblockCopies } from "@/00-storage/service/hizofs/authenticated-store/superblock-store";
import {
  publishPreparedMutationCommit,
  type PreparedMutationCommitPublicationPort,
} from "@/00-storage/service/hizofs/filesystem/mutation/prepared-mutation-commit-publisher";
import { WriterMutationLifecycleError } from "@/00-storage/service/hizofs/filesystem/mutation/writer-mutation-lifecycle";

function homeReference({ kind = HIZOFS_V1_FORMAT_CONSTANTS.recordKinds.file_system_commit, offset }: { kind?: number; offset: bigint }) {
  return createHomeRecordReference({ fields: {
    byteOffset: createUInt64({ value: offset }),
    frameLength: 128,
    recordKind: kind,
    segmentId: parseSegmentId({ bytes: new Uint8Array(16).fill(Number(offset % 251n) + 1) }),
  } });
}

function baseAuthority(): OpenedSuperblockCopies {
  const logicalState = {
    activeCommitHomeRef: homeReference({ offset: 64n }),
    activeCommitSequence: createCommitSequence({ value: 1n }),
    activeMutationId: parseMutationId({ bytes: new Uint8Array(16).fill(3) }),
    fallbackCommitHomeRef: null,
    minimumUnlockSequence: createUnlockSequence({ value: 1n }),
    relocationIndexRootPhysicalRef: null,
    requiredFeatureBits: createFeatureBits({ value: 0n }),
  };
  return {
    authenticatedLogicalStates: [logicalState],
    copyState: "normal",
    historicalRootFeatureState: "supported_or_absent",
    logicalState,
    maximumStructurallyObservedPublicationSequence: createPublicationSequence({ value: 2n }),
    selectedCopy: 1,
    selectedPublicationId: parsePublicationId({ bytes: new Uint8Array(16).fill(4) }),
    selectedPublicationSequence: createPublicationSequence({ value: 2n }),
  };
}

function preparedCommit() {
  return createFileSystemCommitPayload({ payload: {
    commitSequence: createCommitSequence({ value: 2n }),
    mutationId: parseMutationId({ bytes: new Uint8Array(16).fill(17) }),
    nestedSubvolumeTableRootHomeRef: null,
    nextInodeNumber: createInodeNumber({ value: 2n }),
    nextSubvolumeId: createSubvolumeId({ value: 2n }),
    rootDirectoryInodeNumber: createInodeNumber({ value: 1n }),
    rootInodeTableRootHomeRef: homeReference({
      kind: HIZOFS_V1_FORMAT_CONSTANTS.recordKinds.inode_table_page,
      offset: 192n,
    }),
  } });
}

function successfulPort(): {
  port: PreparedMutationCommitPublicationPort;
  publish: ReturnType<typeof vi.fn>;
  } {
  const publish = vi.fn(async (request: Parameters<PreparedMutationCommitPublicationPort["publish"]>[0]) => {
    request.beforeFirstAuthorityWrite();
    return {
      commitHomeRef: homeReference({ offset: 320n }),
      superblock: {
        ...request.base,
        logicalState: {
          ...request.base.logicalState,
          activeCommitHomeRef: homeReference({ offset: 320n }),
          activeCommitSequence: request.commitPayload.commitSequence,
          activeMutationId: request.commitPayload.mutationId,
          fallbackCommitHomeRef: request.base.logicalState.activeCommitHomeRef,
        },
        maximumStructurallyObservedPublicationSequence: request.secondPublicationSequence,
        selectedPublicationSequence: request.secondPublicationSequence,
      },
    };
  });
  return { port: { publish }, publish };
}

describe("prepared mutation Commit publisher", () => {
  it("passes the exact reserved publication plan through the injected port", async () => {
    const base = baseAuthority();
    const commitPayload = preparedCommit();
    const { port, publish } = successfulPort();
    const published = await publishPreparedMutationCommit({
      assertPublicationAllowed: () => undefined,
      base,
      commitPayload,
      publicationPort: port,
    });

    expect(published.superblock.logicalState.activeCommitSequence).toBe(2n);
    expect(publish).toHaveBeenCalledWith(expect.objectContaining({
      base,
      commitPayload,
      firstPublicationSequence: 3n,
      secondPublicationSequence: 4n,
    }));
  });

  it("rejects owner closing before invoking the publication port", async () => {
    const { port, publish } = successfulPort();
    await expect(publishPreparedMutationCommit({
      assertPublicationAllowed: () => {
        throw new WriterMutationLifecycleError({ code: "publication_revoked", message: "writer owner is closing" });
      },
      base: baseAuthority(),
      commitPayload: preparedCommit(),
      publicationPort: port,
    })).rejects.toMatchObject({ code: "publication_revoked" });
    expect(publish).not.toHaveBeenCalled();
  });

  it("rethrows late owner revocation immediately before the first authority write", async () => {
    let gateChecks = 0;
    const publicationPort: PreparedMutationCommitPublicationPort = {
      publish: async request => {
        request.beforeFirstAuthorityWrite();
        throw new Error("unreachable after final gate");
      },
    };
    await expect(publishPreparedMutationCommit({
      assertPublicationAllowed: () => {
        gateChecks += 1;
        if (gateChecks === 2) {
          throw new WriterMutationLifecycleError({ code: "publication_revoked", message: "writer owner started closing" });
        }
      },
      base: baseAuthority(),
      commitPayload: preparedCommit(),
      publicationPort,
    })).rejects.toMatchObject({ code: "publication_revoked" });
    expect(gateChecks).toBe(2);
  });
});
