import { decodeBase64Url } from '@/00-storage/service/hizofs/base64-url';
import { bytesEqual, concatenateBytes } from '@/00-storage/service/hizofs/bytes';
import type { HizoFSBackingStore } from '@/00-storage/service/hizofs/backing-store/backing-store';
import { HizoFSCorruptionError, HizoFSUnsupportedFormatError } from '@/00-storage/service/hizofs/errors';
import {
  createHizoFSNonce,
  decryptHizoFSAesGcm,
  deriveHizoFSGarbageCollectionCheckpointKey,
  encryptHizoFSAesGcm,
  HIZOFS_AES_GCM_NONCE_BYTE_LENGTH,
  HIZOFS_AES_GCM_TAG_BYTE_LENGTH,
} from '@/00-storage/service/hizofs/segment-store/segment-crypto';
import { decodeHizoFSObjectReference } from '@/00-storage/service/hizofs/segment-store/object-reference';

const MAGIC = new TextEncoder().encode('HZGCP001');
const FORMAT_VERSION = 1;
const HEADER_BYTE_LENGTH = 64;
const MAX_PAYLOAD_BYTE_LENGTH = 1024 * 1024;
const UTF8 = new TextEncoder();
const TEXT = new TextDecoder('utf-8', { fatal: true });

export type HizoFSGarbageCollectionCheckpoint = {
  readonly sequence: number;
  readonly activeCommitObjectId: string;
  readonly phase: 'compaction' | 'sweep';
  readonly completedCompactionCandidateCount: number;
  readonly completedSweepCandidateCount: number;
  readonly relocatedObjectCount: number;
  readonly reclaimedCompactionObjectCount: number;
  readonly removedSweepObjectCount: number;
  readonly lastCompletedCandidateObjectId: string | null;
};

function pathForSlot({ slot }: { slot: 0 | 1 }): readonly string[] {
  return ['maintenance', `gc-checkpoint-${String(slot)}.hfs`];
}

function decodeFileSystemId({ fileSystemId }: { fileSystemId: string }): Uint8Array {
  const bytes = decodeBase64Url({ value: fileSystemId });
  if (bytes.byteLength !== 16) throw new Error('HizoFS file-system ID must decode to exactly 16 bytes');
  return bytes;
}

