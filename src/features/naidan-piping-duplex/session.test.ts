// @vitest-environment node
import { expect, it } from 'vitest';
import { promiseAllKeyed } from '@/utils/promise';
import { sessionPair, opened, drive, exchange, pattern, readAll, useOfflineScope } from '@/features/naidan-piping-duplex/test-support';

useOfflineScope();

it('dynamic duplex transfer and independent half-closes release all claimed buffers', async () => {
  const { a, b } = await sessionPair(), { aStream, bStream } = await opened({ a, b });
  const left = pattern({ size: 48013, seed: 13 }), right = pattern({ size: 37829, seed: 41 });
  const aRead = readAll({ readable: aStream.readable }), bRead = readAll({ readable: bStream.readable });
  const wa = aStream.writable.getWriter(), wb = bStream.writable.getWriter();
  await drive({ a, b, limit: 100, operation: async () => {
    await Promise.all([wa.write(left), wb.write(right)]);
    await Promise.all([wa.close(), wb.close(), aStream.closed, bStream.closed]);
  } });
  const output = await promiseAllKeyed({ left: aRead, right: bRead });
  expect(output.left).toEqual(right); expect(output.right).toEqual(left);
  expect(a.debug()).toMatchObject({ retained: 0 }); expect(b.debug()).toMatchObject({ retained: 0 });
});

it('half-close ends only its send direction while the reverse direction stays writable', async () => {
  const { a, b } = await sessionPair(), { aStream, bStream } = await opened({ a, b });
  const wa = aStream.writable.getWriter(), wb = bStream.writable.getWriter(), rb = bStream.readable.getReader();
  await drive({ a, b, operation: () => wa.close(), limit: 30 });
  await expect(rb.closed).resolves.toBeUndefined(); expect((await rb.read()).done).toBe(true);
  const reading = aStream.readable.getReader().read(), value = pattern({ size: 33, seed: 91 });
  await drive({ a, b, operation: () => wb.write(value), limit: 30 }); expect((await reading).value).toEqual(value);
  await drive({ a, b, operation: () => wb.close(), limit: 30 }); await Promise.all([aStream.closed, bStream.closed]);
});

it('completed unread data survives stopping the session until the application reads it', async () => {
  const { a, b } = await sessionPair(), { aStream, bStream } = await opened({ a, b });
  const data = pattern({ size: 27091, seed: 99 }), wa = aStream.writable.getWriter(), wb = bStream.writable.getWriter();
  await drive({ a, b, operation: () => wa.write(data), limit: 40 });
  await drive({ a, b, limit: 40, operation: async () => {
    await Promise.all([wa.close(), wb.close(), aStream.closed, bStream.closed]);
  } });
  expect(b.debug()).toMatchObject({ retained: 1 });
  b.abort({ reason: 'Stop transport without losing completed bytes' });
  expect(await readAll({ readable: bStream.readable })).toEqual(data);
  expect(b.debug()).toMatchObject({ retained: 0 });
});

it('cancelling a completed readable discards private bytes without converting completion to reset', async () => {
  const { a, b } = await sessionPair(), { aStream, bStream } = await opened({ a, b });
  const wa = aStream.writable.getWriter(), wb = bStream.writable.getWriter();
  await drive({ a, b, operation: () => wa.write(new Uint8Array([7])), limit: 30 });
  await drive({ a, b, operation: async () => {
    await Promise.all([wa.close(), wb.close(), aStream.closed, bStream.closed]);
  }, limit: 40 });
  await bStream.readable.cancel(); expect(b.debug()).toMatchObject({ retained: 0 }); await bStream.closed;
});

it('native abort interrupts a write waiting for peer acceptance and resets the other endpoint', async () => {
  const { a, b } = await sessionPair(), { aStream, bStream } = await opened({ a, b });
  const writer = aStream.writable.getWriter(), writing = expect(writer.write(new Uint8Array([1]))).rejects.toThrow('reset');
  await Promise.resolve(); await writer.abort('Cancel'); await writing;
  const remote = expect(bStream.readable.getReader().read()).rejects.toThrow('reset');
  await exchange({ a, b }); await remote;
});

