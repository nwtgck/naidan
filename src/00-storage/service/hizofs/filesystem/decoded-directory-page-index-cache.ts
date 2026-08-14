import {
  compareUnsignedBytes,
  createInodeNumber,
  createSubvolumeId,
  decodeFilenameComponent,
  decodeRequiredHomeRecordReference,
  writeFilenameComponent,
  writeHomeRecordReference,
  HIZOFS_V1_FORMAT_CONSTANTS,
  type DirectoryLeafEntry,
  type DirectoryPage,
  type HomeRecordReference,
  type InodeKind,
} from "@/00-storage/service/hizofs/00-format";
import { runtimeHomeRecordReferenceIdentity } from "@/00-storage/service/hizofs/authenticated-store/runtime-home-record-reference-identity";

const RECORD_REFERENCE_BYTES = HIZOFS_V1_FORMAT_CONSTANTS.fixedSizes.recordReference;
const TARGET_INODE = 1;
const TARGET_SUBVOLUME = 2;
const INODE_KIND_FILE = 1;
const INODE_KIND_DIRECTORY = 2;
const INODE_KIND_SYMLINK = 3;

type RetainedNames = Readonly<{
  bytes: Uint8Array;
  lengths: Uint16Array;
  offsets: Uint32Array;
}>;

type RetainedLeaf = Readonly<{
  ids: BigUint64Array;
  inodeKinds: Uint8Array;
  names: RetainedNames;
  targetTypes: Uint8Array;
  type: "leaf";
}>;

type RetainedBranch = Readonly<{
  level: number;
  names: RetainedNames;
  references: Uint8Array;
  type: "branch";
}>;

type RetainedPage = RetainedBranch | RetainedLeaf;

type RetainedCacheEntry = Readonly<{
  bytes: number;
  encodedByteLength: number;
  page: RetainedPage;
}>;

export type DirectoryPointPage = Readonly<
  | { level: number; type: "absent" }
  | { childPageReference: HomeRecordReference; level: number; type: "branch" }
  | { entry: DirectoryLeafEntry | undefined; type: "leaf" }
>;

function identity({ isRoot, reference }: { isRoot: boolean; reference: HomeRecordReference }): string {
  return `${isRoot ? "root" : "non_root"}:${runtimeHomeRecordReferenceIdentity({ reference })}`;
}

function encodeNames({ totalBytes, values }: { totalBytes: number; values: readonly string[] }): RetainedNames {
  if (!Number.isSafeInteger(totalBytes) || totalBytes < 0) {
    throw new RangeError("Directory page index retained filename bytes must be a non-negative safe integer");
  }
  const lengths = new Uint16Array(values.length);
  const offsets = new Uint32Array(values.length);
  const bytes = new Uint8Array(totalBytes);
  let offset = 0;
  try {
    for (let index = 0; index < values.length; index += 1) {
      const value = values[index];
      if (value === undefined) throw new Error("Directory page index name invariant failed");
      offsets[index] = offset;
      const written = writeFilenameComponent({ bytes, offset, value });
      if (written > 0xffff) throw new RangeError("Directory page index filename length exceeds retained index width");
      lengths[index] = written;
      offset += written;
      if (offset > bytes.byteLength) {
        throw new Error("Directory page index canonical filename bytes exceed the authenticated page length");
      }
    }
    if (offset !== bytes.byteLength) {
      throw new Error("Directory page index canonical filename bytes do not match the authenticated page length");
    }
    return Object.freeze({ bytes, lengths, offsets });
  } catch (error: unknown) {
    bytes.fill(0);
    lengths.fill(0);
    offsets.fill(0);
    throw error;
  }
}

function namesBytes({ names }: { names: RetainedNames }): number {
  return names.bytes.byteLength + names.lengths.byteLength + names.offsets.byteLength;
}

function nameAt({ index, names }: { index: number; names: RetainedNames }): Uint8Array {
  const offset = names.offsets[index];
  const length = names.lengths[index];
  if (offset === undefined || length === undefined || offset + length > names.bytes.byteLength) {
    throw new Error("Directory page index retained-name invariant failed");
  }
  return names.bytes.subarray(offset, offset + length);
}

