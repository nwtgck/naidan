import { describe, expect, it } from "vitest";
import {
  createCommitSequence,
  createFeatureBits,
  createFileSystemCommitPayload,
  createPublicationSequence,
  createUnlockSequence,
  parseFileSystemId,
  parseMutationId,
} from "@/00-storage/service/hizofs/00-format";
import {
  createInitialBootstrapSegment,
  readBootstrapRoot,
} from "@/00-storage/service/hizofs/authenticated-store/bootstrap-segment-store";
import type { AuthenticatedHizoFSPhysicalBytes } from "@/00-storage/service/hizofs/authenticated-store/physical-bytes";
import {
  appendAndPublishPreparedMutationCommit,
  appendPreparedMutationCommitCandidate,
  publishPreparedMutationCommitCandidate,
} from "@/00-storage/service/hizofs/authenticated-store/prepared-mutation-commit-store";
import { createAuthenticatedSegmentWriter } from "@/00-storage/service/hizofs/authenticated-store/record-appender";
import {
  createInitialSuperblockCopies,
  openSuperblockCopies,
} from "@/00-storage/service/hizofs/authenticated-store/superblock-store";
import {
  generateFileSystemRootKey,
  type RandomByteSource,
} from "@/00-storage/service/hizofs/01-crypto";
import { InMemoryCrashDurabilityBackend } from "@/00-storage/service/hizofs/physical-store/testing/in-memory-crash-durability-backend";

function deterministicRandomSource(): RandomByteSource {
  let next = 1;
  return ({ bytes }) => {
    for (let index = 0; index < bytes.byteLength; index += 1) {
      bytes[index] = next;
      next = next === 251 ? 1 : next + 1;
    }
  };
}

async function setup() {
  const backend = new InMemoryCrashDurabilityBackend<AuthenticatedHizoFSPhysicalBytes>({});
  const randomSource = deterministicRandomSource();
  const fileSystemId = parseFileSystemId({ value: "0123456789_ABCDEFGHIJ" });
  const rootKey = generateFileSystemRootKey({ randomSource });
  const bootstrap = await createInitialBootstrapSegment({ backend, fileSystemId, randomSource, rootKey });
  const base = await createInitialSuperblockCopies({
    backend,
    fileSystemId,
    logicalState: {
      activeCommitHomeRef: bootstrap.activeCommitHomeRef,
      activeCommitSequence: bootstrap.activeCommitSequence,
      activeMutationId: bootstrap.activeMutationId,
      fallbackCommitHomeRef: null,
      minimumUnlockSequence: createUnlockSequence({ value: 1n }),
      relocationIndexRootPhysicalRef: null,
      requiredFeatureBits: createFeatureBits({ value: 0n }),
    },
    randomSource,
    rootKey,
    supportedFeatureBits: createFeatureBits({ value: 0n }),
  });
  const openedRoot = await readBootstrapRoot({
    authority: {
      commitHomeRef: bootstrap.activeCommitHomeRef,
      commitSequence: bootstrap.activeCommitSequence,
      mutationId: bootstrap.activeMutationId,
      type: "active",
    },
    backend,
    fileSystemId,
    relocationIndexRootPhysicalRef: null,
    rootKey,
  });
  const commitPayload = createFileSystemCommitPayload({ payload: {
    ...openedRoot.commit,
    commitSequence: createCommitSequence({ value: 2n }),
    mutationId: parseMutationId({ bytes: new Uint8Array(16).fill(17) }),
  } });
  return { backend, base, commitPayload, fileSystemId, randomSource, rootKey };
}

