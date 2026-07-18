import { describe, expect, it } from 'vitest';
import { encodeHizoFSRecord } from '@/00-storage/service/hizofs/format/record';
import { DEFAULT_HIZOFS_POLICY } from './policy';

describe('HizoFS runtime policy', () => {
  it('retains one complete 64-chunk read working set without admitting a 65th chunk', () => {
    const encodedChunkByteLength = encodeHizoFSRecord({
      kind: 'file_chunk',
      recordVersion: 1,
      metadata: {},
      binaryPayload: new Uint8Array(DEFAULT_HIZOFS_POLICY.fileChunkSize),
    }).byteLength;

    expect(DEFAULT_HIZOFS_POLICY.fileChunkCacheByteLimit)
      .toBeGreaterThanOrEqual(encodedChunkByteLength * 64);
    expect(DEFAULT_HIZOFS_POLICY.fileChunkCacheByteLimit)
      .toBeLessThan(encodedChunkByteLength * 65);
  });
});
