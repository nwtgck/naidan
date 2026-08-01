import fs from 'node:fs/promises';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  createUInt64,
  decodeFileExtentPage,
  decodeFileSystemCommitPayload,
  decodeInodeBranchPage,
  encodeFileExtentPage,
  encodeFileSystemCommitPayload,
  encodeInodeBranchPage,
  encodePassphraseSlotAad,
  encodePassphraseSlotKdfContext,
  encodeRecordAad,
  encodeRecordKeyContext,
  encodeSegmentFooterAad,
  encodeSuperblockAad,
  encodeUnlockAuthenticatorAad,
  encodeUnlockAuthenticatorKeyContext,
  parseCredentialSlotId,
  parseFileSystemId,
  parseSegmentId,
} from '@/00-storage/service/hizofs/00-format';
import * as cryptoBoundary from '@/00-storage/service/hizofs/crypto';
import {
  PASSPHRASE_CREDENTIAL_METHOD_V1,
  createUnlockAuthenticatorTag,
  decryptAuthenticatedRecord,
  encryptRecord,
  generateSegmentId,
  recordNonce,
  unwrapFileSystemRootKeyFromCredentialSlot,
  verifyUnlockAuthenticator,
  wrapFileSystemRootKeyForCredentialSlot,
  credentialWrapNonce,
  unlockAuthenticatorNonce,
  FileSystemRootKey,
  plaintextRecordBytes,
} from '@/00-storage/service/hizofs/crypto';

function hex({ value }: { value: string }): Uint8Array {
  return Uint8Array.from(Buffer.from(value, 'hex'));
}

async function vectors() {
  const fixturePath = path.resolve(
    __dirname,
    '../../00-format/v1/test-fixtures/known-answer-vectors-v1.json',
  );
  return JSON.parse(await fs.readFile(fixturePath, 'utf8')) as {
    inputs: Record<string, string | number>;
    expected: {
      contextsHex: Record<string, string>;
      fileExtentLeafPageHex: string;
      fileSystemCommitHex: string;
      inodeBranchPageHex: string;
      recordCiphertextAndTagHex: string;
      unlockAuthenticatorTagHex: string;
      wrappedRootKeyCiphertextAndTagHex: string;
    };
  };
}