function lowerBoundName({ key, names }: { key: Uint8Array; names: RetainedNames }): number {
  let lower = 0;
  let upper = names.offsets.length;
  while (lower < upper) {
    const middle = lower + Math.floor((upper - lower) / 2);
    if (compareUnsignedBytes({ left: nameAt({ index: middle, names }), right: key }) < 0) lower = middle + 1;
    else upper = middle;
  }
  return lower;
}

function inodeKindTag({ kind }: { kind: InodeKind }): number {
  switch (kind) {
  case "file": return INODE_KIND_FILE;
  case "directory": return INODE_KIND_DIRECTORY;
  case "symlink": return INODE_KIND_SYMLINK;
  default: return kind satisfies never;
  }
}

function inodeKindFromTag({ tag }: { tag: number }): InodeKind {
  switch (tag) {
  case INODE_KIND_FILE: return "file";
  case INODE_KIND_DIRECTORY: return "directory";
  case INODE_KIND_SYMLINK: return "symlink";
  default: throw new Error("Directory page index cached Inode kind is invalid");
  }
}

function retainPage({ encodedByteLength, page }: {
  encodedByteLength: number;
  page: DirectoryPage;
}): RetainedPage {
  const nameBytes = plannedNameBytes({ encodedByteLength, page });
  switch (page.type) {
  case "branch": {
    const names = encodeNames({ totalBytes: nameBytes, values: page.entries.map(entry => entry.upperBoundName) });
    const references = new Uint8Array(page.entries.length * RECORD_REFERENCE_BYTES);
    for (let index = 0; index < page.entries.length; index += 1) {
      const entry = page.entries[index];
      if (entry === undefined) throw new Error("Directory branch page cache entry invariant failed");
      writeHomeRecordReference({
        bytes: references,
        offset: index * RECORD_REFERENCE_BYTES,
        reference: entry.childPageHomeRef,
      });
    }
    return Object.freeze({ level: page.level, names, references, type: "branch" });
  }
  case "leaf": {
    const names = encodeNames({ totalBytes: nameBytes, values: page.entries.map(entry => entry.name) });
    const ids = new BigUint64Array(page.entries.length);
    const inodeKinds = new Uint8Array(page.entries.length);
    const targetTypes = new Uint8Array(page.entries.length);
    for (let index = 0; index < page.entries.length; index += 1) {
      const entry = page.entries[index];
      if (entry === undefined) throw new Error("Directory leaf page cache entry invariant failed");
      switch (entry.targetType) {
      case "inode":
        targetTypes[index] = TARGET_INODE;
        inodeKinds[index] = inodeKindTag({ kind: entry.inodeKind });
        ids[index] = entry.inodeNumber;
        break;
      case "subvolume":
        targetTypes[index] = TARGET_SUBVOLUME;
        ids[index] = entry.subvolumeId;
        break;
      default: entry satisfies never;
      }
    }
    return Object.freeze({ ids, inodeKinds, names, targetTypes, type: "leaf" });
  }
  default: return page satisfies never;
  }
}

function retainedBytes({ page }: { page: RetainedPage }): number {
  switch (page.type) {
  case "branch": return namesBytes({ names: page.names }) + page.references.byteLength;
  case "leaf": return namesBytes({ names: page.names }) + page.ids.byteLength + page.inodeKinds.byteLength + page.targetTypes.byteLength;
  default: return page satisfies never;
  }
}

function plannedNameBytes({ encodedByteLength, page }: {
  encodedByteLength: number;
  page: DirectoryPage;
}): number {
  assertEncodedByteLength({ encodedByteLength });
  const entryCount = page.entries.length;
  const entryPrefixBytes = (() => {
    switch (page.type) {
    case "branch": return HIZOFS_V1_FORMAT_CONSTANTS.fixedSizes.directoryBranchChildPrefix;
    case "leaf": return HIZOFS_V1_FORMAT_CONSTANTS.fixedSizes.directoryEntryPrefix;
    default: return page satisfies never;
    }
  })();
  const fixedBytes = HIZOFS_V1_FORMAT_CONSTANTS.fixedSizes.commonPageHeader + entryCount * entryPrefixBytes;
  if (encodedByteLength < fixedBytes) {
    throw new RangeError("decoded Directory page cache encoded byte length is shorter than the page prefixes");
  }
  return encodedByteLength - fixedBytes;
}

