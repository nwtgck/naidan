#!/usr/bin/env node
// TODO(hizofs-segment-store): Port this independent Node.js recovery tool to
// the segmented HizoFS format before recovery tooling is shipped. The
// TypeScript runtime now uses authenticated A/B heads and packed segment
// records; this unreleased object-per-file reader is intentionally not kept as
// a compatibility path.
import { Buffer } from 'node:buffer';
import { TextDecoder } from 'node:util';
import console from 'node:console';
import {
  createDecipheriv,
  hkdfSync,
  pbkdf2Sync,
} from 'node:crypto';
import {
  lstat,
  mkdir,
  open,
  readFile,
  rename,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from 'node:path';
import process, { stdin, stdout } from 'node:process';
import { createInterface } from 'node:readline/promises';

const OBJECT_MAGIC = Buffer.from([0x48, 0x49, 0x5a, 0x4f, 0x46, 0x53, 0x00, 0x00]);
const OBJECT_ENVELOPE_VERSION = 1;
const OBJECT_HEADER_BYTE_LENGTH = 32;
const RECORD_HEADER_BYTE_LENGTH = 16;
const AES_GCM_TAG_BYTE_LENGTH = 16;
const MAX_PBKDF2_ITERATIONS = 10_000_000;
const MAX_ENCRYPTION_KEY_SLOTS = 32;
const OBJECT_ID_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-';
const OBJECT_ID_LENGTH = 21;
const STABLE_ID_BYTE_LENGTH = 16;
const HIZOFS_FILE_SYSTEM_ID_SALT = Buffer.from(
  'HizoFS/v1/filesystem-id/salt',
  'utf8',
);
const HIZOFS_FILE_SYSTEM_ID_INFO = Buffer.from(
  'HizoFS/v1/filesystem-id',
  'utf8',
);
const RECORD_KINDS = new Map([
  [1, 'commit'],
  [2, 'inode_index_page'],
  [3, 'file_inode'],
  [4, 'directory_inode'],
  [5, 'symlink_inode'],
  [6, 'directory_index_page'],
  [7, 'file_extent_page'],
  [8, 'file_chunk'],
  [9, 'superblock'],
]);

class UnsupportedFormatError extends Error {}
class CorruptionError extends Error {}

function usage() {
  console.error(`Usage:
  node naidan-recover.mjs <raw-opfs-or-naidan-storage> <output-directory>
    [--passphrase <value>]
    [--store-id <encrypted-store-id>]

The input may be a raw OPFS export root containing naidan-storage/ or the
naidan-storage/ directory itself. The output directory must not already exist.`);
}

function parseArgs(argv) {
  const positional = [];
  const options = new Map();
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (!value.startsWith('--')) {
      positional.push(value);
      continue;
    }
    const next = argv[index + 1];
    if (next === undefined || next.startsWith('--')) {
      throw new Error(`Missing value for ${value}`);
    }
    options.set(value, next);
    index += 1;
  }
  if (positional.length !== 2) {
    usage();
    return undefined;
  }
  return {
    input: resolve(positional[0]),
    output: resolve(positional[1]),
    passphrase: options.get('--passphrase'),
    storeId: options.get('--store-id'),
  };
}

function assertObject(value, label) {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new CorruptionError(`${label} must be an object`);
  }
  return value;
}

function assertString(value, label) {
  if (typeof value !== 'string') {
    throw new CorruptionError(`${label} must be a string`);
  }
  return value;
}

function assertArray(value, label) {
  if (!Array.isArray(value)) {
    throw new CorruptionError(`${label} must be an array`);
  }
  return value;
}

function assertNonNegativeSafeInteger(value, label) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new CorruptionError(`${label} must be a non-negative safe integer`);
  }
  return value;
}

function assertPositiveSafeInteger(value, label) {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new CorruptionError(`${label} must be a positive safe integer`);
  }
  return value;
}

function decodeBase64Url(value, expectedLength, label) {
  const text = assertString(value, label);
  if (!/^[A-Za-z0-9_-]*$/.test(text)) {
    throw new CorruptionError(`${label} is not canonical Base64URL`);
  }
  const bytes = Buffer.from(text, 'base64url');
  if (bytes.length !== expectedLength || bytes.toString('base64url') !== text) {
    throw new CorruptionError(`${label} must contain exactly ${expectedLength} bytes`);
  }
  return bytes;
}

function assertObjectId(value, label) {
  const text = assertString(value, label);
  if (text.length !== OBJECT_ID_LENGTH) {
    throw new CorruptionError(`${label} must contain exactly ${OBJECT_ID_LENGTH} characters`);
  }
  for (const character of text) {
    if (!OBJECT_ID_ALPHABET.includes(character)) {
      throw new CorruptionError(`${label} contains a character outside its canonical alphabet`);
    }
  }
  return text;
}

