// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createBlobContext, createNativeBlobContext, createBlobResponse, type BlobContext } from './blob-view';
import { createWorkerBlobContext, type WorkerBlobReadHost } from './worker-blob-context';
import * as io from './blob-view-io';
import { workerTransfer } from './worker-transport';

const contexts: BlobContext[] = [];
const savedRange = io.readNativeBlobRange;
const savedArrayBuffer = Blob.prototype.arrayBuffer;
function makeContext({ worker }: { worker: boolean }) {
  const host = { read: vi.fn(async ({ blob, offset, length }: Parameters<WorkerBlobReadHost['read']>[0]) => {
    const buffer = await savedArrayBuffer.call(blob.slice(offset, offset + length));
    return workerTransfer({ value: new Uint8Array(buffer), transferables: [buffer] });
  }) };
  const context = worker ? createWorkerBlobContext({ host }) : createNativeBlobContext();
  contexts.push(context);
  return { context, host };
}
async function readStream({ stream }: { stream: ReadableStream<Uint8Array<ArrayBuffer>> }): Promise<Uint8Array> {
  const result: number[] = [];
  const reader = stream.getReader();
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) return Uint8Array.from(result);
      for (const byte of next.value) result.push(byte);
    }
  } finally {
    await reader.cancel().catch(() => {}); reader.releaseLock();
  }
}
afterEach(() => {
  for (const context of contexts.splice(0)) context.dispose(); vi.restoreAllMocks();
});

