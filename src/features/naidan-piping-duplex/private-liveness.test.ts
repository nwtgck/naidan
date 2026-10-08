// @vitest-environment node
import { expect, it, vi } from 'vitest';
import { StreamSession } from './session';
import { Records } from './records';
import { encodeRecordPayload } from './wire';
import { ResponseUnconfirmedError } from './lifetime';
import { drive, emptySnapshot, exchange, keyPair, offeredCapsule, sessionPair, useOfflineScope } from './test-support';

useOfflineScope();
function clockFixture() {
  const now = { monotonic: 0, wall: 0 }, tasks: (() => void)[] = [];
  return {
    now,
    tasks,
    clock: {
      monotonic: () => now.monotonic,
      wall: () => now.wall,
      schedule({ callback }: { milliseconds: number; callback(): void }) {
        tasks.push(callback); return () => {};
      },
    },
  };
}
async function controlled() {
  const keys = await keyPair(), session = await StreamSession.create({ keys: keys.a });
  const domain = keys.b.createDomain({ label: 'piping-duplex-record/v3', context: keys.b.contextId });
  const sender = new Records({ domain, context: keys.b.contextId, direction: 2, usage: 'encrypt' });
  const receiver = new Records({ domain, context: keys.b.contextId, direction: 1, usage: 'decrypt' });
  const time = clockFixture(); session.startResponses({ policy: { intervalMs: 15_000, responseTimeoutMs: 75_000 }, clock: time.clock });
  let token: Uint8Array | undefined;
  await receiver.accept({
    capsule: await offeredCapsule({ session }),
    apply: ({ challenge }) => {
      token = challenge;
    },
  });
  if (!token) throw new Error('Missing first challenge');
  return { session, sender, receiver, token, time };
}

it.each(['snapshot', 'receipt'] as const)('matching echo with invalid %s cannot publish or commit high', async invalid => {
  const state = await controlled();
  const snapshot = invalid === 'snapshot' ? { ...emptySnapshot(), states: [{ id: 0, flags: 0, rxNext: 0n, rxLimit: 65536n, final: 0n }] } : emptySnapshot();
  const capsule = await state.sender.seal({
    plaintext: encodeRecordPayload({
      payload: {
        snapshot,
        challenge: undefined,
        echo: state.token,
        receiptRequest: 'not-requested',
        receivedRecord: invalid === 'receipt' ? 1n : 0n,
      },
    }),
  });
  await expect(state.session.acceptCapsule({ capsule })).rejects.toThrow();
  await expect(state.session.firstResponse).rejects.toThrow(); expect(state.session.debug()).toMatchObject({ receivedRecord: '-1' });
});

it('matching echo decrypted after expiry cannot publish even before the delayed timer callback', async () => {
  const state = await controlled();
  const capsule = await state.sender.seal({ plaintext: encodeRecordPayload({ payload: { snapshot: emptySnapshot(), challenge: undefined, echo: state.token, receiptRequest: 'not-requested', receivedRecord: 0n } }) });
  const decrypt = crypto.subtle.decrypt.bind(crypto.subtle), entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  vi.spyOn(crypto.subtle, 'decrypt').mockImplementationOnce(async (...args) => {
    entered.resolve(); await release.promise; return decrypt(...args);
  });
  const accepting = state.session.acceptCapsule({ capsule }); void accepting.catch(() => {}); await entered.promise;
  state.time.now.wall = 75_000; release.resolve();
  await expect(accepting).rejects.toBeInstanceOf(ResponseUnconfirmedError);
  await expect(state.session.firstResponse).rejects.toBeInstanceOf(ResponseUnconfirmedError);
  expect((await state.session.ended).kind).toBe('response-unconfirmed'); state.time.tasks[0]!();
});

it('wrong-direction and unrelated authenticated records cannot satisfy the fresh echo', async () => {
  const state = await controlled(); let ready = false; void state.session.firstResponse.then(() => {
    ready = true;
  }, () => {});
  const wrong = state.token.slice(); wrong[0]! ^= 1;
  for (const echo of [undefined, wrong]) {
    await state.session.acceptCapsule({ capsule: await state.sender.seal({ plaintext: encodeRecordPayload({ payload: { snapshot: emptySnapshot(), challenge: undefined, echo, receiptRequest: 'not-requested', receivedRecord: 0n } }) }) });
  }
  const unrelated = await keyPair();
  const otherDomain = unrelated.b.createDomain({ label: 'piping-duplex-record/v3', context: unrelated.b.contextId });
  const other = new Records({ domain: otherDomain, context: unrelated.b.contextId, direction: 2, usage: 'encrypt' });
  const reflectedContext = await other.seal({
    plaintext: encodeRecordPayload({
      payload: {
        snapshot: emptySnapshot(),
        challenge: undefined,
        echo: state.token,
        receiptRequest: 'not-requested',
        receivedRecord: 0n,
      },
    }),
  });
  expect(await state.session.acceptCapsule({ capsule: reflectedContext })).toBe('unauthenticated');
  const reflection = await offeredCapsule({ session: state.session });
  expect(await state.session.acceptCapsule({ capsule: reflection })).toBe('unauthenticated'); expect(ready).toBe(false);
  state.session.abort({ reason: 'Test done' });
});

