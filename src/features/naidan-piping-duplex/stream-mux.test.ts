// @vitest-environment node
import { expect, it } from 'vitest';
import { StreamMux } from '@/features/naidan-piping-duplex/stream-mux';
import { decodeFrames, BATCH_BYTES } from '@/features/naidan-piping-duplex/batch-wire';
import type { Frame, ReceiveLimits } from '@/features/naidan-piping-duplex/batch-wire';
import type { Transmission } from '@/features/naidan-piping-duplex/stream-mux';

const limits = { streams: 32, streamWindow: 1114112, connectionWindow: 4194304 };

function pair({ window = limits }: { window?: ReceiveLimits } = {}) {
  const a = new StreamMux({ role: 'initiator', limits: window }), b = new StreamMux({ role: 'responder', limits: window });
  a.setPeerLimits({ limits: window }); b.setPeerLimits({ limits: window }); a.activate(); b.activate(); return { a, b };
}

function frames({ transmission }: { transmission: Transmission }): Frame[] {
  return transmission.plaintexts.flatMap(bytes => decodeFrames({ bytes }));
}

function deliver({ from, to, complete = true }: { from: StreamMux; to: StreamMux; complete?: boolean }): Transmission | undefined {
  const transmission = from.prepare({});
  if (transmission) {
    for (const frame of frames({ transmission })) to.accept({ frame });
    if (complete) transmission.complete({ result: { kind: 'sent' } });
  }
  return transmission;
}

async function streams({ a, b }: { a: StreamMux; b: StreamMux }) {
  const left = a.openStream({ signal: undefined }); deliver({ from: a, to: b });
  const incoming = b.incomingStreams[Symbol.asyncIterator](); const right = incoming.next();
  deliver({ from: b, to: a }); const item = await right; if (item.done) throw new Error('Missing stream');
  return { left: await left, right: item.value };
}

it('batches a known 1 MiB write and grants reverse-direction credit from READY', async () => {
  const { a, b } = pair(), { left, right } = await streams({ a, b });
  const input = new Uint8Array(1048576).fill(53), writer = left.writable.getWriter();
  const written = writer.write(input); await Promise.resolve();
  const tx = a.prepare({})!; expect(tx).toBeDefined();
  const batchFrames = frames({ transmission: tx });
  expect(batchFrames.filter(frame => frame.kind === 'data').reduce((n, frame) => n + (frame.kind === 'data' ? frame.bytes.length : 0), 0)).toBe(input.length);
  expect(tx.plaintexts.reduce((n, p) => n + p.length + 20, 16)).toBeLessThanOrEqual(BATCH_BYTES);
  for (const frame of batchFrames) b.accept({ frame }); tx.complete({ result: { kind: 'sent' } }); await written;
  const reader = right.readable.getReader(); let size = 0;
  while (size < input.length) {
    const part = await reader.read(); expect(part.done).toBe(false); expect(part.value!.every(byte => byte === 53)).toBe(true); size += part.value!.length;
  }
  deliver({ from: b, to: a });
  const replyWriter = right.writable.getWriter(), reply = replyWriter.write(new Uint8Array([9])); await Promise.resolve();
  deliver({ from: b, to: a }); await reply;
  expect((await left.readable.getReader().read()).value).toEqual(new Uint8Array([9]));
  a.stop({ error: new Error('done') }); b.stop({ error: new Error('done') }); await Promise.all([left.closed, right.closed]);
});

it('accepts authenticated consumption before the sender HTTP completion', async () => {
  const { a, b } = pair(), { left, right } = await streams({ a, b });
  const write = left.writable.getWriter().write(new Uint8Array([1, 2, 3])); await Promise.resolve();
  const tx = deliver({ from: a, to: b, complete: false })!;
  expect((await right.readable.getReader().read()).value).toHaveLength(3);
  expect(() => deliver({ from: b, to: a })).not.toThrow();
  tx.complete({ result: { kind: 'sent' } }); await write;
  a.stop({ error: 'done' }); b.stop({ error: 'done' });
});

