import { describe, expect, it } from "vitest";
import {
  HIZOFS_V1_FORMAT_CONSTANTS,
  createCommitSequence,
  createFileSystemCommitPayload,
  createInodeNumber,
  createInodeRevision,
  parseFileSystemId,
  parseMutationId,
  type InodeLeafEntry,
} from "@/00-storage/service/hizofs/00-format";
import {
  generateFileSystemRootKey,
  type RandomByteSource,
} from "@/00-storage/service/hizofs/01-crypto";
import {
  createInitialBootstrapSegment,
  readBootstrapRoot,
  readInitialBootstrapRoot,
} from "@/00-storage/service/hizofs/authenticated-store/bootstrap-segment-store";
import type { AuthenticatedHizoFSPhysicalBytes } from "@/00-storage/service/hizofs/authenticated-store/physical-bytes";
import {
  appendAuthenticatedInodeTablePage,
} from "@/00-storage/service/hizofs/authenticated-store/inode-table-page-store";
import { appendPreparedMutationCommitCandidate } from "@/00-storage/service/hizofs/authenticated-store/prepared-mutation-commit-store";
import { createAuthenticatedSegmentWriter } from "@/00-storage/service/hizofs/authenticated-store/record-appender";
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

function directoryInode({ inodeNumber }: { inodeNumber: bigint }): InodeLeafEntry {
  return {
    content: { entries: [], type: "inline" },
    inodeKind: "directory",
    inodeNumber: createInodeNumber({ value: inodeNumber }),
    inodeRevision: createInodeRevision({ value: 1n }),
    timestamps: { createdAt: null, modifiedAt: null },
  };
}