function getObjectShard(objectId) {
  assertObjectId(objectId, 'HizoFS object ID');
  const firstIndex = OBJECT_ID_ALPHABET.indexOf(objectId[0]);
  const secondIndex = OBJECT_ID_ALPHABET.indexOf(objectId[1]);
  return ((firstIndex << 2) | (secondIndex >>> 4)).toString(16).padStart(2, '0');
}

function deriveHizoFSFileSystemId(rootKey) {
  return Buffer.from(hkdfSync(
    'sha256',
    rootKey,
    HIZOFS_FILE_SYSTEM_ID_SALT,
    HIZOFS_FILE_SYSTEM_ID_INFO,
    STABLE_ID_BYTE_LENGTH,
  )).toString('base64url');
}

function assertStableId(value, label) {
  decodeBase64Url(value, STABLE_ID_BYTE_LENGTH, label);
  return value;
}

function assertEntryName(value) {
  const name = assertString(value, 'Directory entry name');
  if (name === '' || name === '.' || name === '..' || name.includes('/') || name.includes('\0')) {
    throw new CorruptionError(`Invalid HizoFS directory entry name: ${JSON.stringify(name)}`);
  }
  return name;
}

async function readJson(path) {
  let bytes;
  try {
    bytes = await readFile(path);
  } catch (error) {
    if (error?.code === 'ENOENT') return undefined;
    throw error;
  }
  let text;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch (error) {
    throw new CorruptionError(`JSON file is not valid UTF-8: ${path}`, { cause: error });
  }
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new CorruptionError(`JSON file is invalid: ${path}`, { cause: error });
  }
}

async function validateOptionalHizoFSDescriptor(path) {
  let bytes;
  try {
    bytes = await readFile(path);
  } catch (error) {
    if (error?.code === 'ENOENT') return;
    throw error;
  }

  let raw;
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    raw = JSON.parse(text);
  } catch {
    // The descriptor is a non-secret marker. A complete authenticated
    // generation remains authoritative when this marker is truncated or lost.
    return;
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return;
  if ('format' in raw && raw.format !== 'hizofs') {
    throw new UnsupportedFormatError(`HizoFS descriptor identifier is unsupported: ${String(raw.format)}`);
  }
  if (
    'formatVersion' in raw
    && (!Number.isSafeInteger(raw.formatVersion) || raw.formatVersion !== 1)
  ) {
    throw new UnsupportedFormatError(`HizoFS descriptor format is unsupported: ${String(raw.formatVersion)}`);
  }
}

