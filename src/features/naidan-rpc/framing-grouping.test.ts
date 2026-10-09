// @vitest-environment node
import { afterEach, expect, it, vi } from 'vitest';
import { encode } from './codec';
import { FramedDuplex, frameSchema, TEST_ONLY } from './framing';
import type { Frame } from './framing';
import { encodeProtocolHeader } from './protocol-header';
import { FRAME_BYTES, QUEUE_FRAMES, WRITE_BATCH_BYTES } from './primitives';

function wireBytes({ frame }: { frame: Frame }): Uint8Array {
  const payload = encode({ value: frameSchema.parse(frame), limit: FRAME_BYTES }), bytes = new Uint8Array(payload.length + 4);
  new DataView(bytes.buffer).setUint32(0, payload.length, false); bytes.set(payload, 4); return bytes;
}
function joined({ parts }: { parts: Uint8Array[] }): Uint8Array {
  const bytes = new Uint8Array(parts.reduce((size, part) => size + part.length, 0)); let offset = 0;
  for (const part of parts) {
    bytes.set(part, offset); offset += part.length;
  }
  return bytes;
}
function sizedFrame({ length }: { length: number }): Frame {
  let size = length;
  for (let attempt = 0; attempt < 4; attempt++) {
    const frame: Frame = { type: 'result', value: Uint8Array.from({ length: size }, (_, index) => index % 251) };
    const actual = wireBytes({ frame }).length;
    if (actual === length) return frame;
    size += length - actual;
  }
  throw new Error('Fixture could not construct the requested frame size');
}
function outcome({ promise }: { promise: Promise<void> }) {
  const state: { kind: 'pending' | 'resolved' | 'rejected'; reason: unknown } = { kind: 'pending', reason: undefined };
  const settled = promise.then(() => {
    state.kind = 'resolved';
  }, reason => {
    state.kind = 'rejected'; state.reason = reason;
  });
  return { state, settled };
}
function heldWriter() {
  type Write = { bytes: Uint8Array; release: ReturnType<typeof Promise.withResolvers<void>> };
  const writes: Write[] = [], waiting = new Map<number, ReturnType<typeof Promise.withResolvers<Write>>>();
  const close = vi.fn(), abort = vi.fn(), readable = new ReadableStream<Uint8Array>();
  const writable = new WritableStream<Uint8Array>({
    write(bytes) {
      const write = { bytes, release: Promise.withResolvers<void>() }; writes.push(write);
      waiting.get(writes.length - 1)?.resolve(write); return write.release.promise;
    },
    close,
    abort,
  });
  const getWriter = writable.getWriter.bind(writable); let lowerWrite: ReturnType<typeof vi.spyOn> | undefined;
  vi.spyOn(writable, 'getWriter').mockImplementation(() => {
    const writer = getWriter(); lowerWrite = vi.spyOn(writer, 'write'); return writer;
  });
  const framed = new FramedDuplex({ onProtocolFailure: () => {}, duplex: { readable, writable, closed: Promise.resolve(), abort: () => {} } });
  function writeAt({ index }: { index: number }): Promise<Write> {
    const write = writes[index]; if (write) return Promise.resolve(write);
    const pending = Promise.withResolvers<Write>(); waiting.set(index, pending); return pending.promise;
  }
  return { framed, readable, writable, writes, writeAt, close, abort, lowerWrite };
}

afterEach(() => vi.restoreAllMocks());

it('submits the preamble and each unblocked first frame immediately without a batching timer or microtask', async () => {
  const { framed, lowerWrite, writeAt, writes, close } = heldWriter();
  expect(lowerWrite).toHaveBeenCalledOnce();
  const header = await writeAt({ index: 0 }); expect(header.bytes).toEqual(encodeProtocolHeader());
  header.release.resolve(); await framed.preambleSent;
  const sent = framed.send({ frame: { type: 'ack' } });
  expect(lowerWrite).toHaveBeenCalledTimes(2);
  const ack = await writeAt({ index: 1 }); expect(ack.bytes).toEqual(wireBytes({ frame: { type: 'ack' } }));
  expect(TEST_ONLY.writeOwnership({ framed }).scratchBytes).toBe(0);
  ack.release.resolve(); await sent; await framed.finish(); await framed.retire();
  expect(writes).toHaveLength(2); expect(close).toHaveBeenCalledOnce();
});

