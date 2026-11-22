import { describe, expect, it, vi } from 'vitest';
import JSZip from 'jszip';
import {
  StreamingZipReader,
  createBlobZipSource,
  createWebZipCompressionCodec,
  iterateZipStreamChunks,
  type ZipArchiveEntry,
  type ZipRandomAccessSource,
} from './index';

const chunkSize = 64 * 1024;
const compressionCodec = createWebZipCompressionCodec();

interface StoredZipFixture {
  readonly bytes: Uint8Array,
  readonly centralOffset: number,
  readonly centralSize: number,
  readonly localOffsets: readonly number[],
}

async function createStoredZipFixture({ entries, centralOrder, descriptor }: {
  entries: readonly { name: string, payload: Uint8Array }[],
  centralOrder: readonly number[] | undefined,
  descriptor: 'none' | 'signed',
}): Promise<StoredZipFixture> {
  const zip = new JSZip();
  for (const { name, payload } of entries) {
    zip.file(name, payload, { compression: 'STORE', createFolders: false });
  }
  const bytes = await zip.generateAsync({ type: 'uint8array', compression: 'STORE', streamFiles: descriptor === 'signed' });
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const endOffset = bytes.byteLength - 22;
  expect(view.getUint32(endOffset, true)).toBe(0x06054b50);
  const centralOffset = view.getUint32(endOffset + 16, true);
  const centralSize = view.getUint32(endOffset + 12, true);
  const records: Uint8Array[] = [];
  const localOffsets: number[] = [];
  let offset = centralOffset;
  for (let index = 0; index < entries.length; index += 1) {
    expect(view.getUint32(offset, true)).toBe(0x02014b50);
    const length = 46 + view.getUint16(offset + 28, true)
      + view.getUint16(offset + 30, true) + view.getUint16(offset + 32, true);
    localOffsets.push(view.getUint32(offset + 42, true));
    records.push(bytes.slice(offset, offset + length));
    offset += length;
  }
  expect(offset).toBe(centralOffset + centralSize);
  if (centralOrder !== undefined) {
    expect([...centralOrder].sort((left, right) => left - right))
      .toEqual(entries.map((_, index) => index));
    offset = centralOffset;
    for (const index of centralOrder) {
      const record = records[index];
      if (record === undefined) {
        throw new Error('Missing test ZIP central-directory record');
      }
      bytes.set(record, offset);
      offset += record.byteLength;
    }
  }
  return { bytes, centralOffset, centralSize, localOffsets };
}

function trackSourceReads({ bytes }: { bytes: Uint8Array }): {
  source: ZipRandomAccessSource,
  reads: { offset: number, length: number }[],
} {
  const reads: { offset: number, length: number }[] = [];
  return {
    reads,
    source: {
      size: bytes.byteLength,
      async read({ offset, length }) {
        reads.push({ offset, length });
        return bytes.slice(offset, offset + length);
      },
      async close() {},
    },
  };
}

async function readEntryBytes({ reader, entry }: {
  reader: StreamingZipReader,
  entry: ZipArchiveEntry,
}): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  for await (const chunk of iterateZipStreamChunks({ stream: await reader.openEntry({ entry }) })) {
    chunks.push(chunk);
  }
  const bytes = new Uint8Array(chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0));
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

