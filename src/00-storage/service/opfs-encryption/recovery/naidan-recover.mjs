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
  writeFile,
} from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import process, { stdin, stdout } from 'node:process';
import { createInterface } from 'node:readline/promises';

const MAGIC = Buffer.from('NAIDAN01');
const PAYLOAD_MAGIC = Buffer.from('NPAYLD01');
const PAYLOAD_HEADER_BYTE_LENGTH = 17;
const WRAPPED_KEY_AAD = Buffer.from('naidan/opfs-encryption/wrapped-key/v1');
const RECOVERY_HKDF_INFO = Buffer.from('naidan/opfs-encryption/recovery-key/v1');
const OBJECT_ENCRYPTION_HKDF_INFO = Buffer.from('naidan/opfs-encryption/object-encryption-key/v1');
const OBJECT_ADDRESS_HKDF_INFO = Buffer.from('naidan/opfs-encryption/object-address-key/v1');

function usage() {
  console.error(`Usage:
  node naidan-recover.mjs <raw-opfs-or-naidan-storage> <output-directory>
    [--passphrase <value> | --recovery-key <base64url>]
    [--store-id <encrypted-store-id>]

The input may be either a raw OPFS export root containing naidan-storage/ or
naidan-storage/ itself. The output recreates the legacy plaintext layout and
exports encrypted virtual filesystems into recovered-filesystems/.`);
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
  return {
    input: resolve(positional[0]),
    output: resolve(positional[1]),
    passphrase: options.get('--passphrase'),
    recoveryKey: options.get('--recovery-key'),
    storeId: options.get('--store-id'),
  };
}

function decodeBase64Url(value) {
  return Buffer.from(value, 'base64url');
}

function decryptAesGcm({ key, nonce, ciphertext, aad }) {
  if (ciphertext.length < 16) {
    throw new Error('AES-GCM ciphertext is shorter than its authentication tag');
  }
  const encrypted = ciphertext.subarray(0, ciphertext.length - 16);
  const tag = ciphertext.subarray(ciphertext.length - 16);
  const decipher = createDecipheriv('aes-256-gcm', key, nonce);
  decipher.setAAD(aad);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(encrypted), decipher.final()]);
}

function decodePayloadFrame(frame) {
  if (frame.length < PAYLOAD_HEADER_BYTE_LENGTH || !frame.subarray(0, 8).equals(PAYLOAD_MAGIC)) {
    throw new Error('Unsupported or truncated encrypted object payload frame');
  }
  const encoding = frame[8];
  if (encoding !== 0) {
    throw new Error(`Unsupported encrypted object payload encoding: ${encoding}`);
  }
  const plaintextSize = frame.readBigUInt64BE(9);
  if (plaintextSize > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error('Encrypted object plaintext size exceeds the safe integer range');
  }
  const payload = frame.subarray(PAYLOAD_HEADER_BYTE_LENGTH);
  if (payload.length !== Number(plaintextSize)) {
    throw new Error(
      `Encrypted object identity payload size mismatch: expected ${plaintextSize}, received ${payload.length}`,
    );
  }
  return payload;
}

function unwrapKey({ wrappedKey, wrappingKey }) {
  const key = decryptAesGcm({
    key: wrappingKey,
    nonce: decodeBase64Url(wrappedKey.nonce),
    ciphertext: decodeBase64Url(wrappedKey.ciphertext),
    aad: WRAPPED_KEY_AAD,
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
  const values = [];
  for (const slot of [0, 1]) {
    try {
      const value = await readJson(join(directory, `${prefix}-${slot}.json`));
      if (Number.isSafeInteger(value.sequence) && value.sequence >= 0) {
        values.push(value);
      }
    } catch {
      // The other slot may be the last valid atomic write.
    }
  }
  values.sort((left, right) => right.sequence - left.sequence);
  if (values.length === 0) {
    throw new Error(`No valid ${prefix} slot exists in ${directory}`);
  }
  if (values.length === 2 && values[0].sequence === values[1].sequence) {
    throw new Error(`The ${prefix} slots have the same sequence in ${directory}`);
  }
  return values[0];
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
    // Fall through to a clear error.
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
      throw new Error(
        'The encrypted target is not authoritative yet. Recover the remaining plaintext data or pass --store-id to inspect the partial target.',
      );
    }
    return operation.targetEncryptedStoreId;
  default:
    throw new Error(`Unsupported transition operation: ${operation.type}`);
  }
}

