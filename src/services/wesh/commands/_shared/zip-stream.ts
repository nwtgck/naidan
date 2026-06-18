import type { WeshFileHandle } from '@/services/wesh/types';
import { writeAllBytesToHandle, writeAllStreamToHandle } from '@/services/wesh/utils/fs';
import {
  iterateReadableStreamChunks,
  pipeThroughBufferSourceTransform,
} from '@/services/wesh/utils/stream';

const ZIP_LOCAL_FILE_HEADER_SIGNATURE = 0x04034b50;
const ZIP_CENTRAL_DIRECTORY_HEADER_SIGNATURE = 0x02014b50;
const ZIP_END_OF_CENTRAL_DIRECTORY_SIGNATURE = 0x06054b50;
const ZIP_DATA_DESCRIPTOR_SIGNATURE = 0x08074b50;
const ZIP_GENERAL_PURPOSE_UTF8_FLAG = 0x0800;
const ZIP_GENERAL_PURPOSE_DATA_DESCRIPTOR_FLAG = 0x0008;
const ZIP_METHOD_STORE = 0;
const ZIP_METHOD_DEFLATE = 8;
const ZIP_VERSION_NEEDED = 20;
const ZIP_VERSION_MADE_BY = 0x0314;
const ZIP_UINT16_MAX = 0xffff;
const ZIP_UINT32_MAX = 0xffffffff;
const ZIP_END_RECORD_MIN_SIZE = 22;
const ZIP_MAX_COMMENT_SIZE = ZIP_UINT16_MAX;
const ZIP_IO_CHUNK_SIZE = 64 * 1024;

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

export type ZipCompression = 'store' | 'deflate';

export interface ZipArchiveEntry {
  readonly name: string;
  readonly isDirectory: boolean;
  readonly compression: ZipCompression;
  readonly crc32: number;
  readonly compressedSize: number;
  readonly uncompressedSize: number;
  readonly localHeaderOffset: number;
  readonly modifiedAt: Date;
  readonly flags: number;
}

export interface ZipRandomAccessSource {
  readonly size: number;
  read({ offset, length }: { offset: number; length: number }): Promise<Uint8Array>;
  close(): Promise<void>;
}

interface ZipCentralDirectoryInfo {
  readonly entryCount: number;
  readonly offset: number;
  readonly size: number;
}

interface ZipEntryWriteResult {
  readonly crc32: number;
  readonly compressedSize: number;
  readonly uncompressedSize: number;
}

class Crc32Accumulator {
  private static readonly table = Crc32Accumulator.createTable();
  private value = 0xffffffff;

  private static createTable(): Uint32Array {
    const table = new Uint32Array(256);
    for (let index = 0; index < table.length; index += 1) {
      let value = index;
      for (let bit = 0; bit < 8; bit += 1) {
        value = (value & 1) === 1
          ? (value >>> 1) ^ 0xedb88320
          : value >>> 1;
      }
      table[index] = value >>> 0;
    }
    return table;
  }

  update({ chunk }: { chunk: Uint8Array }): void {
    let value = this.value;
    for (const byte of chunk) {
      const tableValue = Crc32Accumulator.table[(value ^ byte) & 0xff];
      if (tableValue === undefined) {
        throw new Error('CRC32 table lookup failed');
      }
      value = (value >>> 8) ^ tableValue;
    }
    this.value = value >>> 0;
  }

  finish(): number {
    return (this.value ^ 0xffffffff) >>> 0;
  }
}

class CountingHandleWriter {
  private readonly handle: WeshFileHandle;
  position = 0;

  constructor({ handle }: { handle: WeshFileHandle }) {
    this.handle = handle;
  }

  async write({ chunk }: { chunk: Uint8Array }): Promise<void> {
    let offset = 0;
    while (offset < chunk.byteLength) {
      const { bytesWritten } = await this.handle.write({
        buffer: chunk,
        offset,
        length: chunk.byteLength - offset,
      });
      if (bytesWritten <= 0) {
        throw new Error('ZIP output stopped accepting data');
      }
      offset += bytesWritten;
      this.position += bytesWritten;
    }
  }

  async close(): Promise<void> {
    await this.handle.close();
  }
}

