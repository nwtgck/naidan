import { describe, expect, it, vi } from "vitest";
import {
  createHomeRecordReference,
  createInodeNumber,
  createUInt64,
  HIZOFS_V1_FORMAT_CONSTANTS,
  parseSegmentId,
  type HomeRecordReference,
} from "@/00-storage/service/hizofs/00-format";
import { ReadOnlyNamespaceValidationCache } from "@/00-storage/service/hizofs/filesystem/namespace-validation-cache";

function reference({ offset }: { offset: bigint }): HomeRecordReference {
  return createHomeRecordReference({ fields: {
    byteOffset: createUInt64({ value: offset }),
    frameLength: 128,
    recordKind: HIZOFS_V1_FORMAT_CONSTANTS.recordKinds.inode_table_page,
    segmentId: parseSegmentId({ bytes: new Uint8Array(16).fill(Number(offset % 251n) + 1) }),
  } });
}

describe("read-only namespace validation cache", () => {
  it("coalesces concurrent validation for one exact immutable root", async () => {
    const cache = new ReadOnlyNamespaceValidationCache({ maximumEntries: 4 });
    let release: (() => void) | undefined;
    const validate = vi.fn(async () => await new Promise<void>((resolve) => {
      release = resolve;
    }));
    const root = reference({ offset: 64n });

    const first = cache.validate({ kind: "inode_table", reference: root, validate });
    const second = cache.validate({ kind: "inode_table", reference: root, validate });
    await vi.waitFor(() => expect(validate).toHaveBeenCalledTimes(1));
    release?.();
    await expect(Promise.all([first, second])).resolves.toEqual([undefined, undefined]);
  });

  it("bounds distinct pending validations by cache capacity", async () => {
    const cache = new ReadOnlyNamespaceValidationCache({ maximumEntries: 1 });
    const first = reference({ offset: 128n });
    const second = reference({ offset: 192n });
    let releaseFirst: (() => void) | undefined;
    const firstValidation = vi.fn(async () => await new Promise<void>((resolve) => {
      releaseFirst = resolve;
    }));
    const secondValidation = vi.fn(async () => undefined);

    const firstPending = cache.validate({ kind: "inode_table", reference: first, validate: firstValidation });
    await vi.waitFor(() => expect(firstValidation).toHaveBeenCalledTimes(1));
    const secondPending = cache.validate({ kind: "inode_table", reference: second, validate: secondValidation });
    await Promise.resolve();
    expect(secondValidation).not.toHaveBeenCalled();

    releaseFirst?.();
    await expect(firstPending).resolves.toBeUndefined();
    await expect(secondPending).resolves.toBeUndefined();
    expect(secondValidation).toHaveBeenCalledTimes(1);
  });

  it("coalesces the same root after waiting for saturated capacity", async () => {
    const cache = new ReadOnlyNamespaceValidationCache({ maximumEntries: 1 });
    const blocker = reference({ offset: 256n });
    const waiting = reference({ offset: 320n });
    let releaseBlocker: (() => void) | undefined;
    const blockerValidation = vi.fn(async () => await new Promise<void>((resolve) => {
      releaseBlocker = resolve;
    }));
    const waitingValidation = vi.fn(async () => undefined);

    const blockerPending = cache.validate({ kind: "inode_table", reference: blocker, validate: blockerValidation });
    await vi.waitFor(() => expect(blockerValidation).toHaveBeenCalledTimes(1));
    const firstWaiting = cache.validate({ kind: "inode_table", reference: waiting, validate: waitingValidation });
    const secondWaiting = cache.validate({ kind: "inode_table", reference: waiting, validate: waitingValidation });
    await Promise.resolve();
    expect(waitingValidation).not.toHaveBeenCalled();

    releaseBlocker?.();
    await expect(Promise.all([blockerPending, firstWaiting, secondWaiting])).resolves.toEqual([
      undefined,
      undefined,
      undefined,
    ]);
    expect(waitingValidation).toHaveBeenCalledTimes(1);
  });

  it("admits a waiting root after saturated validation fails without sharing that failure", async () => {
    const cache = new ReadOnlyNamespaceValidationCache({ maximumEntries: 1 });
    const first = reference({ offset: 256n });
    const second = reference({ offset: 320n });
    const failure = new Error("invalid first tree");
    let rejectFirst: (() => void) | undefined;
    const firstValidation = vi.fn(async () => await new Promise<void>((_resolve, reject) => {
      rejectFirst = () => reject(failure);
    }));
    const secondValidation = vi.fn(async () => undefined);

    const firstPending = cache.validate({ kind: "inode_table", reference: first, validate: firstValidation });
    await vi.waitFor(() => expect(firstValidation).toHaveBeenCalledTimes(1));
    const secondPending = cache.validate({ kind: "inode_table", reference: second, validate: secondValidation });
    await Promise.resolve();
    expect(secondValidation).not.toHaveBeenCalled();

    rejectFirst?.();
    await expect(firstPending).rejects.toBe(failure);
    await expect(secondPending).resolves.toBeUndefined();
    expect(secondValidation).toHaveBeenCalledTimes(1);
  });

  it("does not retain failed validation", async () => {
    const cache = new ReadOnlyNamespaceValidationCache({ maximumEntries: 2 });
    const root = reference({ offset: 128n });
    const failure = new Error("invalid tree");

    await expect(cache.validate({
      kind: "inode_table",
      reference: root,
      validate: async () => {
        throw failure;
      },
    })).rejects.toBe(failure);
    const validate = vi.fn(async () => undefined);
    await expect(cache.validate({ kind: "inode_table", reference: root, validate })).resolves.toBeUndefined();
    expect(validate).toHaveBeenCalledTimes(1);
  });

  it("inherits a successor proof only from a completed exact base proof", async () => {
    const cache = new ReadOnlyNamespaceValidationCache({ maximumEntries: 4 });
    const base = reference({ offset: 192n });
    const successor = reference({ offset: 256n });
    const unrelatedSuccessor = reference({ offset: 320n });
    await cache.validate({ kind: "inode_table", reference: base, validate: async () => undefined });

    cache.inheritValidatedSuccessor({ baseReference: base, kind: "inode_table", successorReference: successor });
    const inheritedValidation = vi.fn(async () => undefined);
    await cache.validate({ kind: "inode_table", reference: successor, validate: inheritedValidation });
    expect(inheritedValidation).not.toHaveBeenCalled();

    cache.inheritValidatedSuccessor({
      baseReference: reference({ offset: 384n }),
      kind: "inode_table",
      successorReference: unrelatedSuccessor,
    });
    const ordinaryValidation = vi.fn(async () => undefined);
    await cache.validate({ kind: "inode_table", reference: unrelatedSuccessor, validate: ordinaryValidation });
    expect(ordinaryValidation).toHaveBeenCalledTimes(1);
  });

  it("coalesces one exact namespace-graph proof and binds it to the root inode", async () => {
    const cache = new ReadOnlyNamespaceValidationCache({ maximumEntries: 4 });
    const root = reference({ offset: 512n });
    const rootDirectoryInodeNumber = createInodeNumber({ value: 1n });
    const differentRootDirectoryInodeNumber = createInodeNumber({ value: 2n });
    const validate = vi.fn(async () => undefined);

    await cache.validateNamespaceGraph({
      inodeTableRootReference: root,
      rootDirectoryInodeNumber,
      validate,
    });
    await cache.validateNamespaceGraph({
      inodeTableRootReference: root,
      rootDirectoryInodeNumber,
      validate,
    });
    expect(validate).toHaveBeenCalledTimes(1);

    const differentRootValidation = vi.fn(async () => undefined);
    await cache.validateNamespaceGraph({
      inodeTableRootReference: root,
      rootDirectoryInodeNumber: differentRootDirectoryInodeNumber,
      validate: differentRootValidation,
    });
    expect(differentRootValidation).toHaveBeenCalledTimes(1);
  });

  it("inherits a namespace-graph proof only from a completed exact base proof", async () => {
    const cache = new ReadOnlyNamespaceValidationCache({ maximumEntries: 6 });
    const base = reference({ offset: 576n });
    const successor = reference({ offset: 640n });
    const unrelatedSuccessor = reference({ offset: 704n });
    const rootDirectoryInodeNumber = createInodeNumber({ value: 1n });
    const differentRootDirectoryInodeNumber = createInodeNumber({ value: 2n });
    await cache.validateNamespaceGraph({
      inodeTableRootReference: base,
      rootDirectoryInodeNumber,
      validate: async () => undefined,
    });

    cache.inheritValidatedNamespaceGraphSuccessor({
      baseInodeTableRootReference: base,
      baseRootDirectoryInodeNumber: rootDirectoryInodeNumber,
      successorInodeTableRootReference: successor,
      successorRootDirectoryInodeNumber: rootDirectoryInodeNumber,
    });
    const inheritedValidation = vi.fn(async () => undefined);
    await cache.validateNamespaceGraph({
      inodeTableRootReference: successor,
      rootDirectoryInodeNumber,
      validate: inheritedValidation,
    });
    expect(inheritedValidation).not.toHaveBeenCalled();

    cache.inheritValidatedNamespaceGraphSuccessor({
      baseInodeTableRootReference: base,
      baseRootDirectoryInodeNumber: differentRootDirectoryInodeNumber,
      successorInodeTableRootReference: unrelatedSuccessor,
      successorRootDirectoryInodeNumber: rootDirectoryInodeNumber,
    });
    const ordinaryValidation = vi.fn(async () => undefined);
    await cache.validateNamespaceGraph({
      inodeTableRootReference: unrelatedSuccessor,
      rootDirectoryInodeNumber,
      validate: ordinaryValidation,
    });
    expect(ordinaryValidation).toHaveBeenCalledTimes(1);

    const changedRootSuccessor = reference({ offset: 768n });
    cache.inheritValidatedNamespaceGraphSuccessor({
      baseInodeTableRootReference: base,
      baseRootDirectoryInodeNumber: rootDirectoryInodeNumber,
      successorInodeTableRootReference: changedRootSuccessor,
      successorRootDirectoryInodeNumber: differentRootDirectoryInodeNumber,
    });
    const changedRootValidation = vi.fn(async () => undefined);
    await cache.validateNamespaceGraph({
      inodeTableRootReference: changedRootSuccessor,
      rootDirectoryInodeNumber: differentRootDirectoryInodeNumber,
      validate: changedRootValidation,
    });
    expect(changedRootValidation).toHaveBeenCalledTimes(1);
  });

  it("inherits a File Extent proof only from an exact validated root and file size", async () => {
    const cache = new ReadOnlyNamespaceValidationCache({ maximumEntries: 6 });
    const base = reference({ offset: 592n });
    const successor = reference({ offset: 656n });
    await cache.validateFileExtentTree({
      fileSize: 10n,
      rootReference: base,
      validate: async () => undefined,
    });

    cache.inheritValidatedFileExtentTreeSuccessor({
      baseFileSize: 10n,
      baseRootReference: base,
      successorFileSize: 12n,
      successorRootReference: successor,
    });
    const inheritedValidation = vi.fn(async () => undefined);
    await cache.validateFileExtentTree({
      fileSize: 12n,
      rootReference: successor,
      validate: inheritedValidation,
    });
    expect(inheritedValidation).not.toHaveBeenCalled();

    const differentSizeValidation = vi.fn(async () => undefined);
    await cache.validateFileExtentTree({
      fileSize: 11n,
      rootReference: successor,
      validate: differentSizeValidation,
    });
    expect(differentSizeValidation).toHaveBeenCalledTimes(1);
  });

  it("binds allocator high-water proof to a completed exact Inode Table root only", async () => {
    const cache = new ReadOnlyNamespaceValidationCache({ maximumEntries: 4 });
    const root = reference({ offset: 640n });
    const maximumKnownInodeNumber = createInodeNumber({ value: 17n });

    cache.rememberInodeTableHighWaterProof({ maximumKnownInodeNumber, reference: root });
    expect(cache.inodeTableHighWaterProof({ reference: root })).toBeUndefined();

    await cache.validate({ kind: "inode_table", reference: root, validate: async () => undefined });
    cache.rememberInodeTableHighWaterProof({ maximumKnownInodeNumber, reference: root });
    expect(cache.inodeTableHighWaterProof({ reference: root })).toEqual({ maximumKnownInodeNumber });
    cache.rememberInodeTableHighWaterProof({
      maximumKnownInodeNumber: createInodeNumber({ value: 18n }),
      reference: root,
    });
    expect(cache.inodeTableHighWaterProof({ reference: root })).toBeUndefined();
  });

  it("does not infer allocator high-water proof for an inherited structural successor", async () => {
    const cache = new ReadOnlyNamespaceValidationCache({ maximumEntries: 4 });
    const base = reference({ offset: 704n });
    const successor = reference({ offset: 768n });
    const maximumKnownInodeNumber = createInodeNumber({ value: 23n });
    await cache.validate({ kind: "inode_table", reference: base, validate: async () => undefined });
    cache.rememberInodeTableHighWaterProof({ maximumKnownInodeNumber, reference: base });

    cache.inheritValidatedSuccessor({ baseReference: base, kind: "inode_table", successorReference: successor });
    expect(cache.inodeTableHighWaterProof({ reference: successor })).toBeUndefined();
  });

  it("drops allocator high-water proof when its bounded structural entry is evicted", async () => {
    const cache = new ReadOnlyNamespaceValidationCache({ maximumEntries: 1 });
    const first = reference({ offset: 832n });
    const second = reference({ offset: 896n });
    await cache.validate({ kind: "inode_table", reference: first, validate: async () => undefined });
    cache.rememberInodeTableHighWaterProof({
      maximumKnownInodeNumber: createInodeNumber({ value: 31n }),
      reference: first,
    });
    await cache.validate({ kind: "directory_tree", reference: second, validate: async () => undefined });

    expect(cache.inodeTableHighWaterProof({ reference: first })).toBeUndefined();
  });

  it("evicts completed proofs within the configured entry bound", async () => {
    const cache = new ReadOnlyNamespaceValidationCache({ maximumEntries: 2 });
    const first = reference({ offset: 448n });
    const second = reference({ offset: 512n });
    const third = reference({ offset: 576n });
    await cache.validate({ kind: "inode_table", reference: first, validate: async () => undefined });
    await cache.validate({ kind: "inode_table", reference: second, validate: async () => undefined });
    await cache.validate({ kind: "inode_table", reference: first, validate: async () => undefined });
    await cache.validate({ kind: "inode_table", reference: third, validate: async () => undefined });

    const secondValidation = vi.fn(async () => undefined);
    await cache.validate({ kind: "inode_table", reference: second, validate: secondValidation });
    expect(secondValidation).toHaveBeenCalledTimes(1);

    cache.clear();
    const firstAfterClear = vi.fn(async () => undefined);
    await cache.validate({ kind: "inode_table", reference: first, validate: firstAfterClear });
    expect(firstAfterClear).toHaveBeenCalledTimes(1);
  });
});
