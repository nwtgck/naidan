// @vitest-environment node
import { expect, it, vi } from 'vitest';
import { FramedDuplex } from '@/features/naidan-rpc/framing';
import { RpcRetirementError } from '@/features/naidan-rpc/stream-retirement';

it('framed stop joins both cleanup algorithms and releases both locks even on failure', async () => {
  const cleanup = new Error('Reader cleanup failed'), entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  const readable = new ReadableStream<Uint8Array>({
    cancel() {
      throw cleanup;
    },
  });
  const writable = new WritableStream<Uint8Array>({
    abort() {
      entered.resolve(); return release.promise;
    },
  });
  const framed = new FramedDuplex({ onProtocolFailure: () => {}, duplex: { readable, writable, closed: Promise.resolve(), abort: () => {} } });
  const retirement = framed.stop({ error: new Error('Call cancelled') }); let retired = false;
  void retirement.then(() => {
    retired = true;
  }, () => {
    retired = true;
  });
  await entered.promise; expect(retired).toBe(false); release.resolve();
  await expect(retirement).rejects.toMatchObject({ cause: cleanup });
  expect(readable.locked).toBe(false); expect(writable.locked).toBe(false);
  expect(framed.stop({ error: new Error('Again') })).toBe(retirement);
});

it('framed stop does not turn existing transport error into a cleanup failure', async () => {
  const logical = new Error('Transport ended');
  const readable = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.error(logical);
    },
  });
  const writable = new WritableStream<Uint8Array>({
    start(controller) {
      controller.error(logical);
    },
  });
  const framed = new FramedDuplex({ onProtocolFailure: () => {}, duplex: { readable, writable, closed: Promise.reject(logical).catch(() => {}), abort: () => {} } });
  await expect(framed.stop({ error: new Error('Cancel') })).resolves.toBeUndefined();
  expect(readable.locked).toBe(false); expect(writable.locked).toBe(false);
});

it('framed retirement still waits for a read/decode continuation after native cancellation', async () => {
  const readable = new ReadableStream<Uint8Array>(), writable = new WritableStream<Uint8Array>();
  const readDone = Promise.withResolvers<ReadableStreamReadResult<Uint8Array>>();
  const getReader = readable.getReader.bind(readable); let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  vi.spyOn(readable, 'getReader').mockImplementation(() => {
    reader = getReader(); vi.spyOn(reader, 'read').mockReturnValue(readDone.promise); return reader;
  });
  const framed = new FramedDuplex({ onProtocolFailure: () => {}, duplex: { readable, writable, closed: Promise.resolve(), abort: () => {} } });
  const read = framed.read(); void read.catch(() => {});
  const stopped = framed.stop({ error: new Error('Stop') }); let retired = false;
  void stopped.then(() => {
    retired = true;
  }, () => {
    retired = true;
  });
  await Promise.resolve(); await Promise.resolve(); expect(retired).toBe(false);
  readDone.resolve({ done: true, value: undefined }); await Promise.allSettled([read]); await stopped;
  expect(readable.locked).toBe(false); expect(writable.locked).toBe(false);
  vi.restoreAllMocks();
});

it('partial constructor failure releases its reader without stealing an existing writer lock', () => {
  const readable = new ReadableStream<Uint8Array>(), writable = new WritableStream<Uint8Array>(), writer = writable.getWriter();
  expect(() => new FramedDuplex({ onProtocolFailure: () => {}, duplex: { readable, writable, closed: Promise.resolve(), abort: () => {} } })).toThrow(TypeError);
  expect(readable.locked).toBe(false); expect(writable.locked).toBe(true); writer.releaseLock();
});

it('genuine lock-release failure remains a retirement failure', async () => {
  const readable = new ReadableStream<Uint8Array>(), writable = new WritableStream<Uint8Array>();
  const getReader = readable.getReader.bind(readable), cleanup = new Error('Release failed');
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined, release: (() => void) | undefined;
  vi.spyOn(readable, 'getReader').mockImplementation(() => {
    reader = getReader(); release = reader.releaseLock.bind(reader); vi.spyOn(reader, 'releaseLock').mockImplementation(() => {
      throw cleanup;
    }); return reader;
  });
  const framed = new FramedDuplex({ onProtocolFailure: () => {}, duplex: { readable, writable, closed: Promise.resolve(), abort: () => {} } });
  await expect(framed.stop({ error: new Error('Stop') })).rejects.toBeInstanceOf(RpcRetirementError);
  expect(writable.locked).toBe(false); release?.(); vi.restoreAllMocks();
});
