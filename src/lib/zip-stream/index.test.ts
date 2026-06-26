import { describe, expect, it } from 'vitest';
import JSZip from 'jszip';
import {
  StreamingZipReader,
  StreamingZipWriter,
  createBlobZipSource,
  type ZipArchiveEntry,
  type ZipRandomAccessSource,
  createWebZipCompressionCodec,
  type ZipByteSink,
  type ZipCentralDirectoryStore,
} from './index';

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

const compressionCodec = createWebZipCompressionCodec();

interface TestZipCapture {
  readonly handle: ZipCentralDirectoryStore & {
    close(): Promise<void>,
  },
  readonly buffer: Uint8Array,
  readonly chunkCount: number,
}

function concatenateChunks({ chunks }: { chunks: readonly Uint8Array[] }): Uint8Array {
  const size = chunks.reduce((total, chunk) => total + chunk.byteLength, 0);
  const output = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output;
}

function createTestWriteCaptureHandle(): TestZipCapture {
  let chunks: Uint8Array[] = [];
  let finalized = false;
  const handle: TestZipCapture['handle'] = {
    async write({ chunk }) {
      if (finalized) {
        throw new Error('Test ZIP capture is finalized');
      }
      chunks.push(chunk);
    },
    async finalize() {
      finalized = true;
    },
    async openStream() {
      const captured = chunks;
      let index = 0;
      return new ReadableStream<Uint8Array>({
        pull(controller) {
          const chunk = captured[index];
          if (chunk === undefined) {
            controller.close();
            return;
          }
          index += 1;
          controller.enqueue(chunk);
        },
      });
    },
    async dispose() {
      finalized = true;
      chunks = [];
    },
    async close() {
      finalized = true;
    },
  };
  return {
    handle,
    get buffer() {
      return concatenateChunks({ chunks });
    },
    get chunkCount() {
      return chunks.length;
    },
  };
}

function createTestStreamingZipWriter({
  outputHandle,
  centralDirectoryHandle,
}: {
  outputHandle: ZipByteSink,
  centralDirectoryHandle: ZipCentralDirectoryStore,
}): StreamingZipWriter {
  return new StreamingZipWriter({
    output: outputHandle,
    centralDirectoryStore: centralDirectoryHandle,
    compressionCodec,
  });
}

class TestStreamingZipReader extends StreamingZipReader {
  constructor({ source }: { source: ZipRandomAccessSource }) {
    super({ source, compressionCodec });
  }
}

function createByteStream({
  chunks,
}: {
  chunks: readonly Uint8Array[],
}): ReadableStream<Uint8Array> {
  let index = 0;
  return new ReadableStream({
    pull(controller) {
      const chunk = chunks[index];
      if (chunk === undefined) {
        controller.close();
        return;
      }
      index += 1;
      controller.enqueue(chunk);
    },
  });
}

function createBlobFromBytes({ bytes }: { bytes: Uint8Array }): Blob {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return new Blob([copy.buffer]);
}

async function readStreamBytes({
  stream,
}: {
  stream: ReadableStream<Uint8Array>,
}): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  let totalLength = 0;
  const reader = stream.getReader();
  try {
    while (true) {
      const result = await reader.read();
      if (result.done) {
        break;
      }
      chunks.push(result.value);
      totalLength += result.value.byteLength;
    }
  } finally {
    reader.releaseLock();
  }

  const output = new Uint8Array(totalLength);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output;
}

async function collectEntries({
  reader,
}: {
  reader: StreamingZipReader,
}): Promise<ZipArchiveEntry[]> {
  const entries: ZipArchiveEntry[] = [];
  for await (const entry of reader.entries()) {
    entries.push(entry);
  }
  return entries;
}

function findEntry({
  entries,
  name,
}: {
  entries: readonly ZipArchiveEntry[],
  name: string,
}): ZipArchiveEntry {
  const entry = entries.find(candidate => candidate.name === name);
  if (entry === undefined) {
    throw new Error(`ZIP entry not found in test: ${name}`);
  }
  return entry;
}

function createDeterministicBytes({ size }: { size: number }): Uint8Array {
  const bytes = new Uint8Array(size);
  let state = 0x12345678;
  for (let index = 0; index < bytes.byteLength; index += 1) {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
    bytes[index] = state >>> 24;
  }
  return bytes;
}

