// @vitest-environment node
import { expect, it, vi } from 'vitest';
import { discoverCandidate } from './bootstrap';
import { encodeDiscovery, encodeHint, inspectDiscovery } from './envelope';
import { encodeProtocolHeader } from './protocol-header';
import { rendezvousRoute } from './rendezvous';
import { JournalChannel } from './journal';
import { joinBytes } from './bytes';
import { PipingRetirementError } from './lifetime';
import { AttemptError } from './finite';
import type { FiniteTransport } from './finite';

function waitAbort({ signal }: { signal: AbortSignal }): Promise<never> {
  signal.throwIfAborted(); return new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
}

it.each(['retired', 'failed'] as const)('a compatible offer cancels the sole hint POST and waits for %s cleanup', async outcome => {
  const room = new Uint8Array(32).fill(4), owner = new Uint8Array(16).fill(5), stop = new AbortController();
  const offerRoute = await rendezvousRoute({ room, kind: 'offer', attempts: [] });
  const bad = encodeDiscovery({ kind: 'offer', attemptI: new Uint8Array(32).fill(1), publicData: new Uint8Array() });
  new DataView(bad.buffer).setUint32(9, 0x80000003, true);
  const good = encodeDiscovery({ kind: 'offer', attemptI: new Uint8Array(32).fill(2), publicData: new Uint8Array([9]) });
  const canceled = Promise.withResolvers<void>(), release = Promise.withResolvers<void>(), replyEntered = Promise.withResolvers<Uint8Array>();
  let receives = 0, posts = 0, active = 0; const cleanup = new Error('Hint retirement unconfirmed');
  const endpoint: FiniteTransport = {
    origin: 'https://relay.invalid',
    repair: async () => {
      throw new Error('No public repair');
    },
    async send({ bytes, signal }) {
      expect(active++).toBe(0); posts++;
      try {
        if (bytes[13] === 3) {
          expect(bytes.length).toBe(46);
          let original: unknown;
          try {
            await waitAbort({ signal });
          } catch (error) {
            original = error;
          }
          canceled.resolve(); await release.promise;
          if (outcome === 'failed') throw new PipingRetirementError({ cause: cleanup, logicalError: original });
          throw original;
        } else {
          replyEntered.resolve(bytes.slice()); await waitAbort({ signal });
        }
      } finally {
        active--;
      }
    },
    async receive({ route, signal }) {
      signal.throwIfAborted();
      if (route === offerRoute) return ++receives === 1 ? bad : good;
      const packet = inspectDiscovery({ bytes: await replyEntered.promise });
      if (packet.kind !== 'reply') throw new Error('Expected reply');
      const journal = new JournalChannel({ role: 'initiator', attemptI: packet.attemptI, attemptR: packet.attemptR });
      const bytes = joinBytes({ parts: [encodeProtocolHeader(), new Uint8Array([4]), new Uint8Array(32).fill(6), journal.snapshot()] });
      journal.dispose(); return bytes;
    },
  };
  const task = discoverCandidate({ role: 'responder', room, owner, endpoint, signal: stop.signal, confirmationTimeoutMs: 1000, intervalMs: 1 });
  void task.catch(() => {});
  await canceled.promise; expect(posts).toBe(1); expect(active).toBe(1); release.resolve();
  if (outcome === 'failed') await expect(task).rejects.toBeInstanceOf(PipingRetirementError);
  else {
    const result = await task; expect(posts).toBe(2); expect(result.peerPublicData).toEqual(new Uint8Array([9]));
    expect(result.channel.bound).toBe(true); result.channel.dispose(); result.confirmation.dispose();
  }
  expect(active).toBe(0); stop.abort();
});

it('hints, wrong magic, zero revision and foreign kinds cannot reflect another hint', async () => {
  const stop = new AbortController(), attemptI = new Uint8Array(32).fill(7);
  const wrong = encodeDiscovery({ kind: 'offer', attemptI, publicData: new Uint8Array() }); wrong[0] = 1;
  const invalid = encodeDiscovery({ kind: 'offer', attemptI, publicData: new Uint8Array() }); new DataView(invalid.buffer).setUint32(9, 0x80000000, true);
  const unknown = encodeDiscovery({ kind: 'offer', attemptI, publicData: new Uint8Array() }); unknown[13] = 255;
  const packets = [encodeHint({ attemptI }), wrong, invalid, unknown], send = vi.fn();
  const reason = new Error('End observation');
  const endpoint: FiniteTransport = {
    origin: 'https://relay.invalid',
    send,
    repair: async () => {},
    async receive() {
      const next = packets.shift(); if (next) return next; stop.abort(reason); throw reason;
    },
  };
  await expect(discoverCandidate({
    role: 'responder',
    room: new Uint8Array(32),
    owner: new Uint8Array(16).fill(8),
    endpoint,
    signal: stop.signal,
    confirmationTimeoutMs: 1000,
    intervalMs: 1,
  })).rejects.toBe(reason);
  expect(send).not.toHaveBeenCalled();
});

