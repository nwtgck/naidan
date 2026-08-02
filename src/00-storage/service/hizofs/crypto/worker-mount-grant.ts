import {
  HIZOFS_V1_FORMAT_CONSTANTS,
  HIZOFS_V1_PASSPHRASE_CREDENTIAL_METHOD,
  encodeBase64UrlUnpadded,
  type CredentialSlotId,
  type FileSystemId,
  type UnlockSequence,
} from '@/00-storage/service/hizofs/00-format';
import { decryptAesGcm, encryptAesGcm } from '@/00-storage/service/hizofs/crypto/primitives/aes-gcm';
import {
  FileSystemRootKey,
  withFileSystemRootKeyBytes,
} from '@/00-storage/service/hizofs/crypto/secret-types';

export type HizoFSWorkerMountAccessMode = 'read' | 'read_write';

type HizoFSWorkerMountGrantPayloadV1 = Readonly<{
  ciphertext: Uint8Array;
  nonce: Uint8Array;
  type: 'hizofs_worker_mount_grant_payload';
  version: 1;
  wrappingKey: CryptoKey;
}>;

export type HizoFSWorkerMountGrantMetadataV1 = Readonly<{
  accessMode: HizoFSWorkerMountAccessMode;
  canonicalBackingLocation: string;
  fileSystemId: string;
  grantId: string;
  inodeNumber: string;
  scopePath: readonly string[];
  type: 'hizofs_worker_mount_grant';
  unlockingSlotId: string;
  unlockSequence: string;
  version: 1;
}>;

const WORKER_MOUNT_GRANT_ROOT_KEY_BYTES = HIZOFS_V1_PASSPHRASE_CREDENTIAL_METHOD.rootKeyBytes;
const WORKER_MOUNT_GRANT_METADATA_LENGTH_BYTES = 4;
const WORKER_MOUNT_GRANT_NONCE_BYTES = HIZOFS_V1_FORMAT_CONSTANTS.crypto.nonceBytes;

function workerMountGrantAad({ accessMode, grantId }: {
  accessMode: HizoFSWorkerMountAccessMode;
  grantId: string;
}): Uint8Array {
  return new TextEncoder().encode(`hizofs-worker-mount-grant-v1\u0000${grantId}\u0000${accessMode}`);
}

function randomWorkerMountGrantId(): string {
  return encodeBase64UrlUnpadded({ bytes: globalThis.crypto.getRandomValues(new Uint8Array(16)) });
}

function requireHizoFSWorkerMountGrantPayload({ value }: {
  value: unknown;
}): HizoFSWorkerMountGrantPayloadV1 {
  if (typeof value !== 'object' || value === null) {
    throw new TypeError('HizoFS Worker mount grant payload must be an object');
  }
  const payload = value as Partial<HizoFSWorkerMountGrantPayloadV1>;
  if (payload.type !== 'hizofs_worker_mount_grant_payload' || payload.version !== 1) {
    throw new TypeError('unsupported HizoFS Worker mount grant payload');
  }
  if (payload.wrappingKey === undefined
    || !(payload.ciphertext instanceof Uint8Array)
    || !(payload.nonce instanceof Uint8Array)
    || payload.nonce.byteLength !== WORKER_MOUNT_GRANT_NONCE_BYTES) {
    throw new TypeError('invalid HizoFS Worker mount grant payload');
  }
  return payload as HizoFSWorkerMountGrantPayloadV1;
}

function requireWorkerMountGrantMetadata({ value }: {
  value: unknown;
}): HizoFSWorkerMountGrantMetadataV1 {
  if (typeof value !== 'object' || value === null) {
    throw new TypeError('invalid HizoFS Worker mount grant plaintext');
  }
  const row = value as Partial<HizoFSWorkerMountGrantMetadataV1>;
  if (row.type !== 'hizofs_worker_mount_grant' || row.version !== 1
    || (row.accessMode !== 'read' && row.accessMode !== 'read_write')
    || typeof row.canonicalBackingLocation !== 'string' || row.canonicalBackingLocation.length === 0
    || typeof row.fileSystemId !== 'string' || typeof row.grantId !== 'string'
    || typeof row.inodeNumber !== 'string'
    || !Array.isArray(row.scopePath) || row.scopePath.some(component => typeof component !== 'string')
    || typeof row.unlockingSlotId !== 'string' || typeof row.unlockSequence !== 'string') {
    throw new TypeError('invalid HizoFS Worker mount grant plaintext');
  }
  return row as HizoFSWorkerMountGrantMetadataV1;
}

function encodeWorkerMountGrantCleartext({ metadata, rootKeyBytes }: {
  metadata: HizoFSWorkerMountGrantMetadataV1;
  rootKeyBytes: Uint8Array;
}): Uint8Array {
  if (rootKeyBytes.byteLength !== WORKER_MOUNT_GRANT_ROOT_KEY_BYTES) {
    throw new RangeError('HizoFS Worker mount grant root key has invalid length');
  }
  const metadataBytes = new TextEncoder().encode(JSON.stringify(metadata));
  try {
    const cleartext = new Uint8Array(
      WORKER_MOUNT_GRANT_METADATA_LENGTH_BYTES
      + metadataBytes.byteLength
      + WORKER_MOUNT_GRANT_ROOT_KEY_BYTES,
    );
    new DataView(cleartext.buffer).setUint32(0, metadataBytes.byteLength, false);
    cleartext.set(metadataBytes, WORKER_MOUNT_GRANT_METADATA_LENGTH_BYTES);
    cleartext.set(rootKeyBytes, WORKER_MOUNT_GRANT_METADATA_LENGTH_BYTES + metadataBytes.byteLength);
    return cleartext;
  } finally {
    metadataBytes.fill(0);
  }
}

