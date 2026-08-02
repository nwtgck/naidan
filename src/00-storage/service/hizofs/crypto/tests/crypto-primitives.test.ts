import { describe, expect, it } from 'vitest';
import { createPublicationSequence, encodeCryptoContext, parseCredentialSlotId, parseFileSystemId, parseSegmentId, type PublicationSequence } from '@/00-storage/service/hizofs/00-format';
import { deriveRecordKey, deriveSuperblockKey } from '@/00-storage/service/hizofs/crypto/key-application/derived-keys';
import { decryptAesGcm, encryptAesGcm } from '@/00-storage/service/hizofs/crypto/primitives/aes-gcm';
import { deriveCredentialWrappingKey } from '@/00-storage/service/hizofs/crypto/primitives/pbkdf2';
import { generateFileSystemRootKey, generateNonce, generateUniqueRandomBytes } from '@/00-storage/service/hizofs/crypto/random/random-bytes';
import { FileSystemRootKey } from '@/00-storage/service/hizofs/crypto/secret-types';
import {
  HizoFSCryptoAuthenticationError,
  throwNormalizedHizoFSCryptoFailure,
} from '@/00-storage/service/hizofs/crypto/authentication-failure';

describe('HizoFS crypto primitives', () => {
  it('encodes the exact versioned length-prefixed crypto context', () => {
    const context = encodeCryptoContext({
      domain: 'HizoFS/v1/record-key',
      fields: [new TextEncoder().encode('abcdefghijklmnopqrstu'), Uint8Array.from({ length: 16 }, (_, index) => index + 1)],
    });
    expect(Array.from(context.subarray(0, 3))).toEqual([1, 0, 20]);
    expect(new TextDecoder().decode(context.subarray(3, 23))).toBe('HizoFS/v1/record-key');
    expect(Array.from(context.subarray(23, 25))).toEqual([0, 2]);
    expect(context.byteLength).toBe(25 + 8 + 21 + 8 + 16);
  });

  it('rejects unregistered domains, wrong field counts, and oversized fields', () => {
    expect(() => encodeCryptoContext({
      domain: 'HizoFS/v1/not-registered' as never,
      fields: [],
    })).toThrow('not registered');
    expect(() => encodeCryptoContext({
      domain: 'HizoFS/v1/record-key',
      fields: [new Uint8Array()],
    })).toThrow('field count');
    expect(() => encodeCryptoContext({
      domain: 'HizoFS/v1/record-key',
      fields: [new Uint8Array(65_537), new Uint8Array()],
    })).toThrow('hard bound');
  });

  it('derives an AES key and rejects a wrong AAD', async () => {
    const rootKey = FileSystemRootKey.create({ bytes: Uint8Array.from({ length: 32 }, (_, index) => index) });
    const key = await deriveSuperblockKey({
      copy: 0,
      fileSystemId: parseFileSystemId({ value: 'abcdefghijklmnopqrstu' }),
      publicationSequence: createPublicationSequence({ value: 1n }),
      rootKey,
    });
    const nonce = Uint8Array.from({ length: 12 }, (_, index) => index + 1);
    const aad = Uint8Array.of(1, 2, 3);
    const plaintext = Uint8Array.of(4, 5, 6);
    const ciphertextAndTag = await encryptAesGcm({ aad, key, nonce, plaintext });
    await expect(decryptAesGcm({ aad, ciphertextAndTag, key, nonce })).resolves.toEqual(plaintext);
    const authenticationFailure = await decryptAesGcm({
      aad: Uint8Array.of(9),
      ciphertextAndTag,
      key,
      nonce,
    }).catch((cause: unknown) => cause);
    expect(authenticationFailure).toBeInstanceOf(HizoFSCryptoAuthenticationError);
    expect(authenticationFailure).toMatchObject({
      cause: { name: 'OperationError' },
      code: 'authentication_failed',
      message: 'HizoFS cryptographic authentication failed',
    });
    rootKey.destroy();
    await expect(deriveSuperblockKey({
      copy: 0,
      fileSystemId: parseFileSystemId({ value: 'abcdefghijklmnopqrstu' }),
      publicationSequence: createPublicationSequence({ value: 1n }),
      rootKey,
    })).rejects.toThrow('destroyed');
  });

  it('preserves non-authentication infrastructure failures and their identity', () => {
    const infrastructureFailure = new Error('test-only crypto runtime unavailable');
    let thrown: unknown;
    try {
      throwNormalizedHizoFSCryptoFailure({ cause: infrastructureFailure });
    } catch (cause: unknown) {
      thrown = cause;
    }
    expect(thrown).toBe(infrastructureFailure);
  });

  it('binds PBKDF2 wrapping keys to passphrase and credential identity', async () => {
    const parameters = {
      fileSystemId: parseFileSystemId({ value: 'abcdefghijklmnopqrstu' }),
      iterations: 600_000,
      passphrase: ' exact passphrase ',
      salt: Uint8Array.from({ length: 16 }, (_, index) => index),
      slotId: parseCredentialSlotId({ value: 'ABCDEFGHIJKLMNOPQRSTU' }),
    };
    const key = await deriveCredentialWrappingKey(parameters);
    const nonce = new Uint8Array(12).fill(4);
    const aad = Uint8Array.of(8, 9);
    const ciphertextAndTag = await encryptAesGcm({ aad, key, nonce, plaintext: new Uint8Array(32).fill(7) });
    const wrongKey = await deriveCredentialWrappingKey({ ...parameters, passphrase: 'wrong passphrase' });
    await expect(decryptAesGcm({ aad, ciphertextAndTag, key: wrongKey, nonce })).rejects.toThrow();
    await expect(deriveCredentialWrappingKey({ ...parameters, iterations: 599_999 })).rejects.toThrow('iterations');
    await expect(deriveCredentialWrappingKey({ ...parameters, salt: new Uint8Array(15) })).rejects.toThrow('16 bytes');
  });

  it('rejects runtime-cast authority fields and domain-separates record keys', async () => {
    const fileSystemId = parseFileSystemId({ value: 'abcdefghijklmnopqrstu' });
    const rootKey = FileSystemRootKey.create({ bytes: new Uint8Array(32).fill(5) });
    await expect(deriveSuperblockKey({
      copy: 2 as never, fileSystemId, publicationSequence: createPublicationSequence({ value: 1n }), rootKey,
    })).rejects.toThrow('copy');
    await expect(deriveSuperblockKey({
      copy: 0, fileSystemId, publicationSequence: 0n as PublicationSequence, rootKey,
    })).rejects.toThrow('at least 1');
    const firstKey = await deriveRecordKey({
      fileSystemId, homeSegmentId: parseSegmentId({ bytes: new Uint8Array(16).fill(1) }), rootKey,
    });
    const secondKey = await deriveRecordKey({
      fileSystemId, homeSegmentId: parseSegmentId({ bytes: new Uint8Array(16).fill(2) }), rootKey,
    });
    const args = { aad: Uint8Array.of(1), nonce: new Uint8Array(12).fill(2), plaintext: Uint8Array.of(3) };
    const first = await encryptAesGcm({ ...args, key: firstKey });
    const second = await encryptAesGcm({ ...args, key: secondKey });
    expect(first).not.toEqual(second);
  });

  it('enforces nonce length and bounded collision retry', async () => {
    expect(generateNonce({ randomSource: ({ bytes }) => {
      bytes.fill(7);
    } })).toEqual(new Uint8Array(12).fill(7));
    const key = await deriveRecordKey({
      fileSystemId: parseFileSystemId({ value: 'abcdefghijklmnopqrstu' }),
      homeSegmentId: parseSegmentId({ bytes: new Uint8Array(16).fill(2) }),
      rootKey: FileSystemRootKey.create({ bytes: new Uint8Array(32).fill(1) }),
    });
    await expect(encryptAesGcm({ aad: new Uint8Array(), key, nonce: new Uint8Array(11), plaintext: new Uint8Array() })).rejects.toThrow('nonce');
    expect(() => generateUniqueRandomBytes({
      byteLength: 16,
      isUsed: () => true,
      randomSource: ({ bytes }) => {
        bytes.fill(1);
      },
    })).toThrow('collision retry bound');
  });

  it('creates a nonzero root-key capability without exposing source mutation', async () => {
    let calls = 0;
    const rootKey = generateFileSystemRootKey({
      randomSource: ({ bytes }) => {
        calls += 1;
        bytes.fill(calls === 1 ? 0 : 9);
      },
    });
    expect(calls).toBe(2);
    await expect(deriveRecordKey({
      fileSystemId: parseFileSystemId({ value: 'abcdefghijklmnopqrstu' }),
      homeSegmentId: parseSegmentId({ bytes: new Uint8Array(16).fill(3) }),
      rootKey,
    })).resolves.toBeInstanceOf(CryptoKey);
    rootKey.destroy();
  });

  it('skips zero and used candidates before returning a fresh identity', () => {
    let call = 0;
    const result = generateUniqueRandomBytes({
      byteLength: 4,
      isUsed: ({ bytes }) => bytes[0] === 1 || bytes[0] === 2,
      randomSource: ({ bytes }) => {
        call += 1;
        bytes.fill(call - 1);
      },
    });
    expect(result).toEqual(Uint8Array.of(3, 3, 3, 3));
    expect(call).toBe(4);
  });
});
