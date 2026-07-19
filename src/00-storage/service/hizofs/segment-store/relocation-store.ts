import { decodeBase64Url } from '@/00-storage/service/hizofs/base64-url';
import { bytesEqual, concatenateBytes } from '@/00-storage/service/hizofs/bytes';
import { HizoFSCorruptionError, HizoFSUnsupportedFormatError } from '@/00-storage/service/hizofs/errors';
import {
  createHizoFSNonce,
  decryptHizoFSAesGcm,
  deriveHizoFSRelocationMapKey,
  encryptHizoFSAesGcm,
  HIZOFS_AES_GCM_NONCE_BYTE_LENGTH,
  HIZOFS_AES_GCM_TAG_BYTE_LENGTH,
} from '@/00-storage/service/hizofs/segment-store/segment-crypto';
import { decodeHizoFSObjectReference } from '@/00-storage/service/hizofs/segment-store/object-reference';
import type { HizoFSBackingStore } from '@/00-storage/service/hizofs/backing-store/backing-store';

const MAGIC = new TextEncoder().encode('HZRLC001');
const FORMAT_VERSION = 1;
const HEADER_BYTE_LENGTH = 64;
const MAX_ENTRY_COUNT = 1_000_000;
const MAX_PLAINTEXT_BYTE_LENGTH = 64 * 1024 * 1024;
const UTF8 = new TextEncoder();
const TEXT = new TextDecoder('utf-8', { fatal: true });

export type HizoFSRelocationSnapshot = {
  readonly sequence: number;
  readonly mappings: ReadonlyMap<string, string>;
};

type PersistedRelocationMap = {
  readonly version: 1;
  readonly mappings: readonly (readonly [string, string])[];
};

function pathForSlot({ slot }: { slot: 0 | 1 }): readonly string[] {
  return ['maintenance', `relocation-${String(slot)}.hfs`];
}

function decodeFileSystemId({ fileSystemId }: { fileSystemId: string }): Uint8Array {
  const bytes = decodeBase64Url({ value: fileSystemId });
  if (bytes.byteLength !== 16) throw new Error('HizoFS file-system ID must decode to exactly 16 bytes');
  return bytes;
}

function assertSequence({ sequence }: { sequence: number }): void {
  if (!Number.isSafeInteger(sequence) || sequence < 0) {
    throw new Error('HizoFS relocation sequence must be a non-negative safe integer');
  }
}

function validatePair({ source, target }: { source: string; target: string }): void {
  const sourceReference = decodeHizoFSObjectReference({ value: source });
  const targetReference = decodeHizoFSObjectReference({ value: target });
  if (sourceReference.kind !== targetReference.kind) {
    throw new HizoFSCorruptionError({
      message: 'HizoFS relocation changes the logical record kind',
      cause: undefined,
    });
  }
  if (source === target) {
    throw new HizoFSCorruptionError({ message: 'HizoFS relocation maps an object to itself', cause: undefined });
  }
}

function resolveInMap({ mappings, objectId }: {
  mappings: ReadonlyMap<string, string>;
  objectId: string;
}): string {
  let current = objectId;
  const visited = new Set<string>();
  while (true) {
    const next = mappings.get(current);
    if (next === undefined) return current;
    if (visited.has(current)) {
      throw new HizoFSCorruptionError({ message: 'HizoFS relocation map contains a cycle', cause: undefined });
    }
    visited.add(current);
    current = next;
    if (visited.size > mappings.size) {
      throw new HizoFSCorruptionError({ message: 'HizoFS relocation map exceeds its bounded chain length', cause: undefined });
    }
  }
}

function flattenMappings({ mappings }: { mappings: ReadonlyMap<string, string> }): Map<string, string> {
  const flattened = new Map<string, string>();
  for (const [source, target] of mappings) {
    validatePair({ source, target });
    const canonical = resolveInMap({ mappings, objectId: target });
    validatePair({ source, target: canonical });
    flattened.set(source, canonical);
  }
  return flattened;
}