describe.each([false, true])('native bulk delegation with Worker=%s', worker => {
  it('uses one native text call, with no application slice, stream, or range merge', async () => {
    const { context, host } = makeContext({ worker });
    // Warm capability once, outside the measured application operation.
    await context.fromNative({ blob: new Blob(['warm']) }).text();
    const blob = new Blob(['a'.repeat(4 * io.BLOB_VIEW_CHUNK_SIZE), '日本語😀']);
    const text = vi.spyOn(blob, 'text'); const slice = vi.spyOn(blob, 'slice'); const stream = vi.spyOn(blob, 'stream');
    const range = vi.spyOn(io, 'readNativeBlobRange');
    expect(await context.fromNative({ blob }).text()).toBe('a'.repeat(4 * io.BLOB_VIEW_CHUNK_SIZE) + '日本語😀');
    expect(text).toHaveBeenCalledOnce(); expect(slice).not.toHaveBeenCalled(); expect(stream).not.toHaveBeenCalled();
    expect(range).not.toHaveBeenCalled(); expect(host.read).not.toHaveBeenCalled();
  });

  it('starts the hot native method synchronously without awaiting a cached capability Promise', async () => {
    const { context, host } = makeContext({ worker });
    await context.fromNative({ blob: new Blob(['warm']) }).text();
    const blob = new Blob(['hot']); const spy = vi.spyOn(blob, 'text');
    const result = context.fromNative({ blob }).text();
    expect(spy).toHaveBeenCalledOnce();
    expect(await result).toBe('hot'); expect(host.read).not.toHaveBeenCalled();
  });

  it('returns the exact native arrayBuffer allocation, not a merged copy', async () => {
    const { context, host } = makeContext({ worker });
    await context.fromNative({ blob: new Blob(['warm']) }).bytes();
    const blob = new Blob([new Uint8Array(3 * io.BLOB_VIEW_CHUNK_SIZE + 3)]);
    const owned = new ArrayBuffer(blob.size);
    const read = vi.spyOn(blob, 'arrayBuffer').mockResolvedValue(owned);
    const slice = vi.spyOn(blob, 'slice'); const stream = vi.spyOn(blob, 'stream');
    const range = vi.spyOn(io, 'readNativeBlobRange');
    expect(await context.fromNative({ blob }).arrayBuffer() === owned).toBe(true);
    expect(read).toHaveBeenCalledOnce(); expect(slice).not.toHaveBeenCalled(); expect(stream).not.toHaveBeenCalled();
    expect(range).not.toHaveBeenCalled(); expect(host.read).not.toHaveBeenCalled();
  });

  it('returns native bytes without a copy, including a large result', async () => {
    const { context, host } = makeContext({ worker });
    await context.fromNative({ blob: new Blob(['warm']) }).text();
    const blob = new Blob([new Uint8Array(3 * io.BLOB_VIEW_CHUNK_SIZE + 1)]);
    const owned = new Uint8Array(blob.size);
    const read = vi.fn(async () => owned);
    Object.defineProperty(blob, 'bytes', { value: read });
    const arrayBuffer = vi.spyOn(blob, 'arrayBuffer'); const slice = vi.spyOn(blob, 'slice');
    expect(await context.fromNative({ blob }).bytes() === owned).toBe(true);
    expect(read).toHaveBeenCalledOnce(); expect(arrayBuffer).not.toHaveBeenCalled(); expect(slice).not.toHaveBeenCalled();
    expect(host.read).not.toHaveBeenCalled();
  });

  it('uses one arrayBuffer and a view when Blob.bytes is absent', async () => {
    const { context } = makeContext({ worker });
    await context.fromNative({ blob: new Blob(['warm']) }).text();
    const blob = new Blob(['abc']); const buffer = new Uint8Array([97, 98, 99]).buffer;
    Object.defineProperty(blob, 'bytes', { value: undefined });
    const read = vi.spyOn(blob, 'arrayBuffer').mockResolvedValue(buffer);
    const bytes = await context.fromNative({ blob }).bytes();
    expect(bytes.buffer).toBe(buffer); expect(read).toHaveBeenCalledOnce();
  });

  it.each(['text', 'bytes', 'arrayBuffer'] as const)('checks an already aborted %s without a native read', async method => {
    const { context, host } = makeContext({ worker });
    const blob = new Blob(['abc']);
    const text = vi.spyOn(blob, 'text'); const ab = vi.spyOn(blob, 'arrayBuffer');
    const signal = new AbortController(); signal.abort(new Error('Cancelled'));
    await expect(context.fromNative({ blob })[method]({ signal: signal.signal })).rejects.toBe(signal.signal.reason);
    expect(text).not.toHaveBeenCalled(); expect(ab).not.toHaveBeenCalled(); expect(host.read).not.toHaveBeenCalled();
  });

  it.each(['text', 'bytes', 'arrayBuffer'] as const)('does not consume an empty Blob or probe for %s', async method => {
    const { context, host } = makeContext({ worker }); const blob = new Blob([]);
    const text = vi.spyOn(blob, 'text'); const ab = vi.spyOn(blob, 'arrayBuffer'); const range = vi.spyOn(io, 'readNativeBlobRange');
    const result = await context.fromNative({ blob })[method]();
    expect(typeof result === 'string' ? result.length : result.byteLength).toBe(0);
    expect(text).not.toHaveBeenCalled(); expect(ab).not.toHaveBeenCalled(); expect(range).not.toHaveBeenCalled(); expect(host.read).not.toHaveBeenCalled();
  });
});

