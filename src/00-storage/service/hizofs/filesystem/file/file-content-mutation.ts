import {
  HIZOFS_V1_FORMAT_CONSTANTS,
  createFileOffset,
  sameRecordReferenceFields,
  type FileExtentLeafEntry,
  type FileInodeEntry,
  type FileOffset,
  type HomeRecordReference,
} from "@/00-storage/service/hizofs/00-format";
import type { FileTruncatePlan } from "@/00-storage/service/hizofs/filesystem/file/file-truncate-plan";
import type { FileWritePlan } from "@/00-storage/service/hizofs/filesystem/file/file-write-plan";
import {
  applyFileExtentTreeMutations,
  fileExtentEntriesFromFloor,
  type FileExtentTreeMutation,
  type FileExtentTreePageStore,
} from "@/00-storage/service/hizofs/filesystem/mutation/file-extent-tree";

export type FileContentMutationLimits = Readonly<{
  maximumExtentMutationsPerBatch: number;
}>;

export const DEFAULT_FILE_CONTENT_MUTATION_LIMITS: FileContentMutationLimits = Object.freeze({
  maximumExtentMutationsPerBatch: 64,
});

export type FileContentMutationPort = Readonly<{
  extentPageStore: FileExtentTreePageStore;
  writeFileData: ({ bytes }: { bytes: Uint8Array }) => Promise<HomeRecordReference>;
}>;

const fileExtentAppendTailWitnessBrand: unique symbol = Symbol("file-extent-append-tail-witness");

/**
 * Mutation-local proof that this prepared writable constructed the current
 * File Extent tree and has changed it only by appending at its logical tail.
 * The private brand prevents callers from manufacturing the proof from an
 * arbitrary persisted root.
 */
export type FileExtentAppendTailWitness = Readonly<{
  fileSize: FileOffset;
  rootReference: HomeRecordReference;
  readonly [fileExtentAppendTailWitnessBrand]: true;
}>;

export type FileWriteMutationWithAppendTailWitnessResult = Readonly<{
  appendTailWitness: FileExtentAppendTailWitness | undefined;
  inode: FileInodeEntry;
}>;

type FileExtentTreeContent = Extract<FileInodeEntry["content"], { type: "tree" }>;

function fileExtentTreeContentOrUndefined({ source }: { source: FileInodeEntry }): FileExtentTreeContent | undefined {
  switch (source.content.type) {
  case "tree": return source.content;
  case "inline": return undefined;
  default: return source.content satisfies never;
  }
}

function requireFileExtentTreeContent({ message, source }: {
  message: string;
  source: FileInodeEntry;
}): FileExtentTreeContent {
  const content = fileExtentTreeContentOrUndefined({ source });
  if (content === undefined) throw new TypeError(message);
  return content;
}

const MAXIMUM_PREPARED_EXTENT_PLAINTEXT_BYTES = 16 * 1024 * 1024;

export const HIZOFS_FILE_EXTENT_TAIL_APPEND_BATCH_RESOURCE_LIMITS = Object.freeze({
  maximumPendingPlaintextBytes: MAXIMUM_PREPARED_EXTENT_PLAINTEXT_BYTES,
});

/**
 * Bounded mutation-local overlay for repeated tail appends from one prepared
 * writable. It deliberately keeps the last persisted File Extent root in the
 * staged inode until materialization; callers must flush the overlay before a
 * non-tail operation or publication.
 *
 * WHY: rewriting one immutable File Extent root and encrypting one File Data
 * Record for every small sequential write turns a logical stream into
 * O(write-count) metadata and crypto work. The overlay takes ownership of the
 * already-captured write bytes, keeps at most 16 MiB, then packs the contiguous
 * tail into canonical <=1 MiB File Data Records at flush. No second retained
 * plaintext copy is introduced and the persisted File Extent format is
 * unchanged.
 */
function tailAppendExtentFragmentsForBytes({ byteLength, pendingPlaintextBytes }: {
  byteLength: number;
  pendingPlaintextBytes: number;
}): number {
  if (!Number.isSafeInteger(byteLength) || byteLength <= 0) return 0;
  const maximumPayload = HIZOFS_V1_FORMAT_CONSTANTS.limits.fileDataPlaintextBytes;
  const offsetInPayload = pendingPlaintextBytes % maximumPayload;
  const firstCapacity = maximumPayload - offsetInPayload;
  if (byteLength <= firstCapacity) return 1;
  return 1 + Math.ceil((byteLength - firstCapacity) / maximumPayload);
}

export class PreparedFileExtentTailAppendBatch {
  private chunks: Uint8Array[] = [];
  private closed = false;
  private fileSize: FileOffset;
  private pendingExtentEntries = 0;
  private pendingPlaintextBytes = 0;
  private readonly startFileOffset: FileOffset;
  private rootReference: HomeRecordReference;

  private constructor({ fileSize, rootReference }: {
    fileSize: FileOffset;
    rootReference: HomeRecordReference;
  }) {
    this.fileSize = fileSize;
    this.startFileOffset = fileSize;
    this.rootReference = rootReference;
  }