it('groups only already-queued finite frames behind a held write and preserves FIFO completion and wire bytes', async () => {
  const { framed, writeAt, writes, close } = heldWriter(), completed: number[] = [];
  const frames: Frame[] = Array.from({ length: 12 }, (_, index) => ({ type: 'notice', name: `event${index}`, value: index }));
  const sends = frames.map((frame, index) => framed.send({ frame }).then(() => {
    completed.push(index);
  }));
  const finished = outcome({ promise: framed.finish() });
  const header = await writeAt({ index: 0 }); expect(writes).toHaveLength(1); expect(completed).toEqual([]);
  header.release.resolve(); const batch = await writeAt({ index: 1 });
  expect(batch.bytes).toEqual(joined({ parts: frames.map(frame => wireBytes({ frame })) }));
  expect(batch.bytes.length).toBeLessThanOrEqual(WRITE_BATCH_BYTES); expect(completed).toEqual([]); expect(close).not.toHaveBeenCalled();
  const owned = TEST_ONLY.writeOwnership({ framed });
  expect(owned.retainedBytes).toBe(batch.bytes.length); expect(owned.scratchBytes).toBe(batch.bytes.buffer.byteLength);
  batch.release.resolve(); await Promise.all(sends); await finished.settled; await framed.retire();
  expect(completed).toEqual(Array.from({ length: frames.length }, (_, index) => index)); expect(finished.state.kind).toBe('resolved');
  expect(writes).toHaveLength(2); expect(close).toHaveBeenCalledOnce();
  expect(joined({ parts: writes.map(write => write.bytes) })).toEqual(joined({ parts: [encodeProtocolHeader(), ...frames.map(frame => wireBytes({ frame }))] }));
  expect(TEST_ONLY.writeOwnership({ framed })).toEqual({ retainedBytes: 0, scratchBytes: 0, queue: [], inFlightEntries: 0 });
});

it.each([1, 2, 3])('preserves a length prefix split after %s bytes, partial-entry ownership, and promise boundaries', async prefixBytes => {
  const { framed, writeAt, writes } = heldWriter();
  const first = sizedFrame({ length: WRITE_BATCH_BYTES - prefixBytes }), second: Frame = { type: 'ack' };
  const firstWire = wireBytes({ frame: first }), secondWire = wireBytes({ frame: second });
  const firstSent = outcome({ promise: framed.send({ frame: first }) }), secondSent = outcome({ promise: framed.send({ frame: second }) });
  (await writeAt({ index: 0 })).release.resolve(); const batch = await writeAt({ index: 1 });
  expect(batch.bytes.length).toBe(WRITE_BATCH_BYTES);
  expect(Buffer.from(batch.bytes).equals(Buffer.from(joined({ parts: [firstWire, secondWire.subarray(0, prefixBytes)] })))).toBe(true);
  expect(TEST_ONLY.writeOwnership({ framed }).queue.map(entry => entry.offset)).toEqual([0, 0]);
  expect(firstSent.state.kind).toBe('pending'); expect(secondSent.state.kind).toBe('pending');
  batch.release.resolve(); const suffix = await writeAt({ index: 2 }); await firstSent.settled;
  expect(firstSent.state.kind).toBe('resolved'); expect(secondSent.state.kind).toBe('pending');
  expect(suffix.bytes).toEqual(secondWire.subarray(prefixBytes)); expect(suffix.bytes.buffer.byteLength).toBe(secondWire.length);
  expect(TEST_ONLY.writeOwnership({ framed })).toEqual({ retainedBytes: secondWire.length, scratchBytes: 0, queue: [{ offset: prefixBytes, backingBytes: secondWire.length }], inFlightEntries: 1 });
  suffix.release.resolve(); await secondSent.settled; await framed.finish(); await framed.retire();
  expect(Buffer.from(joined({ parts: writes.map(write => write.bytes) })).equals(Buffer.from(joined({ parts: [encodeProtocolHeader(), firstWire, secondWire] })))).toBe(true);
  expect(writes.every(write => write.bytes.length <= WRITE_BATCH_BYTES)).toBe(true);
});

it('retains a large entry in full through grouped and direct slices, without copying a single-entry prefix', async () => {
  const { framed, writeAt, writes } = heldWriter(), first: Frame = { type: 'ack' }, second = sizedFrame({ length: 3 * WRITE_BATCH_BYTES + 7 });
  const firstWire = wireBytes({ frame: first }), secondWire = wireBytes({ frame: second });
  const firstSent = outcome({ promise: framed.send({ frame: first }) }), secondSent = outcome({ promise: framed.send({ frame: second }) });
  (await writeAt({ index: 0 })).release.resolve(); (await writeAt({ index: 1 })).release.resolve();
  let backing: ArrayBufferLike | undefined;
  for (let index = 2; index <= 4; index++) {
    const write = await writeAt({ index }); await firstSent.settled;
    expect(firstSent.state.kind).toBe('resolved'); expect(secondSent.state.kind).toBe('pending');
    const owned = TEST_ONLY.writeOwnership({ framed });
    expect(owned.retainedBytes).toBe(secondWire.length); expect(owned.scratchBytes).toBe(0);
    expect(owned.queue).toEqual([{ offset: (index - 1) * WRITE_BATCH_BYTES - firstWire.length, backingBytes: secondWire.length }]);
    expect(write.bytes.buffer.byteLength).toBe(secondWire.length);
    if (backing) expect(write.bytes.buffer).toBe(backing); else backing = write.bytes.buffer;
    write.release.resolve();
  }
  await secondSent.settled; await framed.finish(); await framed.retire();
  expect(writes.every(write => write.bytes.length <= WRITE_BATCH_BYTES)).toBe(true);
  expect(Buffer.from(joined({ parts: writes.map(write => write.bytes) })).equals(Buffer.from(joined({ parts: [encodeProtocolHeader(), firstWire, secondWire] })))).toBe(true);
  expect(TEST_ONLY.writeOwnership({ framed }).retainedBytes).toBe(0);
});

