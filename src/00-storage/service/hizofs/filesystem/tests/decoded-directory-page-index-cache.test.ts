import { describe, expect, it } from "vitest";
import {
  createHomeRecordReference,
  createInodeNumber,
  createSubvolumeId,
  createUInt64,
  encodeFilenameComponent,
  HIZOFS_V1_FORMAT_CONSTANTS,
  parseSegmentId,
  type HomeRecordReference,
} from "@/00-storage/service/hizofs/00-format";
import {
  DecodedDirectoryPageIndexCache,
  TEST_ONLY,
} from "@/00-storage/service/hizofs/filesystem/decoded-directory-page-index-cache";

function reference({ offset }: { offset: bigint }): HomeRecordReference {
  return createHomeRecordReference({ fields: {
    byteOffset: createUInt64({ value: offset }),
    frameLength: 128,
    recordKind: HIZOFS_V1_FORMAT_CONSTANTS.recordKinds.directory_page,
    segmentId: parseSegmentId({ bytes: new Uint8Array(16).fill(Number(offset % 251n) + 1) }),
  } });
}

function key(value: string): Uint8Array {
  return encodeFilenameComponent({ value });
}

describe("decoded Directory page index cache", () => {
  it("selects exact leaf entries without retaining decoded filename objects", () => {
    const cache = new DecodedDirectoryPageIndexCache({ maximumBytes: 4096, maximumEntries: 2 });
    const root = reference({ offset: 64n });
    cache.setPage({
      isRoot: true,
      page: {
        entries: [
          { inodeKind: "file", inodeNumber: createInodeNumber({ value: 2n }), name: "alpha", targetType: "inode" },
          { name: "beta", subvolumeId: createSubvolumeId({ value: 3n }), targetType: "subvolume" },
        ],
        level: 0,
        type: "leaf",
      },
      reference: root,
    });

    expect(cache.getPoint({ isRoot: true, key: key("alpha"), reference: root })).toEqual({
      entry: { inodeKind: "file", inodeNumber: 2n, name: "alpha", targetType: "inode" },
      type: "leaf",
    });
    expect(cache.getPoint({ isRoot: true, key: key("beta"), reference: root })).toEqual({
      entry: { name: "beta", subvolumeId: 3n, targetType: "subvolume" },
      type: "leaf",
    });
    expect(cache.getPoint({ isRoot: true, key: key("gamma"), reference: root })).toEqual({
      entry: undefined,
      type: "leaf",
    });
  });

  it("selects the first branch upper bound that covers the lookup key", () => {
    const cache = new DecodedDirectoryPageIndexCache({ maximumBytes: 4096, maximumEntries: 2 });
    const root = reference({ offset: 128n });
    const first = reference({ offset: 192n });
    const second = reference({ offset: 256n });
    cache.setPage({
      isRoot: true,
      page: {
        entries: [
          { childPageHomeRef: first, upperBoundName: "m" },
          { childPageHomeRef: second, upperBoundName: "z" },
        ],
        level: 1,
        type: "branch",
      },
      reference: root,
    });

    expect(cache.getPoint({ isRoot: true, key: key("a"), reference: root })).toEqual({
      childPageReference: first,
      level: 1,
      type: "branch",
    });
    expect(cache.getPoint({ isRoot: true, key: key("m"), reference: root })).toEqual({
      childPageReference: first,
      level: 1,
      type: "branch",
    });
    expect(cache.getPoint({ isRoot: true, key: key("n"), reference: root })).toEqual({
      childPageReference: second,
      level: 1,
      type: "branch",
    });
    expect(cache.getPoint({ isRoot: true, key: key("zz"), reference: root })).toEqual({
      level: 1,
      type: "absent",
    });
  });

  it("copies branch references and zeroizes retained typed arrays", () => {
    const cache = new DecodedDirectoryPageIndexCache({ maximumBytes: 4096, maximumEntries: 1 });
    const root = reference({ offset: 320n });
    const child = reference({ offset: 384n });
    cache.setPage({
      isRoot: true,
      page: { entries: [{ childPageHomeRef: child, upperBoundName: "z" }], level: 1, type: "branch" },
      reference: root,
    });
    child.segmentId.fill(0xff);
    const point = cache.getPoint({ isRoot: true, key: key("a"), reference: root });
    expect(point?.type).toBe("branch");
    if (point?.type !== "branch") throw new Error("branch cache fixture did not produce a branch point");
    expect(point.childPageReference.segmentId.every(byte => byte !== 0xff)).toBe(true);

    const retained = TEST_ONLY.retainPage({
      page: { entries: [{ inodeKind: "directory", inodeNumber: createInodeNumber({ value: 7n }), name: "secret", targetType: "inode" }], level: 0, type: "leaf" },
    });
    TEST_ONLY.clearPage({ page: retained });
    expect([...retained.names.bytes]).toEqual(new Array(retained.names.bytes.length).fill(0));
    if (retained.type !== "leaf") throw new Error("leaf cache fixture did not retain a leaf");
    expect([...retained.ids]).toEqual([0n]);
  });

  it("refuses an entry that exceeds the configured byte budget", () => {
    const cache = new DecodedDirectoryPageIndexCache({ maximumBytes: 1, maximumEntries: 1 });
    const root = reference({ offset: 448n });
    cache.setPage({
      isRoot: true,
      page: { entries: [{ inodeKind: "file", inodeNumber: createInodeNumber({ value: 2n }), name: "alpha", targetType: "inode" }], level: 0, type: "leaf" },
      reference: root,
    });
    expect(cache.getPoint({ isRoot: true, key: key("alpha"), reference: root })).toBeUndefined();
  });
});
