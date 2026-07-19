import { describe, expect, it } from 'vitest';
import {
  decodeHizoFSRecord,
  decodeHizoFSRecordBinaryPayloadRange,
  encodeHizoFSRecord,
} from './record';

describe('HizoFS record framing', () => {
  it('keeps JSON metadata separate from raw binary payload bytes', () => {
    const plaintext = encodeHizoFSRecord({
      kind: 'file_inode',
      recordVersion: 1,
      metadata: {
        nodeId: 'node',
        size: 3,
      },
      binaryPayload: new Uint8Array([0, 255, 1]),
    });

    expect(decodeHizoFSRecord({ plaintext })).toEqual({
      kind: 'file_inode',
      recordVersion: 1,
      metadata: {
        nodeId: 'node',
        size: 3,
      },
      binaryPayload: new Uint8Array([0, 255, 1]),
    });
  });

  it('rejects an unknown record kind', () => {
    const plaintext = encodeHizoFSRecord({
      kind: 'commit',
      recordVersion: 1,
      metadata: {},
      binaryPayload: new Uint8Array(),
    });
    plaintext[0] = 255;
    expect(() => decodeHizoFSRecord({ plaintext })).toThrow(
      'record kind is unsupported',
    );
  });

  it('rejects inconsistent payload lengths', () => {
    const plaintext = encodeHizoFSRecord({
      kind: 'file_chunk',
      recordVersion: 1,
      metadata: {},
      binaryPayload: new Uint8Array([1]),
    });
    plaintext[15] = 2;
    expect(() => decodeHizoFSRecord({ plaintext })).toThrow(
      'lengths do not match',
    );
  });

  it('copies only the requested binary payload range', () => {
    const plaintext = encodeHizoFSRecord({
      kind: 'file_chunk',
      recordVersion: 1,
      metadata: {},
      binaryPayload: new Uint8Array([1, 2, 3, 4, 5]),
    });
    const decoded = decodeHizoFSRecordBinaryPayloadRange({
      plaintext,
      offset: 1,
      length: 2,
    });

    expect(decoded).toEqual({
      kind: 'file_chunk',
      recordVersion: 1,
      metadata: {},
      binaryPayload: new Uint8Array([2, 3]),
      binaryPayloadByteLength: 5,
    });
    decoded.binaryPayload[0] = 99;
    expect(decodeHizoFSRecord({ plaintext }).binaryPayload).toEqual(
      new Uint8Array([1, 2, 3, 4, 5]),
    );
    expect(decodeHizoFSRecordBinaryPayloadRange({
      plaintext,
      offset: 99,
      length: 2,
    }).binaryPayload).toEqual(new Uint8Array());
    expect(() => decodeHizoFSRecordBinaryPayloadRange({
      plaintext,
      offset: -1,
      length: 1,
    })).toThrow('offset must be a non-negative safe integer');
  });

});
