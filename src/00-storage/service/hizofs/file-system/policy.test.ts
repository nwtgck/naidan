import { describe, expect, it } from 'vitest';
import { encodeHizoFSRecord } from '@/00-storage/service/hizofs/format/record';
import { DEFAULT_HIZOFS_POLICY } from './policy';

describe('HizoFS runtime policy', () => {
  it('uses the measured bounded write-concurrency default', () => {
    expect(DEFAULT_HIZOFS_POLICY.fileChunkWriteConcurrency).toBe(2);
    expect(
      DEFAULT_HIZOFS_POLICY.fileChunkSize
        * DEFAULT_HIZOFS_POLICY.fileChunkWriteConcurrency,
    ).toBe(2 * 1024 * 1024);
  });

  it('uses smaller inode-index pages without shrinking directory or extent pages', () => {
    expect(DEFAULT_HIZOFS_POLICY.inodeIndexPageEntryLimit).toBe(32);
    expect(DEFAULT_HIZOFS_POLICY.directoryIndexPageEntryLimit).toBe(64);
    expect(DEFAULT_HIZOFS_POLICY.fileExtentIndexPageEntryLimit).toBe(64);
  });

  it('bounds the decoded inode-index page cache independently', () => {
    expect(DEFAULT_HIZOFS_POLICY.decodedInodeIndexPageCacheEntryLimit).toBe(128);
    expect(DEFAULT_HIZOFS_POLICY.decodedInodeIndexPageCacheEntryLimit)
      .toBeLessThan(DEFAULT_HIZOFS_POLICY.metadataObjectCacheEntryLimit);
  });

  it('retains one complete 16-chunk read working set without admitting a 17th chunk', () => {
    const encodedChunkByteLength = encodeHizoFSRecord({
      kind: 'file_chunk',
      recordVersion: 1,
      metadata: {},
      binaryPayload: new Uint8Array(DEFAULT_HIZOFS_POLICY.fileChunkSize),
    }).byteLength;

    expect(DEFAULT_HIZOFS_POLICY.fileChunkCacheByteLimit)
      .toBeGreaterThanOrEqual(encodedChunkByteLength * 16);
    expect(DEFAULT_HIZOFS_POLICY.fileChunkCacheByteLimit)
      .toBeLessThan(encodedChunkByteLength * 17);
  });
});
