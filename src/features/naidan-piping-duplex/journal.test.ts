// @vitest-environment node
import { expect, onTestFinished, it } from 'vitest';
import { JournalChannel } from '@/features/naidan-piping-duplex/journal';
import { useOfflineScope } from '@/features/naidan-piping-duplex/test-support';

useOfflineScope();
function pair() {
  const attemptI = new Uint8Array(32).fill(1), attemptR = new Uint8Array(32).fill(2);
  const a = new JournalChannel({ role: 'initiator', attemptI, attemptR }), b = new JournalChannel({ role: 'responder', attemptI, attemptR });
  onTestFinished(() => {
    a.dispose(); b.dispose();
  });
  return { a, b };
}

it('cumulative journals recover lost flights without replaying delivered handshake messages', async () => {
  const { a, b } = pair(), old = a.snapshot();
  await a.send({ bytes: new Uint8Array([7]) }); await a.send({ bytes: new Uint8Array([8, 9]) });
  b.accept({ bytes: a.snapshot() }); b.accept({ bytes: old }); b.accept({ bytes: a.snapshot() });
  const stop = new AbortController();
  expect(await b.receive({ signal: stop.signal })).toEqual(new Uint8Array([7]));
  expect(await b.receive({ signal: stop.signal })).toEqual(new Uint8Array([8, 9]));
  const absent = expect(b.receive({ signal: stop.signal })).rejects.toThrow(); stop.abort(); await absent;
});

it('a modified prefix cannot publish a later entry before the entire advertisement validates', async () => {
  const { a, b } = pair();
  await a.send({ bytes: new Uint8Array([7]) }); b.accept({ bytes: a.snapshot() });
  await a.send({ bytes: new Uint8Array([8]) }); const invalid = a.snapshot(); invalid[71]! ^= 1;
  expect(() => b.accept({ bytes: invalid })).toThrow('prefix');
  expect(await b.receive({ signal: new AbortController().signal })).toEqual(new Uint8Array([7]));
  const stop = new AbortController(), absent = expect(b.receive({ signal: stop.signal })).rejects.toThrow(); stop.abort(); await absent;
  b.accept({ bytes: a.snapshot() });
  expect(await b.receive({ signal: new AbortController().signal })).toEqual(new Uint8Array([8]));
});

it('snapshot and received buffers cannot modify stored journal entries or attempt binding', async () => {
  const { a, b } = pair(), original = new Uint8Array([3, 8, 1]);
  await a.send({ bytes: original }); original.fill(9);
  const snap = a.snapshot(); b.accept({ bytes: snap }); snap.fill(0);
  const bytes = await b.receive({ signal: new AbortController().signal }); expect(bytes).toEqual(new Uint8Array([3, 8, 1]));
  bytes.fill(0); b.accept({ bytes: a.snapshot() });
  const stop = new AbortController(), absent = expect(b.receive({ signal: stop.signal })).rejects.toThrow(); stop.abort(); await absent;
});

it('empty messages are real flights and are delivered once rather than mistaken for absence', async () => {
  const { a, b } = pair(); await a.send({ bytes: new Uint8Array() }); b.accept({ bytes: a.snapshot() });
  expect(await b.receive({ signal: new AbortController().signal })).toEqual(new Uint8Array());
});

it('all truncated prefixes and extra suffix bytes are rejected atomically', async () => {
  const { a, b } = pair(); await a.send({ bytes: new Uint8Array([9, 8]) }); const valid = a.snapshot();
  for (let length = 0; length < valid.length; length++) expect(() => b.accept({ bytes: valid.subarray(0, length) })).toThrow();
  const long = new Uint8Array(valid.length + 1); long.set(valid);
  expect(() => b.accept({ bytes: long })).toThrow();
  b.accept({ bytes: valid }); expect(await b.receive({ signal: new AbortController().signal })).toEqual(new Uint8Array([9, 8]));
});

it.each([0, 1, 2, 34, 66, 67, 68, 69, 70])('journal envelope byte %s cannot alter direction, binding, count, index, phase or size', async at => {
  const { a, b } = pair(); await a.send({ bytes: new Uint8Array([6]) }); const valid = a.snapshot();
  const changed = valid.slice(); changed[at]! ^= 32;
  expect(() => b.accept({ bytes: changed })).toThrow();
  b.accept({ bytes: valid }); expect(await b.receive({ signal: new AbortController().signal })).toEqual(new Uint8Array([6]));
});

it('flight count and payload size are bounded without losing previously valid entries', async () => {
  const { a, b } = pair(); await expect(a.send({ bytes: new Uint8Array(513) })).rejects.toThrow('limit');
  for (let index = 0; index < 16; index++) await a.send({ bytes: new Uint8Array(512).fill(index) });
  await expect(a.send({ bytes: new Uint8Array() })).rejects.toThrow('full');
  b.accept({ bytes: a.snapshot() });
  for (let index = 0; index < 16; index++) expect(await b.receive({ signal: new AbortController().signal })).toEqual(new Uint8Array(512).fill(index));
});