function assertUint16({ value, field }: { value: number; field: string }): number {
  if (!Number.isInteger(value) || value < 0 || value > ZIP_UINT16_MAX) {
    throw new Error(`ZIP ${field} exceeds the non-ZIP64 limit`);
  }
  return value;
}

function assertUint32({ value, field }: { value: number; field: string }): number {
  if (!Number.isInteger(value) || value < 0 || value > ZIP_UINT32_MAX) {
    throw new Error(`ZIP ${field} exceeds the non-ZIP64 limit`);
  }
  return value;
}

function createBytes({ size, write }: {
  size: number;
  write: ({ view }: { view: DataView }) => void;
}): Uint8Array {
  const bytes = new Uint8Array(size);
  write({ view: new DataView(bytes.buffer) });
  return bytes;
}

function getDosDateTime({ date }: { date: Date }): { date: number; time: number } {
  const year = Math.min(Math.max(date.getFullYear(), 1980), 2107);
  const month = date.getMonth() + 1;
  const day = date.getDate();
  const hours = date.getHours();
  const minutes = date.getMinutes();
  const seconds = Math.floor(date.getSeconds() / 2);

  return {
    date: ((year - 1980) << 9) | (month << 5) | day,
    time: (hours << 11) | (minutes << 5) | seconds,
  };
}

function fromDosDateTime({ date, time }: { date: number; time: number }): Date {
  const year = 1980 + ((date >>> 9) & 0x7f);
  const month = ((date >>> 5) & 0x0f) - 1;
  const day = date & 0x1f;
  const hours = (time >>> 11) & 0x1f;
  const minutes = (time >>> 5) & 0x3f;
  const seconds = (time & 0x1f) * 2;
  return new Date(year, month, day, hours, minutes, seconds);
}

function createLocalHeader({
  nameBytes,
  flags,
  method,
  modifiedAt,
  crc32,
  compressedSize,
  uncompressedSize,
}: {
  nameBytes: Uint8Array;
  flags: number;
  method: number;
  modifiedAt: Date;
  crc32: number;
  compressedSize: number;
  uncompressedSize: number;
}): Uint8Array {
  const dos = getDosDateTime({ date: modifiedAt });
  const header = createBytes({
    size: 30,
    write: ({ view }) => {
      view.setUint32(0, ZIP_LOCAL_FILE_HEADER_SIGNATURE, true);
      view.setUint16(4, ZIP_VERSION_NEEDED, true);
      view.setUint16(6, flags, true);
      view.setUint16(8, method, true);
      view.setUint16(10, dos.time, true);
      view.setUint16(12, dos.date, true);
      view.setUint32(14, crc32, true);
      view.setUint32(18, compressedSize, true);
      view.setUint32(22, uncompressedSize, true);
      view.setUint16(26, assertUint16({ value: nameBytes.byteLength, field: 'entry name length' }), true);
      view.setUint16(28, 0, true);
    },
  });
  const result = new Uint8Array(header.byteLength + nameBytes.byteLength);
  result.set(header, 0);
  result.set(nameBytes, header.byteLength);
  return result;
}

function createDataDescriptor({
  crc32,
  compressedSize,
  uncompressedSize,
}: ZipEntryWriteResult): Uint8Array {
  return createBytes({
    size: 16,
    write: ({ view }) => {
      view.setUint32(0, ZIP_DATA_DESCRIPTOR_SIGNATURE, true);
      view.setUint32(4, assertUint32({ value: crc32, field: 'CRC32' }), true);
      view.setUint32(8, assertUint32({ value: compressedSize, field: 'compressed size' }), true);
      view.setUint32(12, assertUint32({ value: uncompressedSize, field: 'uncompressed size' }), true);
    },
  });
}

