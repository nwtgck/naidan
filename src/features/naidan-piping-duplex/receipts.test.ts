// @vitest-environment node
import { expect, it, vi } from 'vitest';
import { StreamSession } from '@/features/naidan-piping-duplex/session';
import type { PreparedTransmission } from '@/features/naidan-piping-duplex/session';
import { Records } from '@/features/naidan-piping-duplex/records';
import { decodeRecordPayload, encodeRecordPayload } from '@/features/naidan-piping-duplex/wire';
import { CAPSULE_BYTES, MAX_OFFSET } from '@/features/naidan-piping-duplex/bytes';
import { emptySnapshot, keyPair, sessionPair, useOfflineScope } from '@/features/naidan-piping-duplex/test-support';

useOfflineScope();

async function deliver({ from, to, reason }: { from: StreamSession, to: StreamSession, reason: 'update' | 'idle-resend' }): Promise<void> {
  const transmission = await from.makeCapsule({ reason });
  const release = transmission.start({ onReceived: () => {} });
  try {
    expect(await to.acceptCapsule({ capsule: transmission.bytes })).toBe('accepted');
  } finally {
    release();
  }
}

async function receiver() {
  const keys = await keyPair();
  const session = await StreamSession.create({ keys: keys.a });
  const domain = keys.b.createDomain({ label: 'piping-duplex-record/v3', context: keys.b.contextId });
  const sender = new Records({ domain, context: keys.b.contextId, direction: 2, usage: 'encrypt' });
  return { session, sender };
}

it('receipt metadata has an independent canonical byte layout within the existing record budget', () => {
  for (const receiptRequest of ['requested', 'not-requested'] as const) {
    for (const receivedRecord of [undefined, 0n, 42n, MAX_OFFSET]) {
      const payload = { snapshot: emptySnapshot(), receiptRequest, receivedRecord };
      const bytes = encodeRecordPayload({ payload });
      const reference = new Uint8Array(Buffer.from(
        `${receiptRequest === 'requested' ? (receivedRecord === undefined ? '01' : '03') : (receivedRecord === undefined ? '00' : '02')}`
        + (receivedRecord === undefined ? '' : receivedRecord.toString(16).padStart(16, '0')) + '0000000000', 'hex',
      ));
      expect(bytes).toEqual(reference);
      expect(decodeRecordPayload({ bytes: reference })).toEqual(payload);
    }
  }
  for (const bytes of [new Uint8Array(), new Uint8Array([4]), new Uint8Array([2, 0]), new Uint8Array(CAPSULE_BYTES)]) {
    expect(() => decodeRecordPayload({ bytes })).toThrow();
  }
  expect(() => encodeRecordPayload({ payload: { snapshot: emptySnapshot(), receiptRequest: 'requested', receivedRecord: MAX_OFFSET + 1n } })).toThrow();
});

it('a fresh round trip completes before HTTP EOF and receipt-only responses do not request another response', async () => {
  const { a, b } = await sessionPair(), started = vi.fn(), received = vi.fn();
  const confirmation = a.confirmResponse({ signal: new AbortController().signal, onRequestStarted: started });
  const request = await a.makeCapsule({ reason: 'update' });
  expect(started).not.toHaveBeenCalled();
  const release = request.start({ onReceived: received });
  try {
    expect(started).toHaveBeenCalledOnce();
    await b.acceptCapsule({ capsule: request.bytes });
    expect(received).not.toHaveBeenCalled();
    await deliver({ from: b, to: a, reason: 'update' });
    await confirmation;
    expect(received).toHaveBeenCalledOnce();
    // Both peers' first regular snapshot requests a receipt. A's response now
    // acknowledges B without creating a fourth automatic transmission.
    release();
    const before = b.transportRevision;
    await deliver({ from: a, to: b, reason: 'update' });
    expect(b.transportRevision).toBe(before);
    expect(b.revision).toBe(0);
  } finally {
    release();
  }
});

