import {
  HIZOFS_V1_FORMAT_CONSTANTS,
  createInodeNumber,
  decodeRequiredHomeRecordReference,
  writeHomeRecordReference,
  type HomeRecordReference,
  type InodeBranchPage,
  type InodeLeafPageIndex,
} from "@/00-storage/service/hizofs/00-format";
import type { AuthenticatedInodeBranchPageCache } from "@/00-storage/service/hizofs/authenticated-store/inode-table-page-store";
import { runtimeHomeRecordReferenceIdentity } from "@/00-storage/service/hizofs/authenticated-store/runtime-home-record-reference-identity";
import type { DecodedInodeIndexPageCacheDiagnosticsPort } from "@/00-storage/service/hizofs/diagnostics/decoded-inode-index-page-cache-diagnostics";

const RECORD_REFERENCE_BYTES = HIZOFS_V1_FORMAT_CONSTANTS.fixedSizes.recordReference;

type LeafCacheEntry = Readonly<{
  bytes: number;
  index: InodeLeafPageIndex;
  type: "leaf_index";
}>;

type RetainedBranchRouting = Readonly<{
  level: number;
  references: Uint8Array;
  upperBounds: BigUint64Array;
}>;

type BranchCacheEntry = Readonly<{
  bytes: number;
  routing: RetainedBranchRouting;
  type: "branch";
}>;

type CacheEntry = BranchCacheEntry | LeafCacheEntry;

