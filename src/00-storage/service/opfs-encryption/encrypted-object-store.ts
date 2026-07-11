import { encodeBase64Url } from './base64-url';
import type { EncryptedStoreRuntimeKeys } from './types';
import { toExactArrayBuffer } from './array-buffer';

interface FileSystemFileHandleWithWritable extends FileSystemFileHandle {
  createWritable(): Promise<FileSystemWritableFileStream>,
}

const UTF8 = new TextEncoder();
const MAGIC = UTF8.encode('NAIDAN01');
const PAYLOAD_MAGIC = UTF8.encode('NPAYLD01');
const PAYLOAD_ENCODING_IDENTITY = 0;
const PAYLOAD_HEADER_BYTE_LENGTH = 17;
const NONCE_BYTE_LENGTH = 12;
const TAG_BYTE_LENGTH = 16;

export interface EncryptedObjectLocator {
  readonly namespace: string,
  readonly key: string,
}

function encodeUint32({ value }: { value: number }): Uint8Array {
  if (!Number.isSafeInteger(value) || value < 0 || value > 0xffff_ffff) {
    throw new Error('Canonical locator segment length is out of range');
  }
  const bytes = new Uint8Array(4);
  new DataView(bytes.buffer).setUint32(0, value, false);
  return bytes;
}

function concatenateBytes({ parts }: { parts: Uint8Array[] }): Uint8Array {
  const byteLength = parts.reduce((total, part) => total + part.byteLength, 0);
  const result = new Uint8Array(byteLength);
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.byteLength;
  }
  return result;
}

function encodePayloadFrame({ plaintext }: { plaintext: Uint8Array }): Uint8Array {
  if (!Number.isSafeInteger(plaintext.byteLength)) {
    throw new Error('Encrypted object plaintext size is not a safe integer');
  }
  const header = new Uint8Array(PAYLOAD_HEADER_BYTE_LENGTH);
  header.set(PAYLOAD_MAGIC, 0);
  header[PAYLOAD_MAGIC.byteLength] = PAYLOAD_ENCODING_IDENTITY;
  new DataView(header.buffer).setBigUint64(
    PAYLOAD_MAGIC.byteLength + 1,
    BigInt(plaintext.byteLength),
    false,
  );
  return concatenateBytes({ parts: [header, plaintext] });
}

function decodePayloadFrame({ frame }: { frame: Uint8Array }): Uint8Array {
  if (frame.byteLength < PAYLOAD_HEADER_BYTE_LENGTH) {
    throw new Error('Encrypted object payload frame is truncated');
  }
  for (let index = 0; index < PAYLOAD_MAGIC.byteLength; index++) {
    if (frame[index] !== PAYLOAD_MAGIC[index]) {
      throw new Error('Encrypted object payload frame has an unsupported format');
    }
  }
  const encoding = frame[PAYLOAD_MAGIC.byteLength];
  switch (encoding) {
  case PAYLOAD_ENCODING_IDENTITY:
    break;
  default:
    throw new Error(`Encrypted object payload encoding is unsupported: ${String(encoding)}`);
  }
  const plaintextSizeBigInt = new DataView(
    frame.buffer,
    frame.byteOffset,
    frame.byteLength,
  ).getBigUint64(PAYLOAD_MAGIC.byteLength + 1, false);
  if (plaintextSizeBigInt > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error('Encrypted object plaintext size exceeds the safe integer range');
  }
  const plaintextSize = Number(plaintextSizeBigInt);
  const payload = frame.subarray(PAYLOAD_HEADER_BYTE_LENGTH);
  if (payload.byteLength !== plaintextSize) {
    throw new Error(
      `Encrypted object identity payload size mismatch: expected ${plaintextSize}, received ${payload.byteLength}`,
    );
  }
  return payload;
}

function encodeCanonicalLocator({ locator }: { locator: EncryptedObjectLocator }): Uint8Array {
  const namespace = UTF8.encode(locator.namespace);
  const key = UTF8.encode(locator.key);
  return concatenateBytes({
    parts: [
      encodeUint32({ value: namespace.byteLength }),
      namespace,
      encodeUint32({ value: key.byteLength }),
      key,
    ],
  });
}

function createAad({ objectId }: { objectId: string }): Uint8Array {
  return UTF8.encode(`naidan/opfs-encryption/object/v1/${objectId}`);
}

function isNotFoundError({ error }: { error: unknown }): boolean {
  return error instanceof DOMException
    ? error.name === 'NotFoundError'
    : error instanceof Error
      && (error.name === 'NotFoundError'
        || error.message.startsWith('NotFoundError'));
}