  static create({ source, witness }: {
    source: FileInodeEntry;
    witness: FileExtentAppendTailWitness;
  }): PreparedFileExtentTailAppendBatch {
    if (!matchesFileExtentAppendTailWitness({ source, witness })) {
      throw new TypeError("File Extent append-tail batch requires the matching mutation-owned witness");
    }
    const content = requireFileExtentTreeContent({
      message: "File Extent append-tail batch requires an extent-backed file",
      source,
    });
    return new PreparedFileExtentTailAppendBatch({
      fileSize: source.fileSize,
      rootReference: content.extentTreeRootHomeRef,
    });
  }

  canStage({ byteLength, limits, source, writeOffset }: {
    byteLength: number;
    limits: FileContentMutationLimits;
    source: FileInodeEntry;
    writeOffset: FileOffset;
  }): boolean {
    if (this.closed) return false;
    const content = fileExtentTreeContentOrUndefined({ source });
    if (content === undefined) return false;
    if (source.fileSize !== this.fileSize || writeOffset !== this.fileSize) return false;
    if (!sameRecordReferenceFields({ left: content.extentTreeRootHomeRef, right: this.rootReference })) return false;
    if (!Number.isSafeInteger(byteLength) || byteLength <= 0) return false;
    const nextPlaintextBytes = this.pendingPlaintextBytes + byteLength;
    if (!Number.isSafeInteger(nextPlaintextBytes) || nextPlaintextBytes > MAXIMUM_PREPARED_EXTENT_PLAINTEXT_BYTES) {
      return false;
    }
    const addedExtentEntries = tailAppendExtentFragmentsForBytes({
      byteLength,
      pendingPlaintextBytes: this.pendingPlaintextBytes,
    });
    return this.pendingExtentEntries + addedExtentEntries <= requirePositiveBatchSize({ limits });
  }

  /**
   * Transfers ownership of plan.writeBytes on success. The caller must zeroize
   * them only when this method rejects; flush/discard owns erasure afterward.
   */
  stage({ limits, plan, source }: {
    limits: FileContentMutationLimits;
    plan: Extract<FileWritePlan, { action: "copy_on_write_extent_range" }>;
    source: FileInodeEntry;
  }): FileInodeEntry {
    if (this.closed) throw new Error("File Extent tail append batch is closed");
    const content = requireFileExtentTreeContent({
      message: "File Extent tail append source must be extent-backed",
      source,
    });
    if (source.fileSize !== this.fileSize || plan.writeOffset !== this.fileSize) {
      throw new TypeError("File Extent tail append batch accepts only the next logical tail write");
    }
    if (!sameRecordReferenceFields({ left: content.extentTreeRootHomeRef, right: this.rootReference })) {
      throw new TypeError("File Extent tail append batch source root changed before materialization");
    }
    const nextPlaintextBytes = this.pendingPlaintextBytes + plan.writeBytes.byteLength;
    if (!Number.isSafeInteger(nextPlaintextBytes) || nextPlaintextBytes > MAXIMUM_PREPARED_EXTENT_PLAINTEXT_BYTES) {
      throw new RangeError("File Extent tail append batch plaintext exceeds its resource bound");
    }
    const addedExtentEntries = tailAppendExtentFragmentsForBytes({
      byteLength: plan.writeBytes.byteLength,
      pendingPlaintextBytes: this.pendingPlaintextBytes,
    });
    if (this.pendingExtentEntries + addedExtentEntries > requirePositiveBatchSize({ limits })) {
      throw new RangeError("File Extent tail append batch exceeds its mutation-entry bound");
    }
    this.chunks.push(plan.writeBytes);
    this.pendingExtentEntries += addedExtentEntries;
    this.pendingPlaintextBytes = nextPlaintextBytes;
    this.fileSize = plan.targetFileSize;
    return updatedFileInode({ content: source.content, plan, source });
  }

  discard(): void {
    if (this.closed) return;
    this.closed = true;
    for (const chunk of this.chunks) chunk.fill(0);
    this.chunks = [];
    this.pendingExtentEntries = 0;
    this.pendingPlaintextBytes = 0;
  }

