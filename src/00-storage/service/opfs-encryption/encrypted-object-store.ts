import { encodeBase64Url } from './base64-url';
import type { EncryptedStoreRuntimeKeys } from './types';
import { toExactArrayBuffer } from './array-buffer';

interface FileSystemFileHandleWithWritable extends FileSystemFileHandle {
  createWritable(): Promise<FileSystemWritableFileStream>,
}

const UTF8 = new TextEncoder();
const OBJECT_MAGIC = new Uint8Array([
  0x4e, 0x41, 0x49, 0x4f, 0x42, 0x4a, 0x00, 0x00,
]);
const OBJECT_FORMAT_VERSION = 1;
const OBJECT_HEADER_BYTE_LENGTH = 24;
const PAYLOAD_FRAME_VERSION = 1;
const PAYLOAD_ENCODING_IDENTITY = 0;
const PAYLOAD_HEADER_BYTE_LENGTH = 10;
const NONCE_BYTE_LENGTH = 12;
const TAG_BYTE_LENGTH = 16;

export type EncryptedObjectPhysicalArea = 'durable' | 'temporary';

export interface EncryptedObjectLocator {
  readonly namespace: string,
  readonly key: string,
}

export interface EncryptedObjectAddress {
  readonly objectId: string,
  readonly shardId: string,
  readonly area: EncryptedObjectPhysicalArea,
  readonly path: string,
}

export interface EncryptedObjectPhysicalHeader {
  readonly formatVersion: number,
  readonly headerByteLength: number,
  readonly nonce: Uint8Array,
  readonly ciphertextByteLength: number,
}

function encodeUint32({ value }: { value: number }): Uint8Array {
  if (!Number.isSafeInteger(value) || value < 0 || value > 0xffff_ffff) {
    throw new Error('Canonical locator segment length is out of range');
  }
  const bytes = new Uint8Array(4);
  new DataView(bytes.buffer).setUint32(0, value, false);
  return bytes;
}

function bytesEqual({
  left,
  right,
}: {
  left: Uint8Array,
  right: Uint8Array,
}): boolean {
  if (left.byteLength !== right.byteLength) {
    return false;
  }
  for (let index = 0; index < left.byteLength; index += 1) {
    if (left[index] !== right[index]) {
      return false;
    }
  }
  return true;
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
  header[0] = PAYLOAD_FRAME_VERSION;
  header[1] = PAYLOAD_ENCODING_IDENTITY;
  new DataView(header.buffer).setBigUint64(2, BigInt(plaintext.byteLength), false);
  return concatenateBytes({ parts: [header, plaintext] });
}

function decodePayloadFrame({ frame }: { frame: Uint8Array }): Uint8Array {
  if (frame.byteLength < PAYLOAD_HEADER_BYTE_LENGTH) {
    throw new Error('Encrypted object payload frame is truncated');
  }
  const frameVersion = frame[0];
  if (frameVersion !== PAYLOAD_FRAME_VERSION) {
    throw new Error(`Encrypted object payload frame version is unsupported: ${String(frameVersion)}`);
  }
  const encoding = frame[1];
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
  ).getBigUint64(2, false);
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

function createAad({
  area,
  objectId,
}: {
  area: EncryptedObjectPhysicalArea,
  objectId: string,
}): Uint8Array {
  return UTF8.encode(`naidan/opfs-encryption/object/v1/${area}/${objectId}`);
}

function encodePhysicalHeader({ nonce }: { nonce: Uint8Array }): Uint8Array {
  if (nonce.byteLength !== NONCE_BYTE_LENGTH) {
    throw new Error('Encrypted object nonce must contain exactly 12 bytes');
  }
  const header = new Uint8Array(OBJECT_HEADER_BYTE_LENGTH);
  header.set(OBJECT_MAGIC, 0);
  const view = new DataView(header.buffer);
  view.setUint16(OBJECT_MAGIC.byteLength, OBJECT_FORMAT_VERSION, false);
  view.setUint16(OBJECT_MAGIC.byteLength + 2, OBJECT_HEADER_BYTE_LENGTH, false);
  header.set(nonce, OBJECT_MAGIC.byteLength + 4);
  return header;
}