async function unlockStorageUnlockKey({ state, passphrase, recoveryKey }) {
  if (passphrase !== undefined && recoveryKey !== undefined) {
    throw new Error('Specify either --passphrase or --recovery-key, not both');
  }
  let suppliedPassphrase = passphrase;
  if (suppliedPassphrase === undefined && recoveryKey === undefined) {
    suppliedPassphrase = await promptSecret('Passphrase: ');
  }

  let lastError;
  for (const slot of state.keySlots) {
    try {
      if (suppliedPassphrase !== undefined && slot.type === 'passphrase') {
        const salt = decodeBase64Url(slot.kdf.salt);
        const wrappingKey = pbkdf2Sync(
          Buffer.from(suppliedPassphrase, 'utf8'),
          salt,
          slot.kdf.iterations,
          32,
          'sha256',
        );
        return unwrapKey({ wrappedKey: slot.wrappedStorageUnlockKey, wrappingKey });
      }
      if (recoveryKey !== undefined && slot.type === 'recovery_key') {
        const wrappingKey = Buffer.from(hkdfSync(
          'sha256',
          decodeBase64Url(recoveryKey),
          decodeBase64Url(slot.kdf.salt),
          RECOVERY_HKDF_INFO,
          32,
        ));
        return unwrapKey({ wrappedKey: slot.wrappedStorageUnlockKey, wrappingKey });
      }
    } catch (error) {
      lastError = error;
    }
  }
  throw new Error('The supplied secret did not unlock any key slot', { cause: lastError });
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

function objectIdFor({ objectAddressKey, namespace, key }) {
  return createHmac('sha256', objectAddressKey)
    .update(encodeLocator(namespace, key))
    .digest('base64url');
}

async function readObject({ storeDirectory, objectEncryptionKey, objectAddressKey, namespace, key }) {
  const objectId = objectIdFor({ objectAddressKey, namespace, key });
  const path = join(storeDirectory, 'objects', objectId.slice(0, 2), `${objectId}.bin`);
  let physical;
  try {
    physical = await readFile(path);
  } catch (error) {
    if (error?.code === 'ENOENT') {
      return undefined;
    }
    throw error;
  }
  if (physical.length < 8 + 12 + 16 || !physical.subarray(0, 8).equals(MAGIC)) {
    throw new Error(`Unsupported or truncated encrypted object: ${objectId}`);
  }
  return decodePayloadFrame(decryptAesGcm({
    key: objectEncryptionKey,
    nonce: physical.subarray(8, 20),
    ciphertext: physical.subarray(20),
    aad: Buffer.from(`naidan/opfs-encryption/object/v1/${objectId}`, 'utf8'),
  }));
}

async function readJsonObject(context, namespace, key) {
  const value = await readObject({ ...context, namespace, key });
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
    const { bytesWritten } = await output.write(
      chunk,
      offset,
      chunk.length - offset,
    );
    if (bytesWritten === 0) {
      throw new Error('Recovery output stopped accepting bytes');
    }
    offset += bytesWritten;
  }
}