it.each([undefined, null, false, 0, ''])('retains the exact first stop cause %s and active scratch through late success and failure', async original => {
  for (const result of ['success', 'failure'] as const) {
    const { framed, writeAt, writes, readable, writable } = heldWriter();
    const first = sizedFrame({ length: WRITE_BATCH_BYTES - 7 }), second = sizedFrame({ length: WRITE_BATCH_BYTES + 21 });
    const sends = [first, second, { type: 'ack' } as const].map(frame => outcome({ promise: framed.send({ frame }) }));
    const finished = outcome({ promise: framed.finish() });
    (await writeAt({ index: 0 })).release.resolve(); const batch = await writeAt({ index: 1 });
    const retirement = framed.stop({ error: original }), retired = outcome({ promise: retirement });
    expect(framed.stop({ error: new Error('Later stop') })).toBe(retirement);
    await Promise.all(sends.map(send => send.settled)); await finished.settled;
    for (const send of sends) expect(send.state).toEqual({ kind: 'rejected', reason: original });
    expect(finished.state).toEqual({ kind: 'rejected', reason: original }); expect(retired.state.kind).toBe('pending');
    expect(TEST_ONLY.writeOwnership({ framed })).toEqual({ retainedBytes: wireBytes({ frame: first }).length + wireBytes({ frame: second }).length, scratchBytes: WRITE_BATCH_BYTES, queue: [], inFlightEntries: 2 });
    expect(readable.locked).toBe(true); expect(writable.locked).toBe(true);
    switch (result) {
    case 'success': batch.release.resolve(); break;
    case 'failure': batch.release.reject(new Error('Late lower failure')); break;
    default: { const exhaustive: never = result; throw new Error(String(exhaustive)); }
    }
    await retirement; await retired.settled;
    expect(retired.state.kind).toBe('resolved'); expect(writes).toHaveLength(2);
    expect(TEST_ONLY.writeOwnership({ framed })).toEqual({ retainedBytes: 0, scratchBytes: 0, queue: [], inFlightEntries: 0 });
    await expect(framed.send({ frame: { type: 'ack' } })).rejects.toBe(original);
    await expect(framed.finish()).rejects.toBe(original); await expect(framed.read()).rejects.toBe(original);
    expect(readable.locked).toBe(false); expect(writable.locked).toBe(false);
  }
});

it('stop before preamble settlement discards queued frames but retains the complete in-flight header', async () => {
  const { framed, writeAt, writes } = heldWriter(), original = new Error('Stop before first settlement');
  const queued = outcome({ promise: framed.send({ frame: { type: 'ack' } }) }), header = await writeAt({ index: 0 });
  const stopped = framed.stop({ error: original }); await queued.settled;
  expect(TEST_ONLY.writeOwnership({ framed })).toEqual({ retainedBytes: encodeProtocolHeader().buffer.byteLength, scratchBytes: 0, queue: [], inFlightEntries: 1 });
  await expect(framed.preambleSent).rejects.toBe(original); header.release.resolve(); await stopped;
  expect(writes).toHaveLength(1); expect(TEST_ONLY.writeOwnership({ framed }).retainedBytes).toBe(0);
});

it.each([undefined, null, false, 0, ''])('rejects every grouped promise with a falsy lower failure %s and does not continue writing', async original => {
  const { framed, writeAt, writes } = heldWriter();
  const sends = Array.from({ length: 3 }, () => outcome({ promise: framed.send({ frame: { type: 'ack' } }) }));
  const finished = outcome({ promise: framed.finish() });
  (await writeAt({ index: 0 })).release.resolve(); (await writeAt({ index: 1 })).release.reject(original);
  await Promise.all(sends.map(send => send.settled)); await finished.settled;
  for (const send of sends) expect(send.state).toEqual({ kind: 'rejected', reason: original });
  expect(finished.state).toEqual({ kind: 'rejected', reason: original });
  await expect(framed.send({ frame: { type: 'ack' } })).rejects.toBe(original); await framed.stop({ error: new Error('Later cancellation') });
  expect(writes).toHaveLength(2); expect(TEST_ONLY.writeOwnership({ framed }).retainedBytes).toBe(0); expect(TEST_ONLY.writeOwnership({ framed }).scratchBytes).toBe(0);
});

