#!/usr/bin/env node
import { Buffer } from 'node:buffer';
import console from 'node:console';
import {
  createDecipheriv,
  createHmac,
  hkdfSync,
  pbkdf2Sync,
} from 'node:crypto';
import {
  mkdir,
  open,
  readFile,
  rm,
  stat,
  utimes,
  writeFile,
} from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import process, { stdin, stdout } from 'node:process';
import { createInterface } from 'node:readline/promises';

const OBJECT_MAGIC = Buffer.from([0x4e, 0x41, 0x49, 0x4f, 0x42, 0x4a, 0x00, 0x00]);
const OBJECT_FORMAT_VERSION = 1;
const OBJECT_HEADER_BYTE_LENGTH = 24;
const PAYLOAD_FRAME_VERSION = 1;
const PAYLOAD_HEADER_BYTE_LENGTH = 10;
const AES_GCM_TAG_BYTE_LENGTH = 16;
const OBJECT_ENCRYPTION_HKDF_INFO = Buffer.from('naidan/opfs-encryption/object-encryption-key/v1');
const OBJECT_ADDRESS_HKDF_INFO = Buffer.from('naidan/opfs-encryption/object-address-key/v1');
const MAX_PBKDF2_ITERATIONS = 10_000_000;
const MAX_ENCRYPTION_KEY_SLOTS = 32;

function usage() {
  console.error(`Usage:
  node naidan-recover.mjs <raw-opfs-or-naidan-storage> <output-directory>
    [--passphrase <value>]
    [--store-id <encrypted-store-id>]
    [--namespace <namespace> --key <key> [--area durable|temporary]]

The input may be a raw OPFS export root containing naidan-storage/ or the
naidan-storage/ directory itself. Normal mode reconstructs the released plain
Naidan layout and exports special virtual filesystems under
recovered-filesystems/. Low-level object mode writes one decoded object to the
requested output path.`);
}

function parseArgs(argv) {
  const positional = [];
  const options = new Map();
  for (let index = 0; index < argv.length; index++) {
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
    index++;
  }
  if (positional.length !== 2) {
    usage();
    process.exitCode = 2;
    return undefined;
  }
  const namespace = options.get('--namespace');
  const key = options.get('--key');
  if ((namespace === undefined) !== (key === undefined)) {
    throw new Error('--namespace and --key must be supplied together');
  }
  const area = options.get('--area') ?? 'durable';
  if (area !== 'durable' && area !== 'temporary') {
    throw new Error(`Unsupported object area: ${area}`);
  }
  return {
    input: resolve(positional[0]),
    output: resolve(positional[1]),
    passphrase: options.get('--passphrase'),
    storeId: options.get('--store-id'),
    namespace,
    key,
    area,
  };
}

function decodeBase64Url(value, expectedLength) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]*$/u.test(value)) {
    throw new Error('Invalid unpadded Base64URL value');
  }
  const decoded = Buffer.from(value, 'base64url');
  if (decoded.toString('base64url') !== value) {
    throw new Error('Non-canonical Base64URL value');
  }
  if (expectedLength !== undefined && decoded.length !== expectedLength) {
    throw new Error(`Decoded value has ${decoded.length} bytes instead of ${expectedLength}`);
  }
  return decoded;
}

function decryptAesGcm({ key, nonce, ciphertext, aad }) {
  if (key.length !== 32 || nonce.length !== 12 || ciphertext.length < AES_GCM_TAG_BYTE_LENGTH) {
    throw new Error('Invalid AES-256-GCM key, nonce, or ciphertext length');
  }
  const encrypted = ciphertext.subarray(0, ciphertext.length - AES_GCM_TAG_BYTE_LENGTH);
  const tag = ciphertext.subarray(ciphertext.length - AES_GCM_TAG_BYTE_LENGTH);
  const decipher = createDecipheriv('aes-256-gcm', key, nonce);
  decipher.setAAD(aad);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(encrypted), decipher.final()]);
}

