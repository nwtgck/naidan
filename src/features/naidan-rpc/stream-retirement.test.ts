// @vitest-environment node
import { expect, it, vi } from 'vitest';
import { abortWriter, cancelReader, releaseLocks, retireUnadoptedStreams, RpcRetirementError } from '@/features/naidan-rpc/stream-retirement';

it('already-errored readable cancellation is a logical error, not failed cleanup', async () => {
  const logical = new Error('Source already errored'), cancel = vi.fn();
  const reader = new ReadableStream({
    start(controller) {
      controller.error(logical);
    },
    cancel,
  }).getReader();
  await expect(cancelReader({ reader, reason: new Error('Local stop') })).resolves.toBeUndefined();
  expect(cancel).not.toHaveBeenCalled(); reader.releaseLock();
});

it('actual readable cancel failure is retained even when it throws the stop reason itself', async () => {
  const error = new Error('Shared reason');
  const reader = new ReadableStream({
    cancel(reason) {
      throw reason;
    },
  }).getReader();
  await expect(cancelReader({ reader, reason: error })).rejects.toMatchObject({ name: 'RpcRetirementError', cause: error });
  await expect(reader.closed).resolves.toBeUndefined(); reader.releaseLock();
});

it('already-errored writable abort does not invoke the abort algorithm', async () => {
  const logical = new Error('Sink errored'), abort = vi.fn();
  const writer = new WritableStream({
    start(controller) {
      controller.error(logical);
    },
    abort,
  }).getWriter();
  expect(writer.desiredSize).toBe(null);
  await expect(abortWriter({ writer, reason: new Error('Local stop') })).resolves.toBeUndefined();
  expect(abort).not.toHaveBeenCalled(); writer.releaseLock();
});

it('an already-erroring writable joins its in-flight write and does not mistake stored error for failed abort', async () => {
  const logical = new Error('Already erroring'), entered = Promise.withResolvers<void>(), finishWrite = Promise.withResolvers<void>();
  let control: WritableStreamDefaultController | undefined;
  const abort = vi.fn();
  const writer = new WritableStream({
    start(controller) {
      control = controller;
    },
    write() {
      entered.resolve(); return finishWrite.promise;
    },
    abort,
  }).getWriter();
  const writing = writer.write(1); void writing.catch(() => {}); await entered.promise;
  control!.error(logical); expect(writer.desiredSize).toBe(null);
  let settled = false; const retirement = abortWriter({ writer, reason: new Error('Stop') });
  void retirement.then(() => {
    settled = true;
  }, () => {
    settled = true;
  });
  await Promise.resolve(); expect(settled).toBe(false); finishWrite.resolve();
  await expect(retirement).resolves.toBeUndefined(); await Promise.allSettled([writing]);
  expect(abort).not.toHaveBeenCalled(); writer.releaseLock();
});

it('initially writable abort failure is real even when it is identical to writer.closed rejection', async () => {
  const error = new Error('Same object'), writer = new WritableStream({
    abort(reason) {
      throw reason;
    },
  }).getWriter();
  expect(writer.desiredSize).not.toBe(null);
  const result = abortWriter({ writer, reason: error });
  await expect(result).rejects.toBeInstanceOf(RpcRetirementError);
  await expect(result).rejects.toMatchObject({ cause: error }); await expect(writer.closed).rejects.toBe(error);
  writer.releaseLock();
});

it('both lock releases are attempted before failure is returned', () => {
  const error = new Error('Reader release failed'), readerRelease = vi.fn(() => {
      throw error;
    }), writerRelease = vi.fn();
  const reader = { closed: Promise.resolve(), cancel: async () => {}, releaseLock: readerRelease };
  const writer = { closed: Promise.resolve(), abort: async () => {}, releaseLock: writerRelease, desiredSize: 1 };
  expect(() => releaseLocks({ reader, writer })).toThrow(RpcRetirementError);
  expect(readerRelease).toHaveBeenCalledOnce(); expect(writerRelease).toHaveBeenCalledOnce();
});

it('raw cleanup joins both algorithms and leaves no acquired locks after one fails', async () => {
  const failure = new Error('Cancel failed'), gate = Promise.withResolvers<void>(), entered = Promise.withResolvers<void>();
  const readable = new ReadableStream<Uint8Array>({
    cancel() {
      throw failure;
    },
  });
  const writable = new WritableStream<Uint8Array>({
    abort() {
      entered.resolve(); return gate.promise;
    },
  });
  const retirement = retireUnadoptedStreams({ readable, writable, reason: 'Stop' }); let settled = false;
  void retirement.then(() => {
    settled = true;
  }, () => {
    settled = true;
  });
  await entered.promise; expect(settled).toBe(false); gate.resolve();
  await expect(retirement).rejects.toMatchObject({ cause: failure });
  expect(readable.locked).toBe(false); expect(writable.locked).toBe(false);
});