it('preserves the existing frame-count admission limit while the first write is held', async () => {
  const { framed, writeAt } = heldWriter(), sends: Promise<void>[] = [];
  for (let index = 1; index < QUEUE_FRAMES; index++) sends.push(framed.send({ frame: { type: 'ack' } }));
  expect(() => framed.send({ frame: { type: 'ack' } })).toThrow(expect.objectContaining({ code: 'RESOURCE_EXHAUSTED', details: expect.objectContaining({ constraint: 'queued-frames', observed: QUEUE_FRAMES + 1 }) }));
  (await writeAt({ index: 0 })).release.resolve(); (await writeAt({ index: 1 })).release.resolve();
  await Promise.all(sends); await framed.finish(); await framed.retire();
});

it('graceful retirement and close wait for every grouped and partial write', async () => {
  const { framed, writeAt, close, readable, writable } = heldWriter();
  const first = framed.send({ frame: { type: 'ack' } }), second = framed.send({ frame: sizedFrame({ length: 2 * WRITE_BATCH_BYTES }) });
  const finished = outcome({ promise: framed.finish() }), retired = outcome({ promise: framed.retire() });
  (await writeAt({ index: 0 })).release.resolve(); (await writeAt({ index: 1 })).release.resolve();
  const middle = await writeAt({ index: 2 }); await first;
  expect(finished.state.kind).toBe('pending'); expect(retired.state.kind).toBe('pending'); expect(close).not.toHaveBeenCalled();
  middle.release.resolve(); const last = await writeAt({ index: 3 }); expect(close).not.toHaveBeenCalled(); last.release.resolve();
  await second; await finished.settled; await retired.settled;
  expect(finished.state.kind).toBe('resolved'); expect(retired.state.kind).toBe('resolved'); expect(close).toHaveBeenCalledOnce();
  expect(readable.locked).toBe(false); expect(writable.locked).toBe(false);
});

it.each(['success', 'failure'] as const)('stop joins a held close with late %s after grouped sends have completed', async result => {
  const { framed, writeAt, close, readable, writable } = heldWriter();
  const closing = Promise.withResolvers<void>(), entered = Promise.withResolvers<void>(), original = new Error('Stop during close');
  close.mockImplementation(() => {
    entered.resolve(); return closing.promise;
  });
  const sends = [framed.send({ frame: { type: 'ack' } }), framed.send({ frame: { type: 'ack' } })];
  const finished = outcome({ promise: framed.finish() });
  (await writeAt({ index: 0 })).release.resolve(); (await writeAt({ index: 1 })).release.resolve(); await Promise.all(sends); await entered.promise;
  const retirement = framed.stop({ error: original }), retired = outcome({ promise: retirement }); await finished.settled;
  expect(finished.state).toEqual({ kind: 'rejected', reason: original }); expect(retired.state.kind).toBe('pending');
  expect(TEST_ONLY.writeOwnership({ framed })).toEqual({ retainedBytes: 0, scratchBytes: 0, queue: [], inFlightEntries: 0 });
  switch (result) {
  case 'success': closing.resolve(); break;
  case 'failure': closing.reject(new Error('Late close failure')); break;
  default: { const exhaustive: never = result; throw new Error(String(exhaustive)); }
  }
  await retirement; await expect(framed.finish()).rejects.toBe(original); expect(readable.locked).toBe(false); expect(writable.locked).toBe(false);
});

it('preserves close failure after successful grouped sends without manufacturing successful finish', async () => {
  const { framed, writeAt, close } = heldWriter(), original = new Error('Lower close failed');
  close.mockImplementation(() => Promise.reject(original));
  const sends = [framed.send({ frame: { type: 'ack' } }), framed.send({ frame: { type: 'ack' } })];
  const finished = outcome({ promise: framed.finish() });
  (await writeAt({ index: 0 })).release.resolve(); (await writeAt({ index: 1 })).release.resolve(); await Promise.all(sends); await finished.settled;
  expect(finished.state).toEqual({ kind: 'rejected', reason: original }); await expect(framed.finish()).rejects.toBe(original);
  await framed.stop({ error: new Error('Secondary cancellation') }); expect(TEST_ONLY.writeOwnership({ framed }).retainedBytes).toBe(0);
});
