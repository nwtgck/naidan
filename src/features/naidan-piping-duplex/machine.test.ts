// @vitest-environment node
import { expect, it } from 'vitest';
import { Machine } from '@/features/naidan-piping-duplex/machine';
import { bitHas, bitSet, RECEIVE_WINDOW, RETAINED_STREAMS, SEGMENT_BYTES } from '@/features/naidan-piping-duplex/bytes';
import type { Snapshot, StreamState } from '@/features/naidan-piping-duplex/wire';
import { emptySnapshot, pattern, useOfflineScope } from '@/features/naidan-piping-duplex/test-support';

useOfflineScope();
function pair() {
  const a = new Machine({ role: 'initiator' }), b = new Machine({ role: 'responder' });
  const id = a.open();
  transfer({ from: a, to: b }); transfer({ from: b, to: a });
  expect(b.takeIncoming()).toBe(id);
  return { a, b, id };
}
function transfer({ from, to }: { from: Machine; to: Machine }): Snapshot {
  const snapshot = from.snapshot(); from.markOffered({ snapshot }); to.accept({ snapshot }); return snapshot;
}
function changedState({ snapshot, change }: { snapshot: Snapshot; change: Partial<StreamState> }): Snapshot {
  const first = snapshot.states[0];
  if (!first) throw new Error('Expected a retained stream');
  return { ...snapshot, states: [{ ...first, ...change }, ...snapshot.states.slice(1)] };
}
function expectRollback({ receiver, snapshot, message }: { receiver: Machine; snapshot: Snapshot; message: string }): void {
  const before = receiver.debug();
  expect(() => receiver.accept({ snapshot })).toThrow(message);
  expect(receiver.debug()).toEqual(before);
}

it('both creators allocate disjoint monotonic identifiers without reusing a reset ID', () => {
  for (const role of ['initiator', 'responder'] as const) {
    const machine = new Machine({ role }), start = role === 'initiator' ? 0 : 1;
    for (let index = 0; index < 100; index++) {
      const id = machine.open(); expect(id).toBe(start + index * 2); machine.resetStream({ id });
      expect(machine.status({ id })).toBe('reset'); expect(machine.retained()).toBe(0);
    }
  }
});

it('identifier exhaustion rejects new streams instead of wrapping into tombstones', () => {
  const machine = new Machine({ role: 'initiator' });
  for (let id = 0; id <= 65534; id += 2) {
    expect(machine.open()).toBe(id); machine.resetStream({ id });
  }
  expect(() => machine.open()).toThrow('capacity');
  expect(machine.status({ id: 0 })).toBe('reset'); expect(machine.retained()).toBe(0);
});

it('bytes are not acknowledged before a capsule has actually been offered', () => {
  const { a, b, id } = pair();
  a.write({ id, bytes: new Uint8Array([1, 2, 3]) });
  const queued = a.snapshot();
  b.accept({ snapshot: queued });
  expectRollback({ receiver: a, snapshot: b.snapshot(), message: 'acknowledgement' });
  a.markOffered({ snapshot: queued }); a.accept({ snapshot: b.snapshot() });
  expect(a.acknowledged({ id, end: 3n })).toBe(true);
});

it.each([1n, 3n, 20000n])('partial or unsent acknowledgement %s cannot free the pending segment', rxNext => {
  const { a, b, id } = pair();
  a.write({ id, bytes: new Uint8Array(20000) }); transfer({ from: a, to: b });
  expectRollback({ receiver: a, snapshot: changedState({ snapshot: b.snapshot(), change: { rxNext } }), message: 'acknowledgement' });
  expect(a.snapshot().data[0]?.bytes.length).toBe(SEGMENT_BYTES);
});

it('accepted acknowledgement cannot regress even inside a new record', () => {
  const { a, b, id } = pair();
  const old = b.snapshot(); a.write({ id, bytes: new Uint8Array([5]) });
  transfer({ from: a, to: b }); transfer({ from: b, to: a });
  expectRollback({ receiver: a, snapshot: old, message: 'acknowledgement' });
});

it.each([RECEIVE_WINDOW - 1n, RECEIVE_WINDOW + 1n])('decreasing or excessive advertised credit %s is rejected', rxLimit => {
  const { a, b } = pair();
  expectRollback({ receiver: a, snapshot: changedState({ snapshot: b.snapshot(), change: { rxLimit } }), message: 'credit' });
});