async function findStorageRoot(input) {
  if (basename(input) === 'naidan-storage') return input;
  const nested = join(input, 'naidan-storage');
  try {
    if ((await lstat(nested)).isDirectory()) return nested;
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  return input;
}

function parseState(value) {
  const state = assertObject(value, 'Encryption state');
  if (state.formatVersion !== 1) {
    throw new UnsupportedFormatError(`Encryption state format is unsupported: ${String(state.formatVersion)}`);
  }
  assertNonNegativeSafeInteger(state.sequence, 'Encryption state sequence');
  const keySlots = assertArray(state.keySlots, 'Encryption key slots');
  if (keySlots.length < 1 || keySlots.length > MAX_ENCRYPTION_KEY_SLOTS) {
    throw new CorruptionError(`Encryption state must contain between 1 and ${MAX_ENCRYPTION_KEY_SLOTS} key slots`);
  }
  if (state.state !== 'encrypted' && state.state !== 'transitioning') {
    throw new UnsupportedFormatError(`Encryption state is unsupported: ${String(state.state)}`);
  }
  return state;
}

async function readEncryptionState(storageRoot) {
  const candidates = [];
  for (const slot of [0, 1]) {
    const path = join(storageRoot, 'encryption-state', `state-${slot}.json`);
    let raw;
    try {
      raw = await readJson(path);
    } catch (error) {
      if (error instanceof SyntaxError) continue;
      throw error;
    }
    if (raw === undefined || typeof raw !== 'object' || raw === null) continue;
    const sequence = raw.sequence;
    const formatVersion = raw.formatVersion;
    if (!Number.isSafeInteger(sequence) || sequence < 0 || !Number.isSafeInteger(formatVersion) || formatVersion < 1) {
      continue;
    }
    candidates.push({ sequence, raw });
  }
  candidates.sort((left, right) => right.sequence - left.sequence);
  if (candidates.length >= 2 && candidates[0].sequence === candidates[1].sequence) {
    throw new CorruptionError('Encryption state slots have the same sequence');
  }
  if (candidates.length === 0) {
    throw new CorruptionError('No valid encryption state slot exists');
  }
  return parseState(candidates[0].raw);
}

function chooseStoreId(state, explicitStoreId) {
  if (explicitStoreId !== undefined) return explicitStoreId;
  if (state.state === 'encrypted') {
    return assertString(state.activeEncryptedStoreId, 'Active encrypted store ID');
  }
  const operation = assertObject(state.operation, 'Encryption operation');
  const phase = operation.phase;
  switch (operation.type) {
  case 'encrypting':
    if (phase !== 'cleaning_up_source') {
      throw new Error('The encrypted target is not authoritative yet; pass --store-id only to inspect an explicitly chosen incomplete store');
    }
    return assertString(operation.targetEncryptedStoreId, 'Target encrypted store ID');
  case 'decrypting':
    return assertString(operation.sourceEncryptedStoreId, 'Source encrypted store ID');
  case 'reencrypting':
    return phase === 'cleaning_up_source'
      ? assertString(operation.targetEncryptedStoreId, 'Target encrypted store ID')
      : assertString(operation.sourceEncryptedStoreId, 'Source encrypted store ID');
  default:
    throw new UnsupportedFormatError(`Encryption operation is unsupported: ${String(operation.type)}`);
  }
}

async function readStoreHeader(storageRoot, storeId) {
  const valid = [];
  const failures = [];
  for (const name of ['header-0.json', 'header-1.json']) {
    try {
      const raw = await readJson(join(
        storageRoot,
        'encrypted-stores',
        storeId,
        name,
      ));
      if (raw === undefined) continue;
      const header = assertObject(raw, 'Encrypted store header');
      if (header.formatVersion !== 1) {
        throw new UnsupportedFormatError(
          `Encrypted store header format is unsupported: ${String(header.formatVersion)}`,
        );
      }
      if (header.encryptedStoreId !== storeId) {
        throw new CorruptionError(
          'Encrypted store header ID does not match its directory',
        );
      }
      assertStableId(header.fileSystemId, 'Encrypted store fileSystemId');
      const wrappedFileSystemRootKey = assertObject(
        header.wrappedFileSystemRootKey,
        'Wrapped file-system root key',
      );
      decodeBase64Url(
        wrappedFileSystemRootKey.nonce,
        12,
        'Wrapped file-system root key nonce',
      );
      decodeBase64Url(
        wrappedFileSystemRootKey.ciphertext,
        48,
        'Wrapped file-system root key ciphertext',
      );
      valid.push(header);
    } catch (error) {
      if (error instanceof UnsupportedFormatError) throw error;
      failures.push(error);
    }
  }
  if (valid.length === 0) {
    throw new AggregateError(failures, 'Encrypted store has no valid header copy');
  }
  const selected = valid[0];
  for (const candidate of valid.slice(1)) {
    if (
      candidate.formatVersion !== selected.formatVersion
      || candidate.encryptedStoreId !== selected.encryptedStoreId
      || candidate.fileSystemId !== selected.fileSystemId
      || candidate.wrappedFileSystemRootKey.nonce
        !== selected.wrappedFileSystemRootKey.nonce
      || candidate.wrappedFileSystemRootKey.ciphertext
        !== selected.wrappedFileSystemRootKey.ciphertext
    ) {
      throw new CorruptionError('Encrypted store header copies disagree');
    }
  }
  return selected;
}

function decryptAesGcm({ key, nonce, ciphertext, aad }) {
  if (nonce.length !== 12 || ciphertext.length < AES_GCM_TAG_BYTE_LENGTH) {
    throw new CorruptionError('AES-GCM input has an invalid length');
  }
  const body = ciphertext.subarray(0, ciphertext.length - AES_GCM_TAG_BYTE_LENGTH);
  const tag = ciphertext.subarray(ciphertext.length - AES_GCM_TAG_BYTE_LENGTH);
  const decipher = createDecipheriv('aes-256-gcm', key, nonce);
  decipher.setAAD(Buffer.from(aad));
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(body), decipher.final()]);
}

function unwrapStorageUnlockKey(state, passphrase) {
  const slots = state.keySlots;
  for (const rawSlot of slots) {
    const slot = assertObject(rawSlot, 'Encryption key slot');
    const slotId = assertString(slot.id, 'Encryption key slot ID');
    const keyDerivation = assertObject(slot.keyDerivation, 'Encryption key derivation');
    if (keyDerivation.type !== 'pbkdf2_hmac_sha256') {
      throw new UnsupportedFormatError(`Key derivation is unsupported: ${String(keyDerivation.type)}`);
    }
    const iterations = assertPositiveSafeInteger(keyDerivation.iterations, 'PBKDF2 iteration count');
    if (iterations > MAX_PBKDF2_ITERATIONS) {
      throw new CorruptionError(`PBKDF2 iteration count exceeds ${MAX_PBKDF2_ITERATIONS}`);
    }
    const salt = decodeBase64Url(keyDerivation.salt, 32, 'PBKDF2 salt');
    const wrapped = assertObject(slot.wrappedStorageUnlockKey, 'Wrapped Storage Unlock Key');
    const nonce = decodeBase64Url(wrapped.nonce, 12, 'Wrapped Storage Unlock Key nonce');
    const ciphertext = decodeBase64Url(wrapped.ciphertext, 48, 'Wrapped Storage Unlock Key ciphertext');
    const wrappingKey = pbkdf2Sync(Buffer.from(passphrase, 'utf8'), salt, iterations, 32, 'sha256');
    try {
      const unwrapped = decryptAesGcm({
        key: wrappingKey,
        nonce,
        ciphertext,
        aad: Buffer.from(`naidan/opfs-encryption/storage-unlock-key/v1/${slotId}`, 'utf8'),
      });
      if (unwrapped.length === 32) return unwrapped;
    } catch {
      // Continue because a different key slot may use the supplied passphrase.
    } finally {
      wrappingKey.fill(0);
    }
  }
  throw new Error('Passphrase did not unlock any encryption key slot');
}

