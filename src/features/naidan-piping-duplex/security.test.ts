// @vitest-environment node
import { runDuplex } from '@/features/naidan-piping-duplex/runner';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { promiseAllKeyed } from '@/utils/promise';
import { Pulse } from '@/features/naidan-piping-duplex/bytes';
import { createNaidanPipingIdentity } from '@/features/naidan-piping-duplex/noise-xx';
import { establishNaidanPipingKeys } from '@/features/naidan-piping-duplex/key-context';
import type { NaidanPipingIdentity } from '@/features/naidan-piping-duplex/noise-xx';
import type { NaidanPipingKeyContext, NaidanPipingHandshakeChannel } from '@/features/naidan-piping-duplex/key-context';
import { Records } from '@/features/naidan-piping-duplex/records';
import { encodeSnapshot } from '@/features/naidan-piping-duplex/wire';
import { StreamSession } from '@/features/naidan-piping-duplex/session';

beforeEach(() => {
  vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Unexpected network request in unit test'));
});
afterEach(() => vi.restoreAllMocks());

function mailbox(): NaidanPipingHandshakeChannel {
  const messages: Uint8Array[] = [], pulse = new Pulse();
  return {
    async send({ bytes }) {
      messages.push(bytes.slice()); pulse.fire();
    },
    async receive({ signal }) {
      for (;;) {
        signal.throwIfAborted();
        const revision = pulse.revision, bytes = messages.shift();
        if (bytes) return bytes;
        await pulse.wait({ revision, signal });
      }
    },
  };
}

async function pair({ identities, binding }: {
  identities: { a: NaidanPipingIdentity; b: NaidanPipingIdentity } | undefined;
  binding: Uint8Array | undefined;
}): Promise<{ a: NaidanPipingKeyContext; b: NaidanPipingKeyContext }> {
  const { a, b } = identities ?? await promiseAllKeyed({ a: createNaidanPipingIdentity(), b: createNaidanPipingIdentity() });
  const toA = mailbox(), toB = mailbox();
  const context = binding ?? crypto.getRandomValues(new Uint8Array(32));
  const signal = AbortSignal.timeout(5000);
  return promiseAllKeyed({
    a: establishNaidanPipingKeys({ role: 'initiator', identity: a, expectedPeer: b.publicKey,
      binding: context, channel: { send: toB.send, receive: toA.receive }, signal }),
    b: establishNaidanPipingKeys({ role: 'responder', identity: b, expectedPeer: a.publicKey,
      binding: context, channel: { send: toA.send, receive: toB.receive }, signal }),
  });
}

function codecs({ keys, label }: { keys: { a: NaidanPipingKeyContext; b: NaidanPipingKeyContext }; label: string }) {
  const context = new Uint8Array();
  const left = keys.a.createDomain({ label, context }), right = keys.b.createDomain({ label, context });
  return {
    left, right,
    tx: new Records({ domain: left, context: keys.a.contextId, direction: 1, usage: 'encrypt' }),
    rx: new Records({ domain: right, context: keys.b.contextId, direction: 1, usage: 'decrypt' }),
  };
}
function empty({ goaway }: { goaway: boolean }): Uint8Array {
  return encodeSnapshot({ snapshot: { goaway, finished: new Uint8Array(), reset: new Uint8Array(), states: [], data: [] } });
}

for (const usage of ['encrypt', 'decrypt'] as const) {
  test(`record ${usage} ownership cannot be reconstructed to reset its security state`, async () => {
    const keys = await pair({ identities: undefined, binding: undefined });
    const key = keys.a, domain = key.createDomain({ label: 'test/owner', context: new Uint8Array() });
    new Records({ domain, context: key.contextId, direction: 1, usage });
    expect(() => new Records({ domain, context: key.contextId, direction: 1, usage })).toThrow('ownership already consumed');
    // The independent direction still has its own state.
    expect(() => new Records({ domain, context: key.contextId, direction: 2, usage })).not.toThrow();
    key.dispose(); keys.b.dispose();
  });
}

test('an invalid record context does not consume the valid owner', async () => {
  const keys = await pair({ identities: undefined, binding: undefined });
  const domain = keys.a.createDomain({ label: 'test/owner-context', context: new Uint8Array() });
  expect(() => new Records({ domain, context: new Uint8Array(31), direction: 1, usage: 'encrypt' })).toThrow();
  expect(() => new Records({ domain, context: new Uint8Array(32), direction: 1, usage: 'encrypt' })).toThrow();
  expect(() => new Records({ domain, context: keys.a.contextId, direction: 1, usage: 'encrypt' })).not.toThrow();
  keys.a.dispose(); keys.b.dispose();
});