function decodePayloadFrame(frame) {
  if (frame.length < PAYLOAD_HEADER_BYTE_LENGTH) {
    throw new Error('Encrypted object payload frame is truncated');
  }
  if (frame[0] !== PAYLOAD_FRAME_VERSION) {
    throw new Error(`Unsupported encrypted object payload frame version: ${frame[0]}`);
  }
  if (frame[1] !== 0) {
    throw new Error(`Unsupported encrypted object payload encoding: ${frame[1]}`);
  }
  const decodedSize = frame.readBigUInt64BE(2);
  if (decodedSize > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error('Encrypted object decoded size exceeds the safe integer range');
  }
  const payload = frame.subarray(PAYLOAD_HEADER_BYTE_LENGTH);
  if (payload.length !== Number(decodedSize)) {
    throw new Error(`Encrypted object payload size mismatch: expected ${decodedSize}, received ${payload.length}`);
  }
  return payload;
}

function unwrapKey({ wrappedKey, wrappingKey, aad }) {
  const key = decryptAesGcm({
    key: wrappingKey,
    nonce: decodeBase64Url(wrappedKey.nonce, 12),
    ciphertext: decodeBase64Url(wrappedKey.ciphertext, 48),
    aad,
  });
  if (key.length !== 32) {
    throw new Error(`Unwrapped key has ${key.length} bytes instead of 32`);
  }
  return key;
}

async function promptSecret(label) {
  const reader = createInterface({ input: stdin, output: stdout });
  try {
    return await reader.question(label);
  } finally {
    reader.close();
  }
}

async function readJson(path) {
  return JSON.parse(await readFile(path, 'utf8'));
}

async function readLatestSlot(directory, prefix) {
  const complete = [];
  for (const slot of [0, 1]) {
    const path = join(directory, `${prefix}-${slot}.json`);
    let raw;
    try {
      raw = await readJson(path);
    } catch {
      continue;
    }
    if (
      raw === null
      || typeof raw !== 'object'
      || !Number.isSafeInteger(raw.sequence)
      || raw.sequence < 0
      || !Number.isSafeInteger(raw.formatVersion)
      || raw.formatVersion < 1
    ) {
      continue;
    }
    complete.push({ raw, path });
  }
  complete.sort((left, right) => right.raw.sequence - left.raw.sequence);
  if (complete.length === 0) {
    throw new Error(`No complete ${prefix} slot exists in ${directory}`);
  }
  if (complete.length === 2 && complete[0].raw.sequence === complete[1].raw.sequence) {
    throw new Error(`The ${prefix} slots have the same sequence in ${directory}`);
  }
  const selected = complete[0].raw;
  if (selected.formatVersion !== 1) {
    throw new Error(`Unsupported newest ${prefix} format version: ${selected.formatVersion}`);
  }
  return selected;
}

async function resolveStorageRoot(input) {
  if (basename(input) === 'naidan-storage') {
    return input;
  }
  const child = join(input, 'naidan-storage');
  try {
    if ((await stat(child)).isDirectory()) {
      return child;
    }
  } catch {
    // Fall through to the clear error below.
  }
  throw new Error(`Input does not contain naidan-storage/: ${input}`);
}

function selectStoreId({ state, explicitStoreId }) {
  if (explicitStoreId !== undefined) {
    return explicitStoreId;
  }
  if (state.state === 'encrypted') {
    return state.activeEncryptedStoreId;
  }
  if (state.state !== 'transitioning' || state.operation === undefined) {
    throw new Error(`Unsupported encryption state: ${JSON.stringify(state)}`);
  }
  const operation = state.operation;
  switch (operation.type) {
  case 'decrypting':
    return operation.sourceEncryptedStoreId;
  case 'reencrypting':
    return operation.phase === 'cleaning_up_source'
      ? operation.targetEncryptedStoreId
      : operation.sourceEncryptedStoreId;
  case 'encrypting':
    if (operation.phase !== 'cleaning_up_source') {
      throw new Error('The encrypted target is not authoritative; use the plaintext source or pass --store-id to inspect it explicitly.');
    }
    return operation.targetEncryptedStoreId;
  default:
    throw new Error(`Unsupported transition operation: ${operation.type}`);
  }
}