describe('native operation lifetime and validation', () => {
  it.each(['abort', 'dispose'] as const)('rejects a native pending read on %s and ignores its late result', async kind => {
    const { context } = makeContext({ worker: false }); const blob = new Blob(['abc']);
    const pending = Promise.withResolvers<string>(); vi.spyOn(blob, 'text').mockReturnValue(pending.promise);
    const owner = new AbortController();
    const reading = context.fromNative({ blob }).text({ signal: owner.signal });
    const check = expect(reading).rejects.toMatchObject({ name: 'AbortError' });
    if (kind === 'abort') owner.abort(); else context.dispose();
    await check; pending.resolve('abc'); await Promise.resolve();
    if (kind === 'abort') expect(await context.fromNative({ blob: new Blob(['next']) }).text()).toBe('next');
  });

  it('observes a native rejection arriving after cancellation', async () => {
    const { context } = makeContext({ worker: false }); const blob = new Blob(['abc']);
    const pending = Promise.withResolvers<ArrayBuffer>(); vi.spyOn(blob, 'arrayBuffer').mockReturnValue(pending.promise);
    const read = context.fromNative({ blob }).arrayBuffer(); const check = expect(read).rejects.toMatchObject({ name: 'AbortError' });
    context.dispose(); await check; pending.reject(new Error('Late native error')); await Promise.resolve();
  });

  it('validates length/ownership without recovering from malformed successful native replies', async () => {
    const { context, host } = makeContext({ worker: true }); await context.fromNative({ blob: new Blob(['warm']) }).text();
    const blob = new Blob(['abc']);
    vi.spyOn(blob, 'arrayBuffer').mockResolvedValue(new ArrayBuffer(2));
    await expect(context.fromNative({ blob }).arrayBuffer()).rejects.toThrow('Incomplete native');
    Object.defineProperty(blob, 'bytes', { value: async () => new Uint8Array(new ArrayBuffer(8), 2, 3) });
    await expect(context.fromNative({ blob }).bytes()).rejects.toThrow('exclusively owned');
    expect(host.read).not.toHaveBeenCalled();
  });

  it.each(['success', 'failure', 'abort'] as const)('removes operation signal listeners after native %s', async state => {
    const { context } = makeContext({ worker: false }); const blob = new Blob(['abc']);
    const signal = new AbortController(); const add = vi.spyOn(signal.signal, 'addEventListener'); const remove = vi.spyOn(signal.signal, 'removeEventListener');
    const pending = Promise.withResolvers<string>(); vi.spyOn(blob, 'text').mockReturnValue(pending.promise);
    const result = context.fromNative({ blob }).text({ signal: signal.signal });
    const checked = state === 'success' ? expect(result).resolves.toBe('abc') : expect(result).rejects.toThrow();
    if (state === 'success') pending.resolve('abc');
    else if (state === 'failure') pending.reject(new Error('Read failed'));
    else {
      signal.abort(); pending.resolve('abc');
    }
    await checked;
    expect(add).toHaveBeenCalledOnce(); expect(remove).toHaveBeenCalled();
    expect(remove.mock.calls.every(args => args[1] === add.mock.calls[0]?.[1])).toBe(true);
  });

  it('keeps custom readers authoritative unless they explicitly expose native capability', async () => {
    const read = vi.fn(async ({ length }: { length: number }) => new Uint8Array(length).fill(120));
    const context = createBlobContext({ reader: { read }, release: undefined }); contexts.push(context);
    const blob = new Blob(['abc']); const text = vi.spyOn(blob, 'text');
    expect(await context.fromNative({ blob }).text()).toBe('xxx');
    expect(text).not.toHaveBeenCalled(); expect(read).toHaveBeenCalledOnce();
  });
});

