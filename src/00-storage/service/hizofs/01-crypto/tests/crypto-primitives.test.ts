import { describe, expect, it, vi } from 'vitest';
import { HIZOFS_V1_FORMAT_CONSTANTS, createPublicationSequence, encodeCryptoContext, parseCredentialSlotId, parseFileSystemId, parseSegmentId, type PublicationSequence } from '@/00-storage/service/hizofs/00-format';
import { deriveRecordKey, deriveSuperblockKey } from '@/00-storage/service/hizofs/01-crypto/key-application/derived-keys';
import { decryptAesGcm, encryptAesGcm, encryptAesGcmOwnedRecord } from '@/00-storage/service/hizofs/01-crypto/primitives/aes-gcm';
import { deriveCredentialWrappingKey } from '@/00-storage/service/hizofs/01-crypto/primitives/pbkdf2';
import { generateFileSystemRootKey, generateNonce, generateUniqueRandomBytes } from '@/00-storage/service/hizofs/01-crypto/random/random-bytes';
import { FileSystemRootKey, withFileSystemRootKeyBytes } from '@/00-storage/service/hizofs/01-crypto/secret-types';
import { decryptAuthenticatedRecord } from '@/00-storage/service/hizofs/01-crypto/data-plane/record';
import { decryptAuthenticatedSuperblock } from '@/00-storage/service/hizofs/01-crypto/data-plane/superblock';
import { decryptAuthenticatedSegmentFooter, decryptAuthenticatedSegmentHeader } from '@/00-storage/service/hizofs/01-crypto/data-plane/segment';
import {
  authenticatedRecordBytes,
  authenticatedSegmentFooterBytes,
  authenticatedSegmentHeaderBytes,
  authenticatedSuperblockBytes,
  plaintextRecordBytes,
  plaintextSegmentFooterBytes,
  plaintextSegmentHeaderBytes,
  plaintextSuperblockBytes,
  recordNonce,
  segmentFooterNonce,
  superblockNonce,
} from '@/00-storage/service/hizofs/01-crypto/types';
import {
  HizoFSCryptoAuthenticationError,
  throwNormalizedHizoFSCryptoFailure,
} from '@/00-storage/service/hizofs/01-crypto/authentication-failure';

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

  it('passes append-owned Record crypto inputs to Web Crypto without another JavaScript snapshot', async () => {
    const rootKey = FileSystemRootKey.create({ bytes: new Uint8Array(32).fill(9) });
    const key = await deriveRecordKey({
      fileSystemId: parseFileSystemId({ value: 'abcdefghijklmnopqrstu' }),
      homeSegmentId: parseSegmentId({ bytes: new Uint8Array(16).fill(4) }),
      rootKey,
    });
    const aad = Uint8Array.of(1, 2, 3, 4);
    const nonce = recordNonce({ bytes: new Uint8Array(12).fill(5) });
    const plaintext = plaintextRecordBytes({ bytes: Uint8Array.of(6, 7, 8, 9) });
    const encryptedBuffer = new ArrayBuffer(plaintext.byteLength + 16);
    const encryptSpy = vi.spyOn(globalThis.crypto.subtle, 'encrypt').mockResolvedValue(encryptedBuffer);
    try {
      const result = await encryptAesGcmOwnedRecord({ aad, key, nonce, plaintext });
      expect(encryptSpy).toHaveBeenCalledTimes(1);
      const [algorithm, observedKey, observedPlaintext] = encryptSpy.mock.calls[0]!;
      expect(observedKey).toBe(key);
      expect(observedPlaintext).toBe(plaintext);
      expect((algorithm as AesGcmParams).additionalData).toBe(aad);
      expect((algorithm as AesGcmParams).iv).toBe(nonce);
      expect(result.buffer).toBe(encryptedBuffer);
    } finally {
      encryptSpy.mockRestore();
      plaintext.fill(0);
      rootKey.destroy();
    }
  });

  it.each(['success', 'failure'] as const)('wipes only the owned encryption snapshot after %s', async outcome => {
    const key = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt']);
    const plaintext = Uint8Array.of(4, 5, 6);
    const nonce = new Uint8Array(12).fill(7);
    const aad = Uint8Array.of(8, 9);
    const encrypted = new ArrayBuffer(19);
    const gate = Promise.withResolvers<ArrayBuffer>();
    const failure = new Error('encryption dependency failed');
    const encrypt = vi.spyOn(crypto.subtle, 'encrypt').mockReturnValue(gate.promise);
    const operation = Promise.allSettled([encryptAesGcm({ aad, key, nonce, plaintext })]);
    try {
      const snapshot = encrypt.mock.calls[0]![2];
      expect(snapshot).toBeInstanceOf(Uint8Array);
      if (!(snapshot instanceof Uint8Array)) throw new Error('expected owned encryption snapshot');
      expect(snapshot).not.toBe(plaintext);
      plaintext.fill(10);
      expect(snapshot).toEqual(Uint8Array.of(4, 5, 6));
      if (outcome === 'success') gate.resolve(encrypted);
      else gate.reject(failure);
      const [result] = await operation;
      if (outcome === 'success') {
        expect(result).toEqual({ status: 'fulfilled', value: new Uint8Array(encrypted) });
      } else {
        expect(result).toEqual({ status: 'rejected', reason: failure });
        if (result?.status === 'rejected') expect(result.reason).toBe(failure);
      }
      expect(snapshot).toEqual(new Uint8Array(3));
      expect(plaintext).toEqual(new Uint8Array(3).fill(10));
      expect(nonce).toEqual(new Uint8Array(12).fill(7));
      expect(aad).toEqual(Uint8Array.of(8, 9));
    } finally {
      gate.resolve(encrypted);
      await operation;
      encrypt.mockRestore();
    }
  });

  it.each(['success', 'failure'] as const)('wipes the passphrase import copy after import %s', async outcome => {
    const baseKey = await crypto.subtle.importKey('raw', Uint8Array.of(1), 'PBKDF2', false, ['deriveKey']);
    const derivedKey = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt']);
    const importing = Promise.withResolvers<CryptoKey>();
    const deriving = Promise.withResolvers<CryptoKey>();
    const derivationStarted = Promise.withResolvers<void>();
    const failure = new Error('import dependency failed');
    const importKey = vi.spyOn(crypto.subtle, 'importKey').mockReturnValue(importing.promise);
    const deriveKey = vi.spyOn(crypto.subtle, 'deriveKey').mockImplementation(() => {
      derivationStarted.resolve();
      return deriving.promise;
    });
    const salt = new Uint8Array(16).fill(3);
    const operation = Promise.allSettled([deriveCredentialWrappingKey({
      fileSystemId: parseFileSystemId({ value: 'abcdefghijklmnopqrstu' }),
      slotId: parseCredentialSlotId({ value: 'ABCDEFGHIJKLMNOPQRSTU' }),
      iterations: 600_000, passphrase: 'temporary input', salt,
    })]);
    try {
      const imported = importKey.mock.calls[0]![1];
      if (!(imported instanceof ArrayBuffer)) throw new Error('expected owned passphrase import buffer');
      const snapshot = new Uint8Array(imported);
      expect(new TextDecoder().decode(snapshot)).toBe('temporary input');
      if (outcome === 'success') {
        importing.resolve(baseKey);
        await derivationStarted.promise;
        expect(snapshot).toEqual(new Uint8Array(snapshot.byteLength));
        deriving.resolve(derivedKey);
        expect(await operation).toEqual([{ status: 'fulfilled', value: derivedKey }]);
      } else {
        importing.reject(failure);
        const [result] = await operation;
        expect(result).toEqual({ status: 'rejected', reason: failure });
        if (result?.status === 'rejected') expect(result.reason).toBe(failure);
        expect(deriveKey).not.toHaveBeenCalled();
      }
      expect(snapshot).toEqual(new Uint8Array(snapshot.byteLength));
      expect(salt).toEqual(new Uint8Array(16).fill(3));
    } finally {
      importing.resolve(baseKey);
      deriving.resolve(derivedKey);
      await operation;
      importKey.mockRestore();
      deriveKey.mockRestore();
    }
  });

  it.each(['record', 'superblock', 'segment header', 'segment footer'] as const)(
    'transfers the fresh decrypted %s buffer to its caller', async kind => {
      const rootKey = FileSystemRootKey.create({ bytes: new Uint8Array(32).fill(5) });
      const fileSystemId = parseFileSystemId({ value: 'abcdefghijklmnopqrstu' });
      const segmentId = parseSegmentId({ bytes: new Uint8Array(16).fill(2) });
      const fresh = kind === 'segment header' ? new ArrayBuffer(0) : Uint8Array.of(1, 2, 3).buffer;
      const ciphertext = new Uint8Array(fresh.byteLength + 16);
      const nonce = new Uint8Array(12).fill(4);
      const decrypt = vi.spyOn(crypto.subtle, 'decrypt').mockResolvedValue(fresh);
      try {
        let result: Uint8Array;
        switch (kind) {
        case 'record':
          result = await decryptAuthenticatedRecord({
            ciphertext: authenticatedRecordBytes({ bytes: ciphertext }),
            completeFrameHeader: new Uint8Array(HIZOFS_V1_FORMAT_CONSTANTS.fixedSizes.recordFrameHeader),
            fileSystemId, homeSegmentId: segmentId, nonce: recordNonce({ bytes: nonce }), rootKey,
          });
          break;
        case 'superblock':
          result = await decryptAuthenticatedSuperblock({
            ciphertext: authenticatedSuperblockBytes({ bytes: ciphertext }), copy: 0,
            exactHeader: new Uint8Array(HIZOFS_V1_FORMAT_CONSTANTS.fixedSizes.superblockHeader),
            fileSystemId, nonce: superblockNonce({ bytes: nonce }),
            publicationSequence: createPublicationSequence({ value: 1n }), rootKey,
          });
          break;
        case 'segment header':
          result = await decryptAuthenticatedSegmentHeader({
            ciphertext: authenticatedSegmentHeaderBytes({ bytes: ciphertext }),
            fileSystemId, physicalSegmentId: segmentId, rootKey, segmentClass: 1,
            segmentHeaderPrefix: new Uint8Array(48),
          });
          break;
        case 'segment footer':
          result = await decryptAuthenticatedSegmentFooter({
            ciphertext: authenticatedSegmentFooterBytes({ bytes: ciphertext }),
            fileSystemId,
            footerHeader: new Uint8Array(HIZOFS_V1_FORMAT_CONSTANTS.fixedSizes.segmentFooterHeader),
            footerTrailer: new Uint8Array(HIZOFS_V1_FORMAT_CONSTANTS.fixedSizes.segmentFooterTrailer),
            nonce: segmentFooterNonce({ bytes: nonce }), physicalSegmentId: segmentId, rootKey,
          });
          break;
        default:
          throw new Error(`unhandled wrapper ${kind satisfies never}`);
        }
        expect(result.buffer).toBe(fresh);
        expect(result).toEqual(kind === 'segment header' ? new Uint8Array(0) : Uint8Array.of(1, 2, 3));
        expect(decrypt).toHaveBeenCalledOnce();
        result.fill(0);
        expect(new Uint8Array(fresh)).toEqual(new Uint8Array(fresh.byteLength));
      } finally {
        decrypt.mockRestore();
        rootKey.destroy();
      }
    },
  );

  it('keeps public plaintext factories detached from borrowed input', () => {
    const input = Uint8Array.of(1, 2, 3);
    for (const createBytes of [plaintextRecordBytes, plaintextSuperblockBytes, plaintextSegmentHeaderBytes, plaintextSegmentFooterBytes]) {
      const owned = createBytes({ bytes: input });
      expect(owned).toEqual(input);
      expect(owned.buffer).not.toBe(input.buffer);
      owned.fill(0);
      expect(input).toEqual(Uint8Array.of(1, 2, 3));
    }
  });

  it.each(['success', 'failure'] as const)('wipes default random scratch after %s', outcome => {
    let scratch: Uint8Array | undefined;
    const failure = new Error('random dependency failed');
    const getRandomValues = vi.spyOn(crypto, 'getRandomValues').mockImplementation(bytes => {
      if (!(bytes instanceof Uint8Array)) throw new Error('expected random scratch bytes');
      scratch = bytes;
      bytes.fill(7);
      if (outcome === 'failure') throw failure;
      return bytes;
    });
    try {
      if (outcome === 'success') expect(generateNonce()).toEqual(new Uint8Array(12).fill(7));
      else expect(() => generateNonce()).toThrow(failure);
      expect(scratch).toEqual(new Uint8Array(12));
    } finally {
      getRandomValues.mockRestore();
    }
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
    const candidates: Uint8Array[] = [];
    const rootKey = generateFileSystemRootKey({
      randomSource: ({ bytes }) => {
        candidates.push(bytes);
        calls += 1;
        bytes.fill(calls === 1 ? 0 : 9);
      },
    });
    expect(calls).toBe(2);
    expect(candidates.every(bytes => bytes.every(byte => byte === 0))).toBe(true);
    await withFileSystemRootKeyBytes({ rootKey, useBytes: async ({ bytes }) => {
      expect(bytes).toEqual(new Uint8Array(32).fill(9));
    } });
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