it('disposing a journal wakes pending readers and makes all subsequent operations unavailable', async () => {
  const { a } = pair(), pending = expect(a.receive({ signal: new AbortController().signal })).rejects.toThrow('disposed');
  a.dispose(); a.dispose(); await pending;
  expect(() => a.snapshot()).toThrow('disposed'); expect(() => a.accept({ bytes: new Uint8Array() })).toThrow('disposed');
  await expect(a.send({ bytes: new Uint8Array() })).rejects.toThrow('disposed');
  await expect(a.receive({ signal: new AbortController().signal })).rejects.toThrow('disposed');
});

it('zero or wrong-sized attempt identifiers cannot construct a bound journal', () => {
  for (const attemptI of [new Uint8Array(32), new Uint8Array(31).fill(1), new Uint8Array(33).fill(1)]) {
    expect(() => new JournalChannel({ role: 'initiator', attemptI, attemptR: new Uint8Array(32).fill(2) })).toThrow();
  }
});

it('late shorter journals never discard unread flights or replay flights already delivered', async () => {
  const { a, b } = pair(), signal = new AbortController().signal;
  const empty = a.snapshot();
  await a.send({ bytes: new Uint8Array([1]) }); const first = a.snapshot();
  await a.send({ bytes: new Uint8Array([2]) });
  await a.send({ bytes: new Uint8Array([3]) }); const all = a.snapshot();
  b.accept({ bytes: all });
  expect(await b.receive({ signal })).toEqual(new Uint8Array([1]));
  b.accept({ bytes: empty }); b.accept({ bytes: first });
  expect(await b.receive({ signal })).toEqual(new Uint8Array([2]));
  expect(await b.receive({ signal })).toEqual(new Uint8Array([3]));
  b.accept({ bytes: all }); b.accept({ bytes: first });
  const stop = new AbortController(), reason = new Error('No fourth flight');
  const pending = expect(b.receive({ signal: stop.signal })).rejects.toBe(reason);
  stop.abort(reason); await pending;
});

it('rejects a conflicting old prefix even after that prefix has been consumed', async () => {
  const { a, b } = pair(), signal = new AbortController().signal;
  await a.send({ bytes: new Uint8Array([1]) }); const first = a.snapshot();
  b.accept({ bytes: first }); expect(await b.receive({ signal })).toEqual(new Uint8Array([1]));
  await a.send({ bytes: new Uint8Array([2]) }); b.accept({ bytes: a.snapshot() });
  first[first.length - 1] = 99;
  expect(() => b.accept({ bytes: first })).toThrow('prefix');
  expect(await b.receive({ signal })).toEqual(new Uint8Array([2]));
});

it('concurrent receivers obtain separate flights and a cancelled waiter never steals a flight', async () => {
  const { a, b } = pair(), stop = new AbortController(), signal = new AbortController().signal;
  const reason = new Error('Cancel only one receiver');
  const cancelled = expect(b.receive({ signal: stop.signal })).rejects.toBe(reason);
  const first = b.receive({ signal }), second = b.receive({ signal });
  await a.send({ bytes: new Uint8Array([5]) }); await a.send({ bytes: new Uint8Array([6]) });
  b.accept({ bytes: a.snapshot() });
  // Cancellation wins before the woken receiver resumes and advances its cursor.
  stop.abort(reason);
  await cancelled;
  expect(await first).toEqual(new Uint8Array([5])); expect(await second).toEqual(new Uint8Array([6]));
});

it('cancelling a read with queued data leaves that data available to the next reader', async () => {
  const { a, b } = pair(), stop = new AbortController(), reason = new Error('Already cancelled');
  await a.send({ bytes: new Uint8Array([11]) }); b.accept({ bytes: a.snapshot() });
  stop.abort(reason);
  await expect(b.receive({ signal: stop.signal })).rejects.toBe(reason);
  expect(await b.receive({ signal: new AbortController().signal })).toEqual(new Uint8Array([11]));
});

it('copies both attempt identifiers and disposal cannot zero the caller-owned identifiers', () => {
  const attemptI = new Uint8Array(32).fill(7), attemptR = new Uint8Array(32).fill(8);
  const journal = new JournalChannel({ role: 'responder', attemptI, attemptR });
  try {
    const original = journal.snapshot(); attemptI.fill(1); attemptR.fill(2);
    expect(journal.snapshot()).toEqual(original);
  } finally {
    journal.dispose();
  }
  expect(attemptI).toEqual(new Uint8Array(32).fill(1)); expect(attemptR).toEqual(new Uint8Array(32).fill(2));
});