function createCentralDirectoryRecord({
  nameBytes,
  flags,
  method,
  modifiedAt,
  crc32,
  compressedSize,
  uncompressedSize,
  localHeaderOffset,
  isDirectory,
}: {
  nameBytes: Uint8Array;
  flags: number;
  method: number;
  modifiedAt: Date;
  crc32: number;
  compressedSize: number;
  uncompressedSize: number;
  localHeaderOffset: number;
  isDirectory: boolean;
}): Uint8Array {
  const dos = getDosDateTime({ date: modifiedAt });
  const header = createBytes({
    size: 46,
    write: ({ view }) => {
      view.setUint32(0, ZIP_CENTRAL_DIRECTORY_HEADER_SIGNATURE, true);
      view.setUint16(4, ZIP_VERSION_MADE_BY, true);
      view.setUint16(6, ZIP_VERSION_NEEDED, true);
      view.setUint16(8, flags, true);
      view.setUint16(10, method, true);
      view.setUint16(12, dos.time, true);
      view.setUint16(14, dos.date, true);
      view.setUint32(16, assertUint32({ value: crc32, field: 'CRC32' }), true);
      view.setUint32(20, assertUint32({ value: compressedSize, field: 'compressed size' }), true);
      view.setUint32(24, assertUint32({ value: uncompressedSize, field: 'uncompressed size' }), true);
      view.setUint16(28, assertUint16({ value: nameBytes.byteLength, field: 'entry name length' }), true);
      view.setUint16(30, 0, true);
      view.setUint16(32, 0, true);
      view.setUint16(34, 0, true);
      view.setUint16(36, 0, true);
      view.setUint32(38, isDirectory ? 0x10 : 0, true);
      view.setUint32(42, assertUint32({ value: localHeaderOffset, field: 'local header offset' }), true);
    },
  });
  const result = new Uint8Array(header.byteLength + nameBytes.byteLength);
  result.set(header, 0);
  result.set(nameBytes, header.byteLength);
  return result;
}

function createEndOfCentralDirectory({
  entryCount,
  centralDirectorySize,
  centralDirectoryOffset,
}: {
  entryCount: number;
  centralDirectorySize: number;
  centralDirectoryOffset: number;
}): Uint8Array {
  return createBytes({
    size: ZIP_END_RECORD_MIN_SIZE,
    write: ({ view }) => {
      view.setUint32(0, ZIP_END_OF_CENTRAL_DIRECTORY_SIGNATURE, true);
      view.setUint16(4, 0, true);
      view.setUint16(6, 0, true);
      view.setUint16(8, assertUint16({ value: entryCount, field: 'entry count' }), true);
      view.setUint16(10, assertUint16({ value: entryCount, field: 'entry count' }), true);
      view.setUint32(12, assertUint32({ value: centralDirectorySize, field: 'central directory size' }), true);
      view.setUint32(16, assertUint32({ value: centralDirectoryOffset, field: 'central directory offset' }), true);
      view.setUint16(20, 0, true);
    },
  });
}

function compressionMethodToNumber({ compression }: { compression: ZipCompression }): number {
  switch (compression) {
  case 'store':
    return ZIP_METHOD_STORE;
  case 'deflate':
    return ZIP_METHOD_DEFLATE;
  default: {
    const _exhaustiveCheck: never = compression;
    throw new Error(`Unhandled ZIP compression: ${String(_exhaustiveCheck)}`);
  }
  }
}

function compressionNumberToMethod({ method }: { method: number }): ZipCompression {
  switch (method) {
  case ZIP_METHOD_STORE:
    return 'store';
  case ZIP_METHOD_DEFLATE:
    return 'deflate';
  default:
    throw new Error(`Unsupported ZIP compression method: ${method}`);
  }
}

function createCrcTrackingStream({
  state,
}: {
  state: {
    accumulator: Crc32Accumulator;
    uncompressedSize: number;
  };
}): TransformStream<Uint8Array, Uint8Array> {
  return new TransformStream({
    transform(chunk, controller) {
      state.accumulator.update({ chunk });
      state.uncompressedSize += chunk.byteLength;
      assertUint32({ value: state.uncompressedSize, field: 'uncompressed size' });
      controller.enqueue(chunk);
    },
  });
}

function createValidationStream({
  entry,
}: {
  entry: ZipArchiveEntry;
}): TransformStream<Uint8Array, Uint8Array> {
  const accumulator = new Crc32Accumulator();
  let size = 0;
  return new TransformStream({
    transform(chunk, controller) {
      accumulator.update({ chunk });
      size += chunk.byteLength;
      controller.enqueue(chunk);
    },
    flush() {
      if (size !== entry.uncompressedSize) {
        throw new Error(`ZIP entry size mismatch: ${entry.name}`);
      }
      if (accumulator.finish() !== entry.crc32) {
        throw new Error(`ZIP entry CRC mismatch: ${entry.name}`);
      }
    },
  });
}

