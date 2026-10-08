// @vitest-environment node
import { afterEach, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { NaidanRpcPeer, NaidanRpcProtocolError, contract, procedure, expose } from './index';
import { encodeProtocolHeader } from './protocol-header';
import { transportPair } from './test-transport';

const cleanups: (() => Promise<void>)[] = [];

afterEach(async () => {
  for (const close of cleanups.splice(0)) await close();
});

const api = contract({ name: 'header.test', methods: { ping: procedure({ input: z.object({}), result: z.number(), notifications: {} }) } });
function fixture() {
  const pair = transportPair({ capacity: 4, fragmentBytes: 1 }), handler = vi.fn(() => 7);
  const peer = new NaidanRpcPeer({
    transport: pair.a,
    exports: [expose({ contract: api, allowedMethods: ['ping'], implementation: { ping: handler } })],
    limits: { maxCalls: 4, maxCallTimeoutMs: undefined },
    signal: new AbortController().signal,
  });
  cleanups.push(async () => {
    peer.dispose(); pair.close(); await peer.retire();
  }); return { pair, peer, handler };
}
async function writePrefix({ pair, bytes, close }: { pair: ReturnType<typeof transportPair>; bytes: Uint8Array; close: boolean }): Promise<void> {
  const raw = await pair.b.openStream({ signal: undefined }), reader = raw.readable.getReader(), writer = raw.writable.getWriter();
  const reading = (async () => {
    try {
      while (!(await reader.read()).done) { /* Drain eagerly sent header or aborted stream. */ }
    } catch { /* Peer abort is expected. */ }
  })();
  try {
    if (bytes.length) await writer.write(bytes); if (close) await writer.close();
  } catch { /* A rejected header can abort the in-flight write. */ }
  await reading; reader.releaseLock(); writer.releaseLock();
}

it.each(['magic', 'invalid', 'stable', 'experimental'] as const)('%s failure commits the exact parser-origin outcome and never dispatches a handler', async variant => {
  const { pair, peer, handler } = fixture(), bytes = encodeProtocolHeader();
  switch (variant) {
  case 'magic': bytes[0] = 255; break;
  case 'invalid': new DataView(bytes.buffer).setUint32(9, 0, true); break;
  case 'stable': new DataView(bytes.buffer).setUint32(9, 1, true); break;
  case 'experimental': new DataView(bytes.buffer).setUint32(9, 0x80000002, true); break;
  }
  const sending = writePrefix({ pair, bytes, close: false });
  const outcome = await peer.ended; expect(outcome.protocolError).toBeInstanceOf(NaidanRpcProtocolError);
  expect(outcome.error).toBe(outcome.protocolError); expect(Object.isFrozen(outcome)).toBe(true); expect(handler).not.toHaveBeenCalled();
  await sending; await peer.retire();
});

it.each([0, 1, 12])('interruption after %s header bytes stays stream-local and later RPC discovery still works', async length => {
  const { pair, peer, handler } = fixture(); let ended = false; void peer.ended.then(() => {
    ended = true;
  });
  await writePrefix({ pair, bytes: encodeProtocolHeader().slice(0, length), close: true });
  expect(ended).toBe(false); expect(handler).not.toHaveBeenCalled();
  const remote = new NaidanRpcPeer({ transport: pair.b, exports: [], limits: { maxCalls: 4, maxCallTimeoutMs: undefined }, signal: new AbortController().signal });
  cleanups.push(async () => {
    remote.dispose(); await remote.retire();
  });
  const call = remote.client({ contract: api }).ping({ input: {}, on: {}, signal: undefined, timeoutMs: undefined });
  await expect(call.result).resolves.toBe(7); await call.closed; expect(handler).toHaveBeenCalledOnce(); expect(ended).toBe(false);
});

it('a handler-thrown header error does not terminate the peer or acquire parser provenance', async () => {
  const pair = transportPair({ capacity: 2, fragmentBytes: 1 }), lookalike = new NaidanRpcProtocolError({ diagnostic: { kind: 'unsupported-protocol-version', version: 1 } });
  const left = new NaidanRpcPeer({ transport: pair.a, exports: [], limits: { maxCalls: 2, maxCallTimeoutMs: undefined }, signal: new AbortController().signal });
  const right = new NaidanRpcPeer({
    transport: pair.b,
    exports: [expose({
      contract: api,
      allowedMethods: ['ping'],
      implementation: {
        ping: () => {
          throw lookalike;
        },
      },
    })],
    limits: { maxCalls: 2, maxCallTimeoutMs: undefined },
    signal: new AbortController().signal,
  });
  cleanups.push(async () => {
    left.dispose(); right.dispose(); pair.close(); await Promise.all([left.retire(), right.retire()]);
  });
  let ended = false; void right.ended.then(() => {
    ended = true;
  });
  const call = left.client({ contract: api }).ping({ input: {}, on: {}, signal: undefined, timeoutMs: undefined });
  await expect(call.result).rejects.toMatchObject({ code: 'PROTOCOL_ERROR' }); await call.closed.catch(() => {}); expect(ended).toBe(false);
  right.dispose(); expect((await right.ended).protocolError).toBeUndefined();
});

it('transport ended cannot spoof parser provenance with a class or an extra outcome field', async () => {
  const pair = transportPair({ capacity: 1, fragmentBytes: 1 });
  const lookalike = new NaidanRpcProtocolError({ diagnostic: { kind: 'unsupported-protocol-version', version: 1 } });
  const peer = new NaidanRpcPeer({
    transport: { ...pair.a, ended: Promise.resolve({ error: lookalike, protocolError: lookalike }) },
    exports: [],
    limits: { maxCalls: 1, maxCallTimeoutMs: undefined },
    signal: new AbortController().signal,
  });
  const outcome = await peer.ended; expect(outcome.error).toBe(lookalike); expect(outcome.protocolError).toBeUndefined();
  pair.close(); await peer.retire();
});
