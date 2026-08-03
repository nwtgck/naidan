import { describe, expect, it, vi } from "vitest";
import {
  createHomeRecordReference,
  createUInt64,
  HIZOFS_V1_FORMAT_CONSTANTS,
  parseSegmentId,
  type HomeRecordReference,
  type InodeLeafPageIndex,
} from "@/00-storage/service/hizofs/00-format";
import { DecodedInodeLeafPageIndexCache } from "@/00-storage/service/hizofs/filesystem/decoded-inode-leaf-page-index-cache";

function reference({ offset }: { offset: bigint }): HomeRecordReference {
  return createHomeRecordReference({ fields: {
    byteOffset: createUInt64({ value: offset }),
    frameLength: 128,
    recordKind: HIZOFS_V1_FORMAT_CONSTANTS.recordKinds.inode_table_page,
    segmentId: parseSegmentId({ bytes: new Uint8Array(16).fill(Number(offset % 251n) + 1) }),
  } });
}

function index({ value }: { value: bigint }): InodeLeafPageIndex {
  return {
    entryLengths: Uint32Array.of(40),
    entryOffsets: Uint32Array.of(16),
    inodeNumbers: BigUint64Array.of(value),
  };
}

describe("decoded Inode leaf-page index cache", () => {
  it("retains detached zeroizable numeric routing metadata", () => {
    const cache = new DecodedInodeLeafPageIndexCache({ maximumEntries: 2 });
    const root = reference({ offset: 64n });
    const source = index({ value: 3n });
    const retained = cache.set({ index: source, isRoot: true, pageBytes: 128, reference: root });
    source.inodeNumbers.fill(99n);
    expect(retained.inodeNumbers[0]).toBe(3n);
    expect(cache.get({ isRoot: true, reference: root })?.inodeNumbers[0]).toBe(3n);
  });

  it("evicts within the configured entry bound and reports aggregates", () => {
    const event = vi.fn();
    const lookup = vi.fn();
    const usage = vi.fn();
    const cache = new DecodedInodeLeafPageIndexCache({
      diagnostics: {
        recordDecodedInodeIndexPageCacheEvent: event,
        recordInodeLeafLookup: lookup,
        setDecodedInodeIndexPageCacheUsage: usage,
      },
      maximumEntries: 1,
    });
    const first = reference({ offset: 128n });
    const second = reference({ offset: 192n });
    cache.set({ index: index({ value: 1n }), isRoot: true, pageBytes: 128, reference: first });
    cache.set({ index: index({ value: 2n }), isRoot: true, pageBytes: 128, reference: second });
    expect(cache.get({ isRoot: true, reference: first })).toBeUndefined();
    expect(cache.get({ isRoot: true, reference: second })).toBeDefined();
    cache.recordSelectiveEntryHit({ entryBytes: 40, pageBytes: 128 });
    cache.recordSelectiveEntryMiss({ pageBytes: 128 });
    cache.recordBranchPageDecode({ pageBytes: 256 });
    expect(event).toHaveBeenCalledWith({ event: "eviction" });
    expect(event).toHaveBeenCalledWith({ event: "miss" });
    expect(event).toHaveBeenCalledWith({ event: "hit" });
    expect(usage).toHaveBeenLastCalledWith({ bytes: 16, entries: 1 });
    expect(lookup).toHaveBeenCalledWith({ observation: {
      event: "index_build",
      indexBytes: 16,
      indexedEntries: 1,
      pageBytes: 128,
    } });
    expect(lookup).toHaveBeenCalledWith({ observation: {
      entryBytes: 40,
      event: "selective_entry_hit",
      pageBytes: 128,
    } });
    expect(lookup).toHaveBeenCalledWith({ observation: {
      event: "selective_entry_miss",
      pageBytes: 128,
    } });
    expect(lookup).toHaveBeenCalledWith({ observation: {
      event: "branch_page_decode",
      pageBytes: 256,
    } });
  });

  it("zeroes retained typed arrays on disposal", () => {
    const cache = new DecodedInodeLeafPageIndexCache({ maximumEntries: 1 });
    const retained = cache.set({ index: index({ value: 7n }), isRoot: true, pageBytes: 128, reference: reference({ offset: 256n }) });
    cache.dispose();
    expect([...retained.entryLengths]).toEqual([0]);
    expect([...retained.entryOffsets]).toEqual([0]);
    expect([...retained.inodeNumbers]).toEqual([0n]);
  });
});