it.each(['local-abort', 'remote-reset'] as const)('%s errors idle standard reader and writer without requiring another operation', async mode => {
  const { a, b } = await sessionPair(), { aStream, bStream } = await opened({ a, b });
  const reader = aStream.readable.getReader(), writer = aStream.writable.getWriter();
  const reads = expect(reader.closed).rejects.toThrow('reset'), writes = expect(writer.closed).rejects.toThrow('reset');
  if (mode === 'local-abort') a.abort({ reason: 'Local stop' });
  else {
    bStream.abort({ reason: 'Peer stop' }); await exchange({ a, b });
  }
  await Promise.all([reads, writes]);
});

it('the open signal is checked before allocation and owns only a pending OPEN', async () => {
  const { a, b } = await sessionPair(), stopped = new AbortController(); stopped.abort(new Error('Already cancelled'));
  await expect(a.openStream({ signal: stopped.signal })).rejects.toThrow('Already cancelled');
  expect(a.debug()).toMatchObject({ nextId: 0, retained: 0 });
  const stop = new AbortController();
  const stream = await drive({ a, b, operation: () => a.openStream({ signal: stop.signal }), limit: 30 });
  stop.abort(); expect(a.debug()).toMatchObject({ streams: [{ id: stream.id, status: 'active' }] });
});

it('cancelling unadvertised OPEN burns its identifier without producing an incoming event', async () => {
  const { a, b } = await sessionPair(), stop = new AbortController();
  const pending = expect(a.openStream({ signal: stop.signal })).rejects.toThrow(); stop.abort(); await pending;
  await exchange({ a, b });
  expect(a.debug()).toMatchObject({ nextId: 2, retained: 0 }); expect(b.debug()).toMatchObject({ incoming: 0 });
});

it('unclaimed incoming streams occupy the bounded capacity and a further OPEN is rejected', async () => {
  const { a, b } = await sessionPair();
  const openedStreams = Array.from({ length: 32 }, () => a.openStream({ signal: undefined }));
  await drive({ a, b, operation: () => Promise.all(openedStreams), limit: 40 });
  expect(a.debug()).toMatchObject({ retained: 32 }); expect(b.debug()).toMatchObject({ incoming: 32, retained: 32 });
  await expect(a.openStream({ signal: undefined })).rejects.toThrow('capacity');
});

it('simultaneous full-capacity OPENs fail rather than leaving both peers waiting forever', async () => {
  const { a, b } = await sessionPair();
  const operations = [...Array.from({ length: 32 }, () => a.openStream({ signal: undefined })),
    ...Array.from({ length: 32 }, () => b.openStream({ signal: undefined }))];
  const outcome = await drive({ a, b, operation: () => Promise.allSettled(operations), limit: 40 });
  expect(outcome.every(item => item.status === 'rejected')).toBe(true);
  expect(a.debug()).toMatchObject({ retained: 0 }); expect(b.debug()).toMatchObject({ retained: 0 });
});

it('incoming iteration has one owner and one pending next, and return wakes that waiter', async () => {
  const { a, b } = await sessionPair(), iterator = b.incomingStreams[Symbol.asyncIterator]();
  expect(() => b.incomingStreams[Symbol.asyncIterator]()).toThrow('one incoming');
  const pending = iterator.next(); await expect(iterator.next()).rejects.toThrow('one pending');
  await iterator.return?.(); expect((await pending).done).toBe(true);
  await exchange({ a, b }); await expect(a.openStream({ signal: undefined })).rejects.toThrow('draining');
});

it('drain delivers queued incoming streams before ending iteration and can itself be cancelled', async () => {
  const { a, b } = await sessionPair();
  const local = await drive({ a, b, operation: () => a.openStream({ signal: undefined }), limit: 30 });
  const stop = new AbortController(), draining = expect(b.drain({ signal: stop.signal })).rejects.toThrow();
  const incoming = b.incomingStreams[Symbol.asyncIterator](), first = await incoming.next();
  expect(first.done).toBe(false); if (!first.done) expect(first.value.id).toBe(local.id);
  expect((await incoming.next()).done).toBe(true);
  stop.abort(); await draining;
});

it('empty drain wakes a pending incoming next', async () => {
  const { a } = await sessionPair(), iterator = a.incomingStreams[Symbol.asyncIterator]();
  const pending = iterator.next(); await a.drain({ signal: undefined }); expect((await pending).done).toBe(true);
});

