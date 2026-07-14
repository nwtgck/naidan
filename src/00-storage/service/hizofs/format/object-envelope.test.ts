import { describe, expect, it } from 'vitest';
import {
  decodeHizoFSObjectEnvelope,
  encodeHizoFSObjectEnvelope,
} from './object-envelope';

describe('HizoFS object envelope', () => {
  it('round-trips nonce and ciphertext with the HizoFS magic', () => {
    const physical = encodeHizoFSObjectEnvelope({
      nonce: new Uint8Array(12).fill(3),
      ciphertext: new Uint8Array(24).fill(7),
    });

    expect([...physical.slice(0, 8)]).toEqual([
      0x48, 0x49, 0x5a, 0x4f, 0x46, 0x53, 0x00, 0x00,
    ]);
    expect(decodeHizoFSObjectEnvelope({ physical })).toEqual({
      formatVersion: 1,
      nonce: new Uint8Array(12).fill(3),
      ciphertext: new Uint8Array(24).fill(7),
    });
  });

  it('rejects truncated and length-mismatched envelopes', () => {
    expect(() => decodeHizoFSObjectEnvelope({
      physical: new Uint8Array(20),
    })).toThrow('truncated');

    const physical = encodeHizoFSObjectEnvelope({
      nonce: new Uint8Array(12),
      ciphertext: new Uint8Array(16),
    });
    physical[31] = 17;
    expect(() => decodeHizoFSObjectEnvelope({ physical })).toThrow(
      'ciphertext length does not match',
    );
  });

  it('rejects an unsupported envelope version', () => {
    const physical = encodeHizoFSObjectEnvelope({
      nonce: new Uint8Array(12),
      ciphertext: new Uint8Array(16),
    });
    physical[9] = 2;
    expect(() => decodeHizoFSObjectEnvelope({ physical })).toThrow(
      'version is unsupported',
    );
  });
});