function unwrapFileSystemRootKey(storageUnlockKey, header) {
  const wrapped = assertObject(header.wrappedFileSystemRootKey, 'Wrapped file-system root key');
  const nonce = decodeBase64Url(wrapped.nonce, 12, 'Wrapped file-system root key nonce');
  const ciphertext = decodeBase64Url(wrapped.ciphertext, 48, 'Wrapped file-system root key ciphertext');
  const rootKey = decryptAesGcm({
    key: storageUnlockKey,
    nonce,
    ciphertext,
    aad: Buffer.from(`naidan/opfs-encryption/store-root-key/v1/${header.encryptedStoreId}`, 'utf8'),
  });
  if (rootKey.length !== 32) throw new CorruptionError('Unwrapped file-system root key has an invalid length');
  return rootKey;
}

function decodeObjectEnvelope(physical) {
  if (physical.length < OBJECT_HEADER_BYTE_LENGTH + AES_GCM_TAG_BYTE_LENGTH) {
    throw new CorruptionError('HizoFS object is truncated');
  }
  if (!physical.subarray(0, OBJECT_MAGIC.length).equals(OBJECT_MAGIC)) {
    throw new CorruptionError('HizoFS object magic is invalid');
  }
  const version = physical.readUInt16BE(8);
  if (version !== OBJECT_ENVELOPE_VERSION) {
    throw new UnsupportedFormatError(`HizoFS object envelope version is unsupported: ${version}`);
  }
  const headerLength = physical.readUInt16BE(10);
  if (headerLength !== OBJECT_HEADER_BYTE_LENGTH) {
    throw new UnsupportedFormatError(`HizoFS object header length is unsupported: ${headerLength}`);
  }
  const ciphertextLength = physical.readBigUInt64BE(24);
  if (ciphertextLength > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new CorruptionError('HizoFS object ciphertext length exceeds the safe integer range');
  }
  if (physical.length !== OBJECT_HEADER_BYTE_LENGTH + Number(ciphertextLength)) {
    throw new CorruptionError('HizoFS object ciphertext length does not match the envelope');
  }
  return {
    nonce: physical.subarray(12, 24),
    ciphertext: physical.subarray(OBJECT_HEADER_BYTE_LENGTH),
  };
}

function decodeRecord(plaintext) {
  if (plaintext.length < RECORD_HEADER_BYTE_LENGTH) {
    throw new CorruptionError('HizoFS record is truncated');
  }
  const kind = RECORD_KINDS.get(plaintext[0]);
  if (kind === undefined) {
    throw new UnsupportedFormatError(`HizoFS record kind is unsupported: ${String(plaintext[0])}`);
  }
  if (plaintext[1] !== 0) {
    throw new UnsupportedFormatError(`HizoFS payload encoding is unsupported: ${String(plaintext[1])}`);
  }
  const recordVersion = plaintext.readUInt16BE(2);
  if (recordVersion !== 1) {
    throw new UnsupportedFormatError(`HizoFS ${kind} record version is unsupported: ${recordVersion}`);
  }
  const metadataLength = plaintext.readUInt32BE(4);
  const binaryLength = plaintext.readBigUInt64BE(8);
  if (binaryLength > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new CorruptionError('HizoFS record binary length exceeds the safe integer range');
  }
  const expectedLength = RECORD_HEADER_BYTE_LENGTH + metadataLength + Number(binaryLength);
  if (plaintext.length !== expectedLength) {
    throw new CorruptionError('HizoFS record lengths do not match its plaintext');
  }
  let metadata;
  try {
    metadata = JSON.parse(plaintext.subarray(RECORD_HEADER_BYTE_LENGTH, RECORD_HEADER_BYTE_LENGTH + metadataLength).toString('utf8'));
  } catch (error) {
    throw new CorruptionError(`HizoFS record metadata is invalid JSON: ${error.message}`);
  }
  return {
    kind,
    metadata,
    binary: plaintext.subarray(RECORD_HEADER_BYTE_LENGTH + metadataLength),
  };
}

class HizoFSReader {
  constructor({ dataDirectory, fileSystemId, rootKey }) {
    this.dataDirectory = dataDirectory;
    this.fileSystemId = fileSystemId;
    this.rootKey = rootKey;
  }

  async readObject(objectId) {
    const shard = getObjectShard(objectId);
    return this.readEncryptedRecord({
      path: join(this.dataDirectory, 'objects', shard, `${objectId}.enc`),
      objectIdentity: objectId,
      area: 'object',
    });
  }