it('empty and terminal-only repeated snapshots do not create acknowledgement feedback loops', async () => {
  const { a, b } = await sessionPair(); await exchange({ a, b });
  const before = { a: a.revision, b: b.revision };
  for (let step = 0; step < 5; step++) await exchange({ a, b });
  expect({ a: a.revision, b: b.revision }).toEqual(before);
  const stop = new AbortController(), pending = expect(a.openStream({ signal: stop.signal })).rejects.toThrow(); stop.abort(); await pending;
  const previous = b.revision; await b.acceptCapsule({ capsule: await a.makeCapsule() }); expect(b.revision).toBeGreaterThan(previous);
  const next = b.revision; await b.acceptCapsule({ capsule: await a.makeCapsule() }); expect(b.revision).toBe(next);
});

it('standard pipeTo handles arbitrarily fragmented finite writes without a separate chunking helper', async () => {
  const { a, b } = await sessionPair(), { aStream, bStream } = await opened({ a, b });
  const chunks = [0, 1, 65535, 65536, 65537, 262145].map((size, seed) => pattern({ size, seed: seed + 13 }));
  const source = new ReadableStream<Uint8Array>({ start(controller) {
    for (const chunk of chunks) controller.enqueue(chunk); controller.close();
  } });
  const received = await drive({ a, b, limit: 240, operation: async () => {
    const reading = readAll({ readable: bStream.readable });
    await Promise.all([source.pipeTo(aStream.writable), bStream.writable.getWriter().close(), aStream.closed, bStream.closed]);
    return reading;
  } });
  expect(Buffer.from(received)).toEqual(Buffer.concat(chunks));
});

it('large writes copy only one bounded window and remain abortable under backpressure', async () => {
  const { a, b } = await sessionPair(), { aStream, bStream } = await opened({ a, b });
  const input = pattern({ size: 2 * 1024 * 1024 + 7, seed: 71 }), writer = aStream.writable.getWriter();
  const writing = expect(writer.write(input)).rejects.toThrow(); await Promise.resolve();
  expect(a.debug()).toMatchObject({ retained: 1, streams: [{ txEnd: '65536', ack: '0' }] });
  await writer.abort('Stop'); await writing; await expect(aStream.closed).rejects.toThrow('reset');
  await exchange({ a, b }); await expect(bStream.closed).rejects.toThrow('reset');
});

it.each(['shared', 'detached'] as const)('%s input is rejected and resets both halves', async kind => {
  const { a, b } = await sessionPair(), { aStream, bStream } = await opened({ a, b });
  const input = kind === 'shared' ? new Uint8Array(new SharedArrayBuffer(10)) : new Uint8Array([1]);
  if (kind === 'detached' && input.buffer instanceof ArrayBuffer) structuredClone(input.buffer, { transfer: [input.buffer] });
  await expect(aStream.writable.getWriter().write(input)).rejects.toThrow();
  await expect(aStream.closed).rejects.toThrow('reset'); await exchange({ a, b }); await expect(bStream.closed).rejects.toThrow('reset');
});

it('detaching the caller input between accepted windows never silently discards the suffix', async () => {
  const { a, b } = await sessionPair(), { aStream, bStream } = await opened({ a, b });
  const input = pattern({ size: 150000, seed: 41 }), writer = aStream.writable.getWriter();
  const writing = expect(writer.write(input)).rejects.toThrow(/detached|resized/); await Promise.resolve();
  for (let step = 0; step < 4; step++) {
    await b.acceptCapsule({ capsule: await a.makeCapsule() });
    if (step !== 3) await a.acceptCapsule({ capsule: await b.makeCapsule() });
  }
  expect(b.debug()).toMatchObject({ streams: [{ rxNext: '65536' }] });
  structuredClone(input.buffer, { transfer: [input.buffer] });
  await a.acceptCapsule({ capsule: await b.makeCapsule() }); await writing;
  await exchange({ a, b }); await expect(bStream.closed).rejects.toThrow('reset');
});