describe("prepared mutation Commit authority store", () => {
  it("keeps an authenticated candidate separate from durable Superblock publication", async () => {
    const fixture = await setup();
    const writer = await createAuthenticatedSegmentWriter({
      backend: fixture.backend,
      fileSystemId: fixture.fileSystemId,
      randomSource: fixture.randomSource,
      rootKey: fixture.rootKey,
      segmentClass: "metadata",
    });
    try {
      const candidate = await appendPreparedMutationCommitCandidate({
        commitPayload: fixture.commitPayload,
        writer,
      });
      writer.abandon();

      const beforePublication = await openSuperblockCopies({
        backend: fixture.backend,
        fileSystemId: fixture.fileSystemId,
        rootKey: fixture.rootKey,
        supportedFeatureBits: createFeatureBits({ value: 0n }),
      });
      expect(beforePublication.logicalState.activeCommitSequence).toBe(1n);

      const candidateRoot = await readBootstrapRoot({
        authority: {
          commitHomeRef: candidate.commitHomeRef,
          commitSequence: candidate.commitPayload.commitSequence,
          mutationId: candidate.commitPayload.mutationId,
          type: "active",
        },
        backend: fixture.backend,
        fileSystemId: fixture.fileSystemId,
        relocationIndexRootPhysicalRef: null,
        rootKey: fixture.rootKey,
      });
      expect(candidateRoot.commit).toEqual(fixture.commitPayload);

      const published = await publishPreparedMutationCommitCandidate({
        backend: fixture.backend,
        base: fixture.base,
        candidate,
        fileSystemId: fixture.fileSystemId,
        firstPublicationSequence: createPublicationSequence({ value: 3n }),
        randomSource: fixture.randomSource,
        rootKey: fixture.rootKey,
        secondPublicationSequence: createPublicationSequence({ value: 4n }),
        supportedFeatureBits: createFeatureBits({ value: 0n }),
      });
      expect(published.superblock.logicalState.activeCommitSequence).toBe(2n);
      expect(published.commitHomeRef).toEqual(candidate.commitHomeRef);
    } finally {
      writer.abandon();
      fixture.rootKey.destroy();
    }
  });

  it("rejects a Commit whose durable append read-back differs without advancing authority", async () => {
    const fixture = await setup();
    const writer = await createAuthenticatedSegmentWriter({
      backend: fixture.backend,
      fileSystemId: fixture.fileSystemId,
      randomSource: fixture.randomSource,
      rootKey: fixture.rootKey,
      segmentClass: "metadata",
    });
    const originalReadExact = fixture.backend.readExact.bind(fixture.backend);
    let corruptedReadBack = false;
    fixture.backend.readExact = async ({ length, offset, path }) => {
      const bytes = await originalReadExact({ length, offset, path });
      if (corruptedReadBack) return bytes;
      corruptedReadBack = true;
      const corrupted = bytes.slice();
      const finalIndex = corrupted.byteLength - 1;
      const finalByte = corrupted[finalIndex];
      if (finalByte === undefined) throw new Error("Commit read-back fixture unexpectedly returned empty bytes");
      corrupted[finalIndex] = finalByte ^ 0xff;
      return corrupted;
    };
    try {
      await expect(appendPreparedMutationCommitCandidate({
        commitPayload: fixture.commitPayload,
        writer,
      })).rejects.toThrow("durable record append read-back differs");
      expect(corruptedReadBack).toBe(true);
      await expect(appendPreparedMutationCommitCandidate({
        commitPayload: fixture.commitPayload,
        writer,
      })).rejects.toThrow(/abandoned segment writer/);
      await expect(openSuperblockCopies({
        backend: fixture.backend,
        fileSystemId: fixture.fileSystemId,
        rootKey: fixture.rootKey,
        supportedFeatureBits: createFeatureBits({ value: 0n }),
      })).resolves.toMatchObject({ logicalState: { activeCommitSequence: 1n } });
    } finally {
      writer.abandon();
      fixture.rootKey.destroy();
    }
  });

  it("keeps candidate authority immutable and rejects forged candidate values", async () => {
    const fixture = await setup();
    const writer = await createAuthenticatedSegmentWriter({
      backend: fixture.backend,
      fileSystemId: fixture.fileSystemId,
      randomSource: fixture.randomSource,
      rootKey: fixture.rootKey,
      segmentClass: "metadata",
    });
    try {
      const candidate = await appendPreparedMutationCommitCandidate({
        commitPayload: fixture.commitPayload,
        writer,
      });
      writer.abandon();
      const expectedHomeRef = candidate.commitHomeRef;
      const exposedPayload = candidate.commitPayload;
      exposedPayload.mutationId.fill(93);
      exposedPayload.rootInodeTableRootHomeRef.segmentId.fill(94);
      candidate.commitHomeRef.segmentId.fill(95);

      const forgedCandidate = Object.freeze({
        commitHomeRef: candidate.commitHomeRef,
        commitPayload: candidate.commitPayload,
      });
      await expect(publishPreparedMutationCommitCandidate({
        backend: fixture.backend,
        base: fixture.base,
        candidate: forgedCandidate,
        fileSystemId: fixture.fileSystemId,
        firstPublicationSequence: createPublicationSequence({ value: 3n }),
        randomSource: fixture.randomSource,
        rootKey: fixture.rootKey,
        secondPublicationSequence: createPublicationSequence({ value: 4n }),
        supportedFeatureBits: createFeatureBits({ value: 0n }),
      })).rejects.toThrow("not authenticated by this runtime");

      const stillDurableBase = await openSuperblockCopies({
        backend: fixture.backend,
        fileSystemId: fixture.fileSystemId,
        rootKey: fixture.rootKey,
        supportedFeatureBits: createFeatureBits({ value: 0n }),
      });
      expect(stillDurableBase.logicalState.activeCommitSequence).toBe(1n);

      const published = await publishPreparedMutationCommitCandidate({
        backend: fixture.backend,
        base: fixture.base,
        candidate,
        fileSystemId: fixture.fileSystemId,
        firstPublicationSequence: createPublicationSequence({ value: 3n }),
        randomSource: fixture.randomSource,
        rootKey: fixture.rootKey,
        secondPublicationSequence: createPublicationSequence({ value: 4n }),
        supportedFeatureBits: createFeatureBits({ value: 0n }),
      });
      expect(published.commitHomeRef).toEqual(expectedHomeRef);
      expect(published.superblock.logicalState.activeMutationId).toEqual(fixture.commitPayload.mutationId);
      expect(published.superblock.logicalState.activeCommitHomeRef).toEqual(expectedHomeRef);
    } finally {
      writer.abandon();
      fixture.rootKey.destroy();
    }
  });

  it("durably appends the Commit before converging the Superblock pair", async () => {
    const fixture = await setup();
    const published = await appendAndPublishPreparedMutationCommit({
      ...fixture,
      firstPublicationSequence: createPublicationSequence({ value: 3n }),
      secondPublicationSequence: createPublicationSequence({ value: 4n }),
      supportedFeatureBits: createFeatureBits({ value: 0n }),
    });

    expect(published.superblock.copyState).toBe("normal");
    expect(published.superblock.logicalState.activeCommitSequence).toBe(2n);
    const reopened = await readBootstrapRoot({
      authority: {
        commitHomeRef: published.commitHomeRef,
        commitSequence: fixture.commitPayload.commitSequence,
        mutationId: fixture.commitPayload.mutationId,
        type: "active",
      },
      backend: fixture.backend,
      fileSystemId: fixture.fileSystemId,
      relocationIndexRootPhysicalRef: null,
      rootKey: fixture.rootKey,
    });
    expect(reopened.commit).toEqual(fixture.commitPayload);
    fixture.rootKey.destroy();
  });

  it("keeps the durable candidate unreachable when the final gate rejects publication", async () => {
    const fixture = await setup();
    await expect(appendAndPublishPreparedMutationCommit({
      ...fixture,
      beforeFirstAuthorityWrite: () => {
        throw new Error("publication revoked");
      },
      firstPublicationSequence: createPublicationSequence({ value: 3n }),
      secondPublicationSequence: createPublicationSequence({ value: 4n }),
      supportedFeatureBits: createFeatureBits({ value: 0n }),
    })).rejects.toMatchObject({ outcome: "not_published" });

    const reopened = await openSuperblockCopies({
      backend: fixture.backend,
      fileSystemId: fixture.fileSystemId,
      rootKey: fixture.rootKey,
      supportedFeatureBits: createFeatureBits({ value: 0n }),
    });
    expect(reopened.logicalState.activeCommitSequence).toBe(1n);
    fixture.rootKey.destroy();
  });
});