  async readSuperblockSlot(slot) {
    return this.readEncryptedRecord({
      path: join(this.dataDirectory, `superblock-${slot}.enc`),
      objectIdentity: `superblock-${slot}`,
      area: 'superblock',
      missingOk: true,
    });
  }

  async readEncryptedRecord({ path, objectIdentity, area, missingOk = false }) {
    let physical;
    try {
      physical = await readFile(path);
    } catch (error) {
      if (missingOk && error?.code === 'ENOENT') return undefined;
      if (error?.code === 'ENOENT') throw new CorruptionError(`HizoFS object is missing: ${objectIdentity}`);
      throw error;
    }
    const { nonce, ciphertext } = decodeObjectEnvelope(physical);
    const key = Buffer.from(hkdfSync(
      'sha256',
      this.rootKey,
      Buffer.from(`HizoFS/v1/filesystem/${this.fileSystemId}`, 'utf8'),
      Buffer.from(`HizoFS/v1/${area}/${objectIdentity}`, 'utf8'),
      32,
    ));
    try {
      const plaintext = decryptAesGcm({
        key,
        nonce,
        ciphertext,
        aad: Buffer.from(`HizoFS/v1/${area}/${this.fileSystemId}/${objectIdentity}`, 'utf8'),
      });
      return decodeRecord(plaintext);
    } finally {
      key.fill(0);
    }
  }

  async readSuperblockCandidates() {
    const candidates = [];
    const corruptions = [];
    for (const slot of [0, 1]) {
      let record;
      try {
        record = await this.readSuperblockSlot(slot);
      } catch (error) {
        if (error instanceof UnsupportedFormatError) throw error;
        corruptions.push(error);
        continue;
      }
      if (record === undefined) continue;
      if (record.kind !== 'superblock') {
        throw new UnsupportedFormatError(`HizoFS superblock slot ${slot} has an unsupported record kind`);
      }
      if (record.binary.length !== 0) throw new CorruptionError('HizoFS superblock has a binary payload');
      const value = assertObject(record.metadata, 'HizoFS superblock');
      const sequence = assertNonNegativeSafeInteger(value.sequence, 'HizoFS superblock sequence');
      if (value.fileSystemId !== this.fileSystemId) throw new CorruptionError('HizoFS superblock fileSystemId mismatch');
      assertObjectId(value.activeCommitObjectId, 'HizoFS active commit object ID');
      candidates.push({ sequence, value });
    }
    candidates.sort((left, right) => right.sequence - left.sequence);
    if (candidates.length === 0) {
      throw new CorruptionError(corruptions.length > 0
        ? 'No valid HizoFS superblock slot remains'
        : 'HizoFS superblock is missing');
    }
    if (candidates.length >= 2 && candidates[0].sequence === candidates[1].sequence) {
      throw new CorruptionError('HizoFS superblock slots have the same sequence');
    }
    return candidates.map(candidate => candidate.value);
  }
}

function parseIndexPage(record, expectedKind) {
  if (record.kind !== expectedKind) throw new CorruptionError(`Expected ${expectedKind}, received ${record.kind}`);
  if (record.binary.length !== 0) throw new CorruptionError(`${expectedKind} contains a binary payload`);
  return assertObject(record.metadata, expectedKind);
}

async function loadInodeIndex(reader, rootObjectId) {
  const result = new Map();
  const visited = new Set();
  async function visit(objectId) {
    assertObjectId(objectId, 'Inode index page object ID');
    if (visited.has(objectId)) throw new CorruptionError('Inode index contains a cycle or duplicate page reference');
    visited.add(objectId);
    const page = parseIndexPage(await reader.readObject(objectId), 'inode_index_page');
    if (page.type === 'leaf') {
      let previous;
      for (const rawEntry of assertArray(page.entries, 'Inode index entries')) {
        const entry = assertObject(rawEntry, 'Inode index entry');
        const nodeId = assertStableId(entry.nodeId, 'Inode index node ID');
        const inodeObjectId = assertObjectId(entry.inodeObjectId, 'Inode object ID');
        if (previous !== undefined && previous >= nodeId) throw new CorruptionError('Inode index entries are not strictly sorted');
        if (result.has(nodeId)) throw new CorruptionError(`Duplicate inode index node ID: ${nodeId}`);
        result.set(nodeId, inodeObjectId);
        previous = nodeId;
      }
      return;
    }
    if (page.type === 'branch') {
      let previous;
      for (const rawChild of assertArray(page.children, 'Inode index children')) {
        const child = assertObject(rawChild, 'Inode index child');
        const upperBound = assertStableId(child.upperBoundNodeId, 'Inode index upper bound');
        if (previous !== undefined && previous >= upperBound) throw new CorruptionError('Inode index bounds are not strictly sorted');
        await visit(assertObjectId(child.childPageObjectId, 'Inode index child object ID'));
        previous = upperBound;
      }
      return;
    }
    throw new UnsupportedFormatError(`Inode index page type is unsupported: ${String(page.type)}`);
  }
  await visit(rootObjectId);
  return result;
}