it('duplicate and lost acceptance snapshots preserve exactly the intended byte prefix', async () => {
  const { a, b } = await sessionPair(), { aStream, bStream } = await opened({ a, b });
  const data = pattern({ size: 65536, seed: 876 }), wa = aStream.writable.getWriter(), wb = bStream.writable.getWriter();
  const received = readAll({ readable: bStream.readable }), writing = wa.write(data); await Promise.resolve();
  const old = await a.makeCapsule(); await b.acceptCapsule({ capsule: old });
  for (let step = 0; step < 4; step++) {
    await b.acceptCapsule({ capsule: await a.makeCapsule() }); await b.makeCapsule();
  }
  await drive({ a, b, operation: () => writing, limit: 50 });
  expect(await b.acceptCapsule({ capsule: old })).toBe('stale');
  await drive({ a, b, operation: async () => {
    await Promise.all([wa.close(), wb.close(), aStream.closed, bStream.closed]);
  }, limit: 40 });
  expect(await received).toEqual(data);
});

it('resetting one stream does not prevent a different stream from continuing', async () => {
  const { a, b } = await sessionPair(), first = await opened({ a, b });
  const secondA = await drive({ a, b, operation: () => a.openStream({ signal: undefined }), limit: 30 });
  const item = await first.incoming.next(); if (item.done) throw new Error('Missing second stream');
  const secondB = item.value;
  first.aStream.abort({ reason: 'Only the first stream' }); await exchange({ a, b });
  await expect(first.bStream.closed).rejects.toThrow('reset');
  const reading = secondB.readable.getReader().read();
  await drive({ a, b, operation: () => secondA.writable.getWriter().write(new Uint8Array([91])), limit: 30 });
  expect((await reading).value).toEqual(new Uint8Array([91])); expect(a.stopped).toBe(false); expect(b.stopped).toBe(false);
});

it('an errored pipeTo source resets the stream without stopping the session or retaining stream capacity', async () => {
  const { a, b } = await sessionPair(), { aStream, bStream } = await opened({ a, b });
  const failure = new Error('Input producer failed');
  const source = new ReadableStream<Uint8Array>({ start(controller) {
    controller.error(failure);
  } });
  await expect(source.pipeTo(aStream.writable)).rejects.toBe(failure);
  await expect(aStream.closed).rejects.toThrow('reset');
  await exchange({ a, b }); await expect(bStream.closed).rejects.toThrow('reset');
  expect(a.debug()).toMatchObject({ retained: 0 }); expect(b.debug()).toMatchObject({ retained: 0 });
  expect(a.stopped).toBe(false); expect(b.stopped).toBe(false);
  expect(aStream.writable.locked).toBe(false);
});

it('an errored pipeTo destination cancels reception and wakes a peer write blocked on further credit', async () => {
  const { a, b } = await sessionPair(), { aStream, bStream } = await opened({ a, b });
  const failure = new Error('Output consumer failed');
  const sink = new WritableStream<Uint8Array>({ write() {
    throw failure;
  } });
  const reader = expect(bStream.readable.pipeTo(sink)).rejects.toBe(failure);
  const writer = aStream.writable.getWriter();
  const writing = expect(writer.write(pattern({ size: 131073, seed: 93 }))).rejects.toThrow('reset');
  try {
    await drive({ a, b, limit: 30, operation: async () => {
      await Promise.all([reader, writing]);
    } });
    await expect(aStream.closed).rejects.toThrow('reset'); await expect(bStream.closed).rejects.toThrow('reset');
    expect(a.debug()).toMatchObject({ retained: 0 }); expect(b.debug()).toMatchObject({ retained: 0 });
    expect(bStream.readable.locked).toBe(false); expect(sink.locked).toBe(false);
    expect(a.stopped).toBe(false); expect(b.stopped).toBe(false);
  } finally {
    writer.releaseLock();
  }
});

it('aborting an active writer rejects queued writes and close rather than leaving their promises pending', async () => {
  const { a, b } = await sessionPair(), { aStream, bStream } = await opened({ a, b });
  const writer = aStream.writable.getWriter();
  const first = expect(writer.write(pattern({ size: 65537, seed: 51 }))).rejects.toThrow();
  const second = expect(writer.write(new Uint8Array([8]))).rejects.toThrow();
  const closing = expect(writer.close()).rejects.toThrow();
  try {
    await Promise.resolve();
    await writer.abort(new Error('Abort queued work'));
    await Promise.all([first, second, closing]);
    await expect(writer.closed).rejects.toThrow();
    await exchange({ a, b }); await expect(bStream.closed).rejects.toThrow('reset');
    expect(a.debug()).toMatchObject({ retained: 0 }); expect(b.debug()).toMatchObject({ retained: 0 });
  } finally {
    writer.releaseLock();
  }
});