async function encodeSnapshot({ rootKey, fileSystemId, slot, snapshot }: {
  rootKey: CryptoKey;
  fileSystemId: string;
  slot: 0 | 1;
  snapshot: HizoFSRelocationSnapshot;
}): Promise<Uint8Array> {
  assertSequence({ sequence: snapshot.sequence });
  const mappings = [...flattenMappings({ mappings: snapshot.mappings })]
    .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0);
  if (mappings.length > MAX_ENTRY_COUNT) throw new Error('HizoFS relocation map contains too many entries');
  const plaintext = UTF8.encode(JSON.stringify({ version: 1, mappings } satisfies PersistedRelocationMap));
  if (plaintext.byteLength > MAX_PLAINTEXT_BYTE_LENGTH) {
    throw new Error('HizoFS relocation map exceeds its bounded plaintext size');
  }
  const header = new Uint8Array(HEADER_BYTE_LENGTH);
  const view = new DataView(header.buffer);
  header.set(MAGIC, 0);
  view.setUint16(8, FORMAT_VERSION, false);
  view.setUint16(10, HEADER_BYTE_LENGTH, false);
  view.setUint8(12, slot);
  header.set(decodeFileSystemId({ fileSystemId }), 16);
  view.setBigUint64(32, BigInt(snapshot.sequence), false);
  view.setUint32(40, mappings.length, false);
  view.setUint32(44, plaintext.byteLength, false);
  const nonce = createHizoFSNonce();
  header.set(nonce, 48);
  const key = await deriveHizoFSRelocationMapKey({ rootKey, fileSystemId, slot });
  const ciphertext = await encryptHizoFSAesGcm({ key, nonce, plaintext, additionalData: header });
  return concatenateBytes({ parts: [header, ciphertext] });
}

async function decodeSnapshot({ rootKey, fileSystemId, slot, bytes }: {
  rootKey: CryptoKey;
  fileSystemId: string;
  slot: 0 | 1;
  bytes: Uint8Array;
}): Promise<HizoFSRelocationSnapshot> {
  if (bytes.byteLength < HEADER_BYTE_LENGTH + HIZOFS_AES_GCM_TAG_BYTE_LENGTH) {
    throw new HizoFSCorruptionError({ message: 'HizoFS relocation map is truncated', cause: undefined });
  }
  const header = bytes.subarray(0, HEADER_BYTE_LENGTH);
  if (!bytesEqual({ left: header.subarray(0, 8), right: MAGIC })) {
    throw new HizoFSCorruptionError({ message: 'HizoFS relocation-map magic is invalid', cause: undefined });
  }
  const view = new DataView(header.buffer, header.byteOffset, header.byteLength);
  if (view.getUint16(8, false) !== FORMAT_VERSION) {
    throw new HizoFSUnsupportedFormatError({
      message: `HizoFS relocation-map version is unsupported: ${String(view.getUint16(8, false))}`,
    });
  }
  if (view.getUint16(10, false) !== HEADER_BYTE_LENGTH || view.getUint8(12) !== slot
    || view.getUint8(13) !== 0 || view.getUint16(14, false) !== 0) {
    throw new HizoFSCorruptionError({ message: 'HizoFS relocation-map header is invalid', cause: undefined });
  }
  if (!bytesEqual({ left: header.subarray(16, 32), right: decodeFileSystemId({ fileSystemId }) })) {
    throw new HizoFSCorruptionError({ message: 'HizoFS relocation-map file-system ID is invalid', cause: undefined });
  }
  const sequenceBig = view.getBigUint64(32, false);
  if (sequenceBig > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new HizoFSCorruptionError({ message: 'HizoFS relocation-map sequence exceeds the safe integer range', cause: undefined });
  }
  const sequence = Number(sequenceBig);
  const entryCount = view.getUint32(40, false);
  const plaintextByteLength = view.getUint32(44, false);
  if (entryCount > MAX_ENTRY_COUNT || plaintextByteLength > MAX_PLAINTEXT_BYTE_LENGTH
    || bytes.byteLength !== HEADER_BYTE_LENGTH + plaintextByteLength + HIZOFS_AES_GCM_TAG_BYTE_LENGTH) {
    throw new HizoFSCorruptionError({ message: 'HizoFS relocation-map bounds are invalid', cause: undefined });
  }
  const nonce = header.subarray(48, 48 + HIZOFS_AES_GCM_NONCE_BYTE_LENGTH);
  const key = await deriveHizoFSRelocationMapKey({ rootKey, fileSystemId, slot });
  let plaintext: Uint8Array;
  try {
    plaintext = await decryptHizoFSAesGcm({
      key,
      nonce,
      ciphertext: bytes.subarray(HEADER_BYTE_LENGTH),
      additionalData: header,
    });
  } catch (error) {
    throw new HizoFSCorruptionError({ message: 'HizoFS relocation-map authentication failed', cause: error });
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(TEXT.decode(plaintext));
  } catch (error) {
    throw new HizoFSCorruptionError({ message: 'HizoFS relocation-map payload is invalid JSON', cause: error });
  } finally {
    plaintext.fill(0);
  }
  if (typeof parsed !== 'object' || parsed === null || !('version' in parsed) || parsed.version !== 1
    || !('mappings' in parsed) || !Array.isArray(parsed.mappings) || parsed.mappings.length !== entryCount) {
    throw new HizoFSCorruptionError({ message: 'HizoFS relocation-map payload shape is invalid', cause: undefined });
  }
  const mappings = new Map<string, string>();
  let previousSource: string | undefined;
  for (const pair of parsed.mappings) {
    if (!Array.isArray(pair) || pair.length !== 2 || typeof pair[0] !== 'string' || typeof pair[1] !== 'string') {
      throw new HizoFSCorruptionError({ message: 'HizoFS relocation-map entry is invalid', cause: undefined });
    }
    const [source, target] = pair;
    validatePair({ source, target });
    if (previousSource !== undefined && source <= previousSource) {
      throw new HizoFSCorruptionError({ message: 'HizoFS relocation-map entries are not canonical', cause: undefined });
    }
    mappings.set(source, target);
    previousSource = source;
  }
  return { sequence, mappings: flattenMappings({ mappings }) };
}