describe('native stream delegation', () => {
  it('opens a native stream once on demand and forwards its buffers without range reads or copies', async () => {
    const { context } = makeContext({ worker: false }); const blob = new Blob(['abcdef']);
    const first = new Uint8Array([97, 98]); const second = new Uint8Array([99, 100, 101, 102]);
    const firstBuffer = first.buffer; const secondBuffer = second.buffer;
    const enqueue = vi.spyOn(ReadableByteStreamController.prototype, 'enqueue');
    const native = new ReadableStream({ start(controller) {
      controller.enqueue(first); controller.enqueue(second); controller.close();
    } });
    const stream = vi.spyOn(blob, 'stream').mockReturnValue(native); const range = vi.spyOn(io, 'readNativeBlobRange');
    const result = context.fromNative({ blob }).stream().getReader();
    await Promise.resolve(); expect(stream).not.toHaveBeenCalled();
    expect((await result.read()).value).toEqual(new Uint8Array([97, 98]));
    expect((await result.read()).value).toEqual(new Uint8Array([99, 100, 101, 102]));
    // Byte-stream enqueue transfers/detaches the source buffer; object identity
    // of the receiving ArrayBuffer is not proof of a copy. Check the handoff.
    expect(enqueue.mock.calls[0]?.[0]).toBe(first);
    expect(enqueue.mock.calls[1]?.[0]).toBe(second);
    expect(firstBuffer.byteLength).toBe(0); expect(secondBuffer.byteLength).toBe(0);
    expect((await result.read()).done).toBe(true); result.releaseLock();
    expect(stream).toHaveBeenCalledOnce(); expect(range).not.toHaveBeenCalled(); expect(native.locked).toBe(false);
  });

  it('supports small BYOB requests even if the native source is not a BYOB byte stream', async () => {
    const { context } = makeContext({ worker: false }); const bytes = new Uint8Array(39).map((_, i) => i);
    const blob = new Blob([bytes]); const native = new ReadableStream<Uint8Array<ArrayBuffer>>({ start(controller) {
      controller.enqueue(bytes.slice()); controller.close();
    } });
    vi.spyOn(blob, 'stream').mockReturnValue(native);
    const reader = context.fromNative({ blob }).stream().getReader({ mode: 'byob' }); const result: number[] = [];
    while (true) {
      const part = await reader.read(new Uint8Array(7)); if (part.done) break; for (const byte of part.value) result.push(byte);
    }
    reader.releaseLock(); expect(Uint8Array.from(result)).toEqual(bytes); expect(native.locked).toBe(false);
  });

  it('reads a multi-megabyte native stream with exact content and no application range reads', async () => {
    const { context, host } = makeContext({ worker: true });
    await context.fromNative({ blob: new Blob(['warm']) }).text();
    const expected = new Uint8Array(8 * io.BLOB_VIEW_CHUNK_SIZE + 17).map((_, i) => i % 251);
    const blob = new Blob([expected]); const range = vi.spyOn(io, 'readNativeBlobRange'); const stream = vi.spyOn(blob, 'stream');
    const reader = context.fromNative({ blob }).stream().getReader(); let length = 0;
    try {
      while (true) {
        const result = await reader.read(); if (result.done) break;
        expect(result.value.every((byte, i) => byte === expected[length + i])).toBe(true);
        length += result.value.byteLength;
      }
    } finally {
      await reader.cancel().catch(() => {}); reader.releaseLock();
    }
    expect(length).toBe(expected.length); expect(range).not.toHaveBeenCalled(); expect(stream).toHaveBeenCalledOnce(); expect(host.read).not.toHaveBeenCalled();
  });

  it('supports aligned BYOB element sizes and rejects an incomplete final element', async () => {
    const { context } = makeContext({ worker: false });
    const good = context.fromNative({ blob: new Blob([new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8])]) }).stream().getReader({ mode: 'byob' });
    const result = await good.read(new Uint16Array(4), { min: 3 });
    expect(new Uint8Array(result.value!.buffer)).toEqual(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]));
    expect((await good.read(new Uint16Array(1))).done).toBe(true); good.releaseLock();
    const bad = context.fromNative({ blob: new Blob([new Uint8Array([1, 2, 3])]) }).stream().getReader({ mode: 'byob' });
    expect((await bad.read(new Uint16Array(2))).value?.byteLength).toBe(2);
    await expect(bad.read(new Uint16Array(2))).rejects.toBeInstanceOf(TypeError); bad.releaseLock();
  });

  it('cleans up a native reader even if the owner ends while the stream is being acquired', async () => {
    const { context } = makeContext({ worker: false }); const blob = new Blob(['abc']);
    const cancel = vi.fn(); const pull = vi.fn();
    const native = new ReadableStream<Uint8Array<ArrayBuffer>>({ pull, cancel }, { highWaterMark: 0 });
    vi.spyOn(blob, 'stream').mockImplementation(() => {
      context.dispose(); return native;
    });
    const reader = context.fromNative({ blob }).stream().getReader();
    await expect(reader.read()).rejects.toMatchObject({ name: 'AbortError' });
    await vi.waitFor(() => expect(native.locked).toBe(false));
    expect(cancel).toHaveBeenCalledOnce(); expect(pull).not.toHaveBeenCalled(); reader.releaseLock();
  });

  it('creates independent native streams for independent consumers', async () => {
    const { context } = makeContext({ worker: false }); const blob = new Blob(['日本語']); const stream = vi.spyOn(blob, 'stream');
    const view = context.fromNative({ blob });
    const a = readStream({ stream: view.stream() }); const b = readStream({ stream: view.stream() });
    expect(await a).toEqual(new TextEncoder().encode('日本語')); expect(await b).toEqual(new TextEncoder().encode('日本語')); expect(stream).toHaveBeenCalledTimes(2);
  });

  it.each(['cancel', 'dispose', 'signal'] as const)('cancels and unlocks the native reader on %s while read is pending', async kind => {
    const { context } = makeContext({ worker: false }); const blob = new Blob(['abc']);
    const cancel = vi.fn(); const native = new ReadableStream<Uint8Array<ArrayBuffer>>({ cancel });
    const spy = vi.spyOn(blob, 'stream').mockReturnValue(native); const signal = new AbortController();
    const reader = context.fromNative({ blob }).stream({ signal: signal.signal }).getReader();
    const pending = reader.read();
    const observed = kind === 'cancel' ? expect(pending).resolves.toMatchObject({ done: true }) : expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    await vi.waitFor(() => expect(spy).toHaveBeenCalledOnce());
    if (kind === 'cancel') await reader.cancel(); else if (kind === 'dispose') context.dispose(); else signal.abort();
    await observed; await vi.waitFor(() => expect(native.locked).toBe(false)); expect(cancel).toHaveBeenCalledOnce(); reader.releaseLock();
  });

  it('does not open the native stream when cancelled before first demand', async () => {
    const { context } = makeContext({ worker: false }); const blob = new Blob(['abc']); const spy = vi.spyOn(blob, 'stream');
    const stream = context.fromNative({ blob }).stream(); await stream.cancel(); expect(spy).not.toHaveBeenCalled();
  });

  it.each(['short', 'long', 'security'] as const)('rejects a %s native stream instead of silently returning different content', async kind => {
    const { context, host } = makeContext({ worker: true }); await context.fromNative({ blob: new Blob(['warm']) }).text();
    const blob = new Blob(['abc']); const error = new DOMException('Forbidden', 'SecurityError');
    const native = new ReadableStream<Uint8Array<ArrayBuffer>>({ start(controller) {
      if (kind === 'security') controller.error(error);
      else {
        controller.enqueue(new Uint8Array(kind === 'short' ? 2 : 4)); controller.close();
      }
    } });
    vi.spyOn(blob, 'stream').mockReturnValue(native);
    await expect(readStream({ stream: context.fromNative({ blob }).stream() })).rejects.toThrow();
    expect(host.read).not.toHaveBeenCalled(); await vi.waitFor(() => expect(native.locked).toBe(false));
  });

  it('keeps Response consumption on the safe stream without re-materializing the Blob', async () => {
    const { context } = makeContext({ worker: false }); const blob = new Blob(['abc']); const spy = vi.spyOn(blob, 'stream');
    expect(await createBlobResponse({ blob: context.fromNative({ blob }), init: undefined, signal: undefined }).text()).toBe('abc');
    expect(spy).toHaveBeenCalledOnce();
  });
});