async function unlockStorageUnlockKey({ state, passphrase }) {
  const suppliedPassphrase = passphrase ?? await promptSecret('Passphrase: ');
  if (
    !Array.isArray(state.keySlots)
    || state.keySlots.length === 0
    || state.keySlots.length > MAX_ENCRYPTION_KEY_SLOTS
  ) {
    throw new Error(`Encryption state must contain between 1 and ${MAX_ENCRYPTION_KEY_SLOTS} key slots`);
  }
  const failures = [];
  for (const slot of state.keySlots) {
    try {
      if (slot?.keyDerivation?.type !== 'pbkdf2_sha256') {
        failures.push(new Error(`Unsupported key derivation for slot ${slot?.id}`));
        continue;
      }
      const iterations = slot.keyDerivation.iterations;
      if (
        !Number.isSafeInteger(iterations)
        || iterations <= 0
        || iterations > MAX_PBKDF2_ITERATIONS
      ) {
        throw new Error(`Invalid PBKDF2 iteration count for slot ${slot.id}`);
      }
      const wrappingKey = pbkdf2Sync(
        Buffer.from(suppliedPassphrase, 'utf8'),
        decodeBase64Url(slot.keyDerivation.salt, 32),
        iterations,
        32,
        'sha256',
      );
      try {
        return unwrapKey({
          wrappedKey: slot.wrappedStorageUnlockKey,
          wrappingKey,
          aad: Buffer.from(`naidan/opfs-encryption/storage-unlock-key/v1/${slot.id}`, 'utf8'),
        });
      } finally {
        wrappingKey.fill(0);
      }
    } catch (error) {
      failures.push(error);
    }
  }
  throw new AggregateError(failures, 'The supplied passphrase did not unlock any key slot');
}

function encodeLocator(namespace, key) {
  const namespaceBytes = Buffer.from(namespace, 'utf8');
  const keyBytes = Buffer.from(key, 'utf8');
  const result = Buffer.allocUnsafe(8 + namespaceBytes.length + keyBytes.length);
  result.writeUInt32BE(namespaceBytes.length, 0);
  namespaceBytes.copy(result, 4);
  result.writeUInt32BE(keyBytes.length, 4 + namespaceBytes.length);
  keyBytes.copy(result, 8 + namespaceBytes.length);
  return result;
}

function objectAddressFor({ objectAddressKey, namespace, key, area }) {
  const signature = createHmac('sha256', objectAddressKey)
    .update(encodeLocator(namespace, key))
    .digest();
  return {
    objectId: signature.toString('base64url'),
    shardId: signature[0].toString(16).padStart(2, '0'),
    area,
  };
}

async function readPhysicalObject({
  storeDirectory,
  objectEncryptionKey,
  objectAddressKey,
  namespace,
  key,
  area = 'durable',
}) {
  const address = objectAddressFor({ objectAddressKey, namespace, key, area });
  const areaDirectory = area === 'durable' ? 'objects' : 'temporary-objects';
  const path = join(storeDirectory, areaDirectory, address.shardId, `${address.objectId}.enc`);
  let physical;
  try {
    physical = await readFile(path);
  } catch (error) {
    if (error?.code === 'ENOENT') {
      return undefined;
    }
    throw error;
  }
  if (physical.length < OBJECT_HEADER_BYTE_LENGTH + AES_GCM_TAG_BYTE_LENGTH) {
    throw new Error(`Truncated encrypted object: ${address.objectId}`);
  }
  if (!physical.subarray(0, OBJECT_MAGIC.length).equals(OBJECT_MAGIC)) {
    throw new Error(`Unsupported encrypted object magic: ${address.objectId}`);
  }
  const formatVersion = physical.readUInt16BE(OBJECT_MAGIC.length);
  const headerLength = physical.readUInt16BE(OBJECT_MAGIC.length + 2);
  if (formatVersion !== OBJECT_FORMAT_VERSION || headerLength !== OBJECT_HEADER_BYTE_LENGTH) {
    throw new Error(`Unsupported encrypted object header: version=${formatVersion} length=${headerLength}`);
  }
  return decodePayloadFrame(decryptAesGcm({
    key: objectEncryptionKey,
    nonce: physical.subarray(12, 24),
    ciphertext: physical.subarray(headerLength),
    aad: Buffer.from(`naidan/opfs-encryption/object/v1/${area}/${address.objectId}`, 'utf8'),
  }));
}