async function loadDirectoryEntries(reader, inode) {
  const storage = assertObject(inode.storage, 'Directory storage');
  if (storage.type === 'inline') return parseDirectoryEntries(storage.entries);
  if (storage.type !== 'indexed') throw new UnsupportedFormatError(`Directory storage is unsupported: ${String(storage.type)}`);
  const result = [];
  const visited = new Set();
  async function visit(objectId) {
    assertObjectId(objectId, 'Directory index page object ID');
    if (visited.has(objectId)) throw new CorruptionError('Directory index contains a cycle or duplicate page reference');
    visited.add(objectId);
    const page = parseIndexPage(await reader.readObject(objectId), 'directory_index_page');
    if (page.type === 'leaf') {
      result.push(...parseDirectoryEntries(page.entries));
      return;
    }
    if (page.type === 'branch') {
      let previous;
      for (const rawChild of assertArray(page.children, 'Directory index children')) {
        const child = assertObject(rawChild, 'Directory index child');
        const upperBound = assertString(child.upperBoundName, 'Directory index upper bound');
        if (previous !== undefined && previous >= upperBound) throw new CorruptionError('Directory index bounds are not strictly sorted');
        await visit(assertObjectId(child.childPageObjectId, 'Directory index child object ID'));
        previous = upperBound;
      }
      return;
    }
    throw new UnsupportedFormatError(`Directory index page type is unsupported: ${String(page.type)}`);
  }
  await visit(assertObjectId(storage.directoryIndexRootObjectId, 'Directory index root object ID'));
  for (let index = 1; index < result.length; index += 1) {
    if (result[index - 1].name >= result[index].name) throw new CorruptionError('Directory entries are not strictly sorted and unique');
  }
  return result;
}

function parseDirectoryEntries(value) {
  const entries = [];
  let previous;
  for (const rawEntry of assertArray(value, 'Directory entries')) {
    const entry = assertObject(rawEntry, 'Directory entry');
    const name = assertEntryName(entry.name);
    const kind = entry.kind;
    if (kind !== 'file' && kind !== 'directory' && kind !== 'symlink') {
      throw new UnsupportedFormatError(`Directory entry kind is unsupported: ${String(kind)}`);
    }
    const nodeId = assertStableId(entry.nodeId, 'Directory entry node ID');
    if (previous !== undefined && previous >= name) throw new CorruptionError('Directory entries are not strictly sorted and unique');
    entries.push({ name, kind, nodeId });
    previous = name;
  }
  return entries;
}

async function loadExtents(reader, rootObjectId) {
  const result = [];
  const visited = new Set();
  async function visit(objectId) {
    assertObjectId(objectId, 'Extent page object ID');
    if (visited.has(objectId)) throw new CorruptionError('Extent index contains a cycle or duplicate page reference');
    visited.add(objectId);
    const page = parseIndexPage(await reader.readObject(objectId), 'file_extent_page');
    if (page.type === 'leaf') {
      for (const rawExtent of assertArray(page.extents, 'File extents')) {
        const extent = assertObject(rawExtent, 'File extent');
        result.push({
          chunkIndex: assertNonNegativeSafeInteger(extent.chunkIndex, 'File extent chunk index'),
          chunkObjectId: assertObjectId(extent.chunkObjectId, 'File chunk object ID'),
        });
      }
      return;
    }
    if (page.type === 'branch') {
      let previous;
      for (const rawChild of assertArray(page.children, 'Extent index children')) {
        const child = assertObject(rawChild, 'Extent index child');
        const upperBound = assertNonNegativeSafeInteger(child.upperBoundChunkIndex, 'Extent upper bound');
        if (previous !== undefined && previous >= upperBound) throw new CorruptionError('Extent index bounds are not strictly sorted');
        await visit(assertObjectId(child.childPageObjectId, 'Extent child object ID'));
        previous = upperBound;
      }
      return;
    }
    throw new UnsupportedFormatError(`Extent page type is unsupported: ${String(page.type)}`);
  }
  await visit(rootObjectId);
  for (let index = 1; index < result.length; index += 1) {
    if (result[index - 1].chunkIndex >= result[index].chunkIndex) throw new CorruptionError('File extents are not strictly sorted and unique');
  }
  return result;
}

function ensurePathInside(root, path) {
  const normalizedRoot = resolve(root);
  const normalizedPath = resolve(path);
  const rel = relative(normalizedRoot, normalizedPath);
  if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new CorruptionError(`Recovered path escapes the output directory: ${path}`);
  }
  return normalizedPath;
}

