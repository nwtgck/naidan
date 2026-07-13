import { describe, expect, it } from 'vitest';
import {
  decodeEncryptedOpfsRecord,
  encodeEncryptedOpfsRecord,
} from './record';

describe('EncryptedOpfs record framing', () => {
  it('keeps JSON metadata separate from raw binary payload bytes', () => {
    const plaintext = encodeEncryptedOpfsRecord({
      kind: 'file_inode',
      recordVersion: 1,
      metadata: {
        nodeId: 'node',
        size: 3,
      },
      binaryPayload: new Uint8Array([0, 255, 1]),
    });

    expect(decodeEncryptedOpfsRecord({ plaintext })).toEqual({
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
    const plaintext = encodeEncryptedOpfsRecord({
      kind: 'commit',
      recordVersion: 1,
      metadata: {},
      binaryPayload: new Uint8Array(),
    });
    plaintext[0] = 255;
    expect(() => decodeEncryptedOpfsRecord({ plaintext })).toThrow(
      'record kind is unsupported',
    );
  });

  it('rejects inconsistent payload lengths', () => {
    const plaintext = encodeEncryptedOpfsRecord({
      kind: 'file_chunk',
      recordVersion: 1,
      metadata: {},
      binaryPayload: new Uint8Array([1]),
    });
    plaintext[15] = 2;
    expect(() => decodeEncryptedOpfsRecord({ plaintext })).toThrow(
      'lengths do not match',
    );
  });
});
