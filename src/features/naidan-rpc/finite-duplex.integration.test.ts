// @vitest-environment node
import { expect, it, vi } from 'vitest';
import { z } from 'zod';
import { contract, procedure, expose, NaidanRpcPeer, rpc } from './index';
import { NaidanPipingDuplexSession } from '@/features/naidan-piping-duplex/naidan-piping-duplex-session';
import { createNaidanPipingIdentity } from '@/features/naidan-piping-duplex/noise-xx';
import { FiniteMemoryRelay } from '@/features/naidan-piping-duplex/finite-memory-relay.test-support';
import { useOfflineScope } from '@/features/naidan-piping-duplex/test-support';
import type { NaidanRpcTransport } from './transport';
import { BYTE_PULL_BYTES, ITEM_FRAGMENT_BYTES, WRITE_BATCH_BYTES } from './primitives';

useOfflineScope();

it.each(['value', 'bytes', 'item'] as const)('carries an already available large %s through RPC and finite Duplex without 16 KiB POSTs', async mode => {
  const relay = new FiniteMemoryRelay({ chunkBytes: 8191 }), stop = new AbortController();
  vi.mocked(fetch).mockImplementation(relay.fetch);
  const identities = await Promise.all([createNaidanPipingIdentity(), createNaidanPipingIdentity()]);
  const piping = { baseUrl: 'https://relay.invalid', policy: 'https-only' as const, requestTimeoutMs: 3000, handshakeResponseTimeoutMs: 3000 };
  const sessions = await Promise.all([0, 1].map(index => NaidanPipingDuplexSession.connectPinned({ piping, identity: identities[index]!, expectedPeer: identities[1 - index]!.publicKey, signal: stop.signal })));
  const payload = new Uint8Array(mode === 'item' ? ITEM_FRAGMENT_BYTES + 33 : BYTE_PULL_BYTES);
  for (let index = 0; index < payload.length; index++) payload[index] = index % 251;
  const definition = contract({
    name: 'finite.large',
    methods: {
      value: procedure({ input: z.object({}), result: z.instanceof(Uint8Array), notifications: {} }),
      bytes: procedure({ input: z.object({}), result: rpc.byteStream(), notifications: {} }),
      item: procedure({ input: z.object({}), result: rpc.stream({ item: z.instanceof(Uint8Array) }), notifications: {} }),
    },
  });
  const source = () => new ReadableStream<Uint8Array<ArrayBuffer>>({
    start(controller) {
      controller.enqueue(payload); controller.close();
    },
  }, { highWaterMark: 0 });
  const asTransport = ({ session }: { session: NaidanPipingDuplexSession }): NaidanRpcTransport => ({
    incomingStreams: session.incomingStreams,
    closed: session.closed,
    ended: session.ended,
    openStream: ({ signal }) => session.openStream({ signal }),
  });
  const a = new NaidanRpcPeer({ transport: asTransport({ session: sessions[0]! }), exports: [], limits: { maxCalls: 2, maxCallTimeoutMs: undefined }, signal: stop.signal });
  const b = new NaidanRpcPeer({ transport: asTransport({ session: sessions[1]! }), exports: [expose({ contract: definition, allowedMethods: ['value', 'bytes', 'item'], implementation: { value: () => payload, bytes: source, item: source } })], limits: { maxCalls: 2, maxCallTimeoutMs: undefined }, signal: stop.signal });
  const start = relay.posts.length;
  try {
    const call = a.client({ contract: definition })[mode]({ input: {}, on: {}, signal: stop.signal, timeoutMs: undefined });
    const value = await call.result;
    let received: Uint8Array;
    if (value instanceof ReadableStream) {
      const reader = value.getReader(), chunks: Uint8Array[] = [];
      try {
        for (;;) {
          const next = await reader.read(); if (next.done) break; chunks.push(next.value);
        }
      } finally {
        reader.releaseLock();
      }
      received = Buffer.concat(chunks);
    } else received = value;
    expect(Buffer.from(received).equals(Buffer.from(payload))).toBe(true);
    await call.closed;
    const posted = relay.posts.slice(start);
    // Window updates and the encoded envelope may require small trailing POSTs;
    // the ready payload itself must travel in a large batch, not 64 tiny ones.
    const large = posted.filter(post => post.bytes.length > 512 * 1024);
    expect(large).toHaveLength(1);
    expect(posted.filter(post => post.bytes.length > 16 * 1024)).toHaveLength(1);
    expect(WRITE_BATCH_BYTES).toBeGreaterThan(BYTE_PULL_BYTES);
  } finally {
    stop.abort(); for (const session of sessions) session.abort({ reason: 'Test finished' });
    await Promise.all([a.retire(), b.retire(), ...sessions.map(session => session.closed)]);
    relay.interrupt();
  }
  expect(relay.occupied).toBe(0);
});
