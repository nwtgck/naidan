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

async function trimExtentTree({ limits, pageStore, rootReference, targetFileSize }: {
  limits: FileContentMutationLimits;
  pageStore: FileExtentTreePageStore;
  rootReference: HomeRecordReference;
  targetFileSize: FileOffset;
}): Promise<HomeRecordReference> {
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
    const extendsProvenAppendTail = plan.writeOffset === source.fileSize
      && plan.targetFileSize > source.fileSize
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
      appendTailWitness: extendsProvenAppendTail
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
