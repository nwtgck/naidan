import { describe, expect, it, vi } from "vitest";
import {
  createHomeRecordReference,
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