function parseTransaction({ bytes, scopeId }) {
  const transaction = JSON.parse(bytes.toString('utf8'));
  if (
    transaction === null
    || typeof transaction !== 'object'
    || typeof transaction.id !== 'string'
    || transaction.id.length === 0
    || transaction.scopeId !== scopeId
    || !Array.isArray(transaction.operations)
  ) {
    throw new Error(`Encrypted object transaction is invalid: ${scopeId}`);
  }
  for (const operation of transaction.operations) {
    if (
      operation === null
      || typeof operation !== 'object'
      || (operation.type !== 'write' && operation.type !== 'delete')
      || typeof operation.namespace !== 'string'
      || operation.namespace.length === 0
      || typeof operation.key !== 'string'
      || operation.key.length === 0
      || (operation.type === 'write' && typeof operation.plaintextBase64Url !== 'string')
    ) {
      throw new Error(`Encrypted object transaction operation is invalid: ${scopeId}`);
    }
  }
  return transaction;
}

async function withTransactionScope({ context, scopeId, area = 'durable' }) {
  const existingScopes = context.transactionScopes ?? [];
  if (existingScopes.some(scope => scope.area === area && scope.scopeId === scopeId)) {
    return context;
  }
  const bytes = await readPhysicalObject({
    ...context,
    namespace: 'object_transaction_journal',
    key: scopeId,
    area,
  });
  if (bytes === undefined) {
    return context;
  }
  return {
    ...context,
    transactionScopes: [
      ...existingScopes,
      {
        area,
        scopeId,
        transaction: parseTransaction({ bytes, scopeId }),
      },
    ],
  };
}

function readTransactionOverlay({ context, namespace, key, area }) {
  const scopes = context.transactionScopes ?? [];
  for (let scopeIndex = scopes.length - 1; scopeIndex >= 0; scopeIndex--) {
    const scope = scopes[scopeIndex];
    if (scope.area !== area) {
      continue;
    }
    for (let operationIndex = scope.transaction.operations.length - 1; operationIndex >= 0; operationIndex--) {
      const operation = scope.transaction.operations[operationIndex];
      if (operation.namespace !== namespace || operation.key !== key) {
        continue;
      }
      return operation.type === 'delete'
        ? { matched: true, value: undefined }
        : {
            matched: true,
            value: decodeBase64Url(operation.plaintextBase64Url),
          };
    }
  }
  return { matched: false, value: undefined };
}

async function readObject({
  storeDirectory,
  objectEncryptionKey,
  objectAddressKey,
  transactionScopes,
  namespace,
  key,
  area = 'durable',
}) {
  if (namespace !== 'object_transaction_journal') {
    const overlay = readTransactionOverlay({
      context: { transactionScopes },
      namespace,
      key,
      area,
    });
    if (overlay.matched) {
      return overlay.value;
    }
  }
  return await readPhysicalObject({
    storeDirectory,
    objectEncryptionKey,
    objectAddressKey,
    namespace,
    key,
    area,
  });
}

async function readJsonObject(context, namespace, key, area = 'durable') {
  const value = await readObject({ ...context, namespace, key, area });
  return value === undefined ? undefined : JSON.parse(value.toString('utf8'));
}

async function ensureParent(path) {
  await mkdir(dirname(path), { recursive: true });
}

async function writeJsonValue(path, value) {
  if (value === undefined) {
    return;
  }
  await ensureParent(path);
  await writeFile(path, JSON.stringify(value));
}

async function writeAll({ output, chunk }) {
  let offset = 0;
  while (offset < chunk.length) {
    const { bytesWritten } = await output.write(chunk, offset, chunk.length - offset);
    if (bytesWritten === 0) {
      throw new Error('Recovery output stopped accepting bytes');
    }
    offset += bytesWritten;
  }
}

async function setRecoveredMtime({ path, modifiedAt }) {
  if (!Number.isSafeInteger(modifiedAt) || modifiedAt < 0) {
    return;
  }
  const date = new Date(modifiedAt);
  await utimes(path, date, date).catch(() => undefined);
}