function createSafeSymlinkTarget({ outputRoot, linkPath, target }) {
  if (target.includes('\0')) throw new CorruptionError('Symlink target contains a null character');
  const virtualParent = relative(outputRoot, dirname(linkPath)).split(sep).filter(Boolean);
  const targetParts = target.replaceAll('\\', '/').split('/');
  const resolvedParts = target.startsWith('/') ? [] : [...virtualParent];
  for (const part of targetParts) {
    if (part === '' || part === '.') continue;
    if (part === '..') {
      if (resolvedParts.length === 0) throw new CorruptionError(`Symlink target escapes the recovered root: ${target}`);
      resolvedParts.pop();
      continue;
    }
    resolvedParts.push(part);
  }
  const targetPath = ensurePathInside(outputRoot, join(outputRoot, ...resolvedParts));
  return relative(dirname(linkPath), targetPath) || '.';
}

async function restoreFile({ reader, inode, outputPath }) {
  const size = assertNonNegativeSafeInteger(inode.size, 'File size');
  const storage = assertObject(inode.storage, 'File storage');
  if (storage.type === 'inline') {
    const record = await reader.readObject(inode.__objectId);
    if (record.binary.length !== size) throw new CorruptionError('Inline file payload length does not match file size');
    await writeFile(outputPath, record.binary);
    return;
  }
  if (storage.type !== 'extents') throw new UnsupportedFormatError(`File storage is unsupported: ${String(storage.type)}`);
  const chunkSize = assertPositiveSafeInteger(storage.chunkSize, 'File chunk size');
  const extents = await loadExtents(reader, assertObjectId(storage.extentIndexRootObjectId, 'Extent index root object ID'));
  const file = await open(outputPath, 'wx');
  try {
    for (const extent of extents) {
      const offset = extent.chunkIndex * chunkSize;
      if (!Number.isSafeInteger(offset) || offset >= size) throw new CorruptionError('File extent lies outside file size');
      const record = await reader.readObject(extent.chunkObjectId);
      if (record.kind !== 'file_chunk') throw new CorruptionError(`Expected file_chunk, received ${record.kind}`);
      const metadata = assertObject(record.metadata, 'File chunk metadata');
      if (Object.keys(metadata).length !== 0) {
        throw new CorruptionError('File chunk metadata must be empty');
      }
      if (record.binary.length < 1 || record.binary.length > chunkSize || offset + record.binary.length > size) {
        throw new CorruptionError('File chunk payload length is invalid');
      }
      await file.write(record.binary, 0, record.binary.length, offset);
    }
    await file.truncate(size);
  } finally {
    await file.close();
  }
}

async function loadCompleteGeneration(reader) {
  const rejected = [];
  for (const superblock of await reader.readSuperblockCandidates()) {
    try {
      const commitRecord = await reader.readObject(superblock.activeCommitObjectId);
      if (commitRecord.kind !== 'commit' || commitRecord.binary.length !== 0) {
        throw new CorruptionError('Active commit object has an invalid kind or binary payload');
      }
      const commit = assertObject(commitRecord.metadata, 'HizoFS commit');
      assertNonNegativeSafeInteger(commit.revision, 'HizoFS commit revision');
      const rootNodeId = assertStableId(
        commit.rootDirectoryNodeId,
        'Root directory node ID',
      );
      const inodeIndexRootObjectId = assertObjectId(
        commit.inodeIndexRootObjectId,
        'Inode index root object ID',
      );
      const inodeIndex = await loadInodeIndex(reader, inodeIndexRootObjectId);
      const rootInodeObjectId = inodeIndex.get(rootNodeId);
      if (rootInodeObjectId === undefined) {
        throw new CorruptionError('HizoFS root directory is absent from the inode index');
      }
      const rootRecord = await reader.readObject(rootInodeObjectId);
      if (rootRecord.kind !== 'directory_inode' || rootRecord.binary.length !== 0) {
        throw new CorruptionError('HizoFS root inode is not a directory inode');
      }
      const rootInode = assertObject(rootRecord.metadata, 'Root directory inode');
      if (assertStableId(rootInode.nodeId, 'Root directory inode node ID') !== rootNodeId) {
        throw new CorruptionError('HizoFS root directory inode identity is inconsistent');
      }
      assertNonNegativeSafeInteger(rootInode.revision, 'Root directory inode revision');
      await loadDirectoryEntries(reader, rootInode);
      return { superblock, commit };
    } catch (error) {
      if (error instanceof UnsupportedFormatError) throw error;
      rejected.push(error);
    }
  }
  throw new CorruptionError('No complete HizoFS superblock generation remains', {
    cause: new AggregateError(rejected),
  });
}