export function decodeEncryptedObjectPhysicalHeader({
  physical,
}: {
  physical: Uint8Array,
}): EncryptedObjectPhysicalHeader {
  if (physical.byteLength < OBJECT_HEADER_BYTE_LENGTH + TAG_BYTE_LENGTH) {
    throw new Error('Encrypted object is truncated');
  }
  for (let index = 0; index < OBJECT_MAGIC.byteLength; index++) {
    if (physical[index] !== OBJECT_MAGIC[index]) {
      throw new Error('Encrypted object magic is unsupported');
    }
  }
  const view = new DataView(physical.buffer, physical.byteOffset, physical.byteLength);
  const formatVersion = view.getUint16(OBJECT_MAGIC.byteLength, false);
  if (formatVersion !== OBJECT_FORMAT_VERSION) {
    throw new Error(`Encrypted object format version is unsupported: ${String(formatVersion)}`);
  }
  const headerByteLength = view.getUint16(OBJECT_MAGIC.byteLength + 2, false);
  if (headerByteLength !== OBJECT_HEADER_BYTE_LENGTH) {
    throw new Error(`Encrypted object header length is unsupported: ${String(headerByteLength)}`);
  }
  return {
    formatVersion,
    headerByteLength,
    nonce: physical.slice(OBJECT_MAGIC.byteLength + 4, OBJECT_HEADER_BYTE_LENGTH),
    ciphertextByteLength: physical.byteLength - OBJECT_HEADER_BYTE_LENGTH,
  };
}

function isNotFoundError({ error }: { error: unknown }): boolean {
  return error instanceof DOMException
    ? error.name === 'NotFoundError'
    : error instanceof Error
      && (error.name === 'NotFoundError'
        || error.message.startsWith('NotFoundError'));
}

function getAreaDirectoryName({ area }: { area: EncryptedObjectPhysicalArea }): string {
  switch (area) {
  case 'durable':
    return 'objects';
  case 'temporary':
    return 'temporary-objects';
  default: {
    const _ex: never = area;
    throw new Error(`Unhandled encrypted object physical area: ${String(_ex)}`);
  }
  }
}

export class EncryptedObjectStore {
  constructor({
    storeDirectory,
    keys,
    area,
  }: {
    storeDirectory: FileSystemDirectoryHandle,
    keys: EncryptedStoreRuntimeKeys,
    area: EncryptedObjectPhysicalArea,
  }) {
    this.storeDirectory = storeDirectory;
    this.keys = keys;
    this.area = area;
  }

  private readonly storeDirectory: FileSystemDirectoryHandle;
  private readonly keys: EncryptedStoreRuntimeKeys;
  private readonly area: EncryptedObjectPhysicalArea;

  async getObjectAddress({ locator }: { locator: EncryptedObjectLocator }): Promise<EncryptedObjectAddress> {
    const signature = new Uint8Array(await crypto.subtle.sign(
      'HMAC',
      this.keys.objectAddressKey,
      toExactArrayBuffer({ bytes: encodeCanonicalLocator({ locator }) }),
    ));
    const objectId = encodeBase64Url({ bytes: signature });
    const firstByte = signature[0];
    if (firstByte === undefined) {
      throw new Error('Encrypted object address HMAC was empty');
    }
    const shardId = firstByte.toString(16).padStart(2, '0');
    const areaDirectoryName = getAreaDirectoryName({ area: this.area });
    return {
      objectId,
      shardId,
      area: this.area,
      path: `${areaDirectoryName}/${shardId}/${objectId}.enc`,
    };
  }

  async getObjectId({ locator }: { locator: EncryptedObjectLocator }): Promise<string> {
    return (await this.getObjectAddress({ locator })).objectId;
  }