  async flush({ limits, port, source }: {
    limits: FileContentMutationLimits;
    port: FileContentMutationPort;
    source: FileInodeEntry;
  }): Promise<FileWriteMutationWithAppendTailWitnessResult> {
    if (this.closed) throw new Error("File Extent tail append batch is closed");
    const content = requireFileExtentTreeContent({
      message: "File Extent tail append source must be extent-backed",
      source,
    });
    if (source.fileSize !== this.fileSize) throw new TypeError("File Extent tail append batch file size changed before materialization");
    if (!sameRecordReferenceFields({ left: content.extentTreeRootHomeRef, right: this.rootReference })) {
      throw new TypeError("File Extent tail append batch source root changed before materialization");
    }
    const maximumPayload = HIZOFS_V1_FORMAT_CONSTANTS.limits.fileDataPlaintextBytes;
    if (this.pendingExtentEntries > requirePositiveBatchSize({ limits })) {
      throw new RangeError("File Extent tail append batch exceeds its mutation-entry bound");
    }
    // Consume the capability before the first data or metadata write. A failed
    // flush may emit unreachable provisional Records, so retrying the same
    // plaintext stream could no longer prove pristine ownership.
    this.closed = true;
    const chunks = this.chunks;
    this.chunks = [];
    const pendingExtentEntries = this.pendingExtentEntries;
    this.pendingExtentEntries = 0;
    const pendingPlaintextBytes = this.pendingPlaintextBytes;
    this.pendingPlaintextBytes = 0;
    const newEntries: FileExtentLeafEntry[] = [];
    let chunkIndex = 0;
    let chunkOffset = 0;
    let emittedBytes = 0;
    try {
      while (emittedBytes < pendingPlaintextBytes) {
        const payloadLength = Math.min(maximumPayload, pendingPlaintextBytes - emittedBytes);
        const payload = new Uint8Array(payloadLength);
        const fragments: Array<Readonly<{
          byteLength: number;
          dataOffset: number;
          fileOffset: FileOffset;
        }>> = [];
        let payloadOffset = 0;
        try {
          while (payloadOffset < payloadLength) {
            const chunk = chunks[chunkIndex];
            if (chunk === undefined) throw new Error("File Extent tail append plaintext stream ended early");
            const copyLength = Math.min(payloadLength - payloadOffset, chunk.byteLength - chunkOffset);
            const dataOffset = payloadOffset;
            payload.set(chunk.subarray(chunkOffset, chunkOffset + copyLength), payloadOffset);
            fragments.push({
              byteLength: copyLength,
              dataOffset,
              fileOffset: createFileOffset({
                value: this.startFileOffset + BigInt(emittedBytes + payloadOffset),
              }),
            });
            payloadOffset += copyLength;
            chunkOffset += copyLength;
            if (chunkOffset === chunk.byteLength) {
              chunk.fill(0);
              chunkIndex += 1;
              chunkOffset = 0;
            }
          }
          const fileDataHomeRef = await port.writeFileData({ bytes: payload });
          newEntries.push(...fragments.map(fragment => ({
            ...fragment,
            fileDataHomeRef,
          })));
        } finally {
          payload.fill(0);
        }
        emittedBytes += payloadLength;
      }
      if (emittedBytes !== pendingPlaintextBytes || this.startFileOffset + BigInt(emittedBytes) !== this.fileSize) {
        throw new Error("File Extent tail append plaintext length invariant failed");
      }
      if (newEntries.length !== pendingExtentEntries) {
        throw new Error("File Extent tail append fragment-count invariant failed");
      }
      const root = await applyMutationBatches({
        changes: newEntries.map(entry => ({ entry, type: "set" as const })),
        limits,
        pageStore: port.extentPageStore,
        rootReference: this.rootReference,
      });
      this.rootReference = root;
      const inode: FileInodeEntry = {
        ...source,
        content: { extentTreeRootHomeRef: root, type: "tree" },
      };
      return Object.freeze({
        appendTailWitness: createFileExtentAppendTailWitness({ fileSize: inode.fileSize, rootReference: root }),
        inode,
      });
    } finally {
      for (const chunk of chunks) chunk.fill(0);
    }
  }
}

/**
 * Bounded mutation-local overlay for non-tail extent writes. It keeps the
 * persisted File Extent root unchanged while public write calls are staged,
 * then packs their owned plaintext into canonical <=1 MiB File Data Records.
 * Metadata replacements are still applied in original write order so overlap
 * semantics and last-write-wins behavior remain identical to individual
 * writes.
 *
 * WHY: random writes otherwise encrypt one tiny File Data Record per public
 * write even though the prepared writable already owns all plaintext until
 * commit. Coalescing only the data records removes that crypto/record
 * amplification without widening the harder File Extent transaction boundary.
 */
export class PreparedFileExtentRangeWriteBatch {
  private closed = false;
  private fileSize: FileOffset;
  private pendingPlaintextBytes = 0;
  private readonly rootReference: HomeRecordReference;
  private writes: Array<{
    bytes: Uint8Array;
    end: FileOffset;
    start: FileOffset;
  }> = [];

  private constructor({ fileSize, rootReference }: {
    fileSize: FileOffset;
    rootReference: HomeRecordReference;
  }) {
    this.fileSize = fileSize;
    this.rootReference = rootReference;
  }

  static create({ source }: { source: FileInodeEntry }): PreparedFileExtentRangeWriteBatch {
    const content = requireFileExtentTreeContent({
      message: "File Extent range-write batch requires an extent-backed file",
      source,
    });
    return new PreparedFileExtentRangeWriteBatch({
      fileSize: source.fileSize,
      rootReference: content.extentTreeRootHomeRef,
    });
  }

  canStage({ byteLength, limits, source, writeOffset }: {
    byteLength: number;
    limits: FileContentMutationLimits;
    source: FileInodeEntry;
    writeOffset: FileOffset;
  }): boolean {
    if (this.closed) return false;
    const content = fileExtentTreeContentOrUndefined({ source });
    if (content === undefined) return false;
    if (source.fileSize !== this.fileSize) return false;
    if (!sameRecordReferenceFields({ left: content.extentTreeRootHomeRef, right: this.rootReference })) return false;
    if (!Number.isSafeInteger(byteLength) || byteLength <= 0) return false;
    // Pure tail appends have a stronger overlay that also coalesces File Extent
    // tree updates; do not absorb them into this data-record-only batch.
    if (writeOffset >= source.fileSize) return false;
    if (this.writes.length >= requirePositiveBatchSize({ limits })) return false;
    const nextPlaintextBytes = this.pendingPlaintextBytes + byteLength;
    return Number.isSafeInteger(nextPlaintextBytes)
      && nextPlaintextBytes <= MAXIMUM_PREPARED_EXTENT_PLAINTEXT_BYTES;
  }