function identity({ isRoot, reference }: { isRoot: boolean; reference: HomeRecordReference }): string {
  return `${isRoot ? "root" : "non_root"}:${runtimeHomeRecordReferenceIdentity({ reference })}`;
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

function retainBranchRouting({ page }: { page: InodeBranchPage }): RetainedBranchRouting {
  const references = new Uint8Array(page.entries.length * RECORD_REFERENCE_BYTES);
  const upperBounds = new BigUint64Array(page.entries.length);
  for (let index = 0; index < page.entries.length; index += 1) {
    const entry = page.entries[index];
    if (entry === undefined) throw new Error("Inode branch cache entry index invariant failed");
    writeHomeRecordReference({
      bytes: references,
      offset: index * RECORD_REFERENCE_BYTES,
      reference: entry.childPageHomeRef,
    });
    upperBounds[index] = entry.upperBound;
  }
  return Object.freeze({ level: page.level, references, upperBounds });
}

function cloneBranchPage({ routing }: { routing: RetainedBranchRouting }): InodeBranchPage {
  const entries = Array.from({ length: routing.upperBounds.length }, (_, index) => {
    const offset = index * RECORD_REFERENCE_BYTES;
    return Object.freeze({
      childPageHomeRef: decodeRequiredHomeRecordReference({
        bytes: routing.references.subarray(offset, offset + RECORD_REFERENCE_BYTES),
      }),
      upperBound: createInodeNumber({ value: routing.upperBounds[index] ?? 0n }),
    });
  });
  return Object.freeze({ entries: Object.freeze(entries), level: routing.level });
}

function clearBranchRouting({ routing }: { routing: RetainedBranchRouting }): void {
  routing.references.fill(0);
  routing.upperBounds.fill(0n);
}

function branchBytes({ routing }: { routing: RetainedBranchRouting }): number {
  return routing.references.byteLength + routing.upperBounds.byteLength;
}

function clearEntry({ entry }: { entry: CacheEntry }): void {
  switch (entry.type) {
  case "branch": clearBranchRouting({ routing: entry.routing }); return;
  case "leaf_index": clearIndex({ index: entry.index }); return;
  default: return entry satisfies never;
  }
}

/**
 * Retains only bounded Inode-index routing metadata, never decoded inode bodies.
 * Branch routing is held in compact zeroizable typed arrays and reconstructed
 * into detached immutable objects on lookup, so eviction cannot invalidate an
 * in-flight traversal.
 */
export class DecodedInodeIndexPageCache implements AuthenticatedInodeBranchPageCache {
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
      throw new RangeError("decoded Inode index-page cache maximum entries must be non-negative");
    }
    this.diagnostics = diagnostics;
    this.maximumEntries = maximumEntries;
    this.report();
  }

  getLeafIndex({ isRoot, reference }: {
    isRoot: boolean;
    reference: HomeRecordReference;
  }): InodeLeafPageIndex | undefined {
    if (this.disposed) throw new TypeError("decoded Inode index-page cache is disposed");
    const key = identity({ isRoot, reference });
    const entry = this.entries.get(key);
    if (entry === undefined) {
      this.diagnostics?.recordDecodedInodeIndexPageCacheEvent({ event: "miss" });
      return undefined;
    }
    switch (entry.type) {
    case "branch":
      this.diagnostics?.recordDecodedInodeIndexPageCacheEvent({ event: "miss" });
      return undefined;
    case "leaf_index":
      this.touch({ entry, key });
      this.diagnostics?.recordDecodedInodeIndexPageCacheEvent({ event: "hit" });
      return entry.index;
    default: return entry satisfies never;
    }
  }

  setLeafIndex({ index, isRoot, pageBytes, reference }: {
    index: InodeLeafPageIndex;
    isRoot: boolean;
    pageBytes: number;
    reference: HomeRecordReference;
  }): InodeLeafPageIndex {
    if (this.disposed) throw new TypeError("decoded Inode index-page cache is disposed");
    const bytes = indexBytes({ index });
    this.diagnostics?.recordInodeLeafLookup({ observation: {
      event: "index_build",
      indexBytes: bytes,
      indexedEntries: index.inodeNumbers.length,
      pageBytes,
    } });
    if (this.maximumEntries === 0) return index;
    const retained = cloneIndex({ index });
    this.replace({ entry: { bytes, index: retained, type: "leaf_index" }, isRoot, reference });
    return retained;
  }

  getBranchPage({ isRoot, reference }: {
    isRoot: boolean;
    reference: HomeRecordReference;
  }): InodeBranchPage | undefined {
    if (this.disposed) throw new TypeError("decoded Inode index-page cache is disposed");
    const key = identity({ isRoot, reference });
    const entry = this.entries.get(key);
    if (entry === undefined) return undefined;
    switch (entry.type) {
    case "branch":
      this.touch({ entry, key });
      // Existing cache hit/miss diagnostics intentionally remain leaf-index
      // metrics so this optimization does not make the historical leaf-cache series
      // incomparable. Branch effectiveness is measured by branchPageDecodes.
      return cloneBranchPage({ routing: entry.routing });
    case "leaf_index": return undefined;
    default: return entry satisfies never;
    }
  }

  setBranchPage({ isRoot, page, reference }: {
    isRoot: boolean;
    page: InodeBranchPage;
    reference: HomeRecordReference;
  }): void {
    if (this.disposed) throw new TypeError("decoded Inode index-page cache is disposed");
    if (this.maximumEntries === 0) return;
    const routing = retainBranchRouting({ page });
    this.replace({
      entry: { bytes: branchBytes({ routing }), routing, type: "branch" },
      isRoot,
      reference,
    });
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const entry of this.entries.values()) clearEntry({ entry });
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

  private replace({ entry, isRoot, reference }: {
    entry: CacheEntry;
    isRoot: boolean;
    reference: HomeRecordReference;
  }): void {
    const key = identity({ isRoot, reference });
    const existing = this.entries.get(key);
    if (existing !== undefined) {
      this.entries.delete(key);
      this.bytes -= existing.bytes;
      clearEntry({ entry: existing });
    }
    while (this.entries.size >= this.maximumEntries) {
      const oldest = this.entries.entries().next().value as [string, CacheEntry] | undefined;
      if (oldest === undefined) break;
      this.entries.delete(oldest[0]);
      this.bytes -= oldest[1].bytes;
      clearEntry({ entry: oldest[1] });
      this.diagnostics?.recordDecodedInodeIndexPageCacheEvent({ event: "eviction" });
    }
    this.entries.set(key, entry);
    this.bytes += entry.bytes;
    this.report();
  }

  private touch({ entry, key }: { entry: CacheEntry; key: string }): void {
    this.entries.delete(key);
    this.entries.set(key, entry);
  }

  private report(): void {
    this.diagnostics?.setDecodedInodeIndexPageCacheUsage({ bytes: this.bytes, entries: this.entries.size });
  }
}

export const TEST_ONLY = {
  branchBytes,
  clearBranchRouting,
  clearIndex,
  cloneBranchPage,
  identity,
  retainBranchRouting,
};