describe('direct File failures still recover without replay', () => {
  it.each(['text', 'bytes', 'arrayBuffer'] as const)('recovers a failing native %s through bounded host reads', async method => {
    const { context, host } = makeContext({ worker: true }); await context.fromNative({ blob: new Blob(['warm']) }).text();
    const blob = new Blob(['日本語😀']);
    const fail = new DOMException('Opaque File', 'NotReadableError');
    const range = vi.spyOn(io, 'readNativeBlobRange').mockRejectedValue(fail);
    Object.defineProperty(blob, method, { value: vi.fn().mockRejectedValue(fail) });
    const result = await context.fromNative({ blob })[method]();
    expect(typeof result === 'string' ? result : new TextDecoder().decode(result)).toBe('日本語😀');
    expect(host.read).toHaveBeenCalledOnce(); expect(range).toHaveBeenCalledOnce();
  });

  it('continues only at the unread offset after a native stream error', async () => {
    const { context, host } = makeContext({ worker: true }); await context.fromNative({ blob: new Blob(['warm']) }).text();
    const blob = new Blob(['abcdefgh']); const error = new DOMException('Snapshot read failed', 'NotReadableError');
    let pulls = 0;
    const native = new ReadableStream<Uint8Array<ArrayBuffer>>({ pull(controller) {
      if (pulls++ === 0) controller.enqueue(new TextEncoder().encode('abc')); else controller.error(error);
    } }, { highWaterMark: 0 });
    vi.spyOn(blob, 'stream').mockReturnValue(native);
    const range = vi.spyOn(io, 'readNativeBlobRange').mockRejectedValue(error);
    expect(await readStream({ stream: context.fromNative({ blob }).stream() })).toEqual(new TextEncoder().encode('abcdefgh'));
    expect(host.read.mock.calls.map(([r]) => [r.offset, r.length])).toEqual([[3, 5]]);
    expect(range).toHaveBeenCalledOnce(); expect(native.locked).toBe(false);
  });

  it('retains both bulk and recovery failures without publishing a partial text', async () => {
    const { context, host } = makeContext({ worker: true }); await context.fromNative({ blob: new Blob(['warm']) }).text();
    const blob = new Blob(['abcdef']); const first = new DOMException('Snapshot failed', 'NotReadableError'); const second = new Error('Host failed');
    vi.spyOn(blob, 'text').mockRejectedValue(first); vi.spyOn(io, 'readNativeBlobRange').mockRejectedValue(first); host.read.mockRejectedValue(second);
    await expect(context.fromNative({ blob }).text()).rejects.toMatchObject({ errors: [first, expect.objectContaining({ errors: [first, second] })] });
  });

  it('retains the native stream error if range recovery also fails', async () => {
    const { context, host } = makeContext({ worker: true }); await context.fromNative({ blob: new Blob(['warm']) }).text();
    const blob = new Blob(['abc']); const first = new DOMException('Stream failed', 'NotReadableError'); const second = new Error('Host failed');
    vi.spyOn(blob, 'stream').mockReturnValue(new ReadableStream({ start(controller) {
      controller.error(first);
    } }));
    vi.spyOn(io, 'readNativeBlobRange').mockRejectedValue(first); host.read.mockRejectedValue(second);
    await expect(readStream({ stream: context.fromNative({ blob }).stream() })).rejects.toMatchObject({ errors: [first, expect.objectContaining({ errors: [first, second] })] });
  });

  it('recovers a native stream that throws before returning a reader', async () => {
    const { context, host } = makeContext({ worker: true }); await context.fromNative({ blob: new Blob(['warm']) }).text();
    const blob = new Blob(['abc']); const error = new DOMException('Cannot create stream', 'NotReadableError');
    vi.spyOn(blob, 'stream').mockImplementation(() => {
      throw error;
    }); vi.spyOn(io, 'readNativeBlobRange').mockRejectedValue(error);
    expect(await readStream({ stream: context.fromNative({ blob }).stream() })).toEqual(new TextEncoder().encode('abc')); expect(host.read).toHaveBeenCalledOnce();
  });

  it('does not make a whole-read failure poison unrelated Blobs, or bypass cancellation to retry', async () => {
    const { context, host } = makeContext({ worker: true }); await context.fromNative({ blob: new Blob(['warm']) }).text();
    const signal = new AbortController(); const blob = new Blob(['abc']);
    vi.spyOn(blob, 'text').mockImplementation(async () => {
      signal.abort(); throw new DOMException('Late', 'NotReadableError');
    });
    await expect(context.fromNative({ blob }).text({ signal: signal.signal })).rejects.toMatchObject({ name: 'AbortError' });
    expect(host.read).not.toHaveBeenCalled();
    const other = new Blob(['next']); const spy = vi.spyOn(other, 'text');
    expect(await context.fromNative({ blob: other }).text()).toBe('next'); expect(spy).toHaveBeenCalledOnce();
  });
});

// Guard the full-range primitive used by the host and unadapted context.
describe('native range entry', () => {
  it('does not slice a full-range request, but retains slice semantics for partial ranges', async () => {
    const blob = new Blob(['abcdef']); const slice = vi.spyOn(blob, 'slice');
    expect(await savedRange({ blob, offset: 0, length: 6 })).toEqual(new TextEncoder().encode('abcdef')); expect(slice).not.toHaveBeenCalled();
    expect(await savedRange({ blob, offset: 2, length: 2 })).toEqual(new TextEncoder().encode('cd')); expect(slice).toHaveBeenCalledWith(2, 4);
  });
});