it('raw cleanup never releases locks already held by another owner', async () => {
  const readable = new ReadableStream<Uint8Array>(), writable = new WritableStream<Uint8Array>();
  const reader = readable.getReader(), writer = writable.getWriter();
  await retireUnadoptedStreams({ readable, writable, reason: 'Stop' });
  expect(readable.locked).toBe(true); expect(writable.locked).toBe(true);
  await reader.cancel(); await writer.abort(); reader.releaseLock(); writer.releaseLock();
});

it.each([false, true])('reentrant abort-signal erroring stays conservatively unconfirmed (same reason: %s)', async same => {
  const reason = new Error('Stop'), logical = same ? reason : new Error('Reentrant error'), abort = vi.fn();
  const writer = new WritableStream({
    start(controller) {
      controller.signal.addEventListener('abort', () => controller.error(logical), { once: true });
    },
    abort,
  }).getWriter();
  await writer.ready;
  expect(writer.desiredSize).not.toBe(null);
  const failure: unknown = await abortWriter({ writer, reason }).catch(error => error);
  expect(failure).toBeInstanceOf(RpcRetirementError);
  if (failure instanceof RpcRetirementError && failure.cause !== logical) {
    // Node 24 currently throws an internal assertion in this reentrant path.
    // This verifies fail-closed handling, not normative browser conformance.
    expect(failure.cause).toMatchObject({ code: 'ERR_INTERNAL_ASSERTION' });
  }
  expect(abort).not.toHaveBeenCalled(); await expect(writer.closed).rejects.toBe(logical); writer.releaseLock();
});

it('first cleanup failure notifies promptly even if notification throws and another owner is held', async () => {
  const error = new Error('Cancel failed'), gate = Promise.withResolvers<void>(), notified = Promise.withResolvers<unknown>();
  const readable = new ReadableStream<Uint8Array>({
    cancel() {
      throw error;
    },
  });
  const writable = new WritableStream<Uint8Array>({
    abort() {
      return gate.promise;
    },
  });
  const retirement = retireUnadoptedStreams({
    readable,
    writable,
    reason: 'Stop',
    onFailure({ error: cause }) {
      notified.resolve(cause); throw new Error('Notification failure');
    },
  });
  const rejected = expect(retirement).rejects.toMatchObject({ cause: error });
  expect(await notified.promise).toBe(error); expect(readable.locked).toBe(true); expect(writable.locked).toBe(true);
  gate.resolve(); await rejected; expect(readable.locked).toBe(false); expect(writable.locked).toBe(false);
});

it.each(['resolve', 'reject'] as const)('abort signals a held in-flight close before joining its %s outcome', async outcome => {
  const entered = Promise.withResolvers<void>(), end = Promise.withResolvers<void>(), logical = new Error('Close failed');
  const abort = vi.fn();
  const writer = new WritableStream({
    start(controller) {
      controller.signal.addEventListener('abort', () => {
        if (outcome === 'resolve') end.resolve(); else end.reject(logical);
      });
    },
    close() {
      entered.resolve(); return end.promise;
    },
    abort,
  }).getWriter();
  const closing = writer.close(); void closing.catch(() => {}); await entered.promise;
  await expect(abortWriter({ writer, reason: new Error('Stop'), ownedClose: closing })).resolves.toBeUndefined();
  expect(abort).not.toHaveBeenCalled(); writer.releaseLock();
});

it('queued close cannot conceal a genuine abort failure throwing the same stop reason', async () => {
  const start = Promise.withResolvers<void>(), reason = new Error('Same reason'), close = vi.fn();
  const writer = new WritableStream({
    start() {
      return start.promise;
    },
    close,
    abort() {
      throw reason;
    },
  }).getWriter();
  const closing = writer.close(); void closing.catch(() => {});
  const retirement = abortWriter({ writer, reason, ownedClose: closing });
  start.resolve(); await expect(retirement).rejects.toMatchObject({ cause: reason });
  expect(close).not.toHaveBeenCalled(); writer.releaseLock();
});