  async getLogicalShard({ locator }: { locator: EncryptedObjectLocator }): Promise<string> {
    return (await this.getObjectAddress({ locator })).shardId;
  }

  async write({
    locator,
    plaintext,
  }: {
    locator: EncryptedObjectLocator,
    plaintext: Uint8Array,
  }): Promise<void> {
    const address = await this.getObjectAddress({ locator });
    const nonce = crypto.getRandomValues(new Uint8Array(NONCE_BYTE_LENGTH));
    const ciphertext = new Uint8Array(await crypto.subtle.encrypt(
      {
        name: 'AES-GCM',
        iv: toExactArrayBuffer({ bytes: nonce }),
        additionalData: toExactArrayBuffer({
          bytes: createAad({ area: this.area, objectId: address.objectId }),
        }),
        tagLength: 128,
      },
      this.keys.objectEncryptionKey,
      toExactArrayBuffer({ bytes: encodePayloadFrame({ plaintext }) }),
    ));
    const physical = concatenateBytes({
      parts: [encodePhysicalHeader({ nonce }), ciphertext],
    });
    const fileHandle = await this.getObjectFileHandle({ address, create: true }) as FileSystemFileHandleWithWritable;
    const writable = await fileHandle.createWritable();
    try {
      // OPFS commits the replacement when close succeeds, so readers never observe a partial object.
      await writable.write(toExactArrayBuffer({ bytes: physical }));
      await writable.close();
    } catch (error) {
      try {
        await writable.abort(error);
      } catch {
        // Preserve the original encryption or write error.
      }
      try {
        const persisted = new Uint8Array(await (await fileHandle.getFile()).arrayBuffer());
        if (bytesEqual({ left: persisted, right: physical })) {
          // Some OPFS implementations may durably replace the file before a
          // close error reaches JavaScript. Exact read-back makes that
          // ambiguous completion observable as success instead of causing a
          // caller to roll back an object that is already committed.
          return;
        }
      } catch {
        // Preserve the original write error when durable completion cannot be
        // proven by an exact read-back.
      }
      throw error;
    }
  }

  async read({ locator }: { locator: EncryptedObjectLocator }): Promise<Uint8Array | undefined> {
    const address = await this.getObjectAddress({ locator });
    const physical = await this.readPhysical({ address });
    if (physical === undefined) {
      return undefined;
    }
    const header = decodeEncryptedObjectPhysicalHeader({ physical });
    const ciphertext = physical.subarray(header.headerByteLength);
    const plaintextFrame = await crypto.subtle.decrypt(
      {
        name: 'AES-GCM',
        iv: toExactArrayBuffer({ bytes: header.nonce }),
        additionalData: toExactArrayBuffer({
          bytes: createAad({ area: this.area, objectId: address.objectId }),
        }),
        tagLength: 128,
      },
      this.keys.objectEncryptionKey,
      toExactArrayBuffer({ bytes: ciphertext }),
    );
    const frame = new Uint8Array(plaintextFrame);
    try {
      return decodePayloadFrame({ frame }).slice();
    } finally {
      frame.fill(0);
    }
  }

  async readPhysical({
    address,
  }: {
    address: EncryptedObjectAddress,
  }): Promise<Uint8Array | undefined> {
    let file: File;
    try {
      file = await (await this.getObjectFileHandle({ address, create: false })).getFile();
    } catch (error) {
      if (isNotFoundError({ error })) {
        return undefined;
      }
      throw error;
    }
    return new Uint8Array(await file.arrayBuffer());
  }