it('a missing prefix is not accepted, and a repeated complete prefix is not delivered twice', () => {
  const { a, b, id } = pair(), bytes = new Uint8Array([8, 7, 6]);
  const state = a.snapshot();
  b.accept({ snapshot: { ...state, data: [{ id, offset: 1n, bytes }] } });
  expect(b.read({ id })).toEqual({ kind: 'wait' });
  b.accept({ snapshot: { ...state, data: [{ id, offset: 0n, bytes }] } });
  b.accept({ snapshot: { ...state, data: [{ id, offset: 0n, bytes }] } });
  expect(b.read({ id })).toEqual({ kind: 'data', bytes });
  expect(b.read({ id })).toEqual({ kind: 'wait' });
});

it('partial overlap is rejected without losing the already accepted prefix', () => {
  const { a, b, id } = pair();
  const snapshot = a.snapshot();
  b.accept({ snapshot: { ...snapshot, data: [{ id, offset: 0n, bytes: new Uint8Array([3, 4, 5]) }] } });
  expectRollback({ receiver: b, snapshot: { ...snapshot, data: [{ id, offset: 2n, bytes: new Uint8Array([7, 8]) }] }, message: 'overlap' });
  expect(b.read({ id })).toEqual({ kind: 'data', bytes: new Uint8Array([3, 4, 5]) });
});

it('one invalid DATA entry rolls back a valid new OPEN and DATA entry in the same snapshot', () => {
  const b = new Machine({ role: 'responder' });
  const state = { id: 0, flags: 0, rxNext: 0n, rxLimit: RECEIVE_WINDOW, final: 0n };
  const candidate: Snapshot = {
    ...emptySnapshot(),
    states: [state],
    data: [{ id: 0, offset: 0n, bytes: new Uint8Array([8]) }, { id: 2, offset: 0n, bytes: new Uint8Array([9]) }],
  };
  expectRollback({ receiver: b, snapshot: candidate, message: 'not retained' });
  expect(b.takeIncoming()).toBeUndefined();
  b.accept({ snapshot: { ...candidate, data: candidate.data.slice(0, 1) } });
  expect(b.takeIncoming()).toBe(0); expect(b.read({ id: 0 })).toEqual({ kind: 'data', bytes: new Uint8Array([8]) });
});

it('DATA without its STATE rejects atomically even if the stream already exists', () => {
  const { b, id } = pair();
  expectRollback({ receiver: b, snapshot: { ...emptySnapshot(), data: [{ id, offset: 0n, bytes: new Uint8Array([1]) }] }, message: 'without STATE' });
});

it('FIN cannot be moved below received bytes, changed, withdrawn, or exceeded by DATA', () => {
  const { a, b, id } = pair();
  a.write({ id, bytes: new Uint8Array([1, 2]) }); transfer({ from: a, to: b }); transfer({ from: b, to: a });
  expectRollback({ receiver: b, snapshot: changedState({ snapshot: a.snapshot(), change: { flags: 1, final: 1n } }), message: 'below' });
  a.closeWrite({ id }); transfer({ from: a, to: b });
  for (const change of [{ flags: 0, final: 0n }, { flags: 1, final: 3n }])
    expectRollback({ receiver: b, snapshot: changedState({ snapshot: a.snapshot(), change }), message: 'Final changed' });
  expectRollback({ receiver: b, snapshot: { ...a.snapshot(), data: [{ id, offset: 2n, bytes: new Uint8Array([3]) }] }, message: 'credit/final' });
});

it('FIN_SEEN is not accepted before a local final and cannot later be withdrawn', () => {
  const { a, b, id } = pair();
  expectRollback({ receiver: a, snapshot: changedState({ snapshot: b.snapshot(), change: { flags: 2 } }), message: 'Premature' });
  a.closeWrite({ id }); transfer({ from: a, to: b }); transfer({ from: b, to: a });
  expectRollback({ receiver: a, snapshot: changedState({ snapshot: b.snapshot(), change: { flags: 0 } }), message: 'regression' });
});