it('full stream capacity still carries private control without opening another stream', async () => {
  const { a, b } = await sessionPair();
  const opening = Array.from({ length: 32 }, () => a.openStream({ signal: undefined }));
  await drive({ a, b, operation: () => Promise.all(opening), limit: 40 });
  expect(a.debug()).toMatchObject({ retained: 32 });
  a.startResponses({ policy: { intervalMs: 15_000, responseTimeoutMs: 75_000 } });
  b.startResponses({ policy: { intervalMs: 15_000, responseTimeoutMs: 75_000 } });
  await exchange({ a, b }); await exchange({ a, b }); await Promise.all([a.firstResponse, b.firstResponse]);
  expect(a.debug()).toMatchObject({ retained: 32 }); expect(b.debug()).toMatchObject({ retained: 32 });
});

it('received same-token challenge in a newer authenticated record can re-advertise a lost echo without recursion', async () => {
  const state = await controlled(), peerToken = new Uint8Array(32).fill(88);
  const payload = { snapshot: emptySnapshot(), challenge: peerToken, echo: undefined, receiptRequest: 'not-requested' as const, receivedRecord: undefined };
  const first = await state.sender.seal({ plaintext: encodeRecordPayload({ payload }) });
  await state.session.acceptCapsule({ capsule: first }); const revision = state.session.transportRevision;
  expect(await state.session.acceptCapsule({ capsule: first })).toBe('stale'); expect(state.session.transportRevision).toBe(revision);
  await state.session.acceptCapsule({ capsule: await state.sender.seal({ plaintext: encodeRecordPayload({ payload }) }) });
  expect(state.session.transportRevision).toBeGreaterThan(revision);
  let echoed: Uint8Array | undefined;
  await state.receiver.accept({
    capsule: await offeredCapsule({ session: state.session }),
    apply: ({ echo }) => {
      echoed = echo;
    },
  });
  expect(echoed).toEqual(peerToken);
  const before = state.session.transportRevision;
  await state.session.acceptCapsule({ capsule: await state.sender.seal({ plaintext: encodeRecordPayload({ payload: { ...payload, challenge: undefined, echo: new Uint8Array(32) } }) }) });
  expect(state.session.transportRevision).toBe(before); state.session.abort({ reason: 'Test done' });
});

it('readiness belongs to the started response owner and keeps its promise identity after stop', async () => {
  const { a } = await sessionPair();
  expect(() => a.firstResponse).toThrow('Response owner not started');
  const time = clockFixture();
  a.startResponses({ policy: { intervalMs: 15_000, responseTimeoutMs: 75_000 }, clock: time.clock });
  const ready = a.firstResponse, reason = new Error('Stop before first echo');
  expect(a.firstResponse).toBe(ready);
  a.fail({ kind: 'local-stop', error: reason });
  expect(a.firstResponse).toBe(ready);
  await expect(ready).rejects.toBe(reason);
  expect((await a.ended).error).toBe(reason);
  a.retireResponses();
});

it('canonical outcome is committed before reentrant stop callbacks and cannot be replaced', async () => {
  const { a } = await sessionPair();
  const first = new Error('Original failure'), later = new Error('Reentrant failure');
  let observed: Error | undefined;
  a.stoppedSignal.addEventListener('abort', () => {
    observed = a.failureReason;
    expect(a.stopped).toBe(true);
    a.fail({ kind: 'transport-fatal', error: later });
  }, { once: true });
  a.fail({ kind: 'local-stop', error: first });
  expect(observed).toBe(first);
  expect(a.failureReason).toBe(first);
  expect(a.stoppedSignal.reason).toBe(first);
  expect(await a.ended).toEqual({ kind: 'local-stop', error: first });
  await expect(a.openStream({ signal: undefined })).rejects.toBe(first);
});