describe('HizoFS purpose-specific crypto boundary and known-answer vectors', () => {
  it('does not expose generic AES-GCM, nonce, or arbitrary random-byte APIs', () => {
    expect(Object.keys(cryptoBoundary)).not.toContain('encryptAesGcm');
    expect(Object.keys(cryptoBoundary)).not.toContain('decryptAesGcm');
    expect(Object.keys(cryptoBoundary)).not.toContain('generateNonce');
    expect(Object.keys(cryptoBoundary)).not.toContain('generateUniqueRandomBytes');
  });

  it('matches independently generated context bytes', async () => {
    const vector = await vectors();
    const fileSystemId = parseFileSystemId({ value: String(vector.inputs.fileSystemIdAscii) });
    const slotId = parseCredentialSlotId({ value: String(vector.inputs.credentialSlotIdAscii) });
    const homeSegmentId = parseSegmentId({ bytes: hex({ value: String(vector.inputs.homeSegmentIdHex) }) });
    const frame = hex({ value: String(vector.inputs.recordFrameHeaderHex) });
    const salt = hex({ value: String(vector.inputs.saltHex) });
    const wrapNonce = credentialWrapNonce({ bytes: hex({ value: String(vector.inputs.credentialWrapNonceHex) }) });
    const methodParameters = new Uint8Array(32);
    methodParameters.set(salt, 0);
    new DataView(methodParameters.buffer).setUint32(16, Number(vector.inputs.iterations), false);
    methodParameters.set(wrapNonce, 20);

    expect(Buffer.from(encodeRecordKeyContext({ fileSystemId, homeSegmentId })).toString('hex')).toBe(vector.expected.contextsHex.recordKey);
    expect(Buffer.from(encodeRecordAad({ completeFrameHeader: frame, fileSystemId })).toString('hex')).toBe(vector.expected.contextsHex.recordAad);
    expect(Buffer.from(encodePassphraseSlotKdfContext({ fileSystemId, salt, slotId })).toString('hex')).toBe(vector.expected.contextsHex.passphraseSlotKdf);
    expect(Buffer.from(encodePassphraseSlotAad({
      fileSystemId,
      formatVersion: 1,
      method: PASSPHRASE_CREDENTIAL_METHOD_V1,
      methodParameters,
      methodVersion: 1,
      slotId,
    })).toString('hex')).toBe(vector.expected.contextsHex.passphraseSlotAad);
    expect(Buffer.from(encodeSuperblockAad({ exactHeader: hex({ value: String(vector.inputs.superblockHeaderHex) }) })).toString('hex')).toBe(vector.expected.contextsHex.superblockAad);
    expect(Buffer.from(encodeSegmentFooterAad({
      fileSystemId,
      footerHeader: hex({ value: String(vector.inputs.segmentFooterHeaderHex) }),
      footerTrailer: hex({ value: String(vector.inputs.segmentFooterTrailerHex) }),
    })).toString('hex')).toBe(vector.expected.contextsHex.segmentFooterAad);
    expect(Buffer.from(encodeUnlockAuthenticatorAad({
      canonicalUnsignedEnvelopeBytes: hex({ value: String(vector.inputs.canonicalUnsignedUnlockEnvelopeHex) }),
    })).toString('hex')).toBe(vector.expected.contextsHex.unlockAuthenticatorAad);
    expect(Buffer.from(encodeUnlockAuthenticatorKeyContext({
      copy: Number(vector.inputs.unlockCopy) as 0,
      fileSystemId,
      unlockSequence: createUInt64({ value: BigInt(Number(vector.inputs.unlockSequence)) }),
    })).toString('hex')).toBe(vector.expected.contextsHex.unlockAuthenticatorKey);
  });

  it('matches record encryption and rejects a wrong purpose-bound header', async () => {
    const vector = await vectors();
    const fileSystemId = parseFileSystemId({ value: String(vector.inputs.fileSystemIdAscii) });
    const homeSegmentId = parseSegmentId({ bytes: hex({ value: String(vector.inputs.homeSegmentIdHex) }) });
    const rootKey = FileSystemRootKey.create({ bytes: hex({ value: String(vector.inputs.rootKeyHex) }) });
    const nonce = recordNonce({ bytes: hex({ value: String(vector.inputs.recordNonceHex) }) });
    const frame = hex({ value: String(vector.inputs.recordFrameHeaderHex) });
    const plaintext = plaintextRecordBytes({ bytes: hex({ value: String(vector.inputs.recordPlaintextHex) }) });
    const encrypted = await encryptRecord({ completeFrameHeader: frame, fileSystemId, homeSegmentId, nonce, plaintext, rootKey });
    expect(Buffer.from(encrypted).toString('hex')).toBe(vector.expected.recordCiphertextAndTagHex);
    await expect(decryptAuthenticatedRecord({ ciphertext: encrypted, completeFrameHeader: Uint8Array.from(frame, value => value ^ 1), fileSystemId, homeSegmentId, nonce, rootKey })).rejects.toThrow();
    await expect(decryptAuthenticatedRecord({ ciphertext: encrypted, completeFrameHeader: frame, fileSystemId, homeSegmentId, nonce, rootKey })).resolves.toEqual(plaintext);
  });

  it('matches credential wrapping and Unlock Authenticator vectors', async () => {
    const vector = await vectors();
    const fileSystemId = parseFileSystemId({ value: String(vector.inputs.fileSystemIdAscii) });
    const slotId = parseCredentialSlotId({ value: String(vector.inputs.credentialSlotIdAscii) });
    const rootKey = FileSystemRootKey.create({ bytes: hex({ value: String(vector.inputs.rootKeyHex) }) });
    const parameters = {
      iterations: Number(vector.inputs.iterations),
      nonce: credentialWrapNonce({ bytes: hex({ value: String(vector.inputs.credentialWrapNonceHex) }) }),
      salt: hex({ value: String(vector.inputs.saltHex) }),
    };
    const wrapped = await wrapFileSystemRootKeyForCredentialSlot({
      fileSystemId,
      parameters,
      passphrase: String(vector.inputs.passphrase),
      rootKey,
      slotId,
    });
    expect(Buffer.from(wrapped).toString('hex')).toBe(vector.expected.wrappedRootKeyCiphertextAndTagHex);
    const unwrapped = await unwrapFileSystemRootKeyFromCredentialSlot({
      fileSystemId,
      parameters,
      passphrase: String(vector.inputs.passphrase),
      slotId,
      wrappedRootKey: wrapped,
    });
    const tag = await createUnlockAuthenticatorTag({
      canonicalUnsignedEnvelopeBytes: hex({ value: String(vector.inputs.canonicalUnsignedUnlockEnvelopeHex) }),
      copy: 0,
      fileSystemId,
      nonce: unlockAuthenticatorNonce({ bytes: hex({ value: String(vector.inputs.unlockAuthenticatorNonceHex) }) }),
      rootKey: unwrapped,
      unlockSequence: createUInt64({ value: 1n }),
    });
    expect(Buffer.from(tag).toString('hex')).toBe(vector.expected.unlockAuthenticatorTagHex);
    await expect(verifyUnlockAuthenticator({
      canonicalUnsignedEnvelopeBytes: hex({ value: String(vector.inputs.canonicalUnsignedUnlockEnvelopeHex) }),
      copy: 0,
      fileSystemId,
      nonce: unlockAuthenticatorNonce({ bytes: hex({ value: String(vector.inputs.unlockAuthenticatorNonceHex) }) }),
      rootKey: unwrapped,
      tag,
      unlockSequence: createUInt64({ value: 1n }),
    })).resolves.toBeUndefined();
  });

  it('matches independent binary fixture bytes', async () => {
    const vector = await vectors();
    const commitBytes = hex({ value: vector.expected.fileSystemCommitHex });
    expect(encodeFileSystemCommitPayload({ payload: decodeFileSystemCommitPayload({ bytes: commitBytes }) })).toEqual(commitBytes);
    const inodeBytes = hex({ value: vector.expected.inodeBranchPageHex });
    expect(encodeInodeBranchPage({ isRoot: true, page: decodeInodeBranchPage({ bytes: inodeBytes, isRoot: true }) })).toEqual(inodeBytes);
    const extentBytes = hex({ value: vector.expected.fileExtentLeafPageHex });
    expect(encodeFileExtentPage({ isRoot: true, page: decodeFileExtentPage({ bytes: extentBytes, isRoot: true }) })).toEqual(extentBytes);
  });

  it('uses an asynchronous purpose-specific Segment ID collision check', async () => {
    let calls = 0;
    await expect(generateSegmentId({
      isUsed: async ({ id }) => id[0] === 1,
      randomSource: ({ bytes }) => {
        calls += 1;
        bytes.fill(calls);
      },
    })).resolves.toEqual(new Uint8Array(16).fill(2));
    expect(calls).toBe(2);
  });
});