async function recoverEncryptedFile({ context, fileId, outputPath }) {
  const manifest = await readJsonObject(context, 'file_manifest', fileId);
  if (manifest === undefined) {
    throw new Error(`Encrypted file manifest is missing: ${fileId}`);
  }
  await ensureParent(outputPath);
  const output = await open(outputPath, 'w', 0o600);
  let completed = false;
  try {
    let remaining = manifest.logicalSize;
    for (const chunkId of manifest.chunkIds) {
      if (remaining <= 0) {
        throw new Error(`Encrypted file manifest has extra chunks: ${fileId}`);
      }
      const expected = Math.min(manifest.logicalChunkSize, remaining);
      const chunk = chunkId === null
        ? Buffer.alloc(expected)
        : await readObject({ ...context, namespace: 'file_chunk', key: chunkId });
      if (chunk === undefined) {
        throw new Error(`Encrypted file chunk is missing: ${chunkId}`);
      }
      if (chunk.length !== expected) {
        throw new Error(`Encrypted file chunk has an unexpected size: ${chunkId}`);
      }
      await writeAll({ output, chunk });
      remaining -= expected;
    }
    if (remaining !== 0) {
      throw new Error(`Encrypted file manifest does not cover its logical size: ${fileId}`);
    }
    completed = true;
  } finally {
    await output.close();
    if (!completed) {
      await rm(outputPath, { force: true });
    }
  }
}

