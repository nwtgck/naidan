import { describe, expect, it } from 'vitest';
import {
  decodeEncryptedOpfsObjectEnvelope,
  encodeEncryptedOpfsObjectEnvelope,
} from './object-envelope';

describe('EncryptedOpfs object envelope', () => {
  it('round-trips nonce and ciphertext with a fixed non-Naidan magic', () => {
    const physical = encodeEncryptedOpfsObjectEnvelope({
      nonce: new Uint8Array(12).fill(3),
      ciphertext: new Uint8Array(24).fill(7),
    });

    expect([...physical.slice(0, 8)]).toEqual([
      0x45, 0x4e, 0x43, 0x4f, 0x50, 0x46, 0x53, 0x00,
    ]);
    expect(decodeEncryptedOpfsObjectEnvelope({ physical })).toEqual({
      formatVersion: 1,
      nonce: new Uint8Array(12).fill(3),
      ciphertext: new Uint8Array(24).fill(7),
    });
  });

  it('rejects truncated and length-mismatched envelopes', () => {
    expect(() => decodeEncryptedOpfsObjectEnvelope({
      physical: new Uint8Array(20),
    })).toThrow('truncated');

    const physical = encodeEncryptedOpfsObjectEnvelope({
      nonce: new Uint8Array(12),
      ciphertext: new Uint8Array(16),
    });
    physical[31] = 17;
    expect(() => decodeEncryptedOpfsObjectEnvelope({ physical })).toThrow(
      'ciphertext length does not match',
    );
  });

  it('rejects an unsupported envelope version', () => {
    const physical = encodeEncryptedOpfsObjectEnvelope({
      nonce: new Uint8Array(12),
      ciphertext: new Uint8Array(16),
    });
    physical[9] = 2;
    expect(() => decodeEncryptedOpfsObjectEnvelope({ physical })).toThrow(
      'version is unsupported',
    );
  });
});
