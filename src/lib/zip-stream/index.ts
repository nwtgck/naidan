/**
 * Environment-independent streaming ZIP core.
 *
 * DEPENDENCY DIRECTION — DO NOT WEAKEN THIS BOUNDARY
 * ==================================================
 *
 * This module must depend only on Web-standard primitives and other modules
 * inside `src/lib/zip-stream`. It must never import Wesh, worker clients,
 * application services, or Node.js filesystem APIs.
 *
 * The only allowed direction is:
 *
 *   ZIP core <- environment adapter <- application feature
 *
 * Never reverse it to:
 *
 *   ZIP core -> Wesh / worker / Node.js / import-export service
 *
 * Reversing this dependency can pull the complete Wesh implementation into
 * the main application bundle, including standalone builds, and can make ZIP
 * performance depend on unrelated filesystem abstractions. Add capabilities
 * through the interfaces below and implement them in an outer adapter instead.
 */

export interface ZipByteSink {
  /** Writes the complete chunk or rejects without reporting partial progress. */
  write({ chunk }: { chunk: Uint8Array }): Promise<void>,
}

export interface ZipCentralDirectoryStore extends ZipByteSink {
  finalize(): Promise<void>,
  openStream(): Promise<ReadableStream<Uint8Array>>,
  dispose(): Promise<void>,
}

export interface ZipCompressionCodec {
  compress({ source }: {
    source: ReadableStream<Uint8Array>,
  }): ReadableStream<Uint8Array>,
  decompress({ source }: {
    source: ReadableStream<Uint8Array>,
  }): ReadableStream<Uint8Array>,
}

export async function* iterateZipStreamChunks({
  stream,
}: {
  stream: ReadableStream<Uint8Array>,
}): AsyncIterable<Uint8Array> {
  const reader = stream.getReader();
  let completed = false;
  try {
    while (true) {
      const result = await reader.read();
      if (result.done) {
        completed = true;
        return;
      }
      yield result.value;
    }
  } finally {
    try {
      if (!completed) {
        await reader.cancel();
      }
    } finally {
      reader.releaseLock();
    }
  }
}

function pipeThroughBufferSourceTransform({
  source,
  transform,
}: {
  source: ReadableStream<Uint8Array>,
  transform: {
    readable: ReadableStream<Uint8Array>,
    writable: WritableStream<BufferSource>,
  },
}): ReadableStream<Uint8Array> {
  const byteTransform: ReadableWritablePair<Uint8Array, Uint8Array> = {
    readable: transform.readable,
    writable: transform.writable as unknown as WritableStream<Uint8Array>,
  };
  return source.pipeThrough(byteTransform);
}

export function createWebZipCompressionCodec(): ZipCompressionCodec {
  return {
    compress({ source }) {
      return pipeThroughBufferSourceTransform({
        source,
        transform: new CompressionStream('deflate-raw'),
      });
    },
    decompress({ source }) {
      return pipeThroughBufferSourceTransform({
        source,
        transform: new DecompressionStream('deflate-raw'),
      });
    },
  };
}

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
  readonly name: string,
  readonly isDirectory: boolean,
  readonly compression: ZipCompression,
  readonly crc32: number,
  readonly compressedSize: number,
  readonly uncompressedSize: number,
  readonly localHeaderOffset: number,
  readonly modifiedAt: Date,
  readonly flags: number,
}

export interface ZipRandomAccessSource {
  readonly size: number,
  /**
   * Returns exactly `length` bytes, or an empty chunk when `length` is zero.
   * Environment adapters must complete any low-level partial reads internally
   * so the ZIP core does not add copies or filesystem-specific retry behavior.
   */
  read({ offset, length }: { offset: number, length: number }): Promise<Uint8Array>,
  close(): Promise<void>,
}

interface ZipCentralDirectoryInfo {
  readonly entryCount: number,
  readonly offset: number,
  readonly size: number,
}

interface ZipEntryWriteResult {
  readonly crc32: number,
  readonly compressedSize: number,
  readonly uncompressedSize: number,
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

class CountingZipWriter {
  private readonly sink: ZipByteSink;
  position = 0;

  constructor({ sink }: { sink: ZipByteSink }) {
    this.sink = sink;
  }