function joinSafeEntryPath({ outputDirectory, name }) {
  if (
    name.length === 0
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

async function recoverDirectory({
  context,
  directoryId,
  outputDirectory,
  ancestors = new Set(),
}) {
  if (ancestors.has(directoryId)) {
    throw new Error(`Encrypted directory cycle detected: ${directoryId}`);
  }
  ancestors.add(directoryId);
  try {
    await mkdir(outputDirectory, { recursive: true });
  const manifest = await readJsonObject(context, 'directory_manifest', directoryId);
  if (manifest === undefined) {
    throw new Error(`Encrypted directory manifest is missing: ${directoryId}`);
  }
  for (const shardId of manifest.shardIds) {
    const shard = await readJsonObject(context, 'directory_shard', `${directoryId}/${shardId}`);
    if (shard === undefined) {
      throw new Error(`Encrypted directory shard is missing: ${directoryId}/${shardId}`);
    }
    for (const entry of Object.values(shard.entries)) {
      const outputPath = joinSafeEntryPath({ outputDirectory, name: entry.name });
      switch (entry.type) {
      case 'file':
        await recoverEncryptedFile({ context, fileId: entry.fileId, outputPath });
        break;
      case 'directory':
        await recoverDirectory({
          context,
          directoryId: entry.directoryId,
          outputDirectory: outputPath,
          ancestors,
        });
        break;
      case 'symlink':
        await writeFile(`${outputPath}.naidan-symlink.json`, JSON.stringify({ targetPath: entry.targetPath }));
        break;
      default:
        throw new Error(`Unsupported encrypted filesystem entry: ${entry.type}`);
      }
    }
  }
  } finally {
    ancestors.delete(directoryId);
  }
}

async function recoverStore({ context, output }) {
  const settings = await readJsonObject(context, 'singleton', 'settings');
  const hierarchy = await readJsonObject(context, 'singleton', 'hierarchy') ?? { items: [] };
  const storeManifest = await readJsonObject(context, 'singleton', 'store_manifest') ?? {
    chatMetaShardIds: [],
    chatGroupShardIds: [],
    binaryObjectShardIds: [],
    volumeShardIds: [],
    fileSystems: [],
  };
  await writeJsonValue(join(output, 'settings.json'), settings);
  await writeJsonValue(join(output, 'hierarchy.json'), hierarchy);

  const chatIds = new Set();
  const groupIds = new Set();
  for (const shardId of storeManifest.chatMetaShardIds ?? []) {
    const index = await readJsonObject(context, 'chat_meta_shard_index', shardId);
    for (const chatId of index?.chatIds ?? []) {
      chatIds.add(chatId);
    }
  }
  for (const shardId of storeManifest.chatGroupShardIds ?? []) {
    const index = await readJsonObject(context, 'chat_group_shard_index', shardId);
    for (const groupId of index?.chatGroupIds ?? []) {
      groupIds.add(groupId);
    }
  }
  for (const item of hierarchy.items ?? []) {
    if (item.type === 'chat') {
      chatIds.add(item.id);
    } else if (item.type === 'chat_group') {
      groupIds.add(item.id);
      for (const chatId of item.chat_ids ?? []) {
        chatIds.add(chatId);
      }
    }
  }
  for (const chatId of chatIds) {
    await writeJsonValue(
      join(output, 'chat-metas', `${chatId}.json`),
      await readJsonObject(context, 'chat_meta', chatId),
    );
    await writeJsonValue(
      join(output, 'chat-contents', `${chatId}.json`),
      await readJsonObject(context, 'chat_content', chatId),
    );
  }
  for (const groupId of groupIds) {
    await writeJsonValue(
      join(output, 'chat-groups', `${groupId}.json`),
      await readJsonObject(context, 'chat_group', groupId),
    );
  }

  for (const shardId of storeManifest.binaryObjectShardIds ?? []) {
    const index = await readJsonObject(context, 'binary_shard_index', shardId);
    if (index === undefined) {
      continue;
    }
    await writeJsonValue(join(output, 'binary-objects', shardId, 'index.json'), index);
    for (const binaryObject of Object.values(index.objects ?? {})) {
      await recoverEncryptedFile({
        context,
        fileId: `binary/${binaryObject.id}`,
        outputPath: join(output, 'binary-objects', shardId, `${binaryObject.id}.bin`),
      });
    }
  }

  for (const shardId of storeManifest.volumeShardIds ?? []) {
    const index = await readJsonObject(context, 'volume_index', shardId);
    if (index !== undefined) {
      await writeJsonValue(join(output, 'volumes', shardId, 'index.json'), index);
    }
  }
  for (const fileSystem of storeManifest.fileSystems ?? []) {
    let outputDirectory;
    switch (fileSystem.type) {
    case 'opfs_volume':
      outputDirectory = joinSafeEntryPath({
        outputDirectory: join(output, 'recovered-filesystems', 'opfs-volumes'),
        name: fileSystem.sourceId,
      });
      break;
    case 'chat_wesh':
    case 'debug_wesh':
    case 'tmp':
      outputDirectory = join(output, 'recovered-filesystems', fileSystem.type);
      break;
    default:
      throw new Error(`Unsupported encrypted filesystem type: ${fileSystem.type}`);
    }
    await recoverDirectory({
      context,
      directoryId: fileSystem.rootDirectoryId,
      outputDirectory,
    });
  }
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
  if (header.formatVersion !== 1 || header.encryptionSuite !== 'aes_256_gcm_chunked_v1') {
    throw new Error(`Unsupported encrypted-store header format: ${JSON.stringify(header)}`);
  }
  const storageUnlockKey = await unlockStorageUnlockKey({
    state,
    passphrase: args.passphrase,
    recoveryKey: args.recoveryKey,
  });
  const storeRootKey = unwrapKey({
    wrappedKey: header.wrappedStoreRootKey,
    wrappingKey: storageUnlockKey,
  });
  const objectEncryptionKey = Buffer.from(hkdfSync(
    'sha256',
    storeRootKey,
    Buffer.from(storeId, 'utf8'),
    OBJECT_ENCRYPTION_HKDF_INFO,
    32,
  ));
  const objectAddressKey = Buffer.from(hkdfSync(
    'sha256',
    storeRootKey,
    Buffer.from(storeId, 'utf8'),
    OBJECT_ADDRESS_HKDF_INFO,
    32,
  ));
  await mkdir(args.output, { recursive: true });
  await recoverStore({
    context: { storeDirectory, objectEncryptionKey, objectAddressKey },
    output: args.output,
  });
  storageUnlockKey.fill(0);
  storeRootKey.fill(0);
  objectEncryptionKey.fill(0);
  objectAddressKey.fill(0);
  console.log(`Recovered encrypted store ${storeId} to ${args.output}`);
}

await main();