export class StreamingZipWriter {
  private readonly output: CountingHandleWriter;
  private readonly centralDirectory: CountingHandleWriter;
  private entryCount = 0;
  private finalized = false;

  constructor({
    outputHandle,
    centralDirectoryHandle,
  }: {
    outputHandle: WeshFileHandle;
    centralDirectoryHandle: WeshFileHandle;
  }) {
    this.output = new CountingHandleWriter({ handle: outputHandle });
    this.centralDirectory = new CountingHandleWriter({ handle: centralDirectoryHandle });
  }

  async addDirectory({
    name,
    modifiedAt,
  }: {
    name: string;
    modifiedAt: Date;
  }): Promise<void> {
    this.assertWritable();
    const normalizedName = name.endsWith('/') ? name : `${name}/`;
    const nameBytes = textEncoder.encode(normalizedName);
    const localHeaderOffset = this.output.position;
    const flags = ZIP_GENERAL_PURPOSE_UTF8_FLAG;
    await this.output.write({
      chunk: createLocalHeader({
        nameBytes,
        flags,
        method: ZIP_METHOD_STORE,
        modifiedAt,
        crc32: 0,
        compressedSize: 0,
        uncompressedSize: 0,
      }),
    });
    await this.centralDirectory.write({
      chunk: createCentralDirectoryRecord({
        nameBytes,
        flags,
        method: ZIP_METHOD_STORE,
        modifiedAt,
        crc32: 0,
        compressedSize: 0,
        uncompressedSize: 0,
        localHeaderOffset,
        isDirectory: true,
      }),
    });
    this.incrementEntryCount();
  }

  async addFile({
    name,
    modifiedAt,
    compression,
    stream,
  }: {
    name: string;
    modifiedAt: Date;
    compression: ZipCompression;
    stream: ReadableStream<Uint8Array>;
  }): Promise<void> {
    this.assertWritable();
    const nameBytes = textEncoder.encode(name);
    const localHeaderOffset = this.output.position;
    const method = compressionMethodToNumber({ compression });
    const flags = ZIP_GENERAL_PURPOSE_UTF8_FLAG | ZIP_GENERAL_PURPOSE_DATA_DESCRIPTOR_FLAG;
    await this.output.write({
      chunk: createLocalHeader({
        nameBytes,
        flags,
        method,
        modifiedAt,
        crc32: 0,
        compressedSize: 0,
        uncompressedSize: 0,
      }),
    });

    const state = {
      accumulator: new Crc32Accumulator(),
      uncompressedSize: 0,
    };
    const trackedStream = stream.pipeThrough(createCrcTrackingStream({ state }));
    const dataStream = (() => {
      switch (compression) {
      case 'store':
        return trackedStream;
      case 'deflate':
        return pipeThroughBufferSourceTransform({
          source: trackedStream,
          transform: new CompressionStream('deflate-raw'),
        });
      default: {
        const _exhaustiveCheck: never = compression;
        throw new Error(`Unhandled ZIP compression: ${String(_exhaustiveCheck)}`);
      }
      }
    })();

    const dataStartOffset = this.output.position;
    for await (const chunk of iterateReadableStreamChunks({ stream: dataStream })) {
      await this.output.write({ chunk });
    }
    const result: ZipEntryWriteResult = {
      crc32: state.accumulator.finish(),
      compressedSize: this.output.position - dataStartOffset,
      uncompressedSize: state.uncompressedSize,
    };
    await this.output.write({ chunk: createDataDescriptor(result) });
    await this.centralDirectory.write({
      chunk: createCentralDirectoryRecord({
        nameBytes,
        flags,
        method,
        modifiedAt,
        crc32: result.crc32,
        compressedSize: result.compressedSize,
        uncompressedSize: result.uncompressedSize,
        localHeaderOffset,
        isDirectory: false,
      }),
    });
    this.incrementEntryCount();
  }