function corruptFirstStoredEntryData({
  archive,
}: {
  archive: Uint8Array,
}): Uint8Array {
  const output = archive.slice();
  const view = new DataView(output.buffer, output.byteOffset, output.byteLength);
  expect(view.getUint32(0, true)).toBe(0x04034b50);
  expect(view.getUint16(8, true)).toBe(0);
  const nameLength = view.getUint16(26, true);
  const extraLength = view.getUint16(28, true);
  const dataOffset = 30 + nameLength + extraLength;
  const original = output[dataOffset];
  if (original === undefined) {
    throw new Error('Stored ZIP entry has no data to corrupt');
  }
  output[dataOffset] = original ^ 0xff;
  return output;
}


function findZipSignature({
  bytes,
  signature,
}: {
  bytes: Uint8Array,
  signature: number,
}): number {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (let offset = 0; offset <= bytes.byteLength - 4; offset += 1) {
    if (view.getUint32(offset, true) === signature) {
      return offset;
    }
  }
  throw new Error(`ZIP signature not found in test: ${signature.toString(16)}`);
}

async function createStoredJsZipArchive(): Promise<Uint8Array> {
  const archive = new JSZip();
  archive.file('payload.txt', 'correct payload', { compression: 'STORE' });
  return archive.generateAsync({ type: 'uint8array', compression: 'STORE' });
}