function decodeWorkerMountGrantCleartext({ cleartext }: {
  cleartext: Uint8Array;
}): Readonly<{
  metadata: HizoFSWorkerMountGrantMetadataV1;
  rootKeyBytes: Uint8Array;
}> {
  if (cleartext.byteLength < WORKER_MOUNT_GRANT_METADATA_LENGTH_BYTES + WORKER_MOUNT_GRANT_ROOT_KEY_BYTES) {
    throw new TypeError('HizoFS Worker mount grant cleartext is truncated');
  }
  const metadataLength = new DataView(
    cleartext.buffer,
    cleartext.byteOffset,
    WORKER_MOUNT_GRANT_METADATA_LENGTH_BYTES,
  ).getUint32(0, false);
  const rootKeyOffset = WORKER_MOUNT_GRANT_METADATA_LENGTH_BYTES + metadataLength;
  if (rootKeyOffset + WORKER_MOUNT_GRANT_ROOT_KEY_BYTES !== cleartext.byteLength) {
    throw new TypeError('HizoFS Worker mount grant cleartext framing is invalid');
  }
  const metadata = requireWorkerMountGrantMetadata({
    value: JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(
      cleartext.subarray(WORKER_MOUNT_GRANT_METADATA_LENGTH_BYTES, rootKeyOffset),
    )),
  });
  return {
    metadata,
    rootKeyBytes: Uint8Array.from(cleartext.subarray(rootKeyOffset)),
  };
}

export async function issueHizoFSWorkerMountGrantPayload({
  accessMode,
  canonicalBackingLocation,
  fileSystemId,
  inodeNumber,
  rootKey,
  scopePath,
  unlockingSlotId,
  unlockSequence,
}: {
  accessMode: HizoFSWorkerMountAccessMode;
  canonicalBackingLocation: string;
  fileSystemId: FileSystemId;
  inodeNumber: bigint;
  rootKey: FileSystemRootKey;
  scopePath: readonly string[];
  unlockingSlotId: CredentialSlotId;
  unlockSequence: UnlockSequence;
}): Promise<Readonly<{
  grantId: string;
  opaquePayload: unknown;
}>> {
  const grantId = randomWorkerMountGrantId();
  const wrappingKey = await globalThis.crypto.subtle.generateKey(
    { length: 256, name: 'AES-GCM' },
    false,
    ['decrypt', 'encrypt'],
  );
  const nonce = globalThis.crypto.getRandomValues(new Uint8Array(WORKER_MOUNT_GRANT_NONCE_BYTES));
  const aad = workerMountGrantAad({ accessMode, grantId });
  let cleartext: Uint8Array | undefined;
  try {
    cleartext = await withFileSystemRootKeyBytes({
      rootKey,
      useBytes: ({ bytes }) => encodeWorkerMountGrantCleartext({
        metadata: {
          accessMode,
          canonicalBackingLocation,
          fileSystemId,
          grantId,
          inodeNumber: inodeNumber.toString(),
          scopePath: [...scopePath],
          type: 'hizofs_worker_mount_grant',
          unlockingSlotId,
          unlockSequence: unlockSequence.toString(),
          version: 1,
        },
        rootKeyBytes: bytes,
      }),
    });
    return {
      grantId,
      opaquePayload: {
        ciphertext: await encryptAesGcm({
          aad,
          key: wrappingKey,
          nonce,
          plaintext: cleartext,
        }),
        nonce,
        type: 'hizofs_worker_mount_grant_payload',
        version: 1,
        wrappingKey,
      },
    };
  } finally {
    aad.fill(0);
    cleartext?.fill(0);
  }
}

export async function openHizoFSWorkerMountGrantPayload({ accessMode, grantId, opaquePayload }: {
  accessMode: HizoFSWorkerMountAccessMode;
  grantId: string;
  opaquePayload: unknown;
}): Promise<Readonly<{
  metadata: HizoFSWorkerMountGrantMetadataV1;
  rootKey: FileSystemRootKey;
}>> {
  const payload = requireHizoFSWorkerMountGrantPayload({ value: opaquePayload });
  const aad = workerMountGrantAad({ accessMode, grantId });
  let cleartext: Uint8Array | undefined;
  let rootKeyBytes: Uint8Array | undefined;
  try {
    cleartext = await decryptAesGcm({
      aad,
      ciphertextAndTag: payload.ciphertext,
      key: payload.wrappingKey,
      nonce: payload.nonce,
    });
    const decoded = decodeWorkerMountGrantCleartext({ cleartext });
    rootKeyBytes = decoded.rootKeyBytes;
    if (decoded.metadata.grantId !== grantId || decoded.metadata.accessMode !== accessMode) {
      throw new TypeError('HizoFS Worker mount grant envelope disagrees with its authenticated payload');
    }
    return {
      metadata: decoded.metadata,
      rootKey: FileSystemRootKey.create({ bytes: rootKeyBytes }),
    };
  } finally {
    aad.fill(0);
    cleartext?.fill(0);
    rootKeyBytes?.fill(0);
  }
}

export async function deriveContainerCoordinationScopeTokenValue({ canonicalBackingLocation }: {
  canonicalBackingLocation: string;
}): Promise<string> {
  const encodedLocation = new TextEncoder().encode(canonicalBackingLocation);
  try {
    const digest = new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256', encodedLocation));
    return encodeBase64UrlUnpadded({ bytes: digest });
  } finally {
    encodedLocation.fill(0);
  }
}

export function generateBenchmarkSecret({ byteLength }: {
  byteLength: number;
}): string {
  const bytes = globalThis.crypto.getRandomValues(new Uint8Array(byteLength));
  try {
    return Array.from(bytes, value => value.toString(16).padStart(2, '0')).join('');
  } finally {
    bytes.fill(0);
  }
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