  /** Transfers ownership of plan.writeBytes on success. */
  stage({ limits, plan, source }: {
    limits: FileContentMutationLimits;
    plan: Extract<FileWritePlan, { action: "copy_on_write_extent_range" }>;
    source: FileInodeEntry;
  }): FileInodeEntry {
    if (this.closed) throw new Error("File Extent range-write batch is closed");
    sameInodePlan({
      inode: source,
      plannedInodeNumber: plan.inodeNumber,
      plannedRevision: plan.nextInodeRevision,
    });
    const content = requireFileExtentTreeContent({
      message: "File Extent range-write batch requires an extent-backed source",
      source,
    });
    if (source.fileSize !== this.fileSize) {
      throw new TypeError("File Extent range-write batch file size changed before materialization");
    }
    if (!sameRecordReferenceFields({ left: content.extentTreeRootHomeRef, right: this.rootReference })) {
      throw new TypeError("File Extent range-write batch source root changed before materialization");
    }
    if (plan.writeOffset >= source.fileSize) {
      throw new TypeError("File Extent range-write batch accepts only writes beginning before the logical tail");
    }
    if (this.writes.length >= requirePositiveBatchSize({ limits })) {
      throw new RangeError("File Extent range-write batch exceeds its write-count bound");
    }
    const nextPlaintextBytes = this.pendingPlaintextBytes + plan.writeBytes.byteLength;
    if (!Number.isSafeInteger(nextPlaintextBytes) || nextPlaintextBytes > MAXIMUM_PREPARED_EXTENT_PLAINTEXT_BYTES) {
      throw new RangeError("File Extent range-write batch plaintext exceeds its resource bound");
    }
    this.writes.push({
      bytes: plan.writeBytes,
      end: createFileOffset({ value: plan.writeOffset + BigInt(plan.writeBytes.byteLength) }),
      start: plan.writeOffset,
    });
    this.pendingPlaintextBytes = nextPlaintextBytes;
    this.fileSize = plan.targetFileSize;
    return updatedFileInode({ content: source.content, plan, source });
  }

  discard(): void {
    if (this.closed) return;
    this.closed = true;
    for (const write of this.writes) write.bytes.fill(0);
    this.writes = [];
    this.pendingPlaintextBytes = 0;
  }

  async flush({ limits, port, source }: {
    limits: FileContentMutationLimits;
    port: FileContentMutationPort;
    source: FileInodeEntry;
  }): Promise<FileInodeEntry> {
    if (this.closed) throw new Error("File Extent range-write batch is closed");
    const content = requireFileExtentTreeContent({
      message: "File Extent range-write batch requires an extent-backed source",
      source,
    });
    if (source.fileSize !== this.fileSize) {
      throw new TypeError("File Extent range-write batch file size changed before materialization");
    }
    if (!sameRecordReferenceFields({ left: content.extentTreeRootHomeRef, right: this.rootReference })) {
      throw new TypeError("File Extent range-write batch source root changed before materialization");
    }

    this.closed = true;
    const writes = this.writes;
    this.writes = [];
    const pendingPlaintextBytes = this.pendingPlaintextBytes;
    this.pendingPlaintextBytes = 0;
    const entriesByWrite = writes.map((): FileExtentLeafEntry[] => []);
    const maximumPayload = HIZOFS_V1_FORMAT_CONSTANTS.limits.fileDataPlaintextBytes;
    let writeIndex = 0;
    let writeByteOffset = 0;
    let emittedBytes = 0;
    try {
      while (emittedBytes < pendingPlaintextBytes) {
        const payloadLength = Math.min(maximumPayload, pendingPlaintextBytes - emittedBytes);
        const payload = new Uint8Array(payloadLength);
        const fragments: Array<{
          byteLength: number;
          dataOffset: number;
          fileOffset: FileOffset;
          writeIndex: number;
        }> = [];
        let payloadOffset = 0;
        try {
          while (payloadOffset < payloadLength) {
            const write = writes[writeIndex];
            if (write === undefined) throw new Error("File Extent range-write plaintext stream ended early");
            const copyLength = Math.min(payloadLength - payloadOffset, write.bytes.byteLength - writeByteOffset);
            const dataOffset = payloadOffset;
            payload.set(write.bytes.subarray(writeByteOffset, writeByteOffset + copyLength), payloadOffset);
            fragments.push({
              byteLength: copyLength,
              dataOffset,
              fileOffset: createFileOffset({ value: write.start + BigInt(writeByteOffset) }),
              writeIndex,
            });
            payloadOffset += copyLength;
            writeByteOffset += copyLength;
            if (writeByteOffset === write.bytes.byteLength) {
              write.bytes.fill(0);
              writeIndex += 1;
              writeByteOffset = 0;
            }
          }
          const fileDataHomeRef = await port.writeFileData({ bytes: payload });
          for (const fragment of fragments) {
            entriesByWrite[fragment.writeIndex]?.push({
              byteLength: fragment.byteLength,
              dataOffset: fragment.dataOffset,
              fileDataHomeRef,
              fileOffset: fragment.fileOffset,
            });
          }
        } finally {
          payload.fill(0);
        }
        emittedBytes += payloadLength;
      }
      if (emittedBytes !== pendingPlaintextBytes || writeIndex !== writes.length || writeByteOffset !== 0) {
        throw new Error("File Extent range-write plaintext length invariant failed");
      }

      const combinedRootReference = await tryReplaceExtentRangesTogether({
        limits,
        pageStore: port.extentPageStore,
        replacements: writes.map((write, index) => ({
          end: write.end,
          newEntries: entriesByWrite[index] ?? [],
          start: write.start,
        })),
        rootReference: this.rootReference,
      });
      if (combinedRootReference !== undefined) {
        return {
          ...source,
          content: { extentTreeRootHomeRef: combinedRootReference, type: "tree" },
        };
      }

      let rootReference = this.rootReference;
      for (let index = 0; index < writes.length; index += 1) {
        const write = writes[index];
        if (write === undefined) throw new Error("File Extent range-write metadata stream ended early");
        rootReference = await replaceExtentRange({
          end: write.end,
          limits,
          newEntries: entriesByWrite[index] ?? [],
          pageStore: port.extentPageStore,
          rootReference,
          start: write.start,
        });
      }
      return {
        ...source,
        content: { extentTreeRootHomeRef: rootReference, type: "tree" },
      };
    } finally {
      for (const write of writes) write.bytes.fill(0);
    }
  }
}