async function recoverEncryptedFile({ context, fileId, outputPath, area = 'durable' }) {
  const fileContext = await withTransactionScope({
    context,
    scopeId: `file/${fileId}`,
    area,
  });
  const manifest = await readJsonObject(fileContext, 'file_manifest', fileId, area);
  if (manifest === undefined) {
    throw new Error(`Encrypted file manifest is missing: ${fileId}`);
  }
  if (
    !Number.isSafeInteger(manifest.size)
    || manifest.size < 0
    || !Number.isSafeInteger(manifest.chunkSize)
    || manifest.chunkSize <= 0
    || !Number.isSafeInteger(manifest.chunkMapPageSize)
    || manifest.chunkMapPageSize <= 0
    || !Array.isArray(manifest.chunkMapPageIds)
  ) {
    throw new Error(`Encrypted file manifest is invalid: ${fileId}`);
  }
  await ensureParent(outputPath);
  const output = await open(outputPath, 'w', 0o600);
  let completed = false;
  try {
    const chunkCount = manifest.size === 0 ? 0 : Math.ceil(manifest.size / manifest.chunkSize);
    const expectedPageCount = chunkCount === 0 ? 0 : Math.ceil(chunkCount / manifest.chunkMapPageSize);
    if (manifest.chunkMapPageIds.length !== expectedPageCount) {
      throw new Error(`Encrypted file chunk-map page count mismatch: ${fileId}`);
    }
    let chunkIndex = 0;
    for (let pageIndex = 0; pageIndex < manifest.chunkMapPageIds.length; pageIndex++) {
      const pageId = manifest.chunkMapPageIds[pageIndex];
      const page = await readJsonObject(fileContext, 'file_chunk_map_page', pageId, area);
      if (
        page === undefined
        || page.pageId !== pageId
        || page.fileId !== fileId
        || page.pageIndex !== pageIndex
        || !Array.isArray(page.chunkIds)
      ) {
        throw new Error(`Encrypted file chunk-map page is missing or invalid: ${pageId}`);
      }
      const expectedEntries = Math.min(manifest.chunkMapPageSize, chunkCount - chunkIndex);
      if (page.chunkIds.length !== expectedEntries) {
        throw new Error(`Encrypted file chunk-map page length mismatch: ${pageId}`);
      }
      for (const chunkId of page.chunkIds) {
        const expectedLength = Math.min(manifest.chunkSize, manifest.size - chunkIndex * manifest.chunkSize);
        const chunk = chunkId === null
          ? Buffer.alloc(expectedLength)
          : await readObject({ ...fileContext, namespace: 'file_chunk', key: chunkId, area });
        if (chunk === undefined) {
          throw new Error(`Encrypted file chunk is missing: ${chunkId}`);
        }
        if (chunk.length !== expectedLength) {
          throw new Error(`Encrypted file chunk has an unexpected size: ${chunkId}`);
        }
        await writeAll({ output, chunk });
        chunkIndex++;
      }
    }
    if (chunkIndex !== chunkCount) {
      throw new Error(`Encrypted file manifest does not cover its size: ${fileId}`);
    }
    completed = true;
  } finally {
    await output.close();
    if (!completed) {
      await rm(outputPath, { force: true });
    }
  }
  await setRecoveredMtime({ path: outputPath, modifiedAt: manifest.modifiedAt });
}

function joinSafeEntryPath({ outputDirectory, name }) {
  if (
    typeof name !== 'string'
    || name.length === 0
    || name === '.'
    || name === '..'
    || name.includes('/')
    || name.includes('\\')
    || name.includes('\0')
  ) {
    throw new Error(`Encrypted filesystem entry has an unsafe name: ${JSON.stringify(name)}`);
  }
  return join(outputDirectory, name);
}

async function recoverFileSystem({ context, fileSystemId, outputDirectory, area = 'durable' }) {
  const descriptorContext = await withTransactionScope({
    context,
    scopeId: `file-system-descriptor/${fileSystemId}`,
    area,
  });
  const descriptor = await readJsonObject(
    descriptorContext,
    'file_system_descriptor',
    fileSystemId,
    area,
  );
  if (descriptor === undefined) {
    return false;
  }
  if (descriptor.id !== fileSystemId || typeof descriptor.rootDirectoryId !== 'string') {
    throw new Error(`Encrypted filesystem descriptor is invalid: ${fileSystemId}`);
  }
  const fileSystemContext = await withTransactionScope({
    context: descriptorContext,
    scopeId: `file-system/${descriptor.rootDirectoryId}`,
    area,
  });
  await recoverDirectory({
    context: fileSystemContext,
    directoryId: descriptor.rootDirectoryId,
    outputDirectory,
    area,
  });
  return true;
}