describe('streaming ZIP source read patterns', () => {
  it('reuses local header read-ahead for a small Blob entry', async () => {
    const payload = Uint8Array.of(1, 2, 3, 4);
    const fixture = await createStoredZipFixture({
      entries: [{ name: 'payload.bin', payload }],
      centralOrder: undefined,
      descriptor: 'none',
    });
    const blob = new Blob([new Uint8Array(fixture.bytes).buffer]);
    using slice = vi.spyOn(blob, 'slice');
    const reader = new StreamingZipReader({ source: createBlobZipSource({ blob }), compressionCodec });
    await using _cleanup = {
      async [Symbol.asyncDispose]() {
        await reader.close();
      },
    };
    for await (const entry of reader.entries()) {
      slice.mockClear();
      expect(await readEntryBytes({ reader, entry })).toEqual(payload);
      expect(slice.mock.calls).toEqual([[0, fixture.bytes.byteLength]]);
    }
  });

  it('fills a partially buffered entry chunk with only the missing bytes', async () => {
    const name = 'large.bin';
    const dataOffset = 30 + name.length;
    const payload = Uint8Array.from({ length: chunkSize + 123 }, (_, index) => index % 251);
    const fixture = await createStoredZipFixture({
      entries: [{ name, payload }],
      centralOrder: undefined,
      descriptor: 'none',
    });
    const blob = new Blob([new Uint8Array(fixture.bytes).buffer]);
    using slice = vi.spyOn(blob, 'slice');
    const reader = new StreamingZipReader({ source: createBlobZipSource({ blob }), compressionCodec });
    await using _cleanup = {
      async [Symbol.asyncDispose]() {
        await reader.close();
      },
    };
    for await (const entry of reader.entries()) {
      slice.mockClear();
      const chunks: Uint8Array[] = [];
      for await (const chunk of iterateZipStreamChunks({ stream: await reader.openEntry({ entry }) })) {
        chunks.push(chunk);
      }
      expect(chunks).toEqual([payload.slice(0, chunkSize), payload.slice(chunkSize)]);
      expect(slice.mock.calls).toEqual([
        [0, chunkSize],
        [chunkSize, dataOffset + chunkSize],
        [dataOffset + chunkSize, dataOffset + payload.byteLength],
      ]);
    }
  });

  it('rejects an incomplete read of the suffix after a buffered prefix', async () => {
    const name = 'large.bin';
    const fixture = await createStoredZipFixture({
      entries: [{ name, payload: new Uint8Array(chunkSize + 123) }],
      centralOrder: undefined,
      descriptor: 'none',
    });
    const blob = new Blob([new Uint8Array(fixture.bytes).buffer]);
    const originalSlice = blob.slice.bind(blob);
    using _shortRead = vi.spyOn(blob, 'slice').mockImplementation((start, end, contentType) =>
      originalSlice(start, start === chunkSize && end !== undefined ? end - 1 : end, contentType));
    const reader = new StreamingZipReader({ source: createBlobZipSource({ blob }), compressionCodec });
    await using _cleanup = {
      async [Symbol.asyncDispose]() {
        await reader.close();
      },
    };
    const suffixLength = 30 + name.length;
    for await (const entry of reader.entries()) {
      await expect(readEntryBytes({ reader, entry })).rejects.toThrow(
        `ZIP source returned ${suffixLength - 1} bytes for a ${suffixLength}-byte range`,
      );
    }
  });

  it('isolates buffered chunks across concurrently open streams', async () => {
    const payload = Uint8Array.of(1, 2, 3, 4);
    const fixture = await createStoredZipFixture({
      entries: [{ name: 'payload.bin', payload }],
      centralOrder: undefined,
      descriptor: 'none',
    });
    const blob = new Blob([new Uint8Array(fixture.bytes).buffer]);
    using slice = vi.spyOn(blob, 'slice');
    const reader = new StreamingZipReader({ source: createBlobZipSource({ blob }), compressionCodec });
    await using _cleanup = {
      async [Symbol.asyncDispose]() {
        await reader.close();
      },
    };
    for await (const entry of reader.entries()) {
      slice.mockClear();
      const first = await reader.openEntry({ entry });
      const second = await reader.openEntry({ entry });
      for await (const chunk of iterateZipStreamChunks({ stream: first })) {
        expect(chunk).toEqual(payload);
        chunk.fill(0);
      }
      for await (const chunk of iterateZipStreamChunks({ stream: second })) {
        expect(chunk).toEqual(payload);
        chunk.fill(1);
      }
      expect(await readEntryBytes({ reader, entry })).toEqual(payload);
      expect(slice.mock.calls).toEqual([[0, fixture.bytes.byteLength]]);
    }
  });

  it.each(['physical', 'alternating', 'paired'] as const)(
    'bounds reads while extracting interleaved entries in %s directory order',
    async (order) => {
      const entryCount = 1500;
      const payload = Uint8Array.from({ length: 128 }, (_, index) => index);
      const entries = Array.from({ length: entryCount }, (_, index) => ({
        name: `entry-${String(index).padStart(4, '0')}.bin`,
        payload,
      }));
      // Jump between distant halves of the file-data region for every entry.
      // A separate local-header read-ahead window still thrashes in this order.
      const centralOrder = order === 'physical' ? undefined : Array.from({ length: entryCount }, (_, index) => {
        const runLength = order === 'paired' ? 2 : 1;
        const run = Math.floor(index / runLength);
        return (Math.floor(run / 2) + (run % 2) * (entryCount / runLength / 2)) * runLength
          + index % runLength;
      });
      const fixture = await createStoredZipFixture({ entries, centralOrder, descriptor: 'none' });
      expect(fixture.centralSize).toBeGreaterThan(chunkSize);
      const { source, reads } = trackSourceReads({ bytes: fixture.bytes });
      const reader = new StreamingZipReader({ source, compressionCodec });
      await using _cleanup = {
        async [Symbol.asyncDispose]() {
          await reader.close();
        },
      };
      let entryIndex = 0;
      for await (const entry of reader.entries()) {
        const expected = entries[centralOrder?.[entryIndex] ?? entryIndex];
        expect(entry.name).toBe(expected?.name);
        expect(await readEntryBytes({ reader, entry })).toEqual(payload);
        entryIndex += 1;
      }
      expect(entryIndex).toBe(entryCount);
      // At most one local-header miss and one payload read per entry, plus a
      // bounded number of directory-window reads and the end-record search.
      expect(reads.length).toBeLessThanOrEqual(entryCount * 2 + 5);
      if (order === 'physical') {
        expect(reads.length).toBeLessThanOrEqual(entryCount + 10);
      }
      const bytesRead = reads.reduce((sum, read) => sum + read.length, 0);
      expect(bytesRead).toBeLessThanOrEqual(fixture.bytes.byteLength + entryCount * payload.byteLength + chunkSize * 3);
      expect(Math.max(...reads.map(read => read.length))).toBeLessThanOrEqual(chunkSize + 22);
    },
  );

  it.each([50, 500])('reuses local windows for %s sequential small entries', async (entryCount) => {
    const payload = new Uint8Array(128);
    const fixture = await createStoredZipFixture({
      entries: Array.from({ length: entryCount }, (_, index) => ({
        name: `entry-${String(index).padStart(4, '0')}.bin`,
        payload,
      })),
      centralOrder: undefined,
      descriptor: 'none',
    });
    const { source, reads } = trackSourceReads({ bytes: fixture.bytes });
    const reader = new StreamingZipReader({ source, compressionCodec });
    await using _cleanup = {
      async [Symbol.asyncDispose]() {
        await reader.close();
      },
    };
    for await (const entry of reader.entries()) {
      expect(await readEntryBytes({ reader, entry })).toEqual(payload);
    }
    expect(reads.length).toBeLessThanOrEqual(entryCount + 7);
  });

  it.each(['none', 'signed'] as const)('recovers read-ahead after jumps with %s descriptors', async (descriptor) => {
    const entryCount = 1500;
    const payload = new Uint8Array(128);
    const fixture = await createStoredZipFixture({
      entries: Array.from({ length: entryCount }, (_, index) => ({
        name: `entry-${String(index).padStart(4, '0')}.bin`,
        payload,
      })),
      centralOrder: [0, ...Array.from({ length: 500 }, (_, index) => index + 1000),
        ...Array.from({ length: 999 }, (_, index) => index + 1)],
      descriptor,
    });
    const { source, reads } = trackSourceReads({ bytes: fixture.bytes });
    const reader = new StreamingZipReader({ source, compressionCodec });
    await using _cleanup = {
      async [Symbol.asyncDispose]() {
        await reader.close();
      },
    };
    for await (const entry of reader.entries()) {
      expect(await readEntryBytes({ reader, entry })).toEqual(payload);
    }
    const localOffsets = new Set(fixture.localOffsets);
    const localReads = reads.filter(read => localOffsets.has(read.offset));
    expect(localReads.slice(0, 5).map(read => read.length)).toEqual([chunkSize, 44, 88, 176, 352]);
    expect(reads.length).toBeLessThanOrEqual(entryCount + 45);
    expect(reads.reduce((sum, read) => sum + read.length, 0)).toBeLessThanOrEqual(fixture.bytes.byteLength * 3);
  });

  it('limits read-ahead when short runs of empty entries repeatedly jump', async () => {
    const entryCount = 1536;
    const runLength = 12;
    const fixture = await createStoredZipFixture({
      entries: Array.from({ length: entryCount }, (_, index) => ({
        name: `entry-${String(index).padStart(4, '0')}.bin`,
        payload: new Uint8Array(0),
      })),
      centralOrder: Array.from({ length: entryCount }, (_, index) => {
        const run = Math.floor(index / runLength);
        return (Math.floor(run / 2) + (run % 2) * (entryCount / runLength / 2)) * runLength
          + index % runLength;
      }),
      descriptor: 'none',
    });
    const { source, reads } = trackSourceReads({ bytes: fixture.bytes });
    const reader = new StreamingZipReader({ source, compressionCodec });
    await using _cleanup = {
      async [Symbol.asyncDispose]() {
        await reader.close();
      },
    };
    let extracted = 0;
    for await (const entry of reader.entries()) {
      expect(await readEntryBytes({ reader, entry })).toHaveLength(0);
      extracted += 1;
    }
    expect(extracted).toBe(entryCount);
    expect(reads.reduce((sum, read) => sum + read.length, 0)).toBeLessThanOrEqual(fixture.bytes.byteLength * 3);
  });

  it('opens the first entry without collecting the remaining directory', async () => {
    const payload = Uint8Array.of(1, 2, 3);
    const fixture = await createStoredZipFixture({
      entries: Array.from({ length: 1500 }, (_, index) => ({
        name: `entry-${String(index).padStart(4, '0')}.bin`,
        payload,
      })),
      centralOrder: undefined,
      descriptor: 'none',
    });
    const { source, reads } = trackSourceReads({ bytes: fixture.bytes });
    const reader = new StreamingZipReader({ source, compressionCodec });
    await using _cleanup = {
      async [Symbol.asyncDispose]() {
        await reader.close();
      },
    };
    for await (const entry of reader.entries()) {
      expect(entry.name).toBe('entry-0000.bin');
      expect(await readEntryBytes({ reader, entry })).toEqual(payload);
      break;
    }
    expect(reads).toHaveLength(4);
    expect(reads.filter(read => read.offset === fixture.centralOffset)).toHaveLength(1);
    expect(reads.some(read => read.offset > fixture.centralOffset + chunkSize)).toBe(false);
    expect(reads.find(read => read.offset === 0)?.length).toBe(chunkSize);
  });

  it('handles crossing window boundaries and maximum-length names with bounded local reads', async () => {
    const payload = Uint8Array.of(42);
    const names = ['a'.repeat(65_484), 'b.txt', 'c'.repeat(0xffff)];
    const fixture = await createStoredZipFixture({
      entries: names.map(name => ({ name, payload })),
      centralOrder: undefined,
      descriptor: 'none',
    });
    const { source, reads } = trackSourceReads({ bytes: fixture.bytes });
    const reader = new StreamingZipReader({ source, compressionCodec });
    await using _cleanup = {
      async [Symbol.asyncDispose]() {
        await reader.close();
      },
    };
    let index = 0;
    for await (const entry of reader.entries()) {
      expect(entry.name).toBe(names[index]);
      expect(await readEntryBytes({ reader, entry })).toEqual(payload);
      index += 1;
    }
    expect(index).toBe(names.length);
    const secondLocalOffset = fixture.localOffsets[1];
    expect(secondLocalOffset).toBe(65_515);
    expect(reads.find(read => read.offset === secondLocalOffset)?.length).toBe(chunkSize);
    expect(reads.some(read => read.length === 30 + 0xffff)).toBe(true);
    expect(Math.max(...reads.map(read => read.length))).toBeLessThanOrEqual(30 + 0xffff);
  });

  it('reads payload after a maximum-length local extra field', async () => {
    const payload = Uint8Array.of(1, 2, 3, 4);
    const fixture = await createStoredZipFixture({
      entries: [{ name: 'file.bin', payload }],
      centralOrder: undefined,
      descriptor: 'none',
    });
    const nameEnd = 30 + 'file.bin'.length;
    const extraLength = 0xffff;
    const bytes = new Uint8Array(fixture.bytes.length + extraLength);
    bytes.set(fixture.bytes.subarray(0, nameEnd));
    bytes.set(fixture.bytes.subarray(nameEnd), nameEnd + extraLength);
    const view = new DataView(bytes.buffer);
    view.setUint16(28, extraLength, true);
    view.setUint16(nameEnd, 0xcafe, true);
    view.setUint16(nameEnd + 2, extraLength - 4, true);
    view.setUint32(bytes.length - 6, fixture.centralOffset + extraLength, true);
    const { source } = trackSourceReads({ bytes });
    const reader = new StreamingZipReader({ source, compressionCodec });
    await using _cleanup = {
      async [Symbol.asyncDispose]() {
        await reader.close();
      },
    };
    let count = 0;
    for await (const entry of reader.entries()) {
      expect(await readEntryBytes({ reader, entry })).toEqual(payload);
      count += 1;
    }
    expect(count).toBe(1);
  });

  it('reads sequential entries with an unsigned data descriptor', async () => {
    const payload = Uint8Array.of(1, 2, 3, 4);
    const fixture = await createStoredZipFixture({
      entries: [{ name: 'first.bin', payload }, { name: 'second.bin', payload }],
      centralOrder: undefined,
      descriptor: 'signed',
    });
    const descriptorOffset = 30 + 'first.bin'.length + payload.length;
    expect(new DataView(fixture.bytes.buffer).getUint32(descriptorOffset, true)).toBe(0x08074b50);
    const bytes = new Uint8Array(fixture.bytes.length - 4);
    bytes.set(fixture.bytes.subarray(0, descriptorOffset));
    bytes.set(fixture.bytes.subarray(descriptorOffset + 4), descriptorOffset);
    const view = new DataView(bytes.buffer);
    const centralOffset = fixture.centralOffset - 4;
    const secondCentralOffset = centralOffset + 46 + 'first.bin'.length;
    const secondLocalOffset = fixture.localOffsets[1];
    if (secondLocalOffset === undefined) {
      throw new Error('Missing second test ZIP local header');
    }
    view.setUint32(secondCentralOffset + 42, secondLocalOffset - 4, true);
    view.setUint32(bytes.length - 6, centralOffset, true);
    const { source } = trackSourceReads({ bytes });
    const reader = new StreamingZipReader({ source, compressionCodec });
    await using _cleanup = {
      async [Symbol.asyncDispose]() {
        await reader.close();
      },
    };
    const names: string[] = [];
    for await (const entry of reader.entries()) {
      names.push(entry.name);
      expect(await readEntryBytes({ reader, entry })).toEqual(payload);
    }
    expect(names).toEqual(['first.bin', 'second.bin']);
  });

  it.each(['directory', 'local header', 'payload'] as const)(
    'rejects short %s reads instead of accepting incomplete bytes',
    async (phase) => {
      const name = 'payload.bin';
      const payload = Uint8Array.of(1, 2, 3, 4);
      const fixture = await createStoredZipFixture({
        entries: [{ name, payload }],
        centralOrder: undefined,
        descriptor: 'none',
      });
      const tracked = trackSourceReads({ bytes: fixture.bytes });
      const failureOffset = phase === 'directory' ? fixture.centralOffset
        : phase === 'local header' ? 0 : 30 + name.length;
      let firstRead = true;
      const source: ZipRandomAccessSource = {
        size: tracked.source.size,
        async read({ offset, length }) {
          const bytes = await tracked.source.read({ offset, length });
          // The end-record search may also start at zero in a small archive.
          const isEndRecordSearch = firstRead;
          firstRead = false;
          return offset === failureOffset && !isEndRecordSearch
            ? bytes.subarray(0, bytes.byteLength - 1)
            : bytes;
        },
        async close() {
          await tracked.source.close();
        },
      };
      const reader = new StreamingZipReader({ source, compressionCodec });
      await using _cleanup = {
        async [Symbol.asyncDispose]() {
          await reader.close();
        },
      };
      const extract = async (): Promise<void> => {
        for await (const entry of reader.entries()) {
          await readEntryBytes({ reader, entry });
        }
      };
      await expect(extract()).rejects.toThrow(/ZIP source returned \d+ bytes for a \d+-byte range/);
    },
  );

  it.each([
    { fieldOffset: 26, value: 10, message: 'ZIP local entry name mismatch' },
    { fieldOffset: 26, value: 12, message: 'ZIP local entry name mismatch' },
    { fieldOffset: 28, value: 0xffff, message: 'ZIP local entry header exceeds file-data bounds' },
  ])('rejects local name and extra lengths after an exact header read: $fieldOffset/$value', async ({
    fieldOffset,
    value,
    message,
  }) => {
    const fixture = await createStoredZipFixture({
      entries: [{ name: 'payload.bin', payload: Uint8Array.of(1, 2, 3, 4) }],
      centralOrder: undefined,
      descriptor: 'none',
    });
    new DataView(fixture.bytes.buffer).setUint16(fieldOffset, value, true);
    const { source } = trackSourceReads({ bytes: fixture.bytes });
    const reader = new StreamingZipReader({ source, compressionCodec });
    await using _cleanup = {
      async [Symbol.asyncDispose]() {
        await reader.close();
      },
    };
    for await (const entry of reader.entries()) {
      await expect(reader.openEntry({ entry })).rejects.toThrow(message);
    }
  });

  it('stops payload reads after cancellation and continues directory iteration', async () => {
    const name = 'large.bin';
    const fixture = await createStoredZipFixture({
      entries: [
        { name, payload: new Uint8Array(chunkSize * 16) },
        { name: 'next.bin', payload: Uint8Array.of(7) },
      ],
      centralOrder: undefined,
      descriptor: 'none',
    });
    const { source, reads } = trackSourceReads({ bytes: fixture.bytes });
    const reader = new StreamingZipReader({ source, compressionCodec });
    await using _cleanup = {
      async [Symbol.asyncDispose]() {
        await reader.close();
      },
    };
    const names: string[] = [];
    for await (const entry of reader.entries()) {
      names.push(entry.name);
      if (entry.name === name) {
        const firstRead = reads.length;
        const streamReader = (await reader.openEntry({ entry })).getReader();
        using _release = {
          [Symbol.dispose]() {
            streamReader.releaseLock();
          },
        };
        expect((await streamReader.read()).value).toHaveLength(chunkSize);
        await streamReader.cancel();
        const dataOffset = 30 + name.length;
        const payloadReads = reads.slice(firstRead).filter(read => read.offset >= dataOffset
          && read.offset < dataOffset + chunkSize * 16);
        // Stream queues may prefetch a few chunks, but never the whole payload.
        expect(payloadReads.reduce((sum, read) => sum + read.length, 0)).toBeLessThanOrEqual(chunkSize * 3);
      } else {
        expect(await readEntryBytes({ reader, entry })).toEqual(Uint8Array.of(7));
      }
    }
    expect(names).toEqual([name, 'next.bin']);
    expect(reads.filter(read => read.offset === fixture.centralOffset)).toHaveLength(1);
  });
});