function createFileExtentAppendTailWitness({ fileSize, rootReference }: {
  fileSize: FileOffset;
  rootReference: HomeRecordReference;
}): FileExtentAppendTailWitness {
  return Object.freeze({
    fileSize,
    rootReference,
    [fileExtentAppendTailWitnessBrand]: true,
  });
}

function matchesFileExtentAppendTailWitness({ source, witness }: {
  source: FileInodeEntry;
  witness: FileExtentAppendTailWitness | undefined;
}): boolean {
  if (witness === undefined || source.content.type !== "tree") return false;
  return witness.fileSize === source.fileSize
    && sameRecordReferenceFields({ left: witness.rootReference, right: source.content.extentTreeRootHomeRef });
}

function requirePositiveBatchSize({ limits }: { limits: FileContentMutationLimits }): number {
  const value = limits.maximumExtentMutationsPerBatch;
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new RangeError("File Extent mutation batch size must be a positive safe integer");
  }
  return value;
}

function sameInodePlan({ inode, plannedInodeNumber, plannedRevision }: {
  inode: FileInodeEntry;
  plannedInodeNumber: FileWritePlan["inodeNumber"] | FileTruncatePlan["inodeNumber"];
  plannedRevision: FileWritePlan["nextInodeRevision"] | FileTruncatePlan["nextInodeRevision"];
}): void {
  if (plannedInodeNumber !== inode.inodeNumber) {
    throw new TypeError("file content plan belongs to a different inode");
  }
  if (plannedRevision !== inode.inodeRevision + 1n) {
    throw new TypeError("file content plan does not advance the captured inode revision exactly once");
  }
}

function updatedFileInode({ content, plan, source }: {
  content: FileInodeEntry["content"];
  plan: FileWritePlan | FileTruncatePlan;
  source: FileInodeEntry;
}): FileInodeEntry {
  const {
    content: _sourceContent,
    fileSize: _sourceFileSize,
    inodeKind,
    inodeNumber,
    inodeRevision: _sourceInodeRevision,
    timestamps: _sourceTimestamps,
    ...unhandledSource
  } = source;
  unhandledSource satisfies Record<PropertyKey, never>;
  return {
    content,
    fileSize: plan.targetFileSize,
    inodeKind,
    inodeNumber,
    inodeRevision: plan.nextInodeRevision,
    timestamps: plan.timestamps,
  };
}

async function applyMutationBatches({ changes, limits, pageStore, rootReference }: {
  changes: AsyncIterable<FileExtentTreeMutation> | Iterable<FileExtentTreeMutation>;
  limits: FileContentMutationLimits;
  pageStore: FileExtentTreePageStore;
  rootReference: HomeRecordReference;
}): Promise<HomeRecordReference> {
  const maximumBatchSize = requirePositiveBatchSize({ limits });
  let root = rootReference;
  let batch: FileExtentTreeMutation[] = [];
  const flush = async (): Promise<void> => {
    if (batch.length === 0) return;
    root = await applyFileExtentTreeMutations({ changes: batch, pageStore, rootReference: root });
    batch = [];
  };
  for await (const change of changes) {
    batch.push(change);
    if (batch.length >= maximumBatchSize) await flush();
  }
  await flush();
  return root;
}

async function appendExtentBytes({ bytes, fileOffset, port }: {
  bytes: Uint8Array;
  fileOffset: FileOffset;
  port: FileContentMutationPort;
}): Promise<readonly FileExtentLeafEntry[]> {
  const maximumPayload = HIZOFS_V1_FORMAT_CONSTANTS.limits.fileDataPlaintextBytes;
  const entries: FileExtentLeafEntry[] = [];
  for (let offset = 0; offset < bytes.byteLength; offset += maximumPayload) {
    const chunk = bytes.subarray(offset, Math.min(offset + maximumPayload, bytes.byteLength));
    const fileDataHomeRef = await port.writeFileData({ bytes: chunk });
    entries.push({
      byteLength: chunk.byteLength,
      dataOffset: 0,
      fileDataHomeRef,
      fileOffset: createFileOffset({ value: fileOffset + BigInt(offset) }),
    });
  }
  return entries;
}

