import {
  compareUnsignedBytes,
  createInodeNumber,
  createSubvolumeId,
  decodeFilenameComponent,
  decodeRequiredHomeRecordReference,
  encodeFilenameComponent,
  encodeHomeRecordReference,
  HIZOFS_V1_FORMAT_CONSTANTS,
  type DirectoryLeafEntry,
  type DirectoryPage,
  type HomeRecordReference,
  type InodeKind,
} from "@/00-storage/service/hizofs/00-format";

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

export type DirectoryPointPage = Readonly<
  | { level: number; type: "absent" }
  | { childPageReference: HomeRecordReference; level: number; type: "branch" }
  | { entry: DirectoryLeafEntry | undefined; type: "leaf" }
>;

function identity({ isRoot, reference }: { isRoot: boolean; reference: HomeRecordReference }): string {
  const encoded = encodeHomeRecordReference({ reference });
  try {
    let value = isRoot ? "root:" : "non_root:";
    for (const byte of encoded) value += byte.toString(16).padStart(2, "0");
    return value;
  } finally {
    encoded.fill(0);
  }
}

function encodeNames({ values }: { values: readonly string[] }): RetainedNames {
  const encoded = values.map(value => encodeFilenameComponent({ value }));
  try {
    let totalBytes = 0;
    for (const value of encoded) totalBytes += value.byteLength;
    const bytes = new Uint8Array(totalBytes);
    const lengths = new Uint16Array(encoded.length);
    const offsets = new Uint32Array(encoded.length);
    let offset = 0;
    for (let index = 0; index < encoded.length; index += 1) {
      const value = encoded[index];
      if (value === undefined) throw new Error("Directory page index name invariant failed");
      offsets[index] = offset;
      lengths[index] = value.byteLength;
      bytes.set(value, offset);
      offset += value.byteLength;
    }
    return Object.freeze({ bytes, lengths, offsets });
  } finally {
    for (const value of encoded) value.fill(0);
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

function retainPage({ page }: { page: DirectoryPage }): RetainedPage {
  switch (page.type) {
  case "branch": {
    const names = encodeNames({ values: page.entries.map(entry => entry.upperBoundName) });
    const references = new Uint8Array(page.entries.length * RECORD_REFERENCE_BYTES);
    for (let index = 0; index < page.entries.length; index += 1) {
      const entry = page.entries[index];
      if (entry === undefined) throw new Error("Directory branch page cache entry invariant failed");
      const encoded = encodeHomeRecordReference({ reference: entry.childPageHomeRef });
      try {
        references.set(encoded, index * RECORD_REFERENCE_BYTES);
      } finally {
        encoded.fill(0);
      }
    }
    return Object.freeze({ level: page.level, names, references, type: "branch" });
  }
  case "leaf": {
    const names = encodeNames({ values: page.entries.map(entry => entry.name) });
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

/**
 * Retains only bounded, zeroizable Directory routing data after a page has
 * already passed the authoritative full decoder. No decoded filename strings
 * or Directory entry objects survive in this cache.
 */
export class DecodedDirectoryPageIndexCache {
  private readonly entries = new Map<string, Readonly<{ bytes: number; page: RetainedPage }>>();
  private readonly maximumBytes: number;
  private readonly maximumEntries: number;
  private bytes = 0;
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

  setPage({ isRoot, page, reference }: { isRoot: boolean; page: DirectoryPage; reference: HomeRecordReference }): void {
    if (this.disposed) throw new TypeError("decoded Directory page cache is disposed");
    if (this.maximumBytes === 0 || this.maximumEntries === 0) return;
    const retainedPage = retainPage({ page });
    const bytes = retainedBytes({ page: retainedPage });
    if (bytes > this.maximumBytes) {
      clearPage({ page: retainedPage });
      return;
    }
    const key = identity({ isRoot, reference });
    const existing = this.entries.get(key);
    if (existing !== undefined) {
      this.entries.delete(key);
      this.bytes -= existing.bytes;
      clearPage({ page: existing.page });
    }
    while (this.entries.size >= this.maximumEntries || this.bytes + bytes > this.maximumBytes) {
      const oldest = this.entries.entries().next().value as [string, Readonly<{ bytes: number; page: RetainedPage }>] | undefined;
      if (oldest === undefined) break;
      this.entries.delete(oldest[0]);
      this.bytes -= oldest[1].bytes;
      clearPage({ page: oldest[1].page });
    }
    this.entries.set(key, { bytes, page: retainedPage });
    this.bytes += bytes;
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
  retainedBytes,
};