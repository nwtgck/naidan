import {
  encodeHomeRecordReference,
  type HomeRecordReference,
  type InodeLeafPageIndex,
} from "@/00-storage/service/hizofs/00-format";
import type { DecodedInodeIndexPageCacheDiagnosticsPort } from "@/00-storage/service/hizofs/diagnostics/decoded-inode-index-page-cache-diagnostics";

type CacheEntry = Readonly<{
  bytes: number;
  index: InodeLeafPageIndex;
}>;

function identity({ isRoot, reference }: { isRoot: boolean; reference: HomeRecordReference }): string {
  let value = isRoot ? "root:" : "non_root:";
  for (const byte of encodeHomeRecordReference({ reference })) value += byte.toString(16).padStart(2, "0");
  return value;
}

function cloneIndex({ index }: { index: InodeLeafPageIndex }): InodeLeafPageIndex {
  return {
    entryLengths: index.entryLengths.slice(),
    entryOffsets: index.entryOffsets.slice(),
    inodeNumbers: index.inodeNumbers.slice(),
  };
}

function clearIndex({ index }: { index: InodeLeafPageIndex }): void {
  index.entryLengths.fill(0);
  index.entryOffsets.fill(0);
  index.inodeNumbers.fill(0n);
}

function indexBytes({ index }: { index: InodeLeafPageIndex }): number {
  return index.entryLengths.byteLength + index.entryOffsets.byteLength + index.inodeNumbers.byteLength;
}

/** Retains only zeroizable numeric routing metadata, never decoded inode bodies. */
export class DecodedInodeLeafPageIndexCache {
  private readonly diagnostics: DecodedInodeIndexPageCacheDiagnosticsPort | undefined;
  private readonly entries = new Map<string, CacheEntry>();
  private readonly maximumEntries: number;
  private bytes = 0;
  private disposed = false;

  constructor({ diagnostics, maximumEntries }: {
    diagnostics?: DecodedInodeIndexPageCacheDiagnosticsPort;
    maximumEntries: number;
  }) {
    if (!Number.isSafeInteger(maximumEntries) || maximumEntries < 0) {
      throw new RangeError("decoded Inode leaf-page index cache maximum entries must be non-negative");
    }
    this.diagnostics = diagnostics;
    this.maximumEntries = maximumEntries;
    this.report();
  }

  get({ isRoot, reference }: { isRoot: boolean; reference: HomeRecordReference }): InodeLeafPageIndex | undefined {
    if (this.disposed) throw new TypeError("decoded Inode leaf-page index cache is disposed");
    const key = identity({ isRoot, reference });
    const entry = this.entries.get(key);
    if (entry === undefined) {
      this.diagnostics?.recordDecodedInodeIndexPageCacheEvent({ event: "miss" });
      return undefined;
    }
    this.entries.delete(key);
    this.entries.set(key, entry);
    this.diagnostics?.recordDecodedInodeIndexPageCacheEvent({ event: "hit" });
    return entry.index;
  }

  set({ index, isRoot, pageBytes, reference }: {
    index: InodeLeafPageIndex;
    isRoot: boolean;
    pageBytes: number;
    reference: HomeRecordReference;
  }): InodeLeafPageIndex {
    if (this.disposed) throw new TypeError("decoded Inode leaf-page index cache is disposed");
    const bytes = indexBytes({ index });
    this.diagnostics?.recordInodeLeafLookup({ observation: {
      event: "index_build",
      indexBytes: bytes,
      indexedEntries: index.inodeNumbers.length,
      pageBytes,
    } });
    if (this.maximumEntries === 0) return index;
    const key = identity({ isRoot, reference });
    const existing = this.entries.get(key);
    if (existing !== undefined) {
      this.entries.delete(key);
      this.bytes -= existing.bytes;
      clearIndex({ index: existing.index });
    }
    while (this.entries.size >= this.maximumEntries) {
      const oldest = this.entries.entries().next().value as [string, CacheEntry] | undefined;
      if (oldest === undefined) break;
      this.entries.delete(oldest[0]);
      this.bytes -= oldest[1].bytes;
      clearIndex({ index: oldest[1].index });
      this.diagnostics?.recordDecodedInodeIndexPageCacheEvent({ event: "eviction" });
    }
    const retained = cloneIndex({ index });
    this.entries.set(key, { bytes, index: retained });
    this.bytes += bytes;
    this.report();
    return retained;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const entry of this.entries.values()) clearIndex({ index: entry.index });
    this.entries.clear();
    this.bytes = 0;
    this.report();
  }

  recordBranchPageDecode({ pageBytes }: { pageBytes: number }): void {
    this.diagnostics?.recordInodeLeafLookup({ observation: { event: "branch_page_decode", pageBytes } });
  }

  recordSelectiveEntryHit({ entryBytes, pageBytes }: { entryBytes: number; pageBytes: number }): void {
    this.diagnostics?.recordInodeLeafLookup({ observation: {
      entryBytes,
      event: "selective_entry_hit",
      pageBytes,
    } });
  }

  recordSelectiveEntryMiss({ pageBytes }: { pageBytes: number }): void {
    this.diagnostics?.recordInodeLeafLookup({ observation: { event: "selective_entry_miss", pageBytes } });
  }

  private report(): void {
    this.diagnostics?.setDecodedInodeIndexPageCacheUsage({ bytes: this.bytes, entries: this.entries.size });
  }
}

export const TEST_ONLY = {
  clearIndex,
  identity,
};