async function emptyExtentRoot({ pageStore }: { pageStore: FileExtentTreePageStore }): Promise<HomeRecordReference> {
  return await pageStore.writePage({
    isRoot: true,
    page: { entries: [], level: 0, type: "leaf" },
  });
}

async function replaceExtentRange({ end, limits, newEntries, pageStore, rootReference, start }: {
  end: FileOffset;
  limits: FileContentMutationLimits;
  newEntries: readonly FileExtentLeafEntry[];
  pageStore: FileExtentTreePageStore;
  rootReference: HomeRecordReference;
  start: FileOffset;
}): Promise<HomeRecordReference> {
  async function* removalsAndBoundaryFragments(): AsyncIterable<FileExtentTreeMutation> {
    for await (const entry of fileExtentEntriesFromFloor({
      fileOffset: start,
      pageStore,
      rootReference,
    })) {
      const entryEnd = entry.fileOffset + BigInt(entry.byteLength);
      if (entryEnd <= start) continue;
      if (entry.fileOffset >= end) break;

      if (entry.fileOffset < start) {
        yield {
          entry: {
            ...entry,
            byteLength: Number(start - entry.fileOffset),
          },
          type: "set",
        };
      } else {
        yield { key: entry.fileOffset, type: "delete" };
      }

      if (entryEnd > end) {
        yield {
          entry: {
            ...entry,
            byteLength: Number(entryEnd - end),
            dataOffset: entry.dataOffset + Number(end - entry.fileOffset),
            fileOffset: end,
          },
          type: "set",
        };
      }
    }
  }

  // Apply one logical range replacement through one bounded tree-update stream.
  // A replacement entry wins when the overlap-removal scan targets the same
  // File Offset; CanonicalBTreeWriter requires each batch key to be unique.
  const replacementOffsets = new Set<FileOffset>(newEntries.map(entry => entry.fileOffset));
  async function* replacementChanges(): AsyncIterable<FileExtentTreeMutation> {
    for await (const mutation of removalsAndBoundaryFragments()) {
      const key = (() => {
        switch (mutation.type) {
        case "delete": return mutation.key;
        case "set": return mutation.entry.fileOffset;
        default: return mutation satisfies never;
        }
      })();
      if (!replacementOffsets.has(key)) yield mutation;
    }
    for (const entry of newEntries) yield { entry, type: "set" };
  }

  return await applyMutationBatches({
    changes: replacementChanges(),
    limits,
    pageStore,
    rootReference,
  });
}

type FileExtentRangeReplacement = Readonly<{
  end: FileOffset;
  newEntries: readonly FileExtentLeafEntry[];
  start: FileOffset;
}>;

function replaceCapturedExtentRange({ end, entries, newEntries, start }: {
  end: FileOffset;
  entries: readonly FileExtentLeafEntry[];
  newEntries: readonly FileExtentLeafEntry[];
  start: FileOffset;
}): FileExtentLeafEntry[] {
  const next: FileExtentLeafEntry[] = [];
  for (const entry of entries) {
    const entryEnd = entry.fileOffset + BigInt(entry.byteLength);
    if (entryEnd <= start || entry.fileOffset >= end) {
      next.push(entry);
      continue;
    }
    if (entry.fileOffset < start) {
      next.push({
        ...entry,
        byteLength: Number(start - entry.fileOffset),
      });
    }
    if (entryEnd > end) {
      next.push({
        ...entry,
        byteLength: Number(entryEnd - end),
        dataOffset: entry.dataOffset + Number(end - entry.fileOffset),
        fileOffset: end,
      });
    }
  }
  next.push(...newEntries);
  next.sort((left, right) => left.fileOffset < right.fileOffset ? -1 : left.fileOffset > right.fileOffset ? 1 : 0);
  return next;
}