async function recoverDirectory({
  context,
  directoryId,
  outputDirectory,
  area = 'durable',
  ancestors = new Set(),
}) {
  if (ancestors.has(directoryId)) {
    throw new Error(`Encrypted directory cycle detected: ${directoryId}`);
  }
  ancestors.add(directoryId);
  try {
    await mkdir(outputDirectory, { recursive: true });
    const manifest = await readJsonObject(context, 'directory_manifest', directoryId, area);
    if (manifest === undefined || manifest.directoryId !== directoryId || !Array.isArray(manifest.shards)) {
      throw new Error(`Encrypted directory manifest is missing or invalid: ${directoryId}`);
    }
    const seenNames = new Set();
    for (const shardReference of manifest.shards) {
      const shard = await readJsonObject(context, 'directory_shard', shardReference.objectId, area);
      if (
        shard === undefined
        || shard.objectId !== shardReference.objectId
        || shard.directoryId !== directoryId
        || shard.shardId !== shardReference.shardId
        || shard.entries === null
        || typeof shard.entries !== 'object'
      ) {
        throw new Error(`Encrypted directory shard is missing or invalid: ${directoryId}/${shardReference.shardId}`);
      }
      for (const entry of Object.values(shard.entries)) {
        if (seenNames.has(entry.name)) {
          throw new Error(`Duplicate encrypted directory entry: ${entry.name}`);
        }
        seenNames.add(entry.name);
        const outputPath = joinSafeEntryPath({ outputDirectory, name: entry.name });
        switch (entry.type) {
        case 'file':
          await recoverEncryptedFile({ context, fileId: entry.fileId, outputPath, area });
          break;
        case 'directory':
          await recoverDirectory({
            context,
            directoryId: entry.directoryId,
            outputDirectory: outputPath,
            area,
            ancestors,
          });
          break;
        case 'symlink':
          await writeFile(`${outputPath}.naidan-symlink.json`, JSON.stringify({
            targetPath: entry.targetPath,
            createdAt: entry.createdAt,
            modifiedAt: entry.modifiedAt,
          }));
          break;
        default:
          throw new Error(`Unsupported encrypted filesystem entry: ${entry.type}`);
        }
      }
    }
    await setRecoveredMtime({ path: outputDirectory, modifiedAt: manifest.modifiedAt });
  } finally {
    ancestors.delete(directoryId);
  }
}

const STORE_COLLECTION_TYPES = [
  'chat_meta',
  'chat_group',
  'binary_object',
  'volume',
];

function validateStoreManifest(manifest) {
  if (manifest === undefined || !Array.isArray(manifest.collections)) {
    throw new Error('Encrypted store manifest is missing or invalid');
  }
  const collections = new Map();
  for (const value of manifest.collections) {
    if (
      value === null
      || typeof value !== 'object'
      || !STORE_COLLECTION_TYPES.includes(value.type)
      || !Array.isArray(value.shardIds)
      || collections.has(value.type)
    ) {
      throw new Error('Encrypted store manifest contains an invalid or duplicate collection');
    }
    const shardIds = new Set();
    for (const shardId of value.shardIds) {
      if (typeof shardId !== 'string' || !/^[0-9a-f]{2}$/u.test(shardId) || shardIds.has(shardId)) {
        throw new Error(`Encrypted ${value.type} collection contains an invalid or duplicate shard ID`);
      }
      shardIds.add(shardId);
    }
    collections.set(value.type, value);
  }
  for (const type of STORE_COLLECTION_TYPES) {
    if (!collections.has(type)) {
      throw new Error(`Encrypted store manifest is missing collection: ${type}`);
    }
  }
  return collections;
}

function requireJsonObject(value, message) {
  if (value === undefined || value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(message);
  }
  return value;
}