export class HizoFSRelocationStore {
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
  private loaded: Promise<HizoFSRelocationSnapshot> | undefined;

  load(): Promise<HizoFSRelocationSnapshot> {
    this.loaded ??= this.loadFromBacking();
    return this.loaded;
  }

  async resolve({ objectId }: { objectId: string }): Promise<string> {
    const snapshot = await this.load();
    return resolveInMap({ mappings: snapshot.mappings, objectId });
  }

  async publish({ mappings: additions }: {
    mappings: ReadonlyMap<string, string>;
  }): Promise<HizoFSRelocationSnapshot> {
    const current = await this.load();
    const merged = new Map(current.mappings);
    for (const [source, target] of additions) merged.set(source, target);
    const flattened = flattenMappings({ mappings: merged });
    const snapshot = { sequence: current.sequence + 1, mappings: flattened };
    const firstSlot = (snapshot.sequence % 2) as 0 | 1;
    const secondSlot = (1 - firstSlot) as 0 | 1;
    const firstBytes = await encodeSnapshot({
      rootKey: this.rootKey,
      fileSystemId: this.fileSystemId,
      slot: firstSlot,
      snapshot,
    });
    await this.backingStore.write({ path: pathForSlot({ slot: firstSlot }), bytes: firstBytes });
    this.loaded = Promise.resolve(snapshot);
    const secondBytes = await encodeSnapshot({
      rootKey: this.rootKey,
      fileSystemId: this.fileSystemId,
      slot: secondSlot,
      snapshot,
    });
    await this.backingStore.write({ path: pathForSlot({ slot: secondSlot }), bytes: secondBytes });
    return snapshot;
  }

  private async loadFromBacking(): Promise<HizoFSRelocationSnapshot> {
    const valid: HizoFSRelocationSnapshot[] = [];
    let presentCount = 0;
    for (const slot of [0, 1] as const) {
      const bytes = await this.backingStore.read({ path: pathForSlot({ slot }) });
      if (bytes === undefined) continue;
      presentCount += 1;
      try {
        valid.push(await decodeSnapshot({ rootKey: this.rootKey, fileSystemId: this.fileSystemId, slot, bytes }));
      } catch {
        // A/B publication tolerates one torn or corrupt slot. If no valid slot
        // remains, fail closed below rather than silently discarding mappings.
      }
    }
    if (valid.length === 0) {
      if (presentCount > 0) {
        throw new HizoFSCorruptionError({ message: 'No authenticated HizoFS relocation-map slot is valid', cause: undefined });
      }
      return { sequence: 0, mappings: new Map() };
    }
    valid.sort((left, right) => right.sequence - left.sequence);
    const newest = valid[0];
    if (newest === undefined) return { sequence: 0, mappings: new Map() };
    for (const candidate of valid.slice(1)) {
      if (candidate.sequence !== newest.sequence) continue;
      const left = JSON.stringify([...candidate.mappings]);
      const right = JSON.stringify([...newest.mappings]);
      if (left !== right) {
        throw new HizoFSCorruptionError({
          message: 'HizoFS relocation-map slots disagree at the same sequence',
          cause: undefined,
        });
      }
    }
    return newest;
  }
}

export const TEST_ONLY = {
  encodeSnapshot,
  decodeSnapshot,
  flattenMappings,
  resolveInMap,
  pathForSlot,
};