it('blocks data on exhausted credit but sends WINDOW without that credit', async () => {
  const { a, b } = pair({ window: { streams: 2, streamWindow: 2, connectionWindow: 2 } });
  const { left, right } = await streams({ a, b });
  const write = left.writable.getWriter().write(new Uint8Array([1, 2, 3])); await Promise.resolve();
  deliver({ from: a, to: b }); expect(a.prepare({})).toBeUndefined();
  const reader = right.readable.getReader(); expect((await reader.read()).value).toEqual(new Uint8Array([1, 2]));
  deliver({ from: b, to: a }); deliver({ from: a, to: b }); await write;
  expect((await reader.read()).value).toEqual(new Uint8Array([3]));
  a.stop({ error: 'done' }); b.stop({ error: 'done' });
});

it('does not let FIN overtake a pending write', async () => {
  const { a, b } = pair(), { left, right } = await streams({ a, b });
  const writer = left.writable.getWriter(), write = writer.write(new Uint8Array([1])), close = writer.close();
  await Promise.resolve(); const first = a.prepare({})!;
  expect(frames({ transmission: first }).map(frame => frame.kind)).toEqual(['data']);
  for (const frame of frames({ transmission: first })) b.accept({ frame }); first.complete({ result: { kind: 'sent' } }); await write; await Promise.resolve();
  const second = a.prepare({})!; expect(frames({ transmission: second }).map(frame => frame.kind)).toEqual(['fin']);
  for (const frame of frames({ transmission: second })) b.accept({ frame }); second.complete({ result: { kind: 'sent' } }); await close;
  const reader = right.readable.getReader(); expect((await reader.read()).value).toEqual(new Uint8Array([1])); expect((await reader.read()).done).toBe(true);
  a.stop({ error: 'done' }); b.stop({ error: 'done' });
});

it('reclaims RESET locally and charges then discards late DATA without an ACK', async () => {
  const { a, b } = pair({ window: { streams: 2, streamWindow: 8, connectionWindow: 8 } });
  const { left, right } = await streams({ a, b });
  const write = left.writable.getWriter().write(new Uint8Array([1, 2, 3])); void write.catch(() => {}); await Promise.resolve();
  const late = a.prepare({})!;
  right.abort({ reason: 'cancel' });
  const reset = b.prepare({})!; expect(frames({ transmission: reset }).map(frame => frame.kind)).toEqual(['reset']);
  for (const frame of frames({ transmission: reset })) a.accept({ frame }); reset.complete({ result: { kind: 'sent' } }); await right.closed;
  expect(b.debug()).toMatchObject({ retained: 0 });
  for (const frame of frames({ transmission: late })) b.accept({ frame }); late.complete({ result: { kind: 'sent' } }); await expect(write).rejects.toThrow(); await left.closed;
  expect(b.debug()).toMatchObject({ received: 3n, released: 3n });
  const release = b.prepare({})!; expect(frames({ transmission: release })).toEqual([{ kind: 'window-connection', released: 3n }]);
  for (const frame of frames({ transmission: release })) a.accept({ frame }); release.complete({ result: { kind: 'sent' } });
  expect(a.debug()).toMatchObject({ sent: 3n, peerReleased: 3n, retained: 0 });
});

it('rejects reuse and future references but permits cancelled identifier gaps', async () => {
  const { a, b } = pair();
  const signal = new AbortController(); const cancelled = a.openStream({ signal: signal.signal }); signal.abort(); await expect(cancelled).rejects.toThrow();
  expect(a.prepare({})).toBeUndefined();
  const opened = a.openStream({ signal: undefined }); deliver({ from: a, to: b }); deliver({ from: b, to: a });
  expect((await opened).id).toBe(2);
  expect(() => b.accept({ frame: { kind: 'open', id: 2 } })).toThrow();
  expect(() => b.accept({ frame: { kind: 'fin', id: 4 } })).toThrow();
  expect(() => b.accept({ frame: { kind: 'data', id: 0, bytes: new Uint8Array([1]) } })).not.toThrow();
  a.stop({ error: 'done' }); b.stop({ error: 'done' });
});

it('holds early OPEN without publishing it until the local READY POST is complete', async () => {
  const b = new StreamMux({ role: 'responder', limits }); b.setPeerLimits({ limits });
  b.accept({ frame: { kind: 'open', id: 0 } }); expect(b.prepare({})).toBeUndefined();
  b.activate(); const tx = b.prepare({})!; expect(frames({ transmission: tx })).toEqual([{ kind: 'accept', id: 0 }]);
  tx.complete({ result: { kind: 'sent' } }); b.stop({ error: 'done' });
});