describe("HizoFS initial bootstrap segment", () => {
  it("authenticates the initial Commit and traverses to an empty root directory", async () => {
    const backend = new InMemoryCrashDurabilityBackend<AuthenticatedHizoFSPhysicalBytes>({});
    const randomSource = deterministicRandomSource();
    const fileSystemId = parseFileSystemId({ value: "0123456789_ABCDEFGHIJ" });
    const rootKey = generateFileSystemRootKey({ randomSource });

    const created = await createInitialBootstrapSegment({
      backend,
      fileSystemId,
      randomSource,
      rootKey,
    });
    expect(created.activeCommitSequence).toBe(1n);
    expect(created.activeCommitHomeRef.recordKind).toBe(HIZOFS_V1_FORMAT_CONSTANTS.recordKinds.file_system_commit);

    const opened = await readInitialBootstrapRoot({
      activeCommitHomeRef: created.activeCommitHomeRef,
      activeCommitSequence: created.activeCommitSequence,
      activeMutationId: created.activeMutationId,
      backend,
      fileSystemId,
      rootKey,
    });
    expect(opened.rootDirectoryInode.inodeKind).toBe("directory");
    expect(opened.rootDirectoryInode.inodeNumber).toBe(1n);
    expect(opened.rootDirectoryInode.content).toEqual({ entries: [], type: "inline" });
    expect(opened.commit.nextInodeNumber).toBe(2n);
    expect(opened.commit.nextSubvolumeId).toBe(2n);
    expect(backend.openHandleCount()).toBe(0);
    rootKey.destroy();
  });


  it("reopens a Commit whose root Inode Table has grown to a branch", async () => {
    const backend = new InMemoryCrashDurabilityBackend<AuthenticatedHizoFSPhysicalBytes>({});
    const randomSource = deterministicRandomSource();
    const fileSystemId = parseFileSystemId({ value: "0123456789_ABCDEFGHIJ" });
    const rootKey = generateFileSystemRootKey({ randomSource });
    const created = await createInitialBootstrapSegment({ backend, fileSystemId, randomSource, rootKey });
    const opened = await readInitialBootstrapRoot({
      activeCommitHomeRef: created.activeCommitHomeRef,
      activeCommitSequence: created.activeCommitSequence,
      activeMutationId: created.activeMutationId,
      backend,
      fileSystemId,
      rootKey,
    });
    const writer = await createAuthenticatedSegmentWriter({
      backend,
      fileSystemId,
      randomSource,
      rootKey,
      segmentClass: "metadata",
    });
    try {
      const firstLeafReference = await appendAuthenticatedInodeTablePage({
        isRoot: false,
        page: { entries: [opened.rootDirectoryInode], level: 0, type: "leaf" },
        writer,
      });
      const secondInode = directoryInode({ inodeNumber: 2n });
      const secondLeafReference = await appendAuthenticatedInodeTablePage({
        isRoot: false,
        page: { entries: [secondInode], level: 0, type: "leaf" },
        writer,
      });
      const rootInodeTableRootHomeRef = await appendAuthenticatedInodeTablePage({
        isRoot: true,
        page: {
          entries: [
            { childPageHomeRef: firstLeafReference, upperBound: opened.rootDirectoryInode.inodeNumber },
            { childPageHomeRef: secondLeafReference, upperBound: secondInode.inodeNumber },
          ],
          level: 1,
          type: "branch",
        },
        writer,
      });
      const commitPayload = createFileSystemCommitPayload({ payload: {
        ...opened.commit,
        commitSequence: createCommitSequence({ value: 2n }),
        mutationId: parseMutationId({ bytes: new Uint8Array(16).fill(37) }),
        nextInodeNumber: createInodeNumber({ value: 3n }),
        rootInodeTableRootHomeRef,
      } });
      const candidate = await appendPreparedMutationCommitCandidate({ commitPayload, writer });
      writer.abandon();

      await expect(readBootstrapRoot({
        authority: {
          commitHomeRef: candidate.commitHomeRef,
          commitSequence: candidate.commitPayload.commitSequence,
          mutationId: candidate.commitPayload.mutationId,
          type: "active",
        },
        backend,
        fileSystemId,
        relocationIndexRootPhysicalRef: null,
        rootKey,
      })).resolves.toMatchObject({
        rootDirectoryInode: { inodeKind: "directory", inodeNumber: 1n },
      });
    } finally {
      writer.abandon();
      rootKey.destroy();
    }
  });

  it("checks Segment ID collisions across metadata and data classes", async () => {
    class ObservedBackend extends InMemoryCrashDurabilityBackend<AuthenticatedHizoFSPhysicalBytes> {
      public readonly sizeChecks: string[] = [];
      private injectOneDataCollision = true;

      public override async getFileSize(input: Parameters<InMemoryCrashDurabilityBackend<AuthenticatedHizoFSPhysicalBytes>["getFileSize"]>[0]) {
        this.sizeChecks.push(input.path);
        if (this.injectOneDataCollision && input.path.includes("/data/")) {
          this.injectOneDataCollision = false;
          return 1n;
        }
        return await super.getFileSize(input);
      }
    }

    const backend = new ObservedBackend({});
    const randomSource = deterministicRandomSource();
    const fileSystemId = parseFileSystemId({ value: "0123456789_ABCDEFGHIJ" });
    const rootKey = generateFileSystemRootKey({ randomSource });
    await createInitialBootstrapSegment({ backend, fileSystemId, randomSource, rootKey });

    expect([...new Set(backend.sizeChecks.filter(path => path.includes("/metadata/")))]).toHaveLength(2);
    expect([...new Set(backend.sizeChecks.filter(path => path.includes("/data/")))]).toHaveLength(2);
    rootKey.destroy();
  });

  it("opens only the explicitly named fallback Commit Sequence", async () => {
    const backend = new InMemoryCrashDurabilityBackend<AuthenticatedHizoFSPhysicalBytes>({});
    const randomSource = deterministicRandomSource();
    const fileSystemId = parseFileSystemId({ value: "0123456789_ABCDEFGHIJ" });
    const rootKey = generateFileSystemRootKey({ randomSource });
    const created = await createInitialBootstrapSegment({ backend, fileSystemId, randomSource, rootKey });

    await expect(readBootstrapRoot({
      authority: {
        commitHomeRef: created.activeCommitHomeRef,
        commitSequence: created.activeCommitSequence,
        type: "fallback",
      },
      backend,
      fileSystemId,
      relocationIndexRootPhysicalRef: null,
      rootKey,
    })).resolves.toMatchObject({ commit: { commitSequence: 1n } });
    await expect(readBootstrapRoot({
      authority: {
        commitHomeRef: created.activeCommitHomeRef,
        commitSequence: createCommitSequence({ value: 2n }),
        type: "fallback",
      },
      backend,
      fileSystemId,
      relocationIndexRootPhysicalRef: null,
      rootKey,
    })).rejects.toMatchObject({
      cause: { message: "fallback Commit Sequence does not match its explicit authority" },
      code: "control_plane_corrupt",
    });
    rootKey.destroy();
  });

});