async function restoreFileSystem({ reader, commit, outputRoot }) {
  const inodeIndex = await loadInodeIndex(reader, assertObjectId(commit.inodeIndexRootObjectId, 'Inode index root object ID'));
  const rootNodeId = assertStableId(commit.rootDirectoryNodeId, 'Root directory node ID');
  const activeStack = new Set();
  const restoredNodes = new Set();

  async function readInode(nodeId, expectedKind) {
    const objectId = inodeIndex.get(nodeId);
    if (objectId === undefined) throw new CorruptionError(`Node is missing from inode index: ${nodeId}`);
    const record = await reader.readObject(objectId);
    const expectedRecordKind = `${expectedKind}_inode`;
    if (record.kind !== expectedRecordKind) throw new CorruptionError(`Node kind mismatch: expected ${expectedRecordKind}, received ${record.kind}`);
    const inode = assertObject(record.metadata, `${expectedKind} inode`);
    if (inode.nodeId !== nodeId) throw new CorruptionError('Inode node ID does not match its index key');
    assertStableId(inode.nodeId, 'Inode node ID');
    assertNonNegativeSafeInteger(inode.revision, 'Inode revision');
    return { ...inode, __objectId: objectId, __binary: record.binary };
  }

  async function restoreDirectory(nodeId, outputPath) {
    if (activeStack.has(nodeId)) throw new CorruptionError('Directory graph contains a cycle');
    if (restoredNodes.has(nodeId)) throw new CorruptionError('Multiple directory entries reference the same node');
    activeStack.add(nodeId);
    restoredNodes.add(nodeId);
    const inode = await readInode(nodeId, 'directory');
    await mkdir(outputPath, { recursive: false });
    for (const entry of await loadDirectoryEntries(reader, inode)) {
      const childPath = ensurePathInside(outputRoot, join(outputPath, entry.name));
      switch (entry.kind) {
      case 'directory':
        await restoreDirectory(entry.nodeId, childPath);
        break;
      case 'file': {
        if (restoredNodes.has(entry.nodeId)) throw new CorruptionError('Multiple directory entries reference the same node');
        restoredNodes.add(entry.nodeId);
        const fileInode = await readInode(entry.nodeId, 'file');
        fileInode.__objectId = inodeIndex.get(entry.nodeId);
        await restoreFile({ reader, inode: fileInode, outputPath: childPath });
        break;
      }
      case 'symlink': {
        if (restoredNodes.has(entry.nodeId)) throw new CorruptionError('Multiple directory entries reference the same node');
        restoredNodes.add(entry.nodeId);
        const linkInode = await readInode(entry.nodeId, 'symlink');
        const target = assertString(linkInode.target, 'Symlink target');
        await symlink(createSafeSymlinkTarget({ outputRoot, linkPath: childPath, target }), childPath);
        break;
      }
      default:
        throw new UnsupportedFormatError(`Directory entry kind is unsupported: ${String(entry.kind)}`);
      }
    }
    activeStack.delete(nodeId);
  }

  await restoreDirectory(rootNodeId, outputRoot);
  if (restoredNodes.size !== inodeIndex.size) {
    throw new CorruptionError('Inode index contains unreachable nodes');
  }
}

async function promptPassphrase() {
  if (!stdin.isTTY) throw new Error('Passphrase was not supplied and stdin is not a TTY');
  const terminal = createInterface({ input: stdin, output: stdout, terminal: true });
  try {
    return await terminal.question('Passphrase: ');
  } finally {
    terminal.close();
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args === undefined) {
    process.exitCode = 2;
    return;
  }
  const passphrase = args.passphrase ?? await promptPassphrase();
  const storageRoot = await findStorageRoot(args.input);
  const state = await readEncryptionState(storageRoot);
  const storeId = chooseStoreId(state, args.storeId);
  const header = await readStoreHeader(storageRoot, storeId);
  const storageUnlockKey = unwrapStorageUnlockKey(state, passphrase);
  let fileSystemRootKey;
  try {
    fileSystemRootKey = unwrapFileSystemRootKey(storageUnlockKey, header);
  } finally {
    storageUnlockKey.fill(0);
  }

  const dataDirectory = join(storageRoot, 'encrypted-stores', storeId, 'filesystem.hizofs');
  await validateOptionalHizoFSDescriptor(join(dataDirectory, 'descriptor.json'));
  const fileSystemId = deriveHizoFSFileSystemId(fileSystemRootKey);
  if (fileSystemId !== header.fileSystemId) {
    throw new CorruptionError('Encrypted store header fileSystemId does not match the root key');
  }

  const reader = new HizoFSReader({ dataDirectory, fileSystemId, rootKey: fileSystemRootKey });
  try {
    const { commit } = await loadCompleteGeneration(reader);

    try {
      await lstat(args.output);
      throw new Error(`Output path already exists: ${args.output}`);
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
    const temporaryOutput = `${args.output}.partial-${process.pid}`;
    await rm(temporaryOutput, { recursive: true, force: true });
    try {
      await restoreFileSystem({ reader, commit, outputRoot: temporaryOutput });
      await rename(temporaryOutput, args.output);
    } catch (error) {
      await rm(temporaryOutput, { recursive: true, force: true });
      throw error;
    }
  } finally {
    fileSystemRootKey.fill(0);
  }
  console.log(`Recovered HizoFS to ${args.output}`);
}

main().catch(error => {
  console.error(`naidan-recover: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
