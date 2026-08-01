import { describe, expect, it } from 'vitest';
import { createRecordFrameHeader } from '@/00-storage/service/hizofs/00-format/v1/binary/record-frame-header';
import { createHomeRecordReference, createPhysicalRecordReference } from '@/00-storage/service/hizofs/00-format/v1/binary/record-reference';
import { HIZOFS_V1_FORMAT_CONSTANTS } from '@/00-storage/service/hizofs/00-format/v1/format-constants';
import { parseMutationId, parseSegmentId } from '@/00-storage/service/hizofs/00-format/v1/identifiers';
import { createFileSystemCommitPayload } from '@/00-storage/service/hizofs/00-format/v1/records/file-system-commit';
import {
  validateActiveCommitAuthority,
  validateExtentAgainstReferencedData,
  validateFallbackCommitAuthority,
  validatePhysicalOnlyRecordIdentity,
  validateRelocationMapping,
} from '@/00-storage/service/hizofs/00-format/v1/semantic-validation/record-payloads';
import {
  createCommitSequence,
  createFileOffset,
  createInodeNumber,
  createSubvolumeId,
  createUInt64,
} from '@/00-storage/service/hizofs/00-format/v1/scalars';

const KINDS = HIZOFS_V1_FORMAT_CONSTANTS.recordKinds;
const segmentId = ({ seed }: { seed: number }) => parseSegmentId({
  bytes: Uint8Array.from({ length: 16 }, (_, index) => (seed + index) & 0xff),
});
const mutationId = ({ seed }: { seed: number }) => parseMutationId({ bytes: new Uint8Array(16).fill(seed) });
const homeRef = ({ kind, offset = 64n, seed = 1 }: { kind: number; offset?: bigint; seed?: number }) =>
  createHomeRecordReference({ fields: {
    byteOffset: createUInt64({ value: offset }),
    frameLength: 96,
    recordKind: kind,
    segmentId: segmentId({ seed }),
  } });

const commit = ({ sequence = 3n, mutationSeed = 7 }: { mutationSeed?: number; sequence?: bigint } = {}) =>
  createFileSystemCommitPayload({ payload: {
    commitSequence: createCommitSequence({ value: sequence }),
    mutationId: mutationId({ seed: mutationSeed }),
    nestedSubvolumeTableRootHomeRef: null,
    nextInodeNumber: createInodeNumber({ value: 2n }),
    nextSubvolumeId: createSubvolumeId({ value: 2n }),
    rootDirectoryInodeNumber: createInodeNumber({ value: 1n }),
    rootInodeTableRootHomeRef: homeRef({ kind: KINDS.inode_table_page }),
  } });

describe('record payload semantic validation', () => {
  it('binds active and fallback Commit authority exactly', () => {
    validateActiveCommitAuthority({
      activeCommitSequence: createCommitSequence({ value: 3n }),
      activeMutationId: mutationId({ seed: 7 }),
      commit: commit(),
    });
    validateFallbackCommitAuthority({
      activeCommitSequence: createCommitSequence({ value: 4n }),
      commit: commit(),
    });
    expect(() => validateActiveCommitAuthority({
      activeCommitSequence: createCommitSequence({ value: 3n }),
      activeMutationId: mutationId({ seed: 8 }),
      commit: commit(),
    })).toThrow('Mutation ID');
    expect(() => validateFallbackCommitAuthority({
      activeCommitSequence: createCommitSequence({ value: 5n }),
      commit: commit(),
    })).toThrow('active minus one');
  });

  it('checks extents against authenticated File Data length and inode fileSize', () => {
    const entry = {
      byteLength: 8,
      dataOffset: 4,
      fileDataHomeRef: homeRef({ kind: KINDS.file_data }),
      fileOffset: createFileOffset({ value: 10n }),
    };
    validateExtentAgainstReferencedData({
      entry,
      fileDataPlaintextLength: 12,
      inodeFileSize: createFileOffset({ value: 18n }),
    });
    expect(() => validateExtentAgainstReferencedData({
      entry,
      fileDataPlaintextLength: 11,
      inodeFileSize: createFileOffset({ value: 18n }),
    })).toThrow('authenticated File Data');
    expect(() => validateExtentAgainstReferencedData({
      entry,
      fileDataPlaintextLength: 12,
      inodeFileSize: createFileOffset({ value: 17n }),
    })).toThrow('fileSize');
  });

  it('binds relocation mappings to logical identity, kind, and frame length', () => {
    const homeReference = homeRef({ kind: KINDS.directory_page, seed: 4 });
    const mappedPhysicalReference = createPhysicalRecordReference({ fields: {
      ...homeReference,
      byteOffset: createUInt64({ value: 160n }),
      segmentId: segmentId({ seed: 9 }),
    } });
    const authenticatedHeader = createRecordFrameHeader({
      flags: 0,
      homeOffset: homeReference.byteOffset,
      homeSegmentId: homeReference.segmentId,
      nonce: new Uint8Array(12).fill(1),
      plaintextLength: 16,
      recordKind: homeReference.recordKind,
    });
    expect(authenticatedHeader.frameLength).toBe(homeReference.frameLength);
    validateRelocationMapping({ authenticatedHeader, homeReference, mappedPhysicalReference });

    expect(() => validateRelocationMapping({
      authenticatedHeader: { ...authenticatedHeader, homeOffset: createUInt64({ value: 160n }) },
      homeReference,
      mappedPhysicalReference,
    })).toThrow('home identity');
    expect(() => validateRelocationMapping({
      authenticatedHeader,
      homeReference,
      mappedPhysicalReference: createPhysicalRecordReference({ fields: {
        ...mappedPhysicalReference,
        recordKind: KINDS.file_data,
      } }),
    })).toThrow('logical record kind');
  });
  it('binds physical-only relocation pages to their exact physical location', () => {
    const physicalSegmentId = segmentId({ seed: 12 });
    const physicalOffset = createUInt64({ value: 160n });
    const authenticatedHeader = createRecordFrameHeader({
      flags: HIZOFS_V1_FORMAT_CONSTANTS.flags.recordPhysicalOnly,
      homeOffset: physicalOffset,
      homeSegmentId: physicalSegmentId,
      nonce: new Uint8Array(12).fill(4),
      plaintextLength: 16,
      recordKind: KINDS.relocation_index_page,
    });

    validatePhysicalOnlyRecordIdentity({ authenticatedHeader, physicalOffset, physicalSegmentId });
    expect(() => validatePhysicalOnlyRecordIdentity({
      authenticatedHeader,
      physicalOffset: createUInt64({ value: 168n }),
      physicalSegmentId,
    })).toThrow('physical location');
    expect(() => validatePhysicalOnlyRecordIdentity({
      authenticatedHeader,
      physicalOffset,
      physicalSegmentId: segmentId({ seed: 13 }),
    })).toThrow('physical location');
  });

});

export const TEST_ONLY = {};