function plannedRetainedBytes({ encodedByteLength, page }: {
  encodedByteLength: number;
  page: DirectoryPage;
}): number {
  const nameBytes = plannedNameBytes({ encodedByteLength, page });
  const entryCount = page.entries.length;
  const nameIndexBytes = entryCount * (Uint16Array.BYTES_PER_ELEMENT + Uint32Array.BYTES_PER_ELEMENT);
  switch (page.type) {
  case "branch": return nameBytes + nameIndexBytes + entryCount * RECORD_REFERENCE_BYTES;
  case "leaf": return nameBytes + nameIndexBytes
    + entryCount * (BigUint64Array.BYTES_PER_ELEMENT + 2 * Uint8Array.BYTES_PER_ELEMENT);
  default: return page satisfies never;
  }
}

const NOOP_CACHE_ADMISSION = Object.freeze({
  commit: (): void => undefined,
  discard: (): void => undefined,
});

function clearNames({ names }: { names: RetainedNames }): void {
  names.bytes.fill(0);
  names.lengths.fill(0);
  names.offsets.fill(0);
}

function clearPage({ page }: { page: RetainedPage }): void {
  clearNames({ names: page.names });
  switch (page.type) {
  case "branch": page.references.fill(0); return;
  case "leaf":
    page.ids.fill(0n);
    page.inodeKinds.fill(0);
    page.targetTypes.fill(0);
    return;
  default: return page satisfies never;
  }
}


function restorePage({ page }: { page: RetainedPage }): DirectoryPage {
  switch (page.type) {
  case "branch":
    return Object.freeze({
      entries: Object.freeze(Array.from({ length: page.names.offsets.length }, (_, index) => {
        const offset = index * RECORD_REFERENCE_BYTES;
        return Object.freeze({
          childPageHomeRef: decodeRequiredHomeRecordReference({
            bytes: page.references.subarray(offset, offset + RECORD_REFERENCE_BYTES),
          }),
          upperBoundName: decodeFilenameComponent({ bytes: nameAt({ index, names: page.names }) }),
        });
      })),
      level: page.level,
      type: "branch" as const,
    });
  case "leaf":
    return Object.freeze({
      entries: Object.freeze(Array.from({ length: page.names.offsets.length }, (_, index) => {
        const id = page.ids[index];
        const targetType = page.targetTypes[index];
        if (id === undefined || targetType === undefined) throw new Error("Directory page cache target invariant failed");
        const name = decodeFilenameComponent({ bytes: nameAt({ index, names: page.names }) });
        if (targetType === TARGET_INODE) {
          const inodeKind = page.inodeKinds[index];
          if (inodeKind === undefined) throw new Error("Directory page cache Inode kind invariant failed");
          return Object.freeze({
            inodeKind: inodeKindFromTag({ tag: inodeKind }),
            inodeNumber: createInodeNumber({ value: id }),
            name,
            targetType: "inode" as const,
          });
        }
        if (targetType === TARGET_SUBVOLUME) {
          return Object.freeze({ name, subvolumeId: createSubvolumeId({ value: id }), targetType: "subvolume" as const });
        }
        throw new Error("Directory page cache target type is invalid");
      })),
      level: 0 as const,
      type: "leaf" as const,
    });
  default: return page satisfies never;
  }
}

function assertEncodedByteLength({ encodedByteLength }: { encodedByteLength: number }): void {
  if (!Number.isSafeInteger(encodedByteLength) || encodedByteLength <= 0) {
    throw new RangeError("decoded Directory page cache encoded byte length must be a positive safe integer");
  }
}

