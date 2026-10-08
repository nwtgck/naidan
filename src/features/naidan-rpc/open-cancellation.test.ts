import { afterEach, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { contract, procedure } from './contract';
import { NaidanRpcPeer } from './peer';
import type { NaidanRpcDuplex, NaidanRpcTransport } from './transport';

const definition = contract({
  name: 'test.open-cancellation',
  methods: {
    run: procedure({ input: z.strictObject({}), result: z.number(), notifications: {} }),
  },
});

afterEach(() => vi.useRealTimers());

function pendingTransport() {
  const incoming = Promise.withResolvers<IteratorResult<NaidanRpcDuplex>>();
  const opening = Promise.withResolvers<NaidanRpcDuplex>();
  const openStream = vi.fn(() => opening.promise);
  const transport: NaidanRpcTransport = {
    openStream,
    ended: new Promise(() => {}),
    closed: new Promise(() => {}),
    incomingStreams: {
      [Symbol.asyncIterator]() {
        return {
          next: () => incoming.promise,
          async return() {
            incoming.resolve({ done: true, value: undefined });
            return { done: true as const, value: undefined };
          },
        };
      },
    },
  };
  return { transport, opening, openStream };
}

it.each(['call', 'signal', 'peer', 'deadline', 'maximum'] as const)('%s reports cancellation before a lower open retires', async kind => {
  vi.useFakeTimers();
  const { transport, opening, openStream } = pendingTransport();
  const parent = new AbortController(), signal = new AbortController();
  const peer = new NaidanRpcPeer({ transport, exports: [], limits: { maxCalls: 1, maxCallTimeoutMs: kind === 'maximum' ? 10 : undefined }, signal: parent.signal });
  const call = peer.client({ contract: definition }).run({ input: {}, on: {}, signal: signal.signal, timeoutMs: kind === 'deadline' ? 10 : undefined });
  let resultCode: unknown, closedCode: unknown;
  void call.result.catch(error => {
    resultCode = error.code;
  });
  void call.closed.catch(error => {
    closedCode = error.code;
  });
  const abort = vi.fn();
  try {
    expect(openStream).toHaveBeenCalledOnce();
    switch (kind) {
    case 'call': call.cancel({ reason: 'User stopped this call' }); break;
    case 'signal': signal.abort(); break;
    case 'peer': parent.abort(); break;
    case 'deadline': case 'maximum': break;
    default: { const exhaustive: never = kind; throw new Error(String(exhaustive)); }
    }
    await vi.advanceTimersByTimeAsync(20);
    const expected = kind === 'deadline' || kind === 'maximum' ? 'DEADLINE_EXCEEDED' : 'CANCELLED';
    expect(resultCode).toBe(expected); expect(closedCode).toBe(expected);
    expect(abort).not.toHaveBeenCalled();
    if (kind !== 'peer') {
      const other = peer.client({ contract: definition }).run({ input: {}, on: {}, signal: undefined, timeoutMs: undefined });
      await expect(other.result).rejects.toMatchObject({ code: 'RESOURCE_EXHAUSTED' });
      await expect(other.closed).rejects.toMatchObject({ code: 'RESOURCE_EXHAUSTED' });
      expect(openStream).toHaveBeenCalledOnce();
    }
    let retired = false;
    const closing = peer.retire().then(() => {
      retired = true;
    });
    await vi.advanceTimersByTimeAsync(1);
    expect(retired).toBe(false);
    opening.resolve({ readable: new ReadableStream(), writable: new WritableStream(), closed: Promise.resolve(), abort });
    await closing;
    expect(abort).toHaveBeenCalledOnce();
    expect(resultCode).toBe(expected); expect(closedCode).toBe(expected);
  } finally {
    opening.resolve({ readable: new ReadableStream(), writable: new WritableStream(), closed: Promise.resolve(), abort });
    await peer.retire();
    await Promise.allSettled([call.result, call.closed]);
  }
});

it('keeps a cancellation result when a lower open eventually rejects', async () => {
  const { transport, opening } = pendingTransport();
  const peer = new NaidanRpcPeer({ transport, exports: [], limits: { maxCalls: 1, maxCallTimeoutMs: undefined }, signal: new AbortController().signal });
  const call = peer.client({ contract: definition }).run({ input: {}, on: {}, signal: undefined, timeoutMs: undefined });
  let failure: unknown;
  void call.result.catch(error => {
    failure = error;
  });
  call.cancel({ reason: 'Cancel' });
  try {
    await Promise.resolve();
    expect(failure).toMatchObject({ code: 'CANCELLED' });
  } finally {
    opening.reject(new Error('Late transport failure'));
    await peer.retire();
    await Promise.allSettled([call.result, call.closed]);
  }
  expect(failure).toMatchObject({ code: 'CANCELLED' });
});

export const TEST_ONLY = {
};
