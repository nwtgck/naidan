import { describe, expect, it, vi } from "vitest";
import {
  createHomeRecordReference,
  createInodeNumber,
  createInodeRevision,
  createSubvolumeId,
  createUInt64,
  HIZOFS_V1_FORMAT_CONSTANTS,
  parseSegmentId,
} from "@/00-storage/service/hizofs/00-format";
import { CapturedDirectoryIterator } from "@/00-storage/service/hizofs/runtime/captured-directory-iterator";
import { SessionLifecycle } from "@/00-storage/service/hizofs/runtime/session-lifecycle";

function commitReference() {
  return createHomeRecordReference({ fields: {
    byteOffset: createUInt64({ value: 64n }),
    frameLength: 96,
    recordKind: HIZOFS_V1_FORMAT_CONSTANTS.recordKinds.file_system_commit,
    segmentId: parseSegmentId({ bytes: Uint8Array.from({ length: 16 }, (_, index) => index + 1) }),
  } });
}

function differentCommitReference() {
  return createHomeRecordReference({ fields: {
    byteOffset: createUInt64({ value: 160n }),
    frameLength: 96,
    recordKind: HIZOFS_V1_FORMAT_CONSTANTS.recordKinds.file_system_commit,
    segmentId: parseSegmentId({ bytes: Uint8Array.from({ length: 16 }, (_, index) => index + 1) }),
  } });
}

function readerPin({ reference = commitReference(), release }: {
  reference?: ReturnType<typeof commitReference>;
  release: () => void;
}) {
  const completion = Promise.withResolvers<void>();
  let active = true;
  return {
    commitReference: reference,
    release: () => {
      if (!active) return;
      active = false;
      release();
      completion.resolve();
    },
    released: completion.promise,
  };
}

function iterator({ entries = [
  { inodeKind: "file" as const, inodeNumber: createInodeNumber({ value: 3n }), name: "z", targetType: "inode" as const },
  { inodeKind: "directory" as const, inodeNumber: createInodeNumber({ value: 2n }), name: "a", targetType: "inode" as const },
] } = {}) {
  const release = vi.fn();
  const session = new SessionLifecycle({ releaseResources: async () => undefined });
  const value = new CapturedDirectoryIterator({
    entries,
    generation: {
      commitReference: commitReference(),
      directoryInodeNumber: createInodeNumber({ value: 9n }),
      inodeRevision: createInodeRevision({ value: 4n }),
      subvolumeId: createSubvolumeId({ value: 1n }),
    },
    maxEntries: 10,
    pin: readerPin({ release }),
    session,
  });
  return { iterator: value, release, session };
}

describe("captured directory iterator", () => {
  it("emits one captured generation in canonical unsigned UTF-8 order", async () => {
    const value = iterator();
    await expect(value.iterator.next()).resolves.toMatchObject({ done: false, value: { name: "a" } });
    await expect(value.iterator.next()).resolves.toMatchObject({ done: false, value: { name: "z" } });
    await expect(value.iterator.next()).resolves.toEqual({ done: true, value: undefined });
    await expect(value.iterator.next()).resolves.toEqual({ done: true, value: undefined });
    expect(value.iterator.generation()).toMatchObject({
      directoryInodeNumber: 9n,
      inodeRevision: 4n,
      subvolumeId: 1n,
    });
    expect(value.release).toHaveBeenCalledOnce();
  });

  it("returns detached entry data and does not observe later caller mutation", async () => {
    const mutable = { inodeKind: "file" as const, inodeNumber: createInodeNumber({ value: 3n }), name: "before", targetType: "inode" as const };
    const value = iterator({ entries: [mutable] });
    mutable.name = "after";
    await expect(value.iterator.next()).resolves.toMatchObject({ value: { name: "before" } });
  });

  it("revokes unfinished iteration and releases its pin on session close", async () => {
    const value = iterator();
    await value.iterator.next();
    await value.session.close();
    expect(value.release).toHaveBeenCalledOnce();
    await expect(value.iterator.next()).rejects.toMatchObject({ code: "capability_closed" });
  });

  it("releases its pin on explicit early return", async () => {
    const value = iterator();
    await value.iterator.return();
    await value.iterator.return();
    await expect(value.iterator.next()).resolves.toEqual({ done: true, value: undefined });
    expect(value.release).toHaveBeenCalledOnce();
  });

  it("rejects duplicate canonical names and boundedness violations without leaking a pin", () => {
    const duplicateRelease = vi.fn();
    const session = new SessionLifecycle({ releaseResources: async () => undefined });
    expect(() => new CapturedDirectoryIterator({
      entries: [
        { inodeKind: "file", inodeNumber: createInodeNumber({ value: 2n }), name: "same", targetType: "inode" },
        { inodeKind: "file", inodeNumber: createInodeNumber({ value: 3n }), name: "same", targetType: "inode" },
      ],
      generation: {
        commitReference: commitReference(),
        directoryInodeNumber: createInodeNumber({ value: 9n }),
        inodeRevision: createInodeRevision({ value: 4n }),
        subvolumeId: createSubvolumeId({ value: 1n }),
      },
      maxEntries: 2,
      pin: readerPin({ release: duplicateRelease }),
      session,
    })).toThrowError(expect.objectContaining({ code: "duplicate_entry" }));
    expect(duplicateRelease).toHaveBeenCalledOnce();

    const invalidNameRelease = vi.fn();
    expect(() => new CapturedDirectoryIterator({
      entries: [
        { inodeKind: "file", inodeNumber: createInodeNumber({ value: 2n }), name: "invalid/name", targetType: "inode" },
      ],
      generation: {
        commitReference: commitReference(),
        directoryInodeNumber: createInodeNumber({ value: 9n }),
        inodeRevision: createInodeRevision({ value: 4n }),
        subvolumeId: createSubvolumeId({ value: 1n }),
      },
      maxEntries: 2,
      pin: readerPin({ release: invalidNameRelease }),
      session,
    })).toThrow();
    expect(invalidNameRelease).toHaveBeenCalledOnce();
  });

  it("rejects a reader pin for a different Commit generation", () => {
    const release = vi.fn();
    const session = new SessionLifecycle({ releaseResources: async () => undefined });
    expect(() => new CapturedDirectoryIterator({
      entries: [],
      generation: {
        commitReference: commitReference(),
        directoryInodeNumber: createInodeNumber({ value: 9n }),
        inodeRevision: createInodeRevision({ value: 4n }),
        subvolumeId: createSubvolumeId({ value: 1n }),
      },
      maxEntries: 2,
      pin: readerPin({ reference: differentCommitReference(), release }),
      session,
    })).toThrowError(expect.objectContaining({ code: "pin_generation_mismatch" }));
    expect(release).toHaveBeenCalledOnce();
  });
});