/**
 * Retains only bounded, zeroizable Directory routing data after a page has
 * already passed the authoritative full decoder. No decoded filename strings
 * or Directory entry objects survive in this cache. Pending durable admissions reserve from the
 * same byte and entry budgets as committed entries, so write-through cannot exceed the cache bound.
 */
export class DecodedDirectoryPageIndexCache {
  private readonly entries = new Map<string, RetainedCacheEntry>();
  private readonly maximumBytes: number;
  private readonly maximumEntries: number;
  private bytes = 0;
  private pendingBytes = 0;
  private pendingEntries = 0;
  private disposed = false;

  constructor({ maximumBytes, maximumEntries }: { maximumBytes: number; maximumEntries: number }) {
    if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 0) {
      throw new RangeError("decoded Directory page cache maximum bytes must be non-negative");
    }
    if (!Number.isSafeInteger(maximumEntries) || maximumEntries < 0) {
      throw new RangeError("decoded Directory page cache maximum entries must be non-negative");
    }
    this.maximumBytes = maximumBytes;
    this.maximumEntries = maximumEntries;
  }

  getPoint({ isRoot, key, reference }: {
    isRoot: boolean;
    key: Uint8Array;
    reference: HomeRecordReference;
  }): DirectoryPointPage | undefined {
    if (this.disposed) throw new TypeError("decoded Directory page cache is disposed");
    const cacheKey = identity({ isRoot, reference });
    const retained = this.entries.get(cacheKey);
    if (retained === undefined) return undefined;
    this.entries.delete(cacheKey);
    this.entries.set(cacheKey, retained);
    const { page } = retained;
    const index = lowerBoundName({ key, names: page.names });
    switch (page.type) {
    case "branch": {
      if (index >= page.names.offsets.length) return { level: page.level, type: "absent" };
      const offset = index * RECORD_REFERENCE_BYTES;
      return {
        childPageReference: decodeRequiredHomeRecordReference({
          bytes: page.references.subarray(offset, offset + RECORD_REFERENCE_BYTES),
        }),
        level: page.level,
        type: "branch",
      };
    }
    case "leaf": {
      if (index >= page.names.offsets.length || compareUnsignedBytes({ left: nameAt({ index, names: page.names }), right: key }) !== 0) {
        return { entry: undefined, type: "leaf" };
      }
      const id = page.ids[index];
      const targetType = page.targetTypes[index];
      if (id === undefined || targetType === undefined) throw new Error("Directory page cache target invariant failed");
      const name = decodeFilenameComponent({ bytes: nameAt({ index, names: page.names }) });
      if (targetType === TARGET_INODE) {
        const inodeKind = page.inodeKinds[index];
        if (inodeKind === undefined) throw new Error("Directory page cache Inode kind invariant failed");
        return {
          entry: { inodeKind: inodeKindFromTag({ tag: inodeKind }), inodeNumber: createInodeNumber({ value: id }), name, targetType: "inode" },
          type: "leaf",
        };
      }
      if (targetType === TARGET_SUBVOLUME) {
        return { entry: { name, subvolumeId: createSubvolumeId({ value: id }), targetType: "subvolume" }, type: "leaf" };
      }
      throw new Error("Directory page cache target type is invalid");
    }
    default: return page satisfies never;
    }
  }

  getPageForUpdate({ isRoot, reference }: {
    isRoot: boolean;
    reference: HomeRecordReference;
  }): Readonly<{ encodedByteLength: number; localStructureValidated: true; page: DirectoryPage }> | undefined {
    if (this.disposed) throw new TypeError("decoded Directory page cache is disposed");
    const cacheKey = identity({ isRoot, reference });
    const retained = this.entries.get(cacheKey);
    if (retained === undefined) return undefined;
    this.entries.delete(cacheKey);
    this.entries.set(cacheKey, retained);
    return Object.freeze({
      encodedByteLength: retained.encodedByteLength,
      localStructureValidated: true as const,
      page: restorePage({ page: retained.page }),
    });
  }

  preparePageAdmission({ encodedByteLength, isRoot, page, reference }: {
    encodedByteLength: number;
    isRoot: boolean;
    page: DirectoryPage;
    reference: HomeRecordReference;
  }): Readonly<{ commit: () => void; discard: () => void }> {
    if (this.disposed) throw new TypeError("decoded Directory page cache is disposed");
    assertEncodedByteLength({ encodedByteLength });
    if (this.maximumBytes === 0 || this.maximumEntries === 0) return NOOP_CACHE_ADMISSION;
    const plannedBytes = plannedRetainedBytes({ encodedByteLength, page });
    if (plannedBytes > this.maximumBytes) return NOOP_CACHE_ADMISSION;
    while (
      this.entries.size + this.pendingEntries >= this.maximumEntries
      || this.bytes + this.pendingBytes + plannedBytes > this.maximumBytes
    ) {
      if (!this.evictOldest()) return NOOP_CACHE_ADMISSION;
    }
    const retainedPage = retainPage({ encodedByteLength, page });
    const bytes = retainedBytes({ page: retainedPage });
    if (bytes !== plannedBytes) {
      clearPage({ page: retainedPage });
      throw new Error("decoded Directory page cache retained-byte planning invariant failed");
    }
    this.pendingBytes += bytes;
    this.pendingEntries += 1;
    let state: "pending" | "committed" | "discarded" = "pending";
    const releaseReservation = (): void => {
      this.pendingBytes -= bytes;
      this.pendingEntries -= 1;
      if (this.pendingBytes < 0 || this.pendingEntries < 0) {
        throw new Error("decoded Directory page cache pending reservation accounting underflowed");
      }
    };
    const discard = (): void => {
      switch (state) {
      case "pending":
        state = "discarded";
        releaseReservation();
        clearPage({ page: retainedPage });
        return;
      case "committed":
      case "discarded": return;
      default: return state satisfies never;
      }
    };
    const commit = (): void => {
      switch (state) {
      case "pending": break;
      case "committed":
      case "discarded": return;
      default: return state satisfies never;
      }
      if (this.disposed) {
        discard();
        return;
      }
      releaseReservation();
      try {
        this.commitRetainedPage({ bytes, encodedByteLength, isRoot, page: retainedPage, reference });
        state = "committed";
      } catch (error: unknown) {
        state = "discarded";
        clearPage({ page: retainedPage });
        throw error;
      }
    };
    return Object.freeze({ commit, discard });
  }

  setPage({ encodedByteLength, isRoot, page, reference }: {
    encodedByteLength: number;
    isRoot: boolean;
    page: DirectoryPage;
    reference: HomeRecordReference;
  }): void {
    const admission = this.preparePageAdmission({ encodedByteLength, isRoot, page, reference });
    admission.commit();
  }

  private commitRetainedPage({ bytes, encodedByteLength, isRoot, page, reference }: {
    bytes: number;
    encodedByteLength: number;
    isRoot: boolean;
    page: RetainedPage;
    reference: HomeRecordReference;
  }): void {
    const key = identity({ isRoot, reference });
    const existing = this.entries.get(key);
    if (existing !== undefined) {
      this.entries.delete(key);
      this.bytes -= existing.bytes;
      clearPage({ page: existing.page });
    }
    while (this.entries.size >= this.maximumEntries || this.bytes + bytes > this.maximumBytes) {
      if (!this.evictOldest()) break;
    }
    this.entries.set(key, { bytes, encodedByteLength, page });
    this.bytes += bytes;
  }

  private evictOldest(): boolean {
    const oldest = this.entries.entries().next().value as [string, RetainedCacheEntry] | undefined;
    if (oldest === undefined) return false;
    this.entries.delete(oldest[0]);
    this.bytes -= oldest[1].bytes;
    clearPage({ page: oldest[1].page });
    return true;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const entry of this.entries.values()) clearPage({ page: entry.page });
    this.entries.clear();
    this.bytes = 0;
  }
}

export const TEST_ONLY = {
  clearPage,
  identity,
  lowerBoundName,
  retainPage,
  plannedRetainedBytes,
  retainedBytes,
  restorePage,
};