async function tryReplaceExtentRangesTogether({ limits, pageStore, replacements, rootReference }: {
  limits: FileContentMutationLimits;
  pageStore: FileExtentTreePageStore;
  replacements: readonly FileExtentRangeReplacement[];
  rootReference: HomeRecordReference;
}): Promise<HomeRecordReference | undefined> {
  if (replacements.length < 2) return undefined;
  const maximumBatchSize = requirePositiveBatchSize({ limits });
  if (replacements.length > maximumBatchSize) return undefined;
  const doubledCaptureBound = maximumBatchSize * 2;
  const maximumCapturedEntries = Number.isSafeInteger(doubledCaptureBound)
    ? doubledCaptureBound
    : maximumBatchSize;
  const capturedByOffset = new Map<FileOffset, FileExtentLeafEntry>();

  // Capture only extents actually touched by pending writes. A min/max span
  // scan would turn two far-apart random writes into an unbounded traversal of
  // every extent between them. Independent floor scans keep memory proportional
  // to the bounded write batch while still sharing one immutable-root update.
  for (const replacement of replacements) {
    for await (const entry of fileExtentEntriesFromFloor({
      fileOffset: replacement.start,
      pageStore,
      rootReference,
    })) {
      const entryEnd = entry.fileOffset + BigInt(entry.byteLength);
      if (entryEnd <= replacement.start) continue;
      if (entry.fileOffset >= replacement.end) break;
      capturedByOffset.set(entry.fileOffset, entry);
      if (capturedByOffset.size > maximumCapturedEntries) return undefined;
    }
  }

  let merged = [...capturedByOffset.values()]
    .sort((left, right) => left.fileOffset < right.fileOffset ? -1 : left.fileOffset > right.fileOffset ? 1 : 0);
  const maximumPayload = HIZOFS_V1_FORMAT_CONSTANTS.limits.fileDataPlaintextBytes;
  const maximumPackedFragments = Math.ceil(MAXIMUM_PREPARED_EXTENT_PLAINTEXT_BYTES / maximumPayload);
  const maximumMergedEntries = maximumCapturedEntries + replacements.length * 3 + maximumPackedFragments;
  if (!Number.isSafeInteger(maximumMergedEntries)) return undefined;
  for (const replacement of replacements) {
    merged = replaceCapturedExtentRange({
      end: replacement.end,
      entries: merged,
      newEntries: replacement.newEntries,
      start: replacement.start,
    });
    if (merged.length > maximumMergedEntries) return undefined;
  }

  const finalByOffset = new Map(merged.map(entry => [entry.fileOffset, entry] as const));
  const sameEntry = ({ left, right }: {
    left: FileExtentLeafEntry;
    right: FileExtentLeafEntry;
  }): boolean => left.byteLength === right.byteLength
    && left.dataOffset === right.dataOffset
    && left.fileOffset === right.fileOffset
    && sameRecordReferenceFields({ left: left.fileDataHomeRef, right: right.fileDataHomeRef });
  function* combinedChanges(): Iterable<FileExtentTreeMutation> {
    for (const original of capturedByOffset.values()) {
      if (!finalByOffset.has(original.fileOffset)) yield { key: original.fileOffset, type: "delete" };
    }
    for (const entry of merged) {
      const original = capturedByOffset.get(entry.fileOffset);
      if (original === undefined || !sameEntry({ left: original, right: entry })) {
        yield { entry, type: "set" };
      }
    }
  }

  // Multiple disjoint/overlapping writes now share one bounded B+tree mutation
  // stream. If any capture/output bound is exceeded, the caller uses the proven
  // sequential range replacement path instead of widening memory or traversal.
  return await applyMutationBatches({
    changes: combinedChanges(),
    limits,
    pageStore,
    rootReference,
  });
}

async function trimExtentTree({ limits, pageStore, rootReference, targetFileSize }: {
  limits: FileContentMutationLimits;
  pageStore: FileExtentTreePageStore;
  rootReference: HomeRecordReference;
  targetFileSize: FileOffset;
}): Promise<HomeRecordReference> {
  // Truncating to zero does not need any old extent content. Publishing one
  // fresh empty root preserves immutable old generations/snapshots while
  // avoiding an O(extent-count) read/delete COW walk whose final state is
  // always the same canonical empty File Extent tree.
  if (targetFileSize === 0n) return await emptyExtentRoot({ pageStore });

  async function* changes(): AsyncIterable<FileExtentTreeMutation> {
    for await (const entry of fileExtentEntriesFromFloor({
      fileOffset: targetFileSize,
      pageStore,
      rootReference,
    })) {
      const entryEnd = entry.fileOffset + BigInt(entry.byteLength);
      if (entryEnd <= targetFileSize) continue;
      if (entry.fileOffset < targetFileSize) {
        yield {
          entry: {
            ...entry,
            byteLength: Number(targetFileSize - entry.fileOffset),
          },
          type: "set",
        };
        continue;
      }
      yield { key: entry.fileOffset, type: "delete" };
    }
  }
  return await applyMutationBatches({ changes: changes(), limits, pageStore, rootReference });
}

async function inlinePromotionRoot({ limits, plan, port }: {
  limits: FileContentMutationLimits;
  plan: Extract<FileWritePlan, { action: "promote_inline_to_extent" }>;
  port: FileContentMutationPort;
}): Promise<HomeRecordReference> {
  const root = await emptyExtentRoot({ pageStore: port.extentPageStore });
  const writeEnd = plan.writeOffset + BigInt(plan.writeBytes.byteLength);
  const preserved: FileExtentLeafEntry[] = [];
  if (plan.writeOffset > 0n && plan.sourceInlineBytes.byteLength > 0) {
    const leftLength = plan.writeOffset >= BigInt(plan.sourceInlineBytes.byteLength)
      ? plan.sourceInlineBytes.byteLength
      : Number(plan.writeOffset);
    preserved.push(...await appendExtentBytes({
      bytes: plan.sourceInlineBytes.subarray(0, leftLength),
      fileOffset: createFileOffset({ value: 0n }),
      port,
    }));
  }
  if (writeEnd < BigInt(plan.sourceInlineBytes.byteLength)) {
    const rightOffset = Number(writeEnd);
    preserved.push(...await appendExtentBytes({
      bytes: plan.sourceInlineBytes.subarray(rightOffset),
      fileOffset: createFileOffset({ value: writeEnd }),
      port,
    }));
  }
  const written = await appendExtentBytes({ bytes: plan.writeBytes, fileOffset: plan.writeOffset, port });
  return await applyMutationBatches({
    changes: [...preserved, ...written].map(entry => ({ entry, type: "set" as const })),
    limits,
    pageStore: port.extentPageStore,
    rootReference: root,
  });
}