function assertSafeOutputIdentifier(value, fieldName) {
  if (
    typeof value !== 'string'
    || value.length === 0
    || value === '.'
    || value === '..'
    || value.includes('/')
    || value.includes('\\')
    || value.includes('\0')
  ) {
    throw new Error(`${fieldName} is unsafe for recovery output: ${JSON.stringify(value)}`);
  }
}

function legacyShard(id) {
  return id.slice(-2).toLowerCase();
}

async function recoverStore({ context, output }) {
  const storeContext = await withTransactionScope({
    context,
    scopeId: 'naidan-store',
  });
  const settings = await readJsonObject(storeContext, 'singleton', 'settings');
  const hierarchy = await readJsonObject(storeContext, 'singleton', 'hierarchy') ?? { items: [] };
  const storeManifest = await readJsonObject(storeContext, 'singleton', 'store_manifest');
  const collections = validateStoreManifest(storeManifest);
  await writeJsonValue(join(output, 'settings.json'), settings);
  await writeJsonValue(join(output, 'hierarchy.json'), hierarchy);

  const chatIds = new Set();
  for (const shardId of collections.get('chat_meta').shardIds) {
    const index = requireJsonObject(
      await readJsonObject(storeContext, 'chat_meta_shard_index', shardId),
      `Chat metadata shard index is missing or invalid: ${shardId}`,
    );
    if (!Array.isArray(index.chatIds)) {
      throw new Error(`Chat metadata shard index is missing or invalid: ${shardId}`);
    }
    for (const chatId of index.chatIds) {
      assertSafeOutputIdentifier(chatId, 'Chat ID');
      chatIds.add(chatId);
    }
  }
  const groupIds = new Set();
  for (const shardId of collections.get('chat_group').shardIds) {
    const index = requireJsonObject(
      await readJsonObject(storeContext, 'chat_group_shard_index', shardId),
      `Chat group shard index is missing or invalid: ${shardId}`,
    );
    if (!Array.isArray(index.chatGroupIds)) {
      throw new Error(`Chat group shard index is missing or invalid: ${shardId}`);
    }
    for (const groupId of index.chatGroupIds) {
      assertSafeOutputIdentifier(groupId, 'Chat Group ID');
      groupIds.add(groupId);
    }
  }
  for (const chatId of chatIds) {
    await writeJsonValue(join(output, 'chat-metas', `${chatId}.json`), await readJsonObject(storeContext, 'chat_meta', chatId));
    await writeJsonValue(join(output, 'chat-contents', `${chatId}.json`), await readJsonObject(storeContext, 'chat_content', chatId));
  }
  for (const groupId of groupIds) {
    await writeJsonValue(join(output, 'chat-groups', `${groupId}.json`), await readJsonObject(storeContext, 'chat_group', groupId));
  }

  const plainBinaryIndices = new Map();
  for (const encryptedShardId of collections.get('binary_object').shardIds) {
    const index = requireJsonObject(
      await readJsonObject(storeContext, 'binary_shard_index', encryptedShardId),
      `Binary-object shard index is missing or invalid: ${encryptedShardId}`,
    );
    const objects = requireJsonObject(
      index.objects,
      `Binary-object shard index is missing or invalid: ${encryptedShardId}`,
    );
    for (const [id, entry] of Object.entries(objects)) {
      assertSafeOutputIdentifier(id, 'Binary Object ID');
      const shard = legacyShard(id);
      const plainIndex = plainBinaryIndices.get(shard) ?? { objects: {} };
      plainIndex.objects[id] = entry.metadata;
      plainBinaryIndices.set(shard, plainIndex);
      const binaryPath = join(output, 'binary-objects', shard, `${id}.bin`);
      await recoverEncryptedFile({ context: storeContext, fileId: entry.fileId, outputPath: binaryPath });
      await writeFile(join(output, 'binary-objects', shard, `.${id}.bin.complete`), '');
    }
  }
  for (const [shard, index] of plainBinaryIndices) {
    await writeJsonValue(join(output, 'binary-objects', shard, 'index.json'), index);
  }

  const plainVolumeIndices = new Map();
  for (const encryptedShardId of collections.get('volume').shardIds) {
    const index = requireJsonObject(
      await readJsonObject(storeContext, 'volume_index', encryptedShardId),
      `Volume shard index is missing or invalid: ${encryptedShardId}`,
    );
    const volumes = requireJsonObject(
      index.volumes,
      `Volume shard index is missing or invalid: ${encryptedShardId}`,
    );
    for (const [id, volume] of Object.entries(volumes)) {
      assertSafeOutputIdentifier(id, 'Volume ID');
      const shard = legacyShard(id);
      const plainIndex = plainVolumeIndices.get(shard) ?? { volumes: {} };
      plainIndex.volumes[id] = volume;
      plainVolumeIndices.set(shard, plainIndex);
      if (volume.type === 'opfs') {
        await recoverFileSystem({
          context: storeContext,
          fileSystemId: `volume/${id}`,
          outputDirectory: join(output, 'volumes', shard, id),
        });
      }
    }
  }
  for (const [shard, index] of plainVolumeIndices) {
    await writeJsonValue(join(output, 'volumes', shard, 'index.json'), index);
  }

  const recoveredFileSystems = join(output, 'recovered-filesystems');
  await recoverFileSystem({
    context: storeContext,
    fileSystemId: 'system/chat-wesh',
    outputDirectory: join(recoveredFileSystems, 'chat-wesh'),
  });
  await recoverFileSystem({
    context: storeContext,
    fileSystemId: 'system/debug-wesh',
    outputDirectory: join(recoveredFileSystems, 'debug-wesh'),
  });
  await recoverFileSystem({
    context: storeContext,
    fileSystemId: 'system/tmp',
    outputDirectory: join(recoveredFileSystems, 'tmp'),
    area: 'temporary',
  });
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args === undefined) {
    return;
  }
  const storageRoot = await resolveStorageRoot(args.input);
  const state = await readLatestSlot(join(storageRoot, 'encryption-state'), 'state');
  const storeId = selectStoreId({ state, explicitStoreId: args.storeId });
  const storeDirectory = join(storageRoot, 'encrypted-stores', storeId);
  const header = await readLatestSlot(join(storeDirectory, 'header'), 'header');
  if (header.encryptedStoreId !== storeId) {
    throw new Error(`Encrypted-store header ID mismatch: ${header.encryptedStoreId}`);
  }
  const storageUnlockKey = await unlockStorageUnlockKey({ state, passphrase: args.passphrase });
  let storeRootKey;
  let objectEncryptionKey;
  let objectAddressKey;
  try {
    storeRootKey = unwrapKey({
      wrappedKey: header.wrappedStoreRootKey,
      wrappingKey: storageUnlockKey,
      aad: Buffer.from(`naidan/opfs-encryption/store-root-key/v1/${storeId}`, 'utf8'),
    });
    objectEncryptionKey = Buffer.from(hkdfSync(
      'sha256',
      storeRootKey,
      Buffer.from(storeId, 'utf8'),
      OBJECT_ENCRYPTION_HKDF_INFO,
      32,
    ));
    objectAddressKey = Buffer.from(hkdfSync(
      'sha256',
      storeRootKey,
      Buffer.from(storeId, 'utf8'),
      OBJECT_ADDRESS_HKDF_INFO,
      32,
    ));
    const context = { storeDirectory, objectEncryptionKey, objectAddressKey, transactionScopes: [] };
    if (args.namespace !== undefined) {
      const decoded = await readObject({
        ...context,
        namespace: args.namespace,
        key: args.key,
        area: args.area,
      });
      if (decoded === undefined) {
        throw new Error(`Encrypted object not found: ${args.namespace}:${args.key}`);
      }
      await ensureParent(args.output);
      await writeFile(args.output, decoded);
      console.log(`Recovered ${args.area} object ${args.namespace}:${args.key} to ${args.output}`);
      return;
    }
    await mkdir(args.output, { recursive: true });
    await recoverStore({ context, output: args.output });
    console.log(`Recovered encrypted store ${storeId} to ${args.output}`);
  } finally {
    storageUnlockKey.fill(0);
    storeRootKey?.fill(0);
    objectEncryptionKey?.fill(0);
    objectAddressKey?.fill(0);
  }
}

await main();
