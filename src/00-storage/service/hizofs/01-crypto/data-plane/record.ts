import {
  HIZOFS_V1_FORMAT_CONSTANTS,
  createRecordAadEncoder,
  encodeRecordAad,
  type FileSystemId,
  type SegmentId,
} from '@/00-storage/service/hizofs/00-format';
import { deriveRecordKey } from '@/00-storage/service/hizofs/01-crypto/key-application/derived-keys';
import { decryptAesGcm, encryptAesGcmOwnedRecord } from '@/00-storage/service/hizofs/01-crypto/primitives/aes-gcm';
import type { FileSystemRootKey } from '@/00-storage/service/hizofs/01-crypto/secret-types';
import {
  plaintextRecordBytes,
  type AuthenticatedRecordBytes,
  type PlaintextRecordBytes,
  type RecordNonce,
} from '@/00-storage/service/hizofs/01-crypto/types';

function validateFrameHeader({ completeFrameHeader }: { completeFrameHeader: Uint8Array }): void {
  if (completeFrameHeader.byteLength !== HIZOFS_V1_FORMAT_CONSTANTS.fixedSizes.recordFrameHeader) {
    throw new RangeError('Record Frame Header must have the exact V1 byte length');
  }
}

export type RecordEncryptionBatchCapability = Readonly<{
  encrypt({ completeFrameHeader, nonce, plaintext }: {
    completeFrameHeader: Uint8Array;
    nonce: RecordNonce;
    plaintext: PlaintextRecordBytes;
  }): Promise<AuthenticatedRecordBytes>;
  expire(): void;
}>;

/**
 * Reuses one non-extractable Record Key only while one same-home-Segment
 * encryption batch is being prepared.
 *
 * WHY: Record Key derivation depends on File System ID + home Segment ID, not
 * on the individual Record. Keeping the capability batch-scoped removes
 * repeated HKDF work without retaining derived key material on a long-lived
 * writer. Expiration drops the JavaScript reference before physical I/O; the
 * Root Key destruction check also prevents later use after owner teardown.
 */
export async function createRecordEncryptionBatchCapability({ fileSystemId, homeSegmentId, rootKey }: {
  fileSystemId: FileSystemId;
  homeSegmentId: SegmentId;
  rootKey: FileSystemRootKey;
}): Promise<RecordEncryptionBatchCapability> {
  let key: CryptoKey | undefined = await deriveRecordKey({ fileSystemId, homeSegmentId, rootKey });
  const aadEncoder = createRecordAadEncoder({ fileSystemId });
  const serialAadScratch = new Uint8Array(aadEncoder.byteLength);
  let serialAadScratchInUse = false;
  return Object.freeze({
    encrypt: async ({ completeFrameHeader, nonce, plaintext }) => {
      validateFrameHeader({ completeFrameHeader });
      const activeKey = key;
      if (activeKey === undefined) throw new TypeError('Record encryption batch capability has expired');
      if (rootKey.isDestroyed()) throw new TypeError('File System Root Key has been destroyed');
      // D0077 restored the production Record schedule to serial execution. Reuse
      // one batch-owned non-secret AAD buffer on that hot path, but preserve the
      // capability's existing concurrent-call behavior by falling back to a
      // fresh AAD buffer if an overlapping caller ever appears.
      const reuseSerialScratch = !serialAadScratchInUse;
      if (reuseSerialScratch) serialAadScratchInUse = true;
      try {
        return await encryptAesGcmOwnedRecord({
          aad: reuseSerialScratch
            ? aadEncoder.write({ bytes: serialAadScratch, completeFrameHeader })
            : aadEncoder.encode({ completeFrameHeader }),
          key: activeKey,
          nonce,
          plaintext,
        });
      } finally {
        if (reuseSerialScratch) serialAadScratchInUse = false;
      }
    },
    expire: () => {
      key = undefined;
      serialAadScratch.fill(0);
    },
  });
}

export async function encryptRecord({ completeFrameHeader, fileSystemId, homeSegmentId, nonce, plaintext, rootKey }: {
  completeFrameHeader: Uint8Array;
  fileSystemId: FileSystemId;
  homeSegmentId: SegmentId;
  nonce: RecordNonce;
  plaintext: PlaintextRecordBytes;
  rootKey: FileSystemRootKey;
}): Promise<AuthenticatedRecordBytes> {
  const capability = await createRecordEncryptionBatchCapability({ fileSystemId, homeSegmentId, rootKey });
  try {
    return await capability.encrypt({ completeFrameHeader, nonce, plaintext });
  } finally {
    capability.expire();
  }
}

export async function decryptAuthenticatedRecord({ ciphertext, completeFrameHeader, fileSystemId, homeSegmentId, nonce, rootKey }: {
  ciphertext: AuthenticatedRecordBytes;
  completeFrameHeader: Uint8Array;
  fileSystemId: FileSystemId;
  homeSegmentId: SegmentId;
  nonce: RecordNonce;
  rootKey: FileSystemRootKey;
}): Promise<PlaintextRecordBytes> {
  validateFrameHeader({ completeFrameHeader });
  const key = await deriveRecordKey({ fileSystemId, homeSegmentId, rootKey });
  return plaintextRecordBytes({
    bytes: await decryptAesGcm({
      aad: encodeRecordAad({ completeFrameHeader, fileSystemId }),
      ciphertextAndTag: ciphertext,
      key,
      nonce,
    }),
  });
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