  async finalize({
    openCentralDirectoryStream,
  }: {
    openCentralDirectoryStream: () => Promise<ReadableStream<Uint8Array>>;
  }): Promise<void> {
    this.assertWritable();
    this.finalized = true;
    const centralDirectorySize = this.centralDirectory.position;
    const centralDirectoryOffset = this.output.position;
    await this.centralDirectory.close();
    const stream = await openCentralDirectoryStream();
    for await (const chunk of iterateReadableStreamChunks({ stream })) {
      await this.output.write({ chunk });
    }
    await this.output.write({
      chunk: createEndOfCentralDirectory({
        entryCount: this.entryCount,
        centralDirectorySize,
        centralDirectoryOffset,
      }),
    });
  }

  private assertWritable(): void {
    if (this.finalized) {
      throw new Error('ZIP writer is already finalized');
    }
  }

  private incrementEntryCount(): void {
    this.entryCount += 1;
    assertUint16({ value: this.entryCount, field: 'entry count' });
  }
}

export function createBlobZipSource({ blob }: { blob: Blob }): ZipRandomAccessSource {
  return {
    size: blob.size,
    async read({ offset, length }) {
      if (offset < 0 || length < 0 || offset + length > blob.size) {
        throw new Error('ZIP read range is outside the archive');
      }
      return new Uint8Array(await blob.slice(offset, offset + length).arrayBuffer());
    },
    async close() {},
  };
}

export async function createHandleZipSource({
  handle,
}: {
  handle: WeshFileHandle;
}): Promise<ZipRandomAccessSource> {
  const stat = await handle.stat();
  return {
    size: stat.size,
    async read({ offset, length }) {
      if (offset < 0 || length < 0 || offset + length > stat.size) {
        throw new Error('ZIP read range is outside the archive');
      }
      const output = new Uint8Array(length);
      let totalRead = 0;
      while (totalRead < length) {
        const { bytesRead } = await handle.read({
          buffer: output,
          offset: totalRead,
          length: length - totalRead,
          position: offset + totalRead,
        });
        if (bytesRead <= 0) {
          throw new Error('Unexpected end of ZIP archive');
        }
        totalRead += bytesRead;
      }
      return output;
    },
    async close() {
      await handle.close();
    },
  };
}

class BufferedZipSource {
  private buffer: Uint8Array<ArrayBufferLike> = new Uint8Array(0);
  private bufferOffset = 0;
  private readonly source: ZipRandomAccessSource;

  constructor({ source }: { source: ZipRandomAccessSource }) {
    this.source = source;
  }

  async read({ offset, length }: { offset: number; length: number }): Promise<Uint8Array> {
    if (length === 0) {
      return new Uint8Array(0);
    }
    const bufferEnd = this.bufferOffset + this.buffer.byteLength;
    if (offset >= this.bufferOffset && offset + length <= bufferEnd) {
      return this.buffer.subarray(offset - this.bufferOffset, offset - this.bufferOffset + length);
    }
    const readLength = Math.min(
      this.source.size - offset,
      Math.max(length, ZIP_IO_CHUNK_SIZE),
    );
    this.buffer = await this.source.read({ offset, length: readLength });
    this.bufferOffset = offset;
    if (length > this.buffer.byteLength) {
      throw new Error('Unexpected end of ZIP archive');
    }
    return this.buffer.subarray(0, length);
  }
}