it('capacity refusal allocates no stream and control flood remains bounded', () => {
  const { b } = pair({ window: { streams: 1, streamWindow: 8, connectionWindow: 8 } });
  b.accept({ frame: { kind: 'open', id: 0 } }); b.accept({ frame: { kind: 'open', id: 2 } });
  expect(b.debug()).toMatchObject({ retained: 1, refusals: 1 });
  const tx = b.prepare({})!;
  expect(frames({ transmission: tx })).toContainEqual({ kind: 'reset', id: 2, reason: 'capacity' }); tx.complete({ result: { kind: 'sent' } });
  expect(() => {
    for (let id = 4; id < 300; id += 2) b.accept({ frame: { kind: 'open', id } });
  }).toThrow(/limit|exhausted/);
  b.stop({ error: 'done' });
});

it('rejects forged and backwards consumption instead of making room', async () => {
  const { a, b } = pair(), { left } = await streams({ a, b });
  expect(() => a.accept({ frame: { kind: 'window-stream', id: left.id, released: 1n } })).toThrow();
  expect(() => a.accept({ frame: { kind: 'window-connection', released: 1n } })).toThrow();
  a.stop({ error: 'done' }); b.stop({ error: 'done' });
});

it('pending reads and writes reject on local abort and retirement joins sealed work', async () => {
  const { a, b } = pair(), { left, right } = await streams({ a, b });
  const read = left.readable.getReader().read(); void read.catch(() => {});
  const write = left.writable.getWriter().write(new Uint8Array([1])); void write.catch(() => {}); await Promise.resolve();
  const tx = a.prepare({})!; left.abort({ reason: 'cancel' });
  await expect(read).rejects.toThrow('cancel'); await expect(write).rejects.toThrow('cancel');
  expect(a.debug()).toMatchObject({ retained: 1 });
  tx.complete({ result: { kind: 'sent' } }); deliver({ from: a, to: b }); await Promise.all([left.closed, right.closed]);
  expect(a.debug()).toMatchObject({ retained: 0 });
});

it('treats an undefined transport rejection as failure rather than successful transmission', async () => {
  const { a, b } = pair(), { left, right } = await streams({ a, b });
  const written = left.writable.getWriter().write(new Uint8Array([1]));
  void written.catch(() => {}); await Promise.resolve();
  const transmission = a.prepare({})!;
  transmission.complete({ result: { kind: 'failed', error: undefined } });
  await expect(written).rejects.toThrow('Connection ended');
  await left.closed;
  expect(a.debug()).toMatchObject({ retained: 0 });
  b.stop({ error: 'done' }); await right.closed;
});

it('keeps pending OPEN identifiers monotonic even when data fairness rotates between them', async () => {
  const { a, b } = pair(); await streams({ a, b });
  const incoming = a.incomingStreams[Symbol.asyncIterator]();
  const remote = [b.openStream({ signal: undefined }), b.openStream({ signal: undefined }), b.openStream({ signal: undefined })];
  deliver({ from: b, to: a }); deliver({ from: a, to: b }); await Promise.all(remote);
  await incoming.next(); await incoming.next(); const last = await incoming.next();
  if (last.done) throw new Error('Missing reverse stream');
  expect(last.value.id).toBe(5);
  const write = last.value.writable.getWriter().write(new Uint8Array([1])); await Promise.resolve();
  deliver({ from: a, to: b }); await write;
  const pending = [a.openStream({ signal: undefined }), a.openStream({ signal: undefined }), a.openStream({ signal: undefined })];
  for (const promise of pending) void promise.catch(() => {});
  const transmission = a.prepare({})!;
  const selected = frames({ transmission });
  expect(selected.filter(frame => frame.kind === 'open').map(frame => frame.id)).toEqual([2, 4, 6]);
  for (const frame of selected) b.accept({ frame }); transmission.complete({ result: { kind: 'sent' } });
  deliver({ from: b, to: a }); await Promise.all(pending);
  a.stop({ error: 'done' }); b.stop({ error: 'done' });
});