it('old successful receipts and stale encrypted records cannot complete a later confirmation', async () => {
  const { a, b } = await sessionPair();
  await deliver({ from: a, to: b, reason: 'idle-resend' });
  const old = await b.makeCapsule({ reason: 'idle-resend' });
  const release = old.start({ onReceived: () => {} });
  await a.acceptCapsule({ capsule: old.bytes }); release();
  await deliver({ from: a, to: b, reason: 'update' });
  let completed = false;
  const started = vi.fn();
  const confirmation = a.confirmResponse({ signal: new AbortController().signal, onRequestStarted: started }).then(() => {
    completed = true;
  });
  expect(await a.acceptCapsule({ capsule: old.bytes })).toBe('stale');
  await deliver({ from: b, to: a, reason: 'update' });
  expect(completed).toBe(false); expect(started).not.toHaveBeenCalled();
  await deliver({ from: a, to: b, reason: 'update' });
  expect(started).toHaveBeenCalledOnce();
  await deliver({ from: b, to: a, reason: 'update' });
  await confirmation;
  expect(completed).toBe(true);
});

it('a confirmation created during encryption requires the next offered record', async () => {
  const { a, b } = await sessionPair(), entered = Promise.withResolvers<void>(), resume = Promise.withResolvers<void>();
  const encrypt = crypto.subtle.encrypt.bind(crypto.subtle);
  vi.spyOn(crypto.subtle, 'encrypt').mockImplementationOnce(async (...args) => {
    entered.resolve(); await resume.promise; return encrypt(...args);
  });
  const preparing = a.makeCapsule({ reason: 'idle-resend' });
  await entered.promise;
  const started = vi.fn(); let completed = false;
  const confirmation = a.confirmResponse({ signal: new AbortController().signal, onRequestStarted: started }).then(() => {
    completed = true;
  });
  resume.resolve();
  const earlier = await preparing, release = earlier.start({ onReceived: () => {} });
  await b.acceptCapsule({ capsule: earlier.bytes }); release();
  await deliver({ from: b, to: a, reason: 'update' });
  expect(started).not.toHaveBeenCalled(); expect(completed).toBe(false);
  await deliver({ from: a, to: b, reason: 'update' });
  expect(started).toHaveBeenCalledOnce();
  await deliver({ from: b, to: a, reason: 'update' });
  await confirmation;
});

it('a request arriving during encryption retains its wake and is acknowledged by the next transmission', async () => {
  const { a, b } = await sessionPair(), entered = Promise.withResolvers<void>(), resume = Promise.withResolvers<void>();
  const encrypt = crypto.subtle.encrypt.bind(crypto.subtle);
  vi.spyOn(crypto.subtle, 'encrypt').mockImplementationOnce(async (...args) => {
    entered.resolve(); await resume.promise; return encrypt(...args);
  });
  const revision = a.transportRevision;
  const preparing = a.makeCapsule({ reason: 'idle-resend' });
  await entered.promise;
  const started = vi.fn(); let completed = false;
  const confirmation = b.confirmResponse({ signal: new AbortController().signal, onRequestStarted: started }).then(() => {
    completed = true;
  });
  await deliver({ from: b, to: a, reason: 'update' });
  expect(a.transportRevision).toBeGreaterThan(revision);
  resume.resolve();
  const earlier = await preparing, release = earlier.start({ onReceived: () => {} });
  await b.acceptCapsule({ capsule: earlier.bytes }); release();
  expect(completed).toBe(false);
  await deliver({ from: a, to: b, reason: 'update' });
  await confirmation;
  expect(started).toHaveBeenCalledOnce();
});

it('an authenticated receipt for a prepared but unoffered record cannot apply its accompanying stream state', async () => {
  const { session, sender } = await receiver();
  await session.makeCapsule({ reason: 'idle-resend' });
  const capsule = await sender.seal({
    plaintext: encodeRecordPayload({
      payload: {
        receiptRequest: 'not-requested',
        receivedRecord: 0n,
        snapshot: { ...emptySnapshot(), states: [{ id: 1, flags: 0, rxNext: 0n, rxLimit: 65536n, final: 0n }] },
      },
    }),
  });
  await expect(session.acceptCapsule({ capsule })).rejects.toThrow('unoffered');
  expect(session.debug()).toMatchObject({ retained: 0, receivedRecord: '-1' });
});