it('unproven FINISHED and resets of unallocated local identifiers are rejected', () => {
  const { a, id } = pair();
  const finished = new Uint8Array(1); bitSet({ bitmap: finished, id });
  expectRollback({ receiver: a, snapshot: { ...emptySnapshot(), finished }, message: 'Unproven' });
  const reset = new Uint8Array(1); bitSet({ bitmap: reset, id: 4 });
  expectRollback({ receiver: a, snapshot: { ...emptySnapshot(), reset }, message: 'unallocated' });
});

it('GOAWAY is monotonic and existing streams remain usable after it is received', () => {
  const { a, b, id } = pair(), old = b.snapshot();
  b.drain(); transfer({ from: b, to: a });
  expect(() => a.open()).toThrow('draining');
  expectRollback({ receiver: a, snapshot: old, message: 'GOAWAY regression' });
  a.write({ id, bytes: new Uint8Array([42]) }); transfer({ from: a, to: b });
  expect(b.read({ id })).toEqual({ kind: 'data', bytes: new Uint8Array([42]) });
});

it('receive credit is granted on read rather than on DATA reception', () => {
  const { a, b, id } = pair();
  a.write({ id, bytes: pattern({ size: 65536, seed: 9 }) });
  for (let index = 0; index < 4; index++) {
    transfer({ from: a, to: b }); transfer({ from: b, to: a });
  }
  expect(b.snapshot().states[0]).toMatchObject({ rxNext: 65536n, rxLimit: 65536n });
  a.write({ id, bytes: new Uint8Array([1]) }); expect(a.snapshot().data).toEqual([]);
  expect(b.read({ id }).kind).toBe('data'); transfer({ from: b, to: a });
  expect(a.snapshot().data[0]?.bytes).toEqual(new Uint8Array([1]));
});

it('a stalled stream cannot monopolize the two DATA entries in each snapshot', () => {
  const a = new Machine({ role: 'initiator' }), b = new Machine({ role: 'responder' });
  const ids = Array.from({ length: 32 }, () => a.open());
  transfer({ from: a, to: b }); transfer({ from: b, to: a });
  for (const id of ids) a.write({ id, bytes: new Uint8Array([id]) });
  const advertised = new Set<number>();
  for (let attempt = 0; attempt < 16; attempt++) {
    const snapshot = a.snapshot(); expect(snapshot.data.length).toBe(2);
    for (const segment of snapshot.data) advertised.add(segment.id);
  }
  expect([...advertised].sort((x, y) => x - y)).toEqual(ids);
});

it('completed but unclaimed or unread streams still consume retention reservations', () => {
  const a = new Machine({ role: 'initiator' }), b = new Machine({ role: 'responder' });
  const ids = Array.from({ length: RETAINED_STREAMS }, () => a.open());
  transfer({ from: a, to: b }); transfer({ from: b, to: a });
  for (const id of ids) {
    a.write({ id, bytes: new Uint8Array([id]) }); b.closeWrite({ id });
  }
  for (let step = 0; step < 16; step++) {
    transfer({ from: a, to: b }); transfer({ from: b, to: a });
  }
  for (const id of ids) a.closeWrite({ id });
  for (let step = 0; step < 4; step++) {
    transfer({ from: a, to: b }); transfer({ from: b, to: a });
  }
  expect(a.retained()).toBe(0); expect(b.retained()).toBe(32);
  const overflow = a.open(); transfer({ from: a, to: b });
  expect(bitHas({ bitmap: b.snapshot().reset, id: overflow })).toBe(true);
  const id = b.takeIncoming(); expect(id).toBe(0); expect(b.retained()).toBe(32);
  expect(b.read({ id: id! })).toEqual({ kind: 'data', bytes: new Uint8Array([0]) });
  expect(b.retained()).toBe(31);
});

it('terminal tombstones prevent delayed state and bytes from creating new incoming streams', () => {
  const { a, b, id } = pair();
  a.write({ id, bytes: new Uint8Array([17]) }); const delayed = a.snapshot();
  b.resetStream({ id }); b.accept({ snapshot: delayed }); b.accept({ snapshot: delayed });
  expect(b.status({ id })).toBe('reset'); expect(b.retained()).toBe(0); expect(b.takeIncoming()).toBeUndefined();
});