describe('streaming ZIP codec', () => {
  it('writes store and deflate entries that JSZip can read', async () => {
    const output = createTestWriteCaptureHandle();
    const centralDirectory = createTestWriteCaptureHandle();
    const writer = createTestStreamingZipWriter({
      outputHandle: output.handle,
      centralDirectoryHandle: centralDirectory.handle,
    });
    const modifiedAt = new Date(2024, 0, 2, 3, 4, 6);
    const repeatedChunks = Array.from(
      { length: 64 },
      (_, index) => textEncoder.encode(`chunk-${String(index).padStart(3, '0')}:`.repeat(32)),
    );
    const streamedChunks = Array.from(
      { length: 64 },
      (_, index) => Uint8Array.from(
        { length: 1024 },
        (__, byteIndex) => (index + byteIndex) & 0xff,
      ),
    );
    const binary = Uint8Array.from({ length: 256 }, (_, index) => index);

    await writer.addDirectory({ name: 'symbols-∞-∑-𝄞-🧪', modifiedAt });
    await writer.addFile({
      name: 'symbols-∞-∑-𝄞-🧪/empty.txt',
      modifiedAt,
      compression: 'store',
      stream: createByteStream({ chunks: [] }),
    });
    await writer.addFile({
      name: 'symbols-∞-∑-𝄞-🧪/repeated.txt',
      modifiedAt,
      compression: 'deflate',
      stream: createByteStream({ chunks: repeatedChunks }),
    });
    await writer.addFile({
      name: 'streamed.bin',
      modifiedAt,
      compression: 'store',
      stream: createByteStream({ chunks: streamedChunks }),
    });
    await writer.addFile({
      name: 'binary.bin',
      modifiedAt,
      compression: 'store',
      stream: createByteStream({ chunks: [binary] }),
    });
    await writer.finalize();
    await output.handle.close();

    const archive = await JSZip.loadAsync(output.buffer);
    expect(archive.folder('symbols-∞-∑-𝄞-🧪')).not.toBeNull();
    expect(await archive.file('symbols-∞-∑-𝄞-🧪/empty.txt')?.async('uint8array')).toEqual(new Uint8Array(0));
    expect(await archive.file('symbols-∞-∑-𝄞-🧪/repeated.txt')?.async('string')).toBe(
      repeatedChunks.map(chunk => textDecoder.decode(chunk)).join(''),
    );
    expect(await archive.file('streamed.bin')?.async('uint8array')).toEqual(
      await readStreamBytes({ stream: createByteStream({ chunks: streamedChunks }) }),
    );
    expect(await archive.file('binary.bin')?.async('uint8array')).toEqual(binary);
    expect(output.chunkCount).toBeGreaterThan(streamedChunks.length);
  });

  it('reads JSZip store, deflate, UTF-8, directory, and empty entries', async () => {
    const archive = new JSZip();
    archive.folder('symbols-∞-∑-𝄞-🧪');
    archive.file('symbols-∞-∑-𝄞-🧪/stored.txt', 'stored payload', { compression: 'STORE' });
    archive.file('symbols-∞-∑-𝄞-🧪/deflated.txt', 'deflated payload '.repeat(256), { compression: 'DEFLATE' });
    archive.file('symbols-∞-∑-𝄞-🧪/empty.bin', new Uint8Array(0), { compression: 'STORE' });
    const archiveBytes = await archive.generateAsync({
      type: 'uint8array',
      compression: 'DEFLATE',
      comment: 'archive-comment-🛰️-PK\u0005\u0006-∞',
    });
    const reader = new TestStreamingZipReader({
      source: createBlobZipSource({ blob: createBlobFromBytes({ bytes: archiveBytes }) }),
    });

    try {
      const entries = await collectEntries({ reader });
      expect(entries.map(entry => entry.name)).toEqual([
        'symbols-∞-∑-𝄞-🧪/',
        'symbols-∞-∑-𝄞-🧪/stored.txt',
        'symbols-∞-∑-𝄞-🧪/deflated.txt',
        'symbols-∞-∑-𝄞-🧪/empty.bin',
      ]);
      expect(findEntry({ entries, name: 'symbols-∞-∑-𝄞-🧪/' }).isDirectory).toBe(true);
      expect(textDecoder.decode(await readStreamBytes({
        stream: await reader.openEntry({ entry: findEntry({ entries, name: 'symbols-∞-∑-𝄞-🧪/stored.txt' }) }),
      }))).toBe('stored payload');
      expect(textDecoder.decode(await readStreamBytes({
        stream: await reader.openEntry({ entry: findEntry({ entries, name: 'symbols-∞-∑-𝄞-🧪/deflated.txt' }) }),
      }))).toBe('deflated payload '.repeat(256));
      expect(await readStreamBytes({
        stream: await reader.openEntry({ entry: findEntry({ entries, name: 'symbols-∞-∑-𝄞-🧪/empty.bin' }) }),
      })).toEqual(new Uint8Array(0));
    } finally {
      await reader.close();
    }
  });


  it('round-trips exact Unicode names and byte-split multibyte payloads through JSZip', async () => {
    const output = createTestWriteCaptureHandle();
    const centralDirectory = createTestWriteCaptureHandle();
    const writer = createTestStreamingZipWriter({
      outputHandle: output.handle,
      centralDirectoryHandle: centralDirectory.handle,
    });
    const modifiedAt = new Date(2025, 4, 6, 7, 8, 10);
    const directory = 'symbols-∞-∑-𝄞-🧪';
    const names = [
      `${directory}/emoji-🚀-👩🏽‍💻-🏳️‍🌈.txt`,
      `${directory}/combining-e\u0301-✈️.txt`,
      `${directory}/precomposed-é-🜁.txt`,
    ] as const;
    const payloadText = '🧪🚀👩🏽‍💻🏳️‍🌈 ∞ ∑ 𝄞 e\u0301 é ✈️\n';
    const payload = textEncoder.encode(payloadText);
    const byteChunks = Array.from(payload, byte => Uint8Array.of(byte));

    await writer.addDirectory({ name: directory, modifiedAt });
    for (const name of names) {
      await writer.addFile({
        name,
        modifiedAt,
        compression: 'deflate',
        stream: createByteStream({ chunks: byteChunks }),
      });
    }
    await writer.finalize();
    await output.handle.close();

    const archive = await JSZip.loadAsync(output.buffer);
    expect(Object.keys(archive.files)).toEqual([
      `${directory}/`,
      ...names,
    ]);
    for (const name of names) {
      expect(await archive.file(name)?.async('string')).toBe(payloadText);
    }
  });

  it('preserves distinct NFC and NFD names from JSZip without normalization', async () => {
    const archive = new JSZip();
    const nfcName = 'unicode/precomposed-é-🧬.txt';
    const nfdName = 'unicode/combining-e\u0301-🧬.txt';
    archive.file(nfcName, 'NFC payload 🧪', { compression: 'DEFLATE' });
    archive.file(nfdName, 'NFD payload 🚀', { compression: 'STORE' });
    const archiveBytes = await archive.generateAsync({
      type: 'uint8array',
      compression: 'DEFLATE',
    });
    const reader = new TestStreamingZipReader({
      source: createBlobZipSource({ blob: createBlobFromBytes({ bytes: archiveBytes }) }),
    });

    try {
      const entries = await collectEntries({ reader });
      expect(entries.map(entry => entry.name)).toEqual(['unicode/', nfcName, nfdName]);
      expect(textDecoder.decode(await readStreamBytes({
        stream: await reader.openEntry({ entry: findEntry({ entries, name: nfdName }) }),
      }))).toBe('NFD payload 🚀');
      expect(textDecoder.decode(await readStreamBytes({
        stream: await reader.openEntry({ entry: findEntry({ entries, name: nfcName }) }),
      }))).toBe('NFC payload 🧪');
      expect(textDecoder.decode(await readStreamBytes({
        stream: await reader.openEntry({ entry: findEntry({ entries, name: nfcName }) }),
      }))).toBe('NFC payload 🧪');
    } finally {
      await reader.close();
    }
  });

  it('sets UTF-8 and data-descriptor flags in local and central headers', async () => {
    const output = createTestWriteCaptureHandle();
    const centralDirectory = createTestWriteCaptureHandle();
    const writer = createTestStreamingZipWriter({
      outputHandle: output.handle,
      centralDirectoryHandle: centralDirectory.handle,
    });
    await writer.addFile({
      name: 'emoji-🧪-𝄞.txt',
      modifiedAt: new Date(2025, 0, 1, 0, 0, 0),
      compression: 'deflate',
      stream: createByteStream({ chunks: [textEncoder.encode('payload 🚀')] }),
    });
    await writer.finalize();
    await output.handle.close();

    const localView = new DataView(output.buffer.buffer, output.buffer.byteOffset, output.buffer.byteLength);
    const localFlags = localView.getUint16(6, true);
    const centralView = new DataView(
      centralDirectory.buffer.buffer,
      centralDirectory.buffer.byteOffset,
      centralDirectory.buffer.byteLength,
    );
    const centralFlags = centralView.getUint16(8, true);
    expect(localFlags & 0x0800).toBe(0x0800);
    expect(localFlags & 0x0008).toBe(0x0008);
    expect(centralFlags & 0x0800).toBe(0x0800);
    expect(centralFlags & 0x0008).toBe(0x0008);
  });

  it('rejects encrypted, unsupported-compression, multi-disk, and ZIP64 markers', async () => {
    const createArchive = async (): Promise<Uint8Array> => {
      const archive = new JSZip();
      archive.file('payload.txt', 'payload', { compression: 'STORE' });
      return archive.generateAsync({ type: 'uint8array', compression: 'STORE' });
    };
    const findSignature = ({ bytes, signature }: { bytes: Uint8Array, signature: number }): number => {
      const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      for (let offset = 0; offset <= bytes.byteLength - 4; offset += 1) {
        if (view.getUint32(offset, true) === signature) {
          return offset;
        }
      }
      throw new Error(`ZIP signature not found in test: ${signature.toString(16)}`);
    };
    const expectEntryFailure = async ({
      bytes,
      message,
    }: {
      bytes: Uint8Array,
      message: string,
    }): Promise<void> => {
      const reader = new TestStreamingZipReader({
        source: createBlobZipSource({ blob: createBlobFromBytes({ bytes }) }),
      });
      try {
        await expect(collectEntries({ reader })).rejects.toThrow(message);
      } finally {
        await reader.close();
      }
    };

    const encrypted = (await createArchive()).slice();
    const encryptedCentralOffset = findSignature({ bytes: encrypted, signature: 0x02014b50 });
    new DataView(encrypted.buffer).setUint16(encryptedCentralOffset + 8, 0x0001, true);
    await expectEntryFailure({ bytes: encrypted, message: 'Encrypted ZIP entries are not supported' });

    const unsupported = (await createArchive()).slice();
    const unsupportedCentralOffset = findSignature({ bytes: unsupported, signature: 0x02014b50 });
    new DataView(unsupported.buffer).setUint16(unsupportedCentralOffset + 10, 99, true);
    await expectEntryFailure({ bytes: unsupported, message: 'Unsupported ZIP compression method: 99' });

    const multiDisk = (await createArchive()).slice();
    const multiDiskEndOffset = findSignature({ bytes: multiDisk, signature: 0x06054b50 });
    new DataView(multiDisk.buffer).setUint16(multiDiskEndOffset + 4, 1, true);
    await expectEntryFailure({ bytes: multiDisk, message: 'Multi-disk ZIP archives are not supported' });

    const zip64 = (await createArchive()).slice();
    const zip64EndOffset = findSignature({ bytes: zip64, signature: 0x06054b50 });
    const zip64View = new DataView(zip64.buffer);
    zip64View.setUint16(zip64EndOffset + 8, 0xffff, true);
    zip64View.setUint16(zip64EndOffset + 10, 0xffff, true);
    await expectEntryFailure({ bytes: zip64, message: 'ZIP64 archives are not supported' });
  });

  it('rejects an invalid central-directory range and invalid local header', async () => {
    const archive = new JSZip();
    archive.file('payload.txt', 'payload', { compression: 'STORE' });
    const original = await archive.generateAsync({ type: 'uint8array', compression: 'STORE' });
    const findSignature = ({ bytes, signature }: { bytes: Uint8Array, signature: number }): number => {
      const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      for (let offset = 0; offset <= bytes.byteLength - 4; offset += 1) {
        if (view.getUint32(offset, true) === signature) {
          return offset;
        }
      }
      throw new Error(`ZIP signature not found in test: ${signature.toString(16)}`);
    };

    const invalidRange = original.slice();
    const endOffset = findSignature({ bytes: invalidRange, signature: 0x06054b50 });
    new DataView(invalidRange.buffer).setUint32(endOffset + 16, invalidRange.byteLength, true);
    const invalidRangeReader = new TestStreamingZipReader({
      source: createBlobZipSource({ blob: createBlobFromBytes({ bytes: invalidRange }) }),
    });
    try {
      await expect(collectEntries({ reader: invalidRangeReader })).rejects.toThrow(
        'Invalid ZIP central directory range',
      );
    } finally {
      await invalidRangeReader.close();
    }

    const invalidLocal = original.slice();
    new DataView(invalidLocal.buffer).setUint32(0, 0, true);
    const invalidLocalReader = new TestStreamingZipReader({
      source: createBlobZipSource({ blob: createBlobFromBytes({ bytes: invalidLocal }) }),
    });
    try {
      const entries = await collectEntries({ reader: invalidLocalReader });
      await expect(invalidLocalReader.openEntry({
        entry: findEntry({ entries, name: 'payload.txt' }),
      })).rejects.toThrow('Invalid local ZIP header: payload.txt');
    } finally {
      await invalidLocalReader.close();
    }
  });


  it('rejects local-header name, compression, encryption, and data-range mismatches', async () => {
    const expectOpenFailure = async ({
      bytes,
      message,
    }: {
      bytes: Uint8Array,
      message: string,
    }): Promise<void> => {
      const reader = new TestStreamingZipReader({
        source: createBlobZipSource({ blob: createBlobFromBytes({ bytes }) }),
      });
      try {
        const entries = await collectEntries({ reader });
        await expect(reader.openEntry({
          entry: findEntry({ entries, name: 'payload.txt' }),
        })).rejects.toThrow(message);
      } finally {
        await reader.close();
      }
    };

    const nameMismatch = (await createStoredJsZipArchive()).slice();
    nameMismatch.set(textEncoder.encode('wrong__.txt'), 30);
    await expectOpenFailure({
      bytes: nameMismatch,
      message: 'ZIP local entry name mismatch: payload.txt',
    });

    const methodMismatch = (await createStoredJsZipArchive()).slice();
    new DataView(methodMismatch.buffer).setUint16(8, 8, true);
    await expectOpenFailure({
      bytes: methodMismatch,
      message: 'ZIP local compression method mismatch: payload.txt',
    });

    const localMetadataMismatch = (await createStoredJsZipArchive()).slice();
    const localMetadataView = new DataView(localMetadataMismatch.buffer);
    localMetadataView.setUint32(14, localMetadataView.getUint32(14, true) ^ 0xffffffff, true);
    await expectOpenFailure({
      bytes: localMetadataMismatch,
      message: 'ZIP local entry metadata mismatch: payload.txt',
    });

    const localEncryption = (await createStoredJsZipArchive()).slice();
    new DataView(localEncryption.buffer).setUint16(6, 0x0001, true);
    await expectOpenFailure({
      bytes: localEncryption,
      message: 'Encrypted local ZIP entry is not supported: payload.txt',
    });

    const outOfBounds = (await createStoredJsZipArchive()).slice();
    const centralOffset = findZipSignature({ bytes: outOfBounds, signature: 0x02014b50 });
    const outOfBoundsView = new DataView(outOfBounds.buffer);
    outOfBoundsView.setUint32(centralOffset + 20, outOfBounds.byteLength, true);
    outOfBoundsView.setUint32(18, outOfBounds.byteLength, true);
    await expectOpenFailure({
      bytes: outOfBounds,
      message: 'ZIP entry data exceeds archive bounds: payload.txt',
    });
  });

  it('rejects central-directory size leftovers, per-entry ZIP64, and nonzero disk starts', async () => {
    const expectEntriesFailure = async ({
      bytes,
      message,
    }: {
      bytes: Uint8Array,
      message: string,
    }): Promise<void> => {
      const reader = new TestStreamingZipReader({
        source: createBlobZipSource({ blob: createBlobFromBytes({ bytes }) }),
      });
      try {
        await expect(collectEntries({ reader })).rejects.toThrow(message);
      } finally {
        await reader.close();
      }
    };

    const sizeMismatch = (await createStoredJsZipArchive()).slice();
    const sizeMismatchView = new DataView(sizeMismatch.buffer);
    const sizeMismatchEndOffset = findZipSignature({ bytes: sizeMismatch, signature: 0x06054b50 });
    sizeMismatchView.setUint16(sizeMismatchEndOffset + 8, 0, true);
    sizeMismatchView.setUint16(sizeMismatchEndOffset + 10, 0, true);
    await expectEntriesFailure({
      bytes: sizeMismatch,
      message: 'ZIP central directory size mismatch',
    });

    const variableLengthOverflow = (await createStoredJsZipArchive()).slice();
    const variableLengthEndOffset = findZipSignature({
      bytes: variableLengthOverflow,
      signature: 0x06054b50,
    });
    new DataView(variableLengthOverflow.buffer).setUint32(variableLengthEndOffset + 12, 46, true);
    await expectEntriesFailure({
      bytes: variableLengthOverflow,
      message: 'ZIP central directory entry exceeds directory bounds',
    });

    const overlapsEndRecord = (await createStoredJsZipArchive()).slice();
    const overlapsEndOffset = findZipSignature({ bytes: overlapsEndRecord, signature: 0x06054b50 });
    const overlapsView = new DataView(overlapsEndRecord.buffer);
    overlapsView.setUint32(overlapsEndOffset + 12, 8, true);
    overlapsView.setUint32(overlapsEndOffset + 16, overlapsEndOffset - 4, true);
    await expectEntriesFailure({
      bytes: overlapsEndRecord,
      message: 'Invalid ZIP central directory range',
    });

    const zip64Entry = (await createStoredJsZipArchive()).slice();
    const zip64CentralOffset = findZipSignature({ bytes: zip64Entry, signature: 0x02014b50 });
    new DataView(zip64Entry.buffer).setUint32(zip64CentralOffset + 20, 0xffffffff, true);
    await expectEntriesFailure({
      bytes: zip64Entry,
      message: 'ZIP64 entry is not supported: payload.txt',
    });

    const diskEntry = (await createStoredJsZipArchive()).slice();
    const diskCentralOffset = findZipSignature({ bytes: diskEntry, signature: 0x02014b50 });
    new DataView(diskEntry.buffer).setUint16(diskCentralOffset + 34, 1, true);
    await expectEntriesFailure({
      bytes: diskEntry,
      message: 'Multi-disk ZIP entry is not supported: payload.txt',
    });
  });

  it('rejects local and central flag mismatches', async () => {
    const archiveBytes = (await createStoredJsZipArchive()).slice();
    new DataView(archiveBytes.buffer).setUint16(6, 0x0008, true);
    const reader = new TestStreamingZipReader({
      source: createBlobZipSource({ blob: createBlobFromBytes({ bytes: archiveBytes }) }),
    });
    try {
      const entries = await collectEntries({ reader });
      await expect(reader.openEntry({
        entry: findEntry({ entries, name: 'payload.txt' }),
      })).rejects.toThrow('ZIP local flags mismatch: payload.txt');
    } finally {
      await reader.close();
    }
  });

  it('rejects a central-directory uncompressed-size mismatch after streaming data', async () => {
    const archiveBytes = (await createStoredJsZipArchive()).slice();
    const centralOffset = findZipSignature({ bytes: archiveBytes, signature: 0x02014b50 });
    const view = new DataView(archiveBytes.buffer);
    const declaredSize = view.getUint32(centralOffset + 24, true) + 1;
    view.setUint32(centralOffset + 24, declaredSize, true);
    view.setUint32(22, declaredSize, true);
    const reader = new TestStreamingZipReader({
      source: createBlobZipSource({ blob: createBlobFromBytes({ bytes: archiveBytes }) }),
    });

    try {
      const entries = await collectEntries({ reader });
      await expect(readStreamBytes({
        stream: await reader.openEntry({ entry: findEntry({ entries, name: 'payload.txt' }) }),
      })).rejects.toThrow('ZIP entry size mismatch: payload.txt');
    } finally {
      await reader.close();
    }
  });

  it('rejects oversized uncompressed output before exposing the invalid chunk', async () => {
    const archiveBytes = (await createStoredJsZipArchive()).slice();
    const centralOffset = findZipSignature({ bytes: archiveBytes, signature: 0x02014b50 });
    const view = new DataView(archiveBytes.buffer);
    const declaredSize = view.getUint32(centralOffset + 24, true) - 1;
    view.setUint32(centralOffset + 24, declaredSize, true);
    view.setUint32(22, declaredSize, true);
    const reader = new TestStreamingZipReader({
      source: createBlobZipSource({ blob: createBlobFromBytes({ bytes: archiveBytes }) }),
    });

    try {
      const entries = await collectEntries({ reader });
      const stream = await reader.openEntry({ entry: findEntry({ entries, name: 'payload.txt' }) });
      const streamReader = stream.getReader();
      try {
        await expect(streamReader.read()).rejects.toThrow('ZIP entry size mismatch: payload.txt');
      } finally {
        streamReader.releaseLock();
      }
    } finally {
      await reader.close();
    }
  });

  it('rejects writer operations after finalization and overlong entry names', async () => {
    const output = createTestWriteCaptureHandle();
    const centralDirectory = createTestWriteCaptureHandle();
    const writer = createTestStreamingZipWriter({
      outputHandle: output.handle,
      centralDirectoryHandle: centralDirectory.handle,
    });
    await writer.finalize();
    await expect(writer.addDirectory({
      name: 'after-finalize',
      modifiedAt: new Date(2025, 0, 1),
    })).rejects.toThrow('ZIP writer is already finalized');
    await expect(writer.finalize()).rejects.toThrow('ZIP writer is already finalized');
    await output.handle.close();

    const longOutput = createTestWriteCaptureHandle();
    const longCentralDirectory = createTestWriteCaptureHandle();
    const longNameWriter = createTestStreamingZipWriter({
      outputHandle: longOutput.handle,
      centralDirectoryHandle: longCentralDirectory.handle,
    });
    await expect(longNameWriter.addFile({
      name: 'a'.repeat(0x10000),
      modifiedAt: new Date(2025, 0, 1),
      compression: 'store',
      stream: createByteStream({ chunks: [] }),
    })).rejects.toThrow('ZIP entry name length exceeds the non-ZIP64 limit');
    await longOutput.handle.close();
    await longCentralDirectory.handle.close();
  });

  it('uses bounded range reads for a large deflated entry', async () => {
    const payload = createDeterministicBytes({ size: 512 * 1024 + 19 });
    const archive = new JSZip();
    archive.file('large-deflated.bin', payload, { compression: 'DEFLATE' });
    const archiveBytes = await archive.generateAsync({
      type: 'uint8array',
      compression: 'DEFLATE',
      compressionOptions: { level: 1 },
    });
    const blobSource = createBlobZipSource({ blob: createBlobFromBytes({ bytes: archiveBytes }) });
    const reads: { offset: number, length: number }[] = [];
    const trackedSource: ZipRandomAccessSource = {
      size: blobSource.size,
      async read({ offset, length }) {
        reads.push({ offset, length });
        return blobSource.read({ offset, length });
      },
      async close() {
        await blobSource.close();
      },
    };
    const reader = new TestStreamingZipReader({ source: trackedSource });

    try {
      const entries = await collectEntries({ reader });
      const extracted = await readStreamBytes({
        stream: await reader.openEntry({ entry: findEntry({ entries, name: 'large-deflated.bin' }) }),
      });
      expect(extracted).toEqual(payload);
      expect(reads.length).toBeGreaterThan(5);
      expect(Math.max(...reads.map(read => read.length))).toBeLessThanOrEqual(66 * 1024);
      expect(reads.some(read => read.length === trackedSource.size)).toBe(false);
    } finally {
      await reader.close();
    }
  });

  it('uses bounded range reads for a large stored entry', async () => {
    const payload = createDeterministicBytes({ size: 384 * 1024 + 37 });
    const archive = new JSZip();
    archive.file('large.bin', payload, { compression: 'STORE' });
    const archiveBytes = await archive.generateAsync({
      type: 'uint8array',
      compression: 'STORE',
      comment: 'prefix PK\x05\x06 suffix',
    });
    const blobSource = createBlobZipSource({ blob: createBlobFromBytes({ bytes: archiveBytes }) });
    const reads: { offset: number, length: number }[] = [];
    let closed = false;
    const trackedSource: ZipRandomAccessSource = {
      size: blobSource.size,
      async read({ offset, length }) {
        reads.push({ offset, length });
        return blobSource.read({ offset, length });
      },
      async close() {
        closed = true;
        await blobSource.close();
      },
    };
    const reader = new TestStreamingZipReader({ source: trackedSource });

    const entries = await collectEntries({ reader });
    const extracted = await readStreamBytes({
      stream: await reader.openEntry({ entry: findEntry({ entries, name: 'large.bin' }) }),
    });
    await reader.close();

    expect(extracted).toEqual(payload);
    expect(reads.length).toBeGreaterThan(5);
    expect(Math.max(...reads.map(read => read.length))).toBeLessThanOrEqual(66 * 1024);
    expect(reads.some(read => read.length === trackedSource.size)).toBe(false);
    expect(closed).toBe(true);
  });

  it('rejects a random-access source that makes no progress while streaming entry data', async () => {
    const payload = createDeterministicBytes({ size: 128 * 1024 });
    const archive = new JSZip();
    archive.file('stalled.bin', payload, { compression: 'STORE' });
    const archiveBytes = await archive.generateAsync({
      type: 'uint8array',
      compression: 'STORE',
    });
    const archiveView = new DataView(archiveBytes.buffer, archiveBytes.byteOffset, archiveBytes.byteLength);
    const stalledDataOffset = 30 + archiveView.getUint16(26, true) + archiveView.getUint16(28, true);
    const blobSource = createBlobZipSource({ blob: createBlobFromBytes({ bytes: archiveBytes }) });
    let stallEntryData = false;
    const source: ZipRandomAccessSource = {
      size: blobSource.size,
      async read({ offset, length }) {
        if (stallEntryData && offset === stalledDataOffset) {
          return new Uint8Array(0);
        }
        return blobSource.read({ offset, length });
      },
      async close() {
        await blobSource.close();
      },
    };
    const reader = new TestStreamingZipReader({ source });

    try {
      const entries = await collectEntries({ reader });
      stallEntryData = true;
      await expect(readStreamBytes({
        stream: await reader.openEntry({ entry: findEntry({ entries, name: 'stalled.bin' }) }),
      })).rejects.toThrow('ZIP source returned 0 bytes for a 65536-byte range');
    } finally {
      await reader.close();
    }
  });

  it('rejects an entry whose uncompressed data does not match its CRC', async () => {
    const archive = new JSZip();
    archive.file('payload.txt', 'correct payload', { compression: 'STORE' });
    const archiveBytes = await archive.generateAsync({
      type: 'uint8array',
      compression: 'STORE',
    });
    const corrupted = corruptFirstStoredEntryData({ archive: archiveBytes });
    const reader = new TestStreamingZipReader({
      source: createBlobZipSource({ blob: createBlobFromBytes({ bytes: corrupted }) }),
    });

    try {
      const entries = await collectEntries({ reader });
      await expect(readStreamBytes({
        stream: await reader.openEntry({ entry: findEntry({ entries, name: 'payload.txt' }) }),
      })).rejects.toThrow('ZIP entry CRC mismatch: payload.txt');
    } finally {
      await reader.close();
    }
  });

  it('rejects truncated archives without a central directory', async () => {
    const reader = new TestStreamingZipReader({
      source: createBlobZipSource({ blob: createBlobFromBytes({ bytes: new Uint8Array([1, 2, 3]) }) }),
    });

    try {
      await expect(collectEntries({ reader })).rejects.toThrow('End of central directory not found');
    } finally {
      await reader.close();
    }
  });
});