function assertCount({ value, field }: { value: number; field: string }): void {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${field} must be a non-negative safe integer`);
}

function validateCheckpoint({ checkpoint }: { checkpoint: HizoFSGarbageCollectionCheckpoint }): void {
  assertCount({ value: checkpoint.sequence, field: 'HizoFS GC checkpoint sequence' });
  assertCount({ value: checkpoint.completedCompactionCandidateCount, field: 'HizoFS GC completed compaction count' });
  assertCount({ value: checkpoint.completedSweepCandidateCount, field: 'HizoFS GC completed sweep count' });
  assertCount({ value: checkpoint.relocatedObjectCount, field: 'HizoFS GC relocated object count' });
  assertCount({ value: checkpoint.reclaimedCompactionObjectCount, field: 'HizoFS GC reclaimed compaction object count' });
  assertCount({ value: checkpoint.removedSweepObjectCount, field: 'HizoFS GC removed sweep object count' });
  decodeHizoFSObjectReference({ value: checkpoint.activeCommitObjectId });
  if (checkpoint.lastCompletedCandidateObjectId !== null) {
    decodeHizoFSObjectReference({ value: checkpoint.lastCompletedCandidateObjectId });
  }
}

function parsePhase({ value }: { value: unknown }): HizoFSGarbageCollectionCheckpoint['phase'] {
  switch (value) {
  case 'compaction':
    return 'compaction';
  case 'sweep':
    return 'sweep';
  default:
    throw new HizoFSCorruptionError({
      message: 'HizoFS GC checkpoint phase is invalid',
      cause: undefined,
    });
  }
}

async function encodeCheckpoint({ rootKey, fileSystemId, slot, checkpoint }: {
  rootKey: CryptoKey;
  fileSystemId: string;
  slot: 0 | 1;
  checkpoint: HizoFSGarbageCollectionCheckpoint;
}): Promise<Uint8Array> {
  validateCheckpoint({ checkpoint });
  const plaintext = UTF8.encode(JSON.stringify({ version: 1, ...checkpoint }));
  if (plaintext.byteLength > MAX_PAYLOAD_BYTE_LENGTH) throw new Error('HizoFS GC checkpoint exceeds its bounded size');
  const header = new Uint8Array(HEADER_BYTE_LENGTH);
  const view = new DataView(header.buffer);
  header.set(MAGIC, 0);
  view.setUint16(8, FORMAT_VERSION, false);
  view.setUint16(10, HEADER_BYTE_LENGTH, false);
  view.setUint8(12, slot);
  header.set(decodeFileSystemId({ fileSystemId }), 16);
  view.setBigUint64(32, BigInt(checkpoint.sequence), false);
  view.setUint32(40, plaintext.byteLength, false);
  const nonce = createHizoFSNonce();
  header.set(nonce, 44);
  const key = await deriveHizoFSGarbageCollectionCheckpointKey({ rootKey, fileSystemId, slot });
  const ciphertext = await encryptHizoFSAesGcm({ key, nonce, plaintext, additionalData: header });
  return concatenateBytes({ parts: [header, ciphertext] });
}

async function decodeCheckpoint({ rootKey, fileSystemId, slot, bytes }: {
  rootKey: CryptoKey;
  fileSystemId: string;
  slot: 0 | 1;
  bytes: Uint8Array;
}): Promise<HizoFSGarbageCollectionCheckpoint> {
  if (bytes.byteLength < HEADER_BYTE_LENGTH + HIZOFS_AES_GCM_TAG_BYTE_LENGTH) {
    throw new HizoFSCorruptionError({ message: 'HizoFS GC checkpoint is truncated', cause: undefined });
  }
  const header = bytes.subarray(0, HEADER_BYTE_LENGTH);
  if (!bytesEqual({ left: header.subarray(0, 8), right: MAGIC })) {
    throw new HizoFSCorruptionError({ message: 'HizoFS GC checkpoint magic is invalid', cause: undefined });
  }
  const view = new DataView(header.buffer, header.byteOffset, header.byteLength);
  if (view.getUint16(8, false) !== FORMAT_VERSION) {
    throw new HizoFSUnsupportedFormatError({
      message: `HizoFS GC checkpoint version is unsupported: ${String(view.getUint16(8, false))}`,
    });
  }
  if (view.getUint16(10, false) !== HEADER_BYTE_LENGTH || view.getUint8(12) !== slot
    || view.getUint8(13) !== 0 || view.getUint16(14, false) !== 0) {
    throw new HizoFSCorruptionError({ message: 'HizoFS GC checkpoint header is invalid', cause: undefined });
  }
  if (!bytesEqual({ left: header.subarray(16, 32), right: decodeFileSystemId({ fileSystemId }) })) {
    throw new HizoFSCorruptionError({ message: 'HizoFS GC checkpoint file-system ID is invalid', cause: undefined });
  }
  const sequenceBig = view.getBigUint64(32, false);
  if (sequenceBig > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new HizoFSCorruptionError({ message: 'HizoFS GC checkpoint sequence exceeds the safe integer range', cause: undefined });
  }
  const plaintextByteLength = view.getUint32(40, false);
  if (plaintextByteLength > MAX_PAYLOAD_BYTE_LENGTH
    || bytes.byteLength !== HEADER_BYTE_LENGTH + plaintextByteLength + HIZOFS_AES_GCM_TAG_BYTE_LENGTH) {
    throw new HizoFSCorruptionError({ message: 'HizoFS GC checkpoint bounds are invalid', cause: undefined });
  }
  if (view.getBigUint64(56, false) !== 0n) {
    throw new HizoFSCorruptionError({ message: 'HizoFS GC checkpoint reserved bytes must be zero', cause: undefined });
  }
  const nonce = header.subarray(44, 44 + HIZOFS_AES_GCM_NONCE_BYTE_LENGTH);
  const key = await deriveHizoFSGarbageCollectionCheckpointKey({ rootKey, fileSystemId, slot });
  let plaintext: Uint8Array;
  try {
    plaintext = await decryptHizoFSAesGcm({
      key,
      nonce,
      ciphertext: bytes.subarray(HEADER_BYTE_LENGTH),
      additionalData: header,
    });
  } catch (error) {
    throw new HizoFSCorruptionError({ message: 'HizoFS GC checkpoint authentication failed', cause: error });
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(TEXT.decode(plaintext));
  } catch (error) {
    throw new HizoFSCorruptionError({ message: 'HizoFS GC checkpoint payload is invalid JSON', cause: error });
  } finally {
    plaintext.fill(0);
  }
  if (typeof parsed !== 'object' || parsed === null || !('version' in parsed) || parsed.version !== 1) {
    throw new HizoFSCorruptionError({ message: 'HizoFS GC checkpoint payload shape is invalid', cause: undefined });
  }
  const candidate = parsed as Record<string, unknown>;
  const checkpoint: HizoFSGarbageCollectionCheckpoint = {
    sequence: Number(candidate.sequence),
    activeCommitObjectId: String(candidate.activeCommitObjectId),
    phase: parsePhase({ value: candidate.phase }),
    completedCompactionCandidateCount: Number(candidate.completedCompactionCandidateCount),
    completedSweepCandidateCount: Number(candidate.completedSweepCandidateCount),
    relocatedObjectCount: Number(candidate.relocatedObjectCount),
    reclaimedCompactionObjectCount: Number(candidate.reclaimedCompactionObjectCount),
    removedSweepObjectCount: Number(candidate.removedSweepObjectCount),
    lastCompletedCandidateObjectId: candidate.lastCompletedCandidateObjectId === null
      ? null
      : String(candidate.lastCompletedCandidateObjectId),
  };
  if (checkpoint.sequence !== Number(sequenceBig)) {
    throw new HizoFSCorruptionError({ message: 'HizoFS GC checkpoint sequence fields disagree', cause: undefined });
  }
  try {
    validateCheckpoint({ checkpoint });
  } catch (error) {
    throw new HizoFSCorruptionError({ message: 'HizoFS GC checkpoint values are invalid', cause: error });
  }
  return checkpoint;
}

export class HizoFSGarbageCollectionCheckpointStore {
  constructor({ backingStore, rootKey, fileSystemId }: {
    backingStore: HizoFSBackingStore;
    rootKey: CryptoKey;
    fileSystemId: string;
  }) {
    this.backingStore = backingStore;
    this.rootKey = rootKey;
    this.fileSystemId = fileSystemId;
  }
  private readonly backingStore: HizoFSBackingStore;
  private readonly rootKey: CryptoKey;
  private readonly fileSystemId: string;

  async read(): Promise<HizoFSGarbageCollectionCheckpoint | undefined> {
    const valid: HizoFSGarbageCollectionCheckpoint[] = [];
    let present = 0;
    for (const slot of [0, 1] as const) {
      const bytes = await this.backingStore.read({ path: pathForSlot({ slot }) });
      if (bytes === undefined) continue;
      present += 1;
      try {
        valid.push(await decodeCheckpoint({ rootKey: this.rootKey, fileSystemId: this.fileSystemId, slot, bytes }));
      } catch {
        // One corrupt A/B slot is tolerated. Both invalid slots fail closed.
      }
    }
    if (valid.length === 0) {
      if (present > 0) throw new HizoFSCorruptionError({ message: 'No authenticated HizoFS GC checkpoint slot is valid', cause: undefined });
      return undefined;
    }
    valid.sort((left, right) => right.sequence - left.sequence);
    return valid[0];
  }

  async write({ checkpoint }: { checkpoint: HizoFSGarbageCollectionCheckpoint }): Promise<void> {
    const firstSlot = (checkpoint.sequence % 2) as 0 | 1;
    const secondSlot = (1 - firstSlot) as 0 | 1;
    for (const slot of [firstSlot, secondSlot]) {
      const bytes = await encodeCheckpoint({ rootKey: this.rootKey, fileSystemId: this.fileSystemId, slot, checkpoint });
      await this.backingStore.write({ path: pathForSlot({ slot }), bytes });
    }
  }

  async clear(): Promise<void> {
    for (const slot of [0, 1] as const) {
      try {
        await this.backingStore.remove({ path: pathForSlot({ slot }), recursive: false });
      } catch {
        // Missing checkpoint slots are equivalent to a cleared checkpoint.
      }
    }
  }
}

export const TEST_ONLY = {
  encodeCheckpoint,
  decodeCheckpoint,
  pathForSlot,
};
