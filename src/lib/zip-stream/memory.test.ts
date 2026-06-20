import { describe, expect, it } from 'vitest';
import {
  createMemoryZipCentralDirectoryStore,
  createReadableZipOutput,
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
});