export class EncryptedObjectStore {
  constructor({
    storeDirectory,
    keys,
  }: {
    storeDirectory: FileSystemDirectoryHandle,
    keys: EncryptedStoreRuntimeKeys,
  }) {
    this.storeDirectory = storeDirectory;
    this.keys = keys;
  }

  private readonly storeDirectory: FileSystemDirectoryHandle;
  private readonly keys: EncryptedStoreRuntimeKeys;

  async getObjectId({ locator }: { locator: EncryptedObjectLocator }): Promise<string> {
    const signature = await crypto.subtle.sign(
      'HMAC',
      this.keys.objectAddressKey,
      toExactArrayBuffer({ bytes: encodeCanonicalLocator({ locator }) }),
    );
    return encodeBase64Url({ bytes: new Uint8Array(signature) });
  }

  async write({
    locator,
    plaintext,
  }: {
    locator: EncryptedObjectLocator,
    plaintext: Uint8Array,
  }): Promise<void> {
    const objectId = await this.getObjectId({ locator });
    const nonce = crypto.getRandomValues(new Uint8Array(NONCE_BYTE_LENGTH));
    const ciphertext = new Uint8Array(await crypto.subtle.encrypt(
      {
        name: 'AES-GCM',
        iv: toExactArrayBuffer({ bytes: nonce }),
        additionalData: toExactArrayBuffer({ bytes: createAad({ objectId }) }),
        tagLength: 128,
      },
      this.keys.objectEncryptionKey,
      toExactArrayBuffer({ bytes: encodePayloadFrame({ plaintext }) }),
    ));
    const physical = concatenateBytes({ parts: [MAGIC, nonce, ciphertext] });
    const fileHandle = await this.getObjectFileHandle({ objectId, create: true }) as FileSystemFileHandleWithWritable;
    const writable = await fileHandle.createWritable();
    try {
      await writable.write(toExactArrayBuffer({ bytes: physical }));
      await writable.close();
    } catch (error) {
      try {
        await writable.abort(error);
      } catch {
        // Preserve the original encryption or write error.
      }
      throw error;
    }
  }

  async read({ locator }: { locator: EncryptedObjectLocator }): Promise<Uint8Array | undefined> {
    const objectId = await this.getObjectId({ locator });
    let file: File;
    try {
      file = await (await this.getObjectFileHandle({ objectId, create: false })).getFile();
    } catch (error) {
      if (isNotFoundError({ error })) {
        return undefined;
      }
      throw error;
    }
    const physical = new Uint8Array(await file.arrayBuffer());
    if (physical.byteLength < MAGIC.byteLength + NONCE_BYTE_LENGTH + TAG_BYTE_LENGTH) {
      throw new Error(`Encrypted object is truncated: ${objectId}`);
    }
    for (let index = 0; index < MAGIC.byteLength; index++) {
      if (physical[index] !== MAGIC[index]) {
        throw new Error(`Encrypted object has an unsupported format: ${objectId}`);
      }
    }
    const nonceStart = MAGIC.byteLength;
    const ciphertextStart = nonceStart + NONCE_BYTE_LENGTH;
    const nonce = physical.subarray(nonceStart, ciphertextStart);
    const ciphertext = physical.subarray(ciphertextStart);
    const plaintextFrame = await crypto.subtle.decrypt(
      {
        name: 'AES-GCM',
        iv: toExactArrayBuffer({ bytes: nonce }),
        additionalData: toExactArrayBuffer({ bytes: createAad({ objectId }) }),
        tagLength: 128,
      },
      this.keys.objectEncryptionKey,
      toExactArrayBuffer({ bytes: ciphertext }),
    );
    return decodePayloadFrame({ frame: new Uint8Array(plaintextFrame) });
  }

  async delete({ locator }: { locator: EncryptedObjectLocator }): Promise<void> {
    const objectId = await this.getObjectId({ locator });
    try {
      const objectsDirectory = await this.storeDirectory.getDirectoryHandle('objects');
      const shardDirectory = await objectsDirectory.getDirectoryHandle(objectId.slice(0, 2));
      await shardDirectory.removeEntry(`${objectId}.bin`);
    } catch (error) {
      if (!isNotFoundError({ error })) {
        throw error;
      }
    }
  }

  private async getObjectFileHandle({
    objectId,
    create,
  }: {
    objectId: string,
    create: boolean,
  }): Promise<FileSystemFileHandle> {
    const objectsDirectory = await this.storeDirectory.getDirectoryHandle('objects', { create });
    const shardDirectory = await objectsDirectory.getDirectoryHandle(objectId.slice(0, 2), { create });
    return await shardDirectory.getFileHandle(`${objectId}.bin`, { create });
  }
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
  decodePayloadFrame,
  encodeCanonicalLocator,
  encodePayloadFrame,
};