async function findCentralDirectory({
  source,
}: {
  source: ZipRandomAccessSource;
}): Promise<ZipCentralDirectoryInfo> {
  if (source.size < ZIP_END_RECORD_MIN_SIZE) {
    throw new Error('End of central directory not found');
  }
  const tailLength = Math.min(source.size, ZIP_END_RECORD_MIN_SIZE + ZIP_MAX_COMMENT_SIZE);
  const tailOffset = source.size - tailLength;
  const tail = await source.read({ offset: tailOffset, length: tailLength });
  const view = new DataView(tail.buffer, tail.byteOffset, tail.byteLength);
  for (let offset = tail.byteLength - ZIP_END_RECORD_MIN_SIZE; offset >= 0; offset -= 1) {
    if (view.getUint32(offset, true) !== ZIP_END_OF_CENTRAL_DIRECTORY_SIGNATURE) {
      continue;
    }
    const commentLength = view.getUint16(offset + 20, true);
    if (offset + ZIP_END_RECORD_MIN_SIZE + commentLength !== tail.byteLength) {
      continue;
    }
    const diskNumber = view.getUint16(offset + 4, true);
    const centralDirectoryDisk = view.getUint16(offset + 6, true);
    const entriesOnDisk = view.getUint16(offset + 8, true);
    const entryCount = view.getUint16(offset + 10, true);
    if (diskNumber !== 0 || centralDirectoryDisk !== 0 || entriesOnDisk !== entryCount) {
      throw new Error('Multi-disk ZIP archives are not supported');
    }
    const size = view.getUint32(offset + 12, true);
    const centralOffset = view.getUint32(offset + 16, true);
    if (entryCount === ZIP_UINT16_MAX || size === ZIP_UINT32_MAX || centralOffset === ZIP_UINT32_MAX) {
      throw new Error('ZIP64 archives are not supported');
    }
    if (centralOffset + size > source.size) {
      throw new Error('Invalid ZIP central directory range');
    }
    return {
      entryCount,
      offset: centralOffset,
      size,
    };
  }
  throw new Error('End of central directory not found');
}

function createRangeStream({
  source,
  offset,
  length,
}: {
  source: ZipRandomAccessSource;
  offset: number;
  length: number;
}): ReadableStream<Uint8Array> {
  let currentOffset = offset;
  let remaining = length;
  return new ReadableStream({
    async pull(controller) {
      if (remaining === 0) {
        controller.close();
        return;
      }
      const chunkLength = Math.min(remaining, ZIP_IO_CHUNK_SIZE);
      const chunk = await source.read({ offset: currentOffset, length: chunkLength });
      if (chunk.byteLength === 0) {
        throw new Error('ZIP source returned an empty range before the requested data was complete');
      }
      if (chunk.byteLength > chunkLength) {
        throw new Error('ZIP source returned more data than requested');
      }
      currentOffset += chunk.byteLength;
      remaining -= chunk.byteLength;
      controller.enqueue(chunk);
    },
  });
}

export class StreamingZipReader {
  private readonly bufferedSource: BufferedZipSource;
  private centralDirectoryPromise: Promise<ZipCentralDirectoryInfo> | undefined;
  private readonly source: ZipRandomAccessSource;

  constructor({ source }: { source: ZipRandomAccessSource }) {
    this.source = source;
    this.bufferedSource = new BufferedZipSource({ source });
  }

  async *entries(): AsyncIterable<ZipArchiveEntry> {
    const central = await this.getCentralDirectory();
    let offset = central.offset;
    const endOffset = central.offset + central.size;
    for (let index = 0; index < central.entryCount; index += 1) {
      const fixed = await this.bufferedSource.read({ offset, length: 46 });
      const view = new DataView(fixed.buffer, fixed.byteOffset, fixed.byteLength);
      if (view.getUint32(0, true) !== ZIP_CENTRAL_DIRECTORY_HEADER_SIGNATURE) {
        throw new Error('Invalid ZIP central directory entry');
      }
      const flags = view.getUint16(8, true);
      if ((flags & 0x0001) !== 0) {
        throw new Error('Encrypted ZIP entries are not supported');
      }
      const method = view.getUint16(10, true);
      const modifiedTime = view.getUint16(12, true);
      const modifiedDate = view.getUint16(14, true);
      const crc32 = view.getUint32(16, true);
      const compressedSize = view.getUint32(20, true);
      const uncompressedSize = view.getUint32(24, true);
      const nameLength = view.getUint16(28, true);
      const extraLength = view.getUint16(30, true);
      const commentLength = view.getUint16(32, true);
      const diskStart = view.getUint16(34, true);
      const externalAttributes = view.getUint32(38, true);
      const localHeaderOffset = view.getUint32(42, true);
      const nameBytes = await this.bufferedSource.read({ offset: offset + 46, length: nameLength });
      const name = textDecoder.decode(nameBytes);
      if (diskStart !== 0) {
        throw new Error(`Multi-disk ZIP entry is not supported: ${name}`);
      }
      if (
        compressedSize === ZIP_UINT32_MAX
        || uncompressedSize === ZIP_UINT32_MAX
        || localHeaderOffset === ZIP_UINT32_MAX
      ) {
        throw new Error(`ZIP64 entry is not supported: ${name}`);
      }
      const isDirectory = name.endsWith('/') || (externalAttributes & 0x10) !== 0;
      yield {
        name,
        isDirectory,
        compression: compressionNumberToMethod({ method }),
        crc32,
        compressedSize,
        uncompressedSize,
        localHeaderOffset,
        modifiedAt: fromDosDateTime({ date: modifiedDate, time: modifiedTime }),
        flags,
      };
      offset += 46 + nameLength + extraLength + commentLength;
      if (offset > endOffset) {
        throw new Error('ZIP central directory entry exceeds directory bounds');
      }
    }
    if (offset !== endOffset) {
      throw new Error('ZIP central directory size mismatch');
    }
  }