it('invalid stream semantics cannot confirm an otherwise valid receipt', async () => {
  const { session, sender } = await receiver(), started = vi.fn(), received = vi.fn();
  const confirmation = session.confirmResponse({ signal: new AbortController().signal, onRequestStarted: started });
  const rejected = expect(confirmation).rejects.toThrow('Record processing failed');
  const transmission = await session.makeCapsule({ reason: 'idle-resend' });
  const release = transmission.start({ onReceived: received });
  try {
    const capsule = await sender.seal({
      plaintext: encodeRecordPayload({
        payload: {
          receiptRequest: 'requested',
          receivedRecord: 0n,
          snapshot: { ...emptySnapshot(), states: [{ id: 0, flags: 0, rxNext: 0n, rxLimit: 65536n, final: 0n }] },
        },
      }),
    });
    await expect(session.acceptCapsule({ capsule })).rejects.toThrow('unallocated');
    await rejected;
    expect(received).not.toHaveBeenCalled();
    expect(session.debug()).toMatchObject({ receivedRecord: '-1' });
  } finally {
    release();
  }
});

it('cancelled confirmations remove their abort listeners and do not affect other owners', async () => {
  const { a, b } = await sessionPair(), stop = new AbortController();
  const remove = vi.spyOn(stop.signal, 'removeEventListener'), cancelledStarted = vi.fn(), liveStarted = vi.fn();
  const cancelled = a.confirmResponse({ signal: stop.signal, onRequestStarted: cancelledStarted });
  const rejected = expect(cancelled).rejects.toThrow('Cancel confirmation');
  const live = a.confirmResponse({ signal: new AbortController().signal, onRequestStarted: liveStarted });
  stop.abort(new Error('Cancel confirmation')); await rejected;
  expect(remove).toHaveBeenCalledOnce();
  await deliver({ from: a, to: b, reason: 'update' });
  await deliver({ from: b, to: a, reason: 'update' });
  await live;
  expect(cancelledStarted).not.toHaveBeenCalled(); expect(liveStarted).toHaveBeenCalledOnce(); expect(a.stopped).toBe(false);
});

it('a reentrant start callback cannot start a confirmation that it just cancelled', async () => {
  const { a, b } = await sessionPair(), cancelled = new AbortController(), cancelledStarted = vi.fn();
  const live = a.confirmResponse({ signal: new AbortController().signal, onRequestStarted: () => cancelled.abort(new Error('Reentrant cancellation')) });
  const abandoned = a.confirmResponse({ signal: cancelled.signal, onRequestStarted: cancelledStarted });
  const rejected = expect(abandoned).rejects.toThrow('Reentrant cancellation');
  await deliver({ from: a, to: b, reason: 'update' });
  await rejected;
  await deliver({ from: b, to: a, reason: 'update' });
  await live;
  expect(cancelledStarted).not.toHaveBeenCalled();
});

it('an old receipt cannot retire a newer outstanding transmission', async () => {
  const { a, b } = await sessionPair();
  await deliver({ from: a, to: b, reason: 'idle-resend' });
  const previous = await b.makeCapsule({ reason: 'idle-resend' });
  const releasePrevious = previous.start({ onReceived: () => {} });
  const next: PreparedTransmission = await a.makeCapsule({ reason: 'idle-resend' }), received = vi.fn();
  const releaseNext = next.start({ onReceived: received });
  try {
    await a.acceptCapsule({ capsule: previous.bytes });
    expect(received).not.toHaveBeenCalled();
    await b.acceptCapsule({ capsule: next.bytes });
    releasePrevious();
    await deliver({ from: b, to: a, reason: 'update' });
    expect(received).toHaveBeenCalledOnce();
  } finally {
    releasePrevious(); releaseNext();
  }
});

it('preserves GOAWAY in receipt-only responses after the incoming iterator is returned', async () => {
  const { a, b } = await sessionPair();
  const incoming = a.incomingStreams[Symbol.asyncIterator]();
  await incoming.return!();
  expect(a.debug()).toMatchObject({ goaway: true });
  await deliver({ from: a, to: b, reason: 'update' });
  expect(b.debug()).toMatchObject({ peerGoaway: true });
  await deliver({ from: b, to: a, reason: 'update' });
  await deliver({ from: a, to: b, reason: 'update' });
  expect(b.stopped).toBe(false); expect(b.debug()).toMatchObject({ peerGoaway: true });
});
