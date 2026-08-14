import { describe, expect, it } from "vitest";
import {
  createHomeRecordReference,
  createInodeNumber,
  createSubvolumeId,
  createUInt64,
  encodeDirectoryPage,
  encodeFilenameComponent,
  HIZOFS_V1_FORMAT_CONSTANTS,
  parseSegmentId,
  type DirectoryPage,
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

function setPage({ cache, isRoot, page, reference: pageReference }: {
  cache: DecodedDirectoryPageIndexCache;
  isRoot: boolean;
  page: DirectoryPage;
  reference: HomeRecordReference;
}): void {
  cache.setPage({
    encodedByteLength: encodeDirectoryPage({ isRoot, page }).byteLength,
    isRoot,
    page,
    reference: pageReference,
  });
}

describe("decoded Directory page index cache", () => {
  it("selects exact leaf entries without retaining decoded filename objects", () => {
    const cache = new DecodedDirectoryPageIndexCache({ maximumBytes: 4096, maximumEntries: 2 });
    const root = reference({ offset: 64n });
    setPage({
      cache,
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
    setPage({
      cache,
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
    setPage({
      cache,
      isRoot: true,
      page: { entries: [{ childPageHomeRef: child, upperBoundName: "z" }], level: 1, type: "branch" },
      reference: root,
    });
    child.segmentId.fill(0xff);
    const point = cache.getPoint({ isRoot: true, key: key("a"), reference: root });
    expect(point?.type).toBe("branch");
    if (point?.type !== "branch") throw new Error("branch cache fixture did not produce a branch point");
    expect(point.childPageReference.segmentId.every(byte => byte !== 0xff)).toBe(true);

    const retainedPage: DirectoryPage = {
      entries: [{ inodeKind: "directory", inodeNumber: createInodeNumber({ value: 7n }), name: "secret", targetType: "inode" }],
      level: 0,
      type: "leaf",
    };
    const retained = TEST_ONLY.retainPage({
      encodedByteLength: encodeDirectoryPage({ isRoot: true, page: retainedPage }).byteLength,
      page: retainedPage,
    });
    TEST_ONLY.clearPage({ page: retained });
    expect([...retained.names.bytes]).toEqual(new Array(retained.names.bytes.length).fill(0));
    if (retained.type !== "leaf") throw new Error("leaf cache fixture did not retain a leaf");
    expect([...retained.ids]).toEqual([0n]);
  });

  it("refuses an entry that exceeds the configured byte budget", () => {
    const cache = new DecodedDirectoryPageIndexCache({ maximumBytes: 1, maximumEntries: 1 });
    const root = reference({ offset: 448n });
    setPage({
      cache,
      isRoot: true,
      page: { entries: [{ inodeKind: "file", inodeNumber: createInodeNumber({ value: 2n }), name: "alpha", targetType: "inode" }], level: 0, type: "leaf" },
      reference: root,
    });
    expect(cache.getPoint({ isRoot: true, key: key("alpha"), reference: root })).toBeUndefined();
  });
  it("restores an exact validated leaf page with its authenticated encoded length", () => {
    const cache = new DecodedDirectoryPageIndexCache({ maximumBytes: 4096, maximumEntries: 2 });
    const root = reference({ offset: 512n });
    const page: DirectoryPage = {
      entries: [
        { inodeKind: "directory", inodeNumber: createInodeNumber({ value: 7n }), name: "alpha", targetType: "inode" },
        { name: "beta", subvolumeId: createSubvolumeId({ value: 9n }), targetType: "subvolume" },
      ],
      level: 0,
      type: "leaf",
    };
    const encodedByteLength = encodeDirectoryPage({ isRoot: true, page }).byteLength;
    cache.setPage({ encodedByteLength, isRoot: true, page, reference: root });

    expect(cache.getPageForUpdate({ isRoot: true, reference: root })).toEqual({
      encodedByteLength,
      localStructureValidated: true,
      page,
    });
  });

  it("restores an exact validated branch page from retained routing data", () => {
    const cache = new DecodedDirectoryPageIndexCache({ maximumBytes: 4096, maximumEntries: 2 });
    const root = reference({ offset: 576n });
    const page: DirectoryPage = {
      entries: [
        { childPageHomeRef: reference({ offset: 640n }), upperBoundName: "m" },
        { childPageHomeRef: reference({ offset: 704n }), upperBoundName: "z" },
      ],
      level: 1,
      type: "branch",
    };
    const encodedByteLength = encodeDirectoryPage({ isRoot: true, page }).byteLength;
    cache.setPage({ encodedByteLength, isRoot: true, page, reference: root });

    expect(cache.getPageForUpdate({ isRoot: true, reference: root })).toEqual({
      encodedByteLength,
      localStructureValidated: true,
      page,
    });
  });

  it("keeps prepared page admissions invisible until commit and drops discarded admissions", () => {
    const cache = new DecodedDirectoryPageIndexCache({ maximumBytes: 4096, maximumEntries: 2 });
    const root = reference({ offset: 768n });
    const page: DirectoryPage = {
      entries: [{ inodeKind: "file", inodeNumber: createInodeNumber({ value: 3n }), name: "pending", targetType: "inode" }],
      level: 0,
      type: "leaf",
    };
    const encodedByteLength = encodeDirectoryPage({ isRoot: true, page }).byteLength;
    const admission = cache.preparePageAdmission({ encodedByteLength, isRoot: true, page, reference: root });
    expect(cache.getPageForUpdate({ isRoot: true, reference: root })).toBeUndefined();
    admission.commit();
    expect(cache.getPageForUpdate({ isRoot: true, reference: root })).toEqual({
      encodedByteLength,
      localStructureValidated: true,
      page,
    });

    const discardedRoot = reference({ offset: 832n });
    const discarded = cache.preparePageAdmission({
      encodedByteLength,
      isRoot: true,
      page,
      reference: discardedRoot,
    });
    discarded.discard();
    expect(cache.getPageForUpdate({ isRoot: true, reference: discardedRoot })).toBeUndefined();
  });

  it("keeps pending durable admissions inside the configured entry budget", () => {
    const cache = new DecodedDirectoryPageIndexCache({ maximumBytes: 4096, maximumEntries: 1 });
    const page: DirectoryPage = {
      entries: [{ inodeKind: "file", inodeNumber: createInodeNumber({ value: 5n }), name: "bounded", targetType: "inode" }],
      level: 0,
      type: "leaf",
    };
    const encodedByteLength = encodeDirectoryPage({ isRoot: true, page }).byteLength;
    const firstReference = reference({ offset: 960n });
    const secondReference = reference({ offset: 1024n });
    const first = cache.preparePageAdmission({ encodedByteLength, isRoot: true, page, reference: firstReference });
    const second = cache.preparePageAdmission({ encodedByteLength, isRoot: true, page, reference: secondReference });

    second.commit();
    expect(cache.getPageForUpdate({ isRoot: true, reference: secondReference })).toBeUndefined();
    first.commit();
    expect(cache.getPageForUpdate({ isRoot: true, reference: firstReference })?.page).toEqual(page);
  });

  it("derives compact admission bytes exactly from canonical encoded page lengths", () => {
    const pages: DirectoryPage[] = [
      {
        entries: [
          { inodeKind: "file", inodeNumber: createInodeNumber({ value: 11n }), name: "alpha", targetType: "inode" },
          { name: "日本語", subvolumeId: createSubvolumeId({ value: 12n }), targetType: "subvolume" },
        ],
        level: 0,
        type: "leaf",
      },
      {
        entries: [
          { childPageHomeRef: reference({ offset: 1216n }), upperBoundName: "m" },
          { childPageHomeRef: reference({ offset: 1280n }), upperBoundName: "😀z" },
        ],
        level: 1,
        type: "branch",
      },
    ];

    for (const page of pages) {
      const encodedByteLength = encodeDirectoryPage({ isRoot: true, page }).byteLength;
      const retained = TEST_ONLY.retainPage({ encodedByteLength, page });
      try {
        expect(TEST_ONLY.plannedRetainedBytes({ encodedByteLength, page })).toBe(
          TEST_ONLY.retainedBytes({ page: retained }),
        );
      } finally {
        TEST_ONLY.clearPage({ page: retained });
      }
    }
  });

  it("keeps pending durable admissions inside the configured byte budget", () => {
    const page: DirectoryPage = {
      entries: [{ inodeKind: "file", inodeNumber: createInodeNumber({ value: 6n }), name: "byte-bounded", targetType: "inode" }],
      level: 0,
      type: "leaf",
    };
    const encodedByteLength = encodeDirectoryPage({ isRoot: true, page }).byteLength;
    const maximumBytes = TEST_ONLY.plannedRetainedBytes({ encodedByteLength, page });
    const cache = new DecodedDirectoryPageIndexCache({ maximumBytes, maximumEntries: 2 });
    const firstReference = reference({ offset: 1088n });
    const secondReference = reference({ offset: 1152n });
    const first = cache.preparePageAdmission({ encodedByteLength, isRoot: true, page, reference: firstReference });
    const second = cache.preparePageAdmission({ encodedByteLength, isRoot: true, page, reference: secondReference });

    second.commit();
    expect(cache.getPageForUpdate({ isRoot: true, reference: secondReference })).toBeUndefined();
    first.commit();
    expect(cache.getPageForUpdate({ isRoot: true, reference: firstReference })?.page).toEqual(page);
  });

  it("discards a pending admission when the cache is disposed before commit", () => {
    const cache = new DecodedDirectoryPageIndexCache({ maximumBytes: 4096, maximumEntries: 2 });
    const root = reference({ offset: 896n });
    const page: DirectoryPage = {
      entries: [{ inodeKind: "file", inodeNumber: createInodeNumber({ value: 4n }), name: "disposed", targetType: "inode" }],
      level: 0,
      type: "leaf",
    };
    const admission = cache.preparePageAdmission({
      encodedByteLength: encodeDirectoryPage({ isRoot: true, page }).byteLength,
      isRoot: true,
      page,
      reference: root,
    });
    cache.dispose();
    expect(() => admission.commit()).not.toThrow();
    expect(() => admission.discard()).not.toThrow();
  });

});