test('duplicate authenticated records apply exactly once to a living receiver', async () => {
  const keys = await pair({ identities: undefined, binding: undefined });
  const { tx, rx } = codecs({ keys, label: 'test/replay' });
  const capsule = await tx.seal({ plaintext: empty({ goaway: false }) });
  let applications = 0;
  for (let index = 0; index < 20; index++) {
    const outcome = await rx.accept({ capsule, apply: () => {
      applications++;
    } });
    expect(outcome).toBe(index === 0 ? 'accepted' : 'stale');
  }
  expect(applications).toBe(1);
  keys.a.dispose(); keys.b.dispose();
});

test('a forged high record number cannot poison the replay watermark', async () => {
  const keys = await pair({ identities: undefined, binding: undefined });
  const { tx, rx } = codecs({ keys, label: 'test/high-number' });
  const capsule = await tx.seal({ plaintext: empty({ goaway: false }) });
  const forged = capsule.slice(); new DataView(forged.buffer).setBigUint64(1, (1n << 48n) - 1n, false);
  expect(await rx.accept({ capsule: forged, apply: () => {
    throw new Error('Unauthenticated application');
  } })).toBe('unauthenticated');
  expect(rx.high).toBe(-1n);
  expect(await rx.accept({ capsule, apply: () => undefined })).toBe('accepted');
  expect(rx.high).toBe(0n);
  keys.a.dispose(); keys.b.dispose();
});

test('old records fail across fresh handshakes even with identical identities and rendezvous binding', async () => {
  const identities = await promiseAllKeyed({ a: createNaidanPipingIdentity(), b: createNaidanPipingIdentity() });
  const binding = new Uint8Array(32);
  const first = await pair({ identities, binding }), second = await pair({ identities, binding });
  const old = codecs({ keys: first, label: 'test/reconnect' }), fresh = codecs({ keys: second, label: 'test/reconnect' });
  expect(first.a.contextId).not.toEqual(second.a.contextId);
  const capsule = await old.tx.seal({ plaintext: empty({ goaway: false }) });
  expect(await fresh.rx.accept({ capsule, apply: () => {
    throw new Error('Cross-session replay');
  } })).toBe('unauthenticated');
  expect(fresh.rx.high).toBe(-1n);
  first.a.dispose(); first.b.dispose(); second.a.dispose(); second.b.dispose();
});

test('direction reflection and domain substitution are rejected', async () => {
  const keys = await pair({ identities: undefined, binding: undefined });
  const { tx, right } = codecs({ keys, label: 'test/reflect' });
  const reflected = new Records({ domain: right, context: keys.b.contextId, direction: 2, usage: 'decrypt' });
  const other = keys.b.createDomain({ label: 'test/other', context: new Uint8Array() });
  const swapped = new Records({ domain: other, context: keys.b.contextId, direction: 1, usage: 'decrypt' });
  const capsule = await tx.seal({ plaintext: empty({ goaway: false }) });
  for (const rx of [reflected, swapped])
    expect(await rx.accept({ capsule, apply: () => {
      throw new Error('Wrong scope');
    } })).toBe('unauthenticated');
  keys.a.dispose(); keys.b.dispose();
});

test('an old decrypt finishing late cannot roll back already committed state', async () => {
  const keys = await pair({ identities: undefined, binding: undefined });
  const { tx, rx } = codecs({ keys, label: 'test/reorder' });
  const old = await tx.seal({ plaintext: empty({ goaway: false }) }), newer = await tx.seal({ plaintext: empty({ goaway: true }) });
  const realDecrypt = crypto.subtle.decrypt.bind(crypto.subtle);
  let release: (() => void) | undefined;
  const blocked = new Promise<void>(resolve => {
    release = resolve;
  });
  const started = Promise.withResolvers<void>();
  let count = 0;
  vi.spyOn(crypto.subtle, 'decrypt').mockImplementation(async (...args) => {
    count++;
    if (count === 1) {
      started.resolve(); await blocked;
    }
    return realDecrypt(...args);
  });
  const applied: boolean[] = [];
  const pending = rx.accept({ capsule: old, apply: ({ snapshot }) => {
    applied.push(snapshot.goaway);
  } });
  await started.promise;
  expect(await rx.accept({ capsule: newer, apply: ({ snapshot }) => {
    applied.push(snapshot.goaway);
  } })).toBe('accepted');
  release?.();
  expect(await pending).toBe('stale');
  expect(applied).toEqual([true]);
  keys.a.dispose(); keys.b.dispose();
});

