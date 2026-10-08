import { afterEach, beforeEach, onTestFinished, vi } from 'vitest';
import { promiseAllKeyed } from '@/utils/promise';
import { Pulse, joinBytes } from '@/features/naidan-piping-duplex/bytes';
import { createNaidanPipingIdentity } from '@/features/naidan-piping-duplex/noise-xx';
import { establishNaidanPipingKeys } from '@/features/naidan-piping-duplex/key-context';
import type { NaidanPipingHandshakeChannel } from '@/features/naidan-piping-duplex/key-context';
import { StreamSession } from '@/features/naidan-piping-duplex/session';
import type { Snapshot } from '@/features/naidan-piping-duplex/wire';

/** Unit tests never fall through to a real HTTP request. */
export function useOfflineScope(): void {
  beforeEach(() => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Unexpected network request in unit test'));
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });
}

export function mailbox(): NaidanPipingHandshakeChannel {
  const messages: Uint8Array[] = [], pulse = new Pulse();
  return {
    async send({ bytes }) {
      messages.push(bytes.slice());
      pulse.fire();
    },
    async receive({ signal }) {
      for (;;) {
        signal.throwIfAborted();
        const revision = pulse.revision, bytes = messages.shift();
        if (bytes !== undefined) return bytes;
        await pulse.wait({ revision, signal });
      }
    },
  };
}

export async function keyPair() {
  const { a, b } = await promiseAllKeyed({ a: createNaidanPipingIdentity(), b: createNaidanPipingIdentity() });
  const toA = mailbox(), toB = mailbox(), binding = crypto.getRandomValues(new Uint8Array(32));
  const stop = new AbortController();
  const timer = setTimeout(() => stop.abort(new Error('Test key exchange timed out')), 5000);
  const jobs = {
    a: establishNaidanPipingKeys({
      responseTimeoutMs: 75_000,
      role: 'initiator',
      identity: a,
      expectedPeer: b.publicKey,
      binding,
      channel: { send: toB.send, receive: toA.receive },
      signal: stop.signal,
    }),
    b: establishNaidanPipingKeys({
      responseTimeoutMs: 75_000,
      role: 'responder',
      identity: b,
      expectedPeer: a.publicKey,
      binding,
      channel: { send: toA.send, receive: toB.receive },
      signal: stop.signal,
    }),
  };
  for (const job of Object.values(jobs)) void job.catch(error => stop.abort(error));
  try {
    const keys = await promiseAllKeyed(jobs);
    onTestFinished(() => {
      keys.a.dispose(); keys.b.dispose();
    });
    return keys;
  } finally {
    clearTimeout(timer);
    stop.abort();
    await Promise.allSettled(Object.values(jobs));
  }
}

export async function sessionPair() {
  const keys = await keyPair();
  const sessions = await promiseAllKeyed({ a: StreamSession.create({ keys: keys.a }), b: StreamSession.create({ keys: keys.b }) });
  onTestFinished(() => {
    sessions.a.abort({ reason: 'Test cleanup' });
    sessions.b.abort({ reason: 'Test cleanup' });
  });
  return sessions;
}

export async function exchange({ a, b }: { a: StreamSession; b: StreamSession }): Promise<void> {
  const capsules = await promiseAllKeyed({ left: offeredCapsule({ session: a }), right: offeredCapsule({ session: b }) });
  await b.acceptCapsule({ capsule: capsules.left });
  await a.acceptCapsule({ capsule: capsules.right });
}

/** Simulate a POST offer without treating delivery as peer acknowledgement. */
export async function offeredCapsule({ session }: { session: StreamSession }): Promise<Uint8Array> {
  const transmission = await session.makeCapsule({ reason: 'idle-resend' });
  const release = transmission.start({ onReceived: () => {} });
  release();
  return transmission.bytes;
}

/** A bounded local driver; no socket, retries on wall-clock races, or private-state writes. */
export async function drive<T>({ a, b, operation, limit }: {
  a: StreamSession; b: StreamSession; operation: () => Promise<T>; limit: number;
}): Promise<T> {
  let settled = false;
  const pending = operation();
  void pending.then(() => {
    settled = true;
  }, () => {
    settled = true;
  });
  for (let step = 0; !settled && step < limit; step++) {
    await exchange({ a, b });
    // Real Web Crypto callbacks and native Streams must get an event-loop turn.
    await new Promise<void>(resolve => setTimeout(resolve, 0));
  }
  if (!settled) throw new Error(`Local driver did not converge: ${JSON.stringify({ a: a.debug(), b: b.debug() })}`);
  return pending;
}

export async function opened({ a, b }: { a: StreamSession; b: StreamSession }) {
  const incoming = b.incomingStreams[Symbol.asyncIterator]();
  const aStream = await drive({ a, b, operation: () => a.openStream({ signal: undefined }), limit: 30 });
  const entry = await incoming.next();
  if (entry.done) throw new Error('Missing incoming stream');
  return { aStream, bStream: entry.value, incoming };
}

export function pattern({ size, seed }: { size: number; seed: number }): Uint8Array<ArrayBuffer> {
  let state = seed >>> 0;
  const bytes = new Uint8Array(size);
  for (let index = 0; index < size; index++) {
    state ^= state << 13; state ^= state >>> 17; state ^= state << 5;
    bytes[index] = state & 255;
  }
  return bytes;
}

export async function readAll({ readable }: { readable: ReadableStream<Uint8Array> }): Promise<Uint8Array<ArrayBuffer>> {
  const reader = readable.getReader(), parts: Uint8Array[] = [];
  try {
    for (;;) {
      const item = await reader.read();
      if (item.done) return joinBytes({ parts });
      parts.push(item.value);
    }
  } finally {
    reader.releaseLock();
  }
}

export function emptySnapshot(): Snapshot {
  return { goaway: false, finished: new Uint8Array(), reset: new Uint8Array(), states: [], data: [] };
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
export const TEST_ONLY = {
};