  async openEntry({ entry }: { entry: ZipArchiveEntry }): Promise<ReadableStream<Uint8Array>> {
    if (entry.isDirectory) {
      return new ReadableStream({ start: controller => controller.close() });
    }
    const fixed = await this.bufferedSource.read({ offset: entry.localHeaderOffset, length: 30 });
    const view = new DataView(fixed.buffer, fixed.byteOffset, fixed.byteLength);
    if (view.getUint32(0, true) !== ZIP_LOCAL_FILE_HEADER_SIGNATURE) {
      throw new Error(`Invalid local ZIP header: ${entry.name}`);
    }
    const localFlags = view.getUint16(6, true);
    if ((localFlags & 0x0001) !== 0) {
      throw new Error(`Encrypted local ZIP entry is not supported: ${entry.name}`);
    }
    if (localFlags !== entry.flags) {
      throw new Error(`ZIP local flags mismatch: ${entry.name}`);
    }
    const localMethod = view.getUint16(8, true);
    const expectedMethod = compressionMethodToNumber({ compression: entry.compression });
    if (localMethod !== expectedMethod) {
      throw new Error(`ZIP local compression method mismatch: ${entry.name}`);
    }
    const nameLength = view.getUint16(26, true);
    const extraLength = view.getUint16(28, true);
    const localNameBytes = await this.bufferedSource.read({
      offset: entry.localHeaderOffset + 30,
      length: nameLength,
    });
    const localName = textDecoder.decode(localNameBytes);
    if (localName !== entry.name) {
      throw new Error(`ZIP local entry name mismatch: ${entry.name}`);
    }
    const dataOffset = entry.localHeaderOffset + 30 + nameLength + extraLength;
    if (dataOffset + entry.compressedSize > this.source.size) {
      throw new Error(`ZIP entry data exceeds archive bounds: ${entry.name}`);
    }
    const compressedStream = createRangeStream({
      source: this.source,
      offset: dataOffset,
      length: entry.compressedSize,
    });
    const decompressedStream = (() => {
      switch (entry.compression) {
      case 'store':
        return compressedStream;
      case 'deflate':
        return pipeThroughBufferSourceTransform({
          source: compressedStream,
          transform: new DecompressionStream('deflate-raw'),
        });
      default: {
        const _exhaustiveCheck: never = entry.compression;
        throw new Error(`Unhandled ZIP compression: ${String(_exhaustiveCheck)}`);
      }
      }
    })();
    return decompressedStream.pipeThrough(createValidationStream({ entry }));
  }

  async close(): Promise<void> {
    await this.source.close();
  }

  private getCentralDirectory(): Promise<ZipCentralDirectoryInfo> {
    this.centralDirectoryPromise ??= findCentralDirectory({ source: this.source });
    return this.centralDirectoryPromise;
  }
}

export async function copyStreamToHandle({
  stream,
  handle,
}: {
  stream: ReadableStream<Uint8Array>;
  handle: WeshFileHandle;
}): Promise<void> {
  await writeAllStreamToHandle({ stream, handle, closeHandle: false });
}

export async function writeBytesToHandle({
  bytes,
  handle,
}: {
  bytes: Uint8Array;
  handle: WeshFileHandle;
}): Promise<void> {
  await writeAllBytesToHandle({ handle, data: bytes });
}
