import { describe, expect, it } from 'vitest';
import {
  createBlobZipSource,
  createWebZipCompressionCodec,
  iterateZipStreamChunks,
  StreamingZipReader,
} from './index';
import {
  createMemoryZipCentralDirectoryStore,
  createReadableZipOutput,
  createSingleFileZipBlob,
} from './memory';

describe('ZIP memory adapters', () => {
  it('replays central-directory chunks and releases them on disposal', async () => {
    const store = createMemoryZipCentralDirectoryStore();
    await store.write({ chunk: new Uint8Array([1, 2]) });
    await store.write({ chunk: new Uint8Array([3]) });
    await store.finalize();

    const chunks: number[][] = [];
    const reader = (await store.openStream()).getReader();
    while (true) {
      const result = await reader.read();
      if (result.done) {
        break;
      }
      chunks.push([...result.value]);
    }
    expect(chunks).toEqual([[1, 2], [3]]);

    await store.dispose();
    await expect(store.openStream()).rejects.toThrow('disposed');
  });

  it('applies byte-sized backpressure instead of buffering unbounded output', async () => {
    const output = createReadableZipOutput({ highWaterMarkBytes: 8 });
    await output.sink.write({ chunk: new Uint8Array([1, 2, 3, 4]) });
    await output.sink.write({ chunk: new Uint8Array([5, 6, 7, 8]) });

    let thirdWriteSettled = false;
    const thirdWrite = output.sink
      .write({ chunk: new Uint8Array([9, 10, 11, 12]) })
      .then(() => {
        thirdWriteSettled = true;
      });
    await Promise.resolve();
    await Promise.resolve();
    expect(thirdWriteSettled).toBe(false);

    const reader = output.stream.getReader();
    expect(await reader.read()).toEqual({ done: false, value: new Uint8Array([1, 2, 3, 4]) });
    await thirdWrite;
    expect(thirdWriteSettled).toBe(true);

    await output.close();
    expect(await reader.read()).toEqual({ done: false, value: new Uint8Array([5, 6, 7, 8]) });
    expect(await reader.read()).toEqual({ done: false, value: new Uint8Array([9, 10, 11, 12]) });
    expect(await reader.read()).toEqual({ done: true, value: undefined });
  });

  it('creates a compressed single-file archive with exact bytes', async () => {
    const bytes = new TextEncoder().encode('{"status":"complete"}\n');
    const blob = await createSingleFileZipBlob({
      fileName: 'benchmark.json',
      bytes,
      modifiedAt: new Date('2026-08-26T00:00:00Z'),
      compression: 'deflate',
    });
    const source = createBlobZipSource({ blob });
    const reader = new StreamingZipReader({
      source,
      compressionCodec: createWebZipCompressionCodec(),
    });
    const entries = [];
    for await (const entry of reader.entries()) entries.push(entry);

    expect(blob.type).toBe('application/zip');
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      name: 'benchmark.json',
      compression: 'deflate',
      uncompressedSize: bytes.byteLength,
    });
    const entry = entries[0];
    if (entry === undefined) throw new Error('Single-file ZIP entry is missing');
    const chunks = [];
    for await (const chunk of iterateZipStreamChunks({ stream: await reader.openEntry({ entry }) })) {
      chunks.push(...chunk);
    }
    expect(chunks).toEqual([...bytes]);
    await reader.close();
  });
});
