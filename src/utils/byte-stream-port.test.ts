// @vitest-environment node
import { describe, it, expect, vi } from 'vitest';
import { BYTE_STREAM_CHUNK_BYTES, receiveByteStream, serveByteStream } from './byte-stream-port';

function connect({ stream, signal }: { stream: ReadableStream<Uint8Array>, signal: AbortSignal | undefined }) {
  const channel = new MessageChannel();
  const openStream = vi.fn(async () => stream);
  const sender = serveByteStream({ port: channel.port1, openStream, signal });
  const receiver = receiveByteStream({ port: channel.port2 });
  return { sender, receiver, openStream };
}

describe('bounded byte stream ports', () => {
  it('rejects a read immediately when sending its pull credit fails synchronously', async () => {
    const channel = new MessageChannel();
    const received = receiveByteStream({ port: channel.port1 });
    vi.spyOn(channel.port1, 'postMessage').mockImplementation(() => {
      throw new Error('broken port');
    });
    try {
      await expect(received.stream.getReader().read()).rejects.toThrow('broken port');
      await expect(received.completed).rejects.toThrow('broken port');
    } finally {
      channel.port2.close();
    }
  });

  it('opens lazily and transfers only one bounded slice per pull without detaching source bytes', async () => {
    const bytes = new Uint8Array(BYTE_STREAM_CHUNK_BYTES * 3 + 7).fill(42);
    const fixture = connect({
      stream: new ReadableStream({
      start(controller) {
        controller.enqueue(bytes); controller.close();
      },
    }),
      signal: undefined,
    });
    await new Promise(resolve => setTimeout(resolve, 10));
    expect(fixture.openStream).not.toHaveBeenCalled();
    const reader = fixture.receiver.stream.getReader();
    const lengths: number[] = [];
    for (;;) {
      const result = await reader.read();
      if (result.done) break;
      lengths.push(result.value.byteLength);
      expect(result.value.every(value => value === 42)).toBe(true);
    }
    expect(lengths).toEqual([BYTE_STREAM_CHUNK_BYTES, BYTE_STREAM_CHUNK_BYTES, BYTE_STREAM_CHUNK_BYTES, 7]);
    expect(bytes.byteLength).toBe(BYTE_STREAM_CHUNK_BYTES * 3 + 7);
    expect(bytes[0]).toBe(42);
    await fixture.sender.completed;
    await fixture.receiver.completed;
  });

  it('does not read ahead while the consumer is paused', async () => {
    let produced = 0;
    const fixture = connect({
      signal: undefined,
      stream: new ReadableStream({
      pull(controller) {
        produced++; controller.enqueue(new Uint8Array(BYTE_STREAM_CHUNK_BYTES));
      },
    }, { highWaterMark: 0 }),
    });
    const reader = fixture.receiver.stream.getReader();
    await reader.read();
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(produced).toBe(1);
    await reader.read();
    expect(produced).toBe(2);
    await reader.cancel();
    await expect(fixture.sender.completed).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('sends the selected subarray, not unrelated backing bytes', async () => {
    const bytes = new Uint8Array([99, 10, 20, 99]);
    const fixture = connect({
      signal: undefined,
      stream: new ReadableStream({
      start(controller) {
        controller.enqueue(bytes.subarray(1, 3)); controller.close();
      },
    }),
    });
    expect([...new Uint8Array(await new Response(fixture.receiver.stream).arrayBuffer())]).toEqual([10, 20]);
    await fixture.sender.completed;
  });

  it('propagates consumer cancellation through a pending read', async () => {
    const cancel = vi.fn();
    const fixture = connect({
      signal: undefined,
      stream: new ReadableStream({
      pull() {
        return new Promise(() => undefined);
      },
      cancel,
    }),
    });
    const reader = fixture.receiver.stream.getReader();
    const pending = reader.read();
    await vi.waitFor(() => expect(fixture.openStream).toHaveBeenCalledOnce());
    await reader.cancel();
    expect(await pending).toMatchObject({ done: true });
    await expect(fixture.sender.completed).rejects.toMatchObject({ name: 'AbortError' });
    expect(cancel).toHaveBeenCalledOnce();
  });

  it('releases a cancelled source lock before asynchronous producer cleanup completes', async () => {
    const cleanup = Promise.withResolvers<void>();
    const cancel = vi.fn(() => cleanup.promise);
    const stream = new ReadableStream<Uint8Array>({
      pull() {
        return new Promise(() => undefined);
      },
      cancel,
    }, { highWaterMark: 0 });
    const fixture = connect({ signal: undefined, stream });
    const reader = fixture.receiver.stream.getReader();
    const pending = reader.read();
    try {
      await vi.waitFor(() => expect(stream.locked).toBe(true));
      await reader.cancel();
      await pending;
      await expect(fixture.sender.completed).rejects.toMatchObject({ name: 'AbortError' });
      expect(cancel).toHaveBeenCalledOnce();
      expect(stream.locked).toBe(false);
    } finally {
      cleanup.resolve();
      fixture.sender.abort({ reason: new Error('Test cleanup') });
      fixture.receiver.abort({ reason: new Error('Test cleanup') });
      reader.releaseLock();
    }
  });

  it('propagates explicit abort even before the lazy factory is opened', async () => {
    const abort = new AbortController();
    const fixture = connect({ signal: abort.signal, stream: new ReadableStream() });
    abort.abort(new Error('stopped'));
    await expect(fixture.sender.completed).rejects.toThrow('stopped');
    await expect(new Response(fixture.receiver.stream).arrayBuffer()).rejects.toThrow('stopped');
    expect(fixture.openStream).not.toHaveBeenCalled();
  });

  it('propagates producer errors instead of returning a truncated successful stream', async () => {
    const fixture = connect({
      signal: undefined,
      stream: new ReadableStream({
      pull(controller) {
        controller.error(new Error('disk read failed'));
      },
    }),
    });
    await expect(new Response(fixture.receiver.stream).arrayBuffer()).rejects.toThrow('disk read failed');
    await expect(fixture.sender.completed).rejects.toThrow('disk read failed');
  });

  it('cancels a late factory result after the consumer has gone', async () => {
    const channel = new MessageChannel();
    const ready = Promise.withResolvers<ReadableStream<Uint8Array>>();
    const openStream = vi.fn(() => ready.promise);
    const sender = serveByteStream({ port: channel.port1, openStream, signal: undefined });
    const receiver = receiveByteStream({ port: channel.port2 });
    const reader = receiver.stream.getReader();
    const read = reader.read();
    await vi.waitFor(() => expect(openStream).toHaveBeenCalledOnce());
    await reader.cancel();
    await read;
    await expect(sender.completed).rejects.toMatchObject({ name: 'AbortError' });
    const cancel = vi.fn();
    ready.resolve(new ReadableStream({ cancel }));
    await vi.waitFor(() => expect(cancel).toHaveBeenCalledOnce());
  });

  it('rejects unsolicited or oversized chunks', async () => {
    const channel = new MessageChannel();
    const receiver = receiveByteStream({ port: channel.port1 });
    channel.port2.postMessage({ type: 'chunk', bytes: new ArrayBuffer(BYTE_STREAM_CHUNK_BYTES + 1) });
    await expect(receiver.completed).rejects.toThrow('Invalid or unrequested');
    channel.port2.close();
  });
});
