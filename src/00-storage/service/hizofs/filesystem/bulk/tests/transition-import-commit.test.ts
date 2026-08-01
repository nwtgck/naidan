import {
  HIZOFS_V1_FORMAT_CONSTANTS,
  createCommitSequence,
  createFileSystemCommitPayload,
  createHomeRecordReference,
  createInodeNumber,
  createSubvolumeId,
  createUInt64,
  parseMutationId,
  parseSegmentId,
} from "@/00-storage/service/hizofs/00-format";
import { prepareTransitionImportCommit } from "@/00-storage/service/hizofs/filesystem/bulk/transition-import-commit";
import { describe, expect, it } from "vitest";

function reference({ byteOffset, recordKind }: { byteOffset: bigint; recordKind: number }) {
  return createHomeRecordReference({ fields: {
    byteOffset: createUInt64({ value: byteOffset }),
    frameLength: 96,
    recordKind,
    segmentId: parseSegmentId({ bytes: new Uint8Array(16).fill(Number(byteOffset % 251n) + 1) }),
  } });
}

function mutationId({ byte }: { byte: number }) {
  return parseMutationId({ bytes: new Uint8Array(16).fill(byte) });
}

describe("transition import Commit preparation", () => {
  const baseCommit = createFileSystemCommitPayload({ payload: {
    commitSequence: createCommitSequence({ value: 7n }),
    mutationId: mutationId({ byte: 1 }),
    nestedSubvolumeTableRootHomeRef: reference({
      byteOffset: 4_096n,
      recordKind: HIZOFS_V1_FORMAT_CONSTANTS.recordKinds.nested_subvolume_table_page,
    }),
    nextInodeNumber: createInodeNumber({ value: 11n }),
    nextSubvolumeId: createSubvolumeId({ value: 5n }),
    rootDirectoryInodeNumber: createInodeNumber({ value: 1n }),
    rootInodeTableRootHomeRef: reference({
      byteOffset: 1_024n,
      recordKind: HIZOFS_V1_FORMAT_CONSTANTS.recordKinds.inode_table_page,
    }),
  } });

  it("changes only the imported namespace authority and next generation fields", () => {
    const rootInodeTableRootHomeRef = reference({
      byteOffset: 8_192n,
      recordKind: HIZOFS_V1_FORMAT_CONSTANTS.recordKinds.inode_table_page,
    });
    const prepared = prepareTransitionImportCommit({
      baseCommit,
      mutationId: mutationId({ byte: 2 }),
      sealed: {
        nextInodeNumber: createInodeNumber({ value: 31n }),
        rootDirectoryInodeNumber: createInodeNumber({ value: 9n }),
        rootInodeTableRootHomeRef,
      },
    });

    expect(prepared).toEqual({
      ...baseCommit,
      commitSequence: createCommitSequence({ value: 8n }),
      mutationId: mutationId({ byte: 2 }),
      nextInodeNumber: createInodeNumber({ value: 31n }),
      rootDirectoryInodeNumber: createInodeNumber({ value: 9n }),
      rootInodeTableRootHomeRef,
    });
  });

  it("rejects reuse of the base Mutation ID", () => {
    expect(() => prepareTransitionImportCommit({
      baseCommit,
      mutationId: baseCommit.mutationId,
      sealed: {
        nextInodeNumber: createInodeNumber({ value: 12n }),
        rootDirectoryInodeNumber: createInodeNumber({ value: 1n }),
        rootInodeTableRootHomeRef: baseCommit.rootInodeTableRootHomeRef,
      },
    })).toThrow("fresh Mutation ID");
  });
});
