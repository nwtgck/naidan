import { describe, expect, it } from 'vitest';
import { assertSegmentId, copyBinaryId, parseCredentialSlotId, parseFileSystemId, parseMutationId, parsePublicationId, parseSegmentId } from '@/00-storage/service/hizofs/00-format/v1/identifiers';
import {
  assertSegmentPathBinding,
  HIZOFS_SUPERBLOCK_FILES,
  HIZOFS_UNLOCK_ENVELOPE_FILES,
  parseSegmentClassDirectoryName,
  parseSegmentFilename,
  parseSegmentShardDirectoryName,
  segmentIdToFilename,
  segmentIdToRelativePath,
  segmentIdToShard,
} from '@/00-storage/service/hizofs/00-format/v1/paths';
import { fileSystemIdToNaidanContainerToken, parseNaidanContainerToken } from '@/00-storage/service/naidan-persistence-control/00-format/container-path';

describe('HizoFS V1 identifier and path contracts', () => {
  it('accepts only the exact 21-character Nano ID profile', () => {
    const value = 'Abcdefghij_klmnopq-12';
    expect(parseFileSystemId({ value })).toBe(value);
    expect(parseCredentialSlotId({ value })).toBe(value);
    expect(() => parseFileSystemId({ value: value.slice(1) })).toThrow('21-character');
    expect(() => parseFileSystemId({ value: '!'.repeat(21) })).toThrow('Nano ID');
  });

  it('copies and rejects invalid 16-byte random identities', () => {
    const source = Uint8Array.from({ length: 16 }, (_, index) => index + 1);
    const segment = parseSegmentId({ bytes: source });
    source[0] = 255;
    expect(segment[0]).toBe(1);
    expect(() => assertSegmentId({ id: segment })).not.toThrow();
    expect(copyBinaryId({ id: parseMutationId({ bytes: segment }) })).toEqual(segment);
    expect(copyBinaryId({ id: parsePublicationId({ bytes: segment }) })).toEqual(segment);
    expect(() => parseSegmentId({ bytes: new Uint8Array(15) })).toThrow('16 bytes');
    expect(() => parseSegmentId({ bytes: new Uint8Array(16) })).toThrow('all-zero');
  });

  it('uses registry-owned fixed authority filenames', () => {
    expect(HIZOFS_UNLOCK_ENVELOPE_FILES).toEqual(['unlock-0.json', 'unlock-1.json']);
    expect(HIZOFS_SUPERBLOCK_FILES).toEqual(['superblock-0.enc', 'superblock-1.enc']);
  });

  it('derives segment filename and shard from canonical raw bytes', () => {
    const bytes = Uint8Array.from({ length: 16 }, (_, index) => index + 1);
    bytes[15] = 0xaf;
    const id = parseSegmentId({ bytes });
    expect(segmentIdToShard({ id })).toBe('af');
    expect(parseSegmentClassDirectoryName({ value: 'data' })).toBe('data');
    expect(parseSegmentClassDirectoryName({ value: 'metadata' })).toBe('metadata');
    expect(parseSegmentShardDirectoryName({ value: 'af' })).toBe('af');
    expect(() => parseSegmentClassDirectoryName({ value: 'unknown' })).toThrow('registry-owned');
    expect(() => parseSegmentShardDirectoryName({ value: 'AF' })).toThrow('lowercase');
    expect(() => parseSegmentShardDirectoryName({ value: '0' })).toThrow('two lowercase');
    expect(segmentIdToFilename({ id })).toBe('0102030405060708090a0b0c0d0e0faf.enc');
    expect(parseSegmentFilename({ value: segmentIdToFilename({ id }) })).toEqual(id);
    expect(segmentIdToRelativePath({ id, segmentClass: 'metadata' })).toBe('segments/metadata/af/0102030405060708090a0b0c0d0e0faf.enc');
    expect(() => assertSegmentPathBinding({ id, segmentClass: 'metadata', relativePath: 'segments/metadata/ae/wrong.enc' })).toThrow('does not match');
    expect(() => parseSegmentFilename({ value: '0102030405060708090A0B0C0D0E0FAF.enc' })).toThrow('lowercase');
  });

  it('roundtrips the Naidan canonical container token without case-folding the ID', () => {
    const id = parseFileSystemId({ value: 'Abcdefghij_klmnopq-12' });
    const token = fileSystemIdToNaidanContainerToken({ id });
    expect(token).toBe('fs-4162636465666768696a5f6b6c6d6e6f70712d3132.hizofs');
    expect(parseNaidanContainerToken({ value: token })).toBe(id);
    expect(() => parseNaidanContainerToken({ value: token.toUpperCase() })).toThrow();
  });
});
