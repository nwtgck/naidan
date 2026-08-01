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
import { appendAndPublishPreparedMutationCommit } from "@/00-storage/service/hizofs/authenticated-store/prepared-mutation-commit-store";
import {
  createInitialSuperblockCopies,
  openSuperblockCopies,
} from "@/00-storage/service/hizofs/authenticated-store/superblock-store";
import {
  generateFileSystemRootKey,
  type RandomByteSource,
} from "@/00-storage/service/hizofs/crypto";
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