it('cancellation stops discovery HTTP immediately but joins native transcript preparation', async () => {
  const stop = new AbortController(), entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  const digest = crypto.subtle.digest.bind(crypto.subtle);
  vi.spyOn(crypto.subtle, 'digest').mockImplementation(async (algorithm, bytes) => {
    const view = bytes instanceof ArrayBuffer ? new Uint8Array(bytes) : new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    if (new TextDecoder().decode(view).includes('piping-rendezvous-binding/v2')) {
      entered.resolve(); await release.promise;
    }
    return digest(algorithm, bytes);
  });
  const offered = Promise.withResolvers<Uint8Array>(); let posts = 0;
  const endpoint: FiniteTransport = {
    origin: 'https://relay.invalid',
    repair: async () => {},
    async send({ bytes, signal }) {
      posts++; offered.resolve(bytes.slice()); try {
        await waitAbort({ signal });
      } finally {
        posts--;
      }
    },
    async receive() {
      const packet = inspectDiscovery({ bytes: await offered.promise }); if (packet.kind !== 'offer') throw new Error('Expected offer');
      return encodeDiscovery({ kind: 'reply', attemptI: packet.attemptI, attemptR: new Uint8Array(32).fill(9), publicData: new Uint8Array() });
    },
  };
  const task = discoverCandidate({
    role: 'initiator',
    room: new Uint8Array(32),
    owner: new Uint8Array(16).fill(1),
    endpoint,
    signal: stop.signal,
    confirmationTimeoutMs: 1000,
    intervalMs: 1,
  });
  let finished = false; void task.then(() => {
    finished = true;
  }, () => {
    finished = true;
  });
  try {
    await entered.promise; const reason = new Error('Cancel native preparation'); stop.abort(reason);
    await Promise.resolve(); expect(posts).toBe(0); expect(finished).toBe(false);
    release.resolve(); await expect(task).rejects.toBe(reason);
  } finally {
    release.resolve(); stop.abort(); await task.catch(() => {}); vi.restoreAllMocks();
  }
});

it('a failed optional hint POST cannot poison later compatible discovery', async () => {
  const stop = new AbortController(), room = new Uint8Array(32), owner = new Uint8Array(16).fill(5);
  const offerRoute = await rendezvousRoute({ room, kind: 'offer', attempts: [] });
  const bad = encodeDiscovery({ kind: 'offer', attemptI: new Uint8Array(32).fill(1), publicData: new Uint8Array() });
  new DataView(bad.buffer).setUint32(9, 0x80000003, true);
  const good = encodeDiscovery({ kind: 'offer', attemptI: new Uint8Array(32).fill(2), publicData: new Uint8Array() });
  let reads = 0, hints = 0; const reply = Promise.withResolvers<Uint8Array>();
  const endpoint: FiniteTransport = {
    origin: 'https://relay.invalid',
    repair: async () => {},
    async send({ bytes, signal }) {
      if (bytes[13] === 3) {
        hints++; throw new AttemptError({ kind: 'fatal' });
      }
      reply.resolve(bytes); await waitAbort({ signal });
    },
    async receive({ route, signal }) {
      if (route === offerRoute) {
        reads++; if (reads === 1) return bad;
        if (reads === 2) return waitAbort({ signal });
        return good;
      }
      const packet = inspectDiscovery({ bytes: await reply.promise }); if (packet.kind !== 'reply') throw new Error('Expected reply');
      const journal = new JournalChannel({ role: 'initiator', attemptI: packet.attemptI, attemptR: packet.attemptR });
      const bytes = joinBytes({ parts: [encodeProtocolHeader(), new Uint8Array([4]), new Uint8Array(32).fill(6), journal.snapshot()] });
      journal.dispose(); return bytes;
    },
  };
  const result = await discoverCandidate({ role: 'responder', room, owner, endpoint, signal: stop.signal, confirmationTimeoutMs: 1000, intervalMs: 1 });
  expect(hints).toBe(1); expect(result.channel.bound).toBe(true); result.channel.dispose(); result.confirmation.dispose(); stop.abort();
});