export async function prepareFileWriteMutationWithAppendTailWitness({
  appendTailWitness,
  limits,
  plan,
  port,
  source,
}: {
  appendTailWitness: FileExtentAppendTailWitness | undefined;
  limits: FileContentMutationLimits;
  plan: FileWritePlan;
  port: FileContentMutationPort;
  source: FileInodeEntry;
}): Promise<FileWriteMutationWithAppendTailWitnessResult> {
  sameInodePlan({ inode: source, plannedInodeNumber: plan.inodeNumber, plannedRevision: plan.nextInodeRevision });
  switch (plan.action) {
  case "write_inline": return Object.freeze({
    appendTailWitness: undefined,
    inode: updatedFileInode({
      content: { bytes: new Uint8Array(plan.bytes), type: "inline" },
      plan,
      source,
    }),
  });
  case "promote_inline_to_extent": {
    const root = await inlinePromotionRoot({ limits, plan, port });
    return Object.freeze({
      appendTailWitness: createFileExtentAppendTailWitness({
        fileSize: plan.targetFileSize,
        rootReference: root,
      }),
      inode: updatedFileInode({
        content: { extentTreeRootHomeRef: root, type: "tree" },
        plan,
        source,
      }),
    });
  }
  case "copy_on_write_extent_range": {
    const written = await appendExtentBytes({ bytes: plan.writeBytes, fileOffset: plan.writeOffset, port });
    const isLogicalTailAppend = plan.writeOffset === source.fileSize
      && plan.targetFileSize > source.fileSize;
    const extendsProvenAppendTail = isLogicalTailAppend
      && matchesFileExtentAppendTailWitness({ source, witness: appendTailWitness });
    const root = extendsProvenAppendTail
      ? await applyMutationBatches({
        changes: written.map(entry => ({ entry, type: "set" as const })),
        limits,
        pageStore: port.extentPageStore,
        rootReference: plan.sourceExtentTreeRootHomeRef,
      })
      : await replaceExtentRange({
        end: createFileOffset({ value: plan.writeOffset + BigInt(plan.writeBytes.byteLength) }),
        limits,
        newEntries: written,
        pageStore: port.extentPageStore,
        rootReference: plan.sourceExtentTreeRootHomeRef,
        start: plan.writeOffset,
      });
    return Object.freeze({
      // A general overlap-checked tail append is slower than the witness fast
      // path, but once it succeeds this mutation owns the resulting root and
      // can re-establish the same append-only proof for the next operation.
      appendTailWitness: isLogicalTailAppend
        ? createFileExtentAppendTailWitness({ fileSize: plan.targetFileSize, rootReference: root })
        : undefined,
      inode: updatedFileInode({
        content: { extentTreeRootHomeRef: root, type: "tree" },
        plan,
        source,
      }),
    });
  }
  default: return plan satisfies never;
  }
}

export async function prepareFileWriteMutation({ limits, plan, port, source }: {
  limits: FileContentMutationLimits;
  plan: FileWritePlan;
  port: FileContentMutationPort;
  source: FileInodeEntry;
}): Promise<FileInodeEntry> {
  return (await prepareFileWriteMutationWithAppendTailWitness({
    appendTailWitness: undefined,
    limits,
    plan,
    port,
    source,
  })).inode;
}

export async function prepareFileTruncateMutation({ limits, plan, port, source }: {
  limits: FileContentMutationLimits;
  plan: FileTruncatePlan;
  port: FileContentMutationPort;
  source: FileInodeEntry;
}): Promise<FileInodeEntry> {
  sameInodePlan({ inode: source, plannedInodeNumber: plan.inodeNumber, plannedRevision: plan.nextInodeRevision });
  switch (plan.action) {
  case "write_inline": return updatedFileInode({
    content: { bytes: new Uint8Array(plan.bytes), type: "inline" },
    plan,
    source,
  });
  case "promote_inline_to_extent": {
    const root = await emptyExtentRoot({ pageStore: port.extentPageStore });
    const extents = await appendExtentBytes({
      bytes: plan.inlinePrefixBytes,
      fileOffset: createFileOffset({ value: 0n }),
      port,
    });
    const nextRoot = await applyMutationBatches({
      changes: extents.map(entry => ({ entry, type: "set" as const })),
      limits,
      pageStore: port.extentPageStore,
      rootReference: root,
    });
    return updatedFileInode({
      content: { extentTreeRootHomeRef: nextRoot, type: "tree" },
      plan,
      source,
    });
  }
  case "reuse_extent_tree": return updatedFileInode({
    content: { extentTreeRootHomeRef: plan.sourceExtentTreeRootHomeRef, type: "tree" },
    plan,
    source,
  });
  case "trim_extent_tree": return updatedFileInode({
    content: {
      extentTreeRootHomeRef: await trimExtentTree({
        limits,
        pageStore: port.extentPageStore,
        rootReference: plan.sourceExtentTreeRootHomeRef,
        targetFileSize: plan.targetFileSize,
      }),
      type: "tree",
    },
    plan,
    source,
  });
  default: return plan satisfies never;
  }
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
  replaceExtentRange,
  trimExtentTree,
};