  async decryptPhysical({
    address,
    physical,
  }: {
    address: EncryptedObjectAddress,
    physical?: Uint8Array,
  }): Promise<Uint8Array | undefined> {
    if (address.area !== this.area) {
      throw new Error(`Encrypted object address area mismatch: ${address.area}`);
    }
    const resolvedPhysical = physical ?? await this.readPhysical({ address });
    if (resolvedPhysical === undefined) {
      return undefined;
    }
    const header = decodeEncryptedObjectPhysicalHeader({ physical: resolvedPhysical });
    const ciphertext = resolvedPhysical.subarray(header.headerByteLength);
    const plaintextFrame = await crypto.subtle.decrypt(
      {
        name: 'AES-GCM',
        iv: toExactArrayBuffer({ bytes: header.nonce }),
        additionalData: toExactArrayBuffer({
          bytes: createAad({ area: this.area, objectId: address.objectId }),
        }),
        tagLength: 128,
      },
      this.keys.objectEncryptionKey,
      toExactArrayBuffer({ bytes: ciphertext }),
    );
    const frame = new Uint8Array(plaintextFrame);
    try {
      return decodePayloadFrame({ frame }).slice();
    } finally {
      frame.fill(0);
    }
  }

  async delete({ locator }: { locator: EncryptedObjectLocator }): Promise<void> {
    const address = await this.getObjectAddress({ locator });
    try {
      const areaDirectory = await this.storeDirectory.getDirectoryHandle(
        getAreaDirectoryName({ area: this.area }),
      );
      const shardDirectory = await areaDirectory.getDirectoryHandle(address.shardId);
      await shardDirectory.removeEntry(`${address.objectId}.enc`);
    } catch (error) {
      if (isNotFoundError({ error })) {
        return;
      }
      try {
        if (await this.readPhysical({ address }) === undefined) {
          // As with writable-stream close, OPFS may complete the mutation before
          // reporting an error. Absence is the exact requested postcondition,
          // so a confirmed deletion is successful and WAL completion must not
          // be surfaced as a failed logical operation.
          return;
        }
      } catch {
        // Preserve the original removal error when the postcondition cannot be
        // observed safely.
      }
      throw error;
    }
  }

  async *listPhysicalObjectAddresses(): AsyncIterable<EncryptedObjectAddress> {
    const areaDirectoryName = getAreaDirectoryName({ area: this.area });
    let areaDirectory: FileSystemDirectoryHandle;
    try {
      areaDirectory = await this.storeDirectory.getDirectoryHandle(areaDirectoryName);
    } catch (error) {
      if (isNotFoundError({ error })) {
        return;
      }
      throw error;
    }
    for await (const [shardId, shardHandle] of areaDirectory.entries()) {
      switch (shardHandle.kind) {
      case 'file':
        continue;
      case 'directory':
        break;
      default: {
        const _ex: never = shardHandle;
        throw new Error(`Unhandled filesystem handle kind: ${String(_ex)}`);
      }
      }
      for await (const [filename, objectHandle] of shardHandle.entries()) {
        switch (objectHandle.kind) {
        case 'directory':
          continue;
        case 'file':
          break;
        default: {
          const _ex: never = objectHandle;
          throw new Error(`Unhandled filesystem handle kind: ${String(_ex)}`);
        }
        }
        if (!filename.endsWith('.enc')) {
          continue;
        }
        const objectId = filename.slice(0, -'.enc'.length);
        yield {
          objectId,
          shardId,
          area: this.area,
          path: `${areaDirectoryName}/${shardId}/${filename}`,
        };
      }
    }
  }

  private async getObjectFileHandle({
    address,
    create,
  }: {
    address: EncryptedObjectAddress,
    create: boolean,
  }): Promise<FileSystemFileHandle> {
    const areaDirectory = await this.storeDirectory.getDirectoryHandle(
      getAreaDirectoryName({ area: this.area }),
      { create },
    );
    const shardDirectory = await areaDirectory.getDirectoryHandle(address.shardId, { create });
    return await shardDirectory.getFileHandle(`${address.objectId}.enc`, { create });
  }
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
  OBJECT_FORMAT_VERSION,
  OBJECT_HEADER_BYTE_LENGTH,
  decodePayloadFrame,
  encodeCanonicalLocator,
  encodePayloadFrame,
  encodePhysicalHeader,
};