test('disposal during authentication prevents publishing plaintext state', async () => {
  const keys = await pair({ identities: undefined, binding: undefined });
  const { tx, rx } = codecs({ keys, label: 'test/dispose-decrypt' });
  const capsule = await tx.seal({ plaintext: empty({ goaway: false }) });
  const decrypt = crypto.subtle.decrypt.bind(crypto.subtle);
  vi.spyOn(crypto.subtle, 'decrypt').mockImplementation(async (...args) => {
    const result = await decrypt(...args); keys.b.dispose(); return result;
  });
  await expect(rx.accept({ capsule, apply: () => {
    throw new Error('Disposed delivery');
  } })).rejects.toThrow('disposed');
  expect(rx.high).toBe(-1n); keys.a.dispose();
});

test('a session cannot be reconstructed from an already consumed key context', async () => {
  const keys = await pair({ identities: undefined, binding: undefined });
  const session = await StreamSession.create({ keys: keys.a });
  await expect(StreamSession.create({ keys: keys.a })).rejects.toThrow('consumed');
  session.abort({ reason: 'Test complete' }); keys.a.dispose(); keys.b.dispose();
});

test('a failed encryption burns its record number rather than reusing its nonce', async () => {
  const keys = await pair({ identities: undefined, binding: undefined });
  const { tx, rx } = codecs({ keys, label: 'test/burn' });
  vi.spyOn(crypto.subtle, 'encrypt').mockRejectedValueOnce(new Error('Injected encryption failure'));
  await expect(tx.seal({ plaintext: empty({ goaway: false }) })).rejects.toThrow('Injected');
  expect(tx.next).toBe(1n);
  const capsule = await tx.seal({ plaintext: empty({ goaway: false }) });
  expect(new DataView(capsule.buffer).getBigUint64(1, false)).toBe(1n);
  expect(await rx.accept({ capsule, apply: () => undefined })).toBe('accepted');
  keys.a.dispose(); keys.b.dispose();
});


test('authenticated protocol violations reject the runner lifetime instead of looking like a clean stop', async () => {
  const keys = await pair({ identities: undefined, binding: undefined });
  const session = await StreamSession.create({ keys: keys.b });
  const domain = keys.a.createDomain({ label: 'piping-duplex-record/v2', context: keys.a.contextId });
  const sender = new Records({ domain, context: keys.a.contextId, direction: 1, usage: 'encrypt' });
  // A responder-local ID cannot be allocated by an incoming initiator advertisement.
  const invalid = await sender.seal({ plaintext: encodeSnapshot({ snapshot: {
    goaway: false, finished: new Uint8Array(), reset: new Uint8Array(),
    states: [{ id: 1, flags: 0, rxNext: 0n, rxLimit: 0n, final: 0n }], data: [],
  } }) });
  const stop = new AbortController();
  try {
    await expect(runDuplex({ session, signal: stop.signal,
      endpoint: { origin: 'https://relay.invalid', send: async () => {}, receive: async () => invalid, repair: async () => {} },
      pacing: { minimumMs: 2, heartbeatMs: 100, retryBaseMs: 10, retryMaximumMs: 100 }, onEvent: () => {},
    })).rejects.toThrow('Record processing failed');
    expect(session.stopped).toBe(true);
  } finally {
    stop.abort(); keys.a.dispose(); keys.b.dispose();
  }
});

test('an all-zero remote X25519 input fails closed rather than establishing a known shared secret', async () => {
  const { NoiseXX } = await import('@/features/naidan-piping-duplex/noise-xx');
  const identities = await promiseAllKeyed({ identity: createNaidanPipingIdentity(), ephemeral: createNaidanPipingIdentity() });
  const state = await NoiseXX.create({ role: 'responder', ...identities, prologue: new Uint8Array() });
  try {
    await state.exchange({ operation: 'read', bytes: new Uint8Array(32) });
    await expect(state.exchange({ operation: 'write', bytes: new Uint8Array() })).rejects.toThrow();
    await expect(state.exchange({ operation: 'write', bytes: new Uint8Array() })).rejects.toThrow('unavailable');
  } finally {
    state.dispose();
  }
});