  async write({ chunk }: { chunk: Uint8Array }): Promise<void> {
    await this.sink.write({ chunk });
    this.position += chunk.byteLength;
  }
}

function assertUint16({ value, field }: { value: number, field: string }): number {
  if (!Number.isInteger(value) || value < 0 || value > ZIP_UINT16_MAX) {
    throw new Error(`ZIP ${field} exceeds the non-ZIP64 limit`);
  }
  return value;
}

function assertUint32({ value, field }: { value: number, field: string }): number {
  if (!Number.isInteger(value) || value < 0 || value > ZIP_UINT32_MAX) {
    throw new Error(`ZIP ${field} exceeds the non-ZIP64 limit`);
  }
  return value;
}

function assertReadRange({
  size,
  offset,
  length,
}: {
  size: number,
  offset: number,
  length: number,
}): void {
  if (
    !Number.isSafeInteger(size)
    || size < 0
    || !Number.isSafeInteger(offset)
    || offset < 0
    || !Number.isSafeInteger(length)
    || length < 0
    || offset > size
    || length > size - offset
  ) {
    throw new Error('ZIP read range is outside the archive');
  }
}

async function readZipSourceRange({
  source,
  offset,
  length,
}: {
  source: ZipRandomAccessSource,
  offset: number,
  length: number,
}): Promise<Uint8Array> {
  assertReadRange({ size: source.size, offset, length });
  const chunk = await source.read({ offset, length });
  if (chunk.byteLength !== length) {
    throw new Error(`ZIP source returned ${chunk.byteLength} bytes for a ${length}-byte range`);
  }
  return chunk;
}

function createBytes({ size, write }: {
  size: number,
  write: ({ view }: { view: DataView }) => void,
}): Uint8Array {
  const bytes = new Uint8Array(size);
  write({ view: new DataView(bytes.buffer) });
  return bytes;
}

function getDosDateTime({ date }: { date: Date }): { date: number, time: number } {
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

function fromDosDateTime({ date, time }: { date: number, time: number }): Date {
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
  nameBytes: Uint8Array,
  flags: number,
  method: number,
  modifiedAt: Date,
  crc32: number,
  compressedSize: number,
  uncompressedSize: number,
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
  nameBytes: Uint8Array,
  flags: number,
  method: number,
  modifiedAt: Date,
  crc32: number,
  compressedSize: number,
  uncompressedSize: number,
  localHeaderOffset: number,
  isDirectory: boolean,
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
  entryCount: number,
  centralDirectorySize: number,
  centralDirectoryOffset: number,
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
    accumulator: Crc32Accumulator,
    uncompressedSize: number,
  },
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
  entry: ZipArchiveEntry,
}): TransformStream<Uint8Array, Uint8Array> {
  const accumulator = new Crc32Accumulator();
  let size = 0;
  return new TransformStream({
    transform(chunk, controller) {
      accumulator.update({ chunk });
      size += chunk.byteLength;
      if (size > entry.uncompressedSize) {
        throw new Error(`ZIP entry size mismatch: ${entry.name}`);
      }
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
  private readonly output: CountingZipWriter;
  private readonly centralDirectory: CountingZipWriter;
  private readonly centralDirectoryStore: ZipCentralDirectoryStore;
  private readonly compressionCodec: ZipCompressionCodec;
  private entryCount = 0;
  private finalized = false;

  constructor({
    output,
    centralDirectoryStore,
    compressionCodec,
  }: {
    output: ZipByteSink,
    centralDirectoryStore: ZipCentralDirectoryStore,
    compressionCodec: ZipCompressionCodec,
  }) {
    this.output = new CountingZipWriter({ sink: output });
    this.centralDirectory = new CountingZipWriter({ sink: centralDirectoryStore });
    this.centralDirectoryStore = centralDirectoryStore;
    this.compressionCodec = compressionCodec;
  }

  async addDirectory({
    name,
    modifiedAt,
  }: {
    name: string,
    modifiedAt: Date,
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
    name: string,
    modifiedAt: Date,
    compression: ZipCompression,
    stream: ReadableStream<Uint8Array>,
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
        return this.compressionCodec.compress({ source: trackedStream });
      default: {
        const _exhaustiveCheck: never = compression;
        throw new Error(`Unhandled ZIP compression: ${String(_exhaustiveCheck)}`);
      }
      }
    })();

    const dataStartOffset = this.output.position;
    for await (const chunk of iterateZipStreamChunks({ stream: dataStream })) {
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

  async finalize(): Promise<void> {
    this.assertWritable();
    this.finalized = true;
    const centralDirectorySize = this.centralDirectory.position;
    const centralDirectoryOffset = this.output.position;
    await this.centralDirectoryStore.finalize();
    const stream = await this.centralDirectoryStore.openStream();
    for await (const chunk of iterateZipStreamChunks({ stream })) {
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
      assertReadRange({ size: blob.size, offset, length });
      return new Uint8Array(await blob.slice(offset, offset + length).arrayBuffer());
    },
    async close() {},
  };
}

class BufferedZipSource {
  private buffer: Uint8Array<ArrayBufferLike> = new Uint8Array(0);
  private bufferOffset = 0;
  private readonly source: ZipRandomAccessSource;

  constructor({ source }: { source: ZipRandomAccessSource }) {
    this.source = source;
  }

  async read({ offset, length }: { offset: number, length: number }): Promise<Uint8Array> {
    assertReadRange({ size: this.source.size, offset, length });
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
    this.buffer = await readZipSourceRange({
      source: this.source,
      offset,
      length: readLength,
    });
    this.bufferOffset = offset;
    return this.buffer.subarray(0, length);
  }
}

async function findCentralDirectory({
  source,
}: {
  source: ZipRandomAccessSource,
}): Promise<ZipCentralDirectoryInfo> {
  if (source.size < ZIP_END_RECORD_MIN_SIZE) {
    throw new Error('End of central directory not found');
  }
  const tailLength = Math.min(source.size, ZIP_END_RECORD_MIN_SIZE + ZIP_MAX_COMMENT_SIZE);
  const tailOffset = source.size - tailLength;
  const tail = await readZipSourceRange({ source, offset: tailOffset, length: tailLength });
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
    const endRecordOffset = tailOffset + offset;
    if (centralOffset + size > endRecordOffset) {
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
  source: ZipRandomAccessSource,
  offset: number,
  length: number,
}): ReadableStream<Uint8Array> {
  assertReadRange({ size: source.size, offset, length });
  let currentOffset = offset;
  let remaining = length;
  return new ReadableStream({
    async pull(controller) {
      if (remaining === 0) {
        controller.close();
        return;
      }
      const chunkLength = Math.min(remaining, ZIP_IO_CHUNK_SIZE);
      const chunk = await readZipSourceRange({
        source,
        offset: currentOffset,
        length: chunkLength,
      });
      currentOffset += chunkLength;
      remaining -= chunkLength;
      controller.enqueue(chunk);
    },
  });
}

export class StreamingZipReader {
  private readonly bufferedSource: BufferedZipSource;
  private centralDirectoryPromise: Promise<ZipCentralDirectoryInfo> | undefined;
  private readonly source: ZipRandomAccessSource;
  private readonly compressionCodec: ZipCompressionCodec;

  constructor({
    source,
    compressionCodec,
  }: {
    source: ZipRandomAccessSource,
    compressionCodec: ZipCompressionCodec,
  }) {
    this.source = source;
    this.bufferedSource = new BufferedZipSource({ source });
    this.compressionCodec = compressionCodec;
  }

  async *entries(): AsyncIterable<ZipArchiveEntry> {
    const central = await this.getCentralDirectory();
    let offset = central.offset;
    const endOffset = central.offset + central.size;
    for (let index = 0; index < central.entryCount; index += 1) {
      if (offset + 46 > endOffset) {
        throw new Error('ZIP central directory entry exceeds directory bounds');
      }
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
      const nextOffset = offset + 46 + nameLength + extraLength + commentLength;
      if (nextOffset > endOffset) {
        throw new Error('ZIP central directory entry exceeds directory bounds');
      }
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
      offset = nextOffset;
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
    const central = await this.getCentralDirectory();
    const localHeaderEnd = entry.localHeaderOffset + 30 + nameLength + extraLength;
    if (entry.localHeaderOffset >= central.offset || localHeaderEnd > central.offset) {
      throw new Error(`ZIP local entry header exceeds file-data bounds: ${entry.name}`);
    }
    const localNameBytes = await this.bufferedSource.read({
      offset: entry.localHeaderOffset + 30,
      length: nameLength,
    });
    const localName = textDecoder.decode(localNameBytes);
    if (localName !== entry.name) {
      throw new Error(`ZIP local entry name mismatch: ${entry.name}`);
    }
    if ((localFlags & ZIP_GENERAL_PURPOSE_DATA_DESCRIPTOR_FLAG) === 0) {
      const localCrc32 = view.getUint32(14, true);
      const localCompressedSize = view.getUint32(18, true);
      const localUncompressedSize = view.getUint32(22, true);
      if (
        localCrc32 !== entry.crc32
        || localCompressedSize !== entry.compressedSize
        || localUncompressedSize !== entry.uncompressedSize
      ) {
        throw new Error(`ZIP local entry metadata mismatch: ${entry.name}`);
      }
    }
    const dataOffset = localHeaderEnd;
    if (dataOffset + entry.compressedSize > central.offset) {
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
        return this.compressionCodec.decompress({ source: compressedStream });
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

