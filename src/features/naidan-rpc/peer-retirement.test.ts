import { expect, it, vi } from 'vitest';
import { z } from 'zod';
import { contract, procedure } from './contract';
import { NaidanRpcPeer } from './peer';
import type { NaidanRpcDuplex, NaidanRpcTransport } from './transport';

const definition = contract({
  name: 'test.retirement',
  methods: {
    run: procedure({ input: z.strictObject({}), result: z.number(), notifications: {} }),
  },
});
function idleIncoming() {
  const next = Promise.withResolvers<IteratorResult<NaidanRpcDuplex>>();
  return {
    [Symbol.asyncIterator]() {
      return {
        next: () => next.promise,
        async return() {
          next.resolve({ done: true, value: undefined }); return { done: true as const, value: undefined };
        },
      };
    },
  };
}

it('retirement joins a pending stream open and aborts its late duplex before returning', async () => {
  const opening = Promise.withResolvers<NaidanRpcDuplex>(), transportClosed = Promise.withResolvers<void>();
  const open = vi.fn(async () => opening.promise);
  const transport: NaidanRpcTransport = { openStream: open, incomingStreams: idleIncoming(), ended: new Promise(() => {}), closed: transportClosed.promise };
  const peer = new NaidanRpcPeer({ transport, exports: [], limits: { maxCalls: 2, maxCallTimeoutMs: undefined }, signal: new AbortController().signal });
  const call = peer.client({ contract: definition }).run({ input: {}, on: {}, signal: undefined, timeoutMs: undefined });
  const rejected = Promise.all([expect(call.result).rejects.toMatchObject({ code: 'CANCELLED' }), expect(call.closed).rejects.toBeDefined()]);
  expect(open).toHaveBeenCalledOnce();
  let ended = false;
  const retired = peer.retire().then(() => {
    ended = true;
  });
  await new Promise(resolve => setTimeout(resolve, 0));
  const endedBeforeOpen = ended;
  const aborted = vi.fn();
  opening.resolve({ readable: new ReadableStream(), writable: new WritableStream(), closed: Promise.resolve(), abort: aborted });
  await retired; await rejected;
  expect(endedBeforeOpen).toBe(false); expect(aborted).toHaveBeenCalledOnce(); expect(ended).toBe(true);
});

it('retirement includes the incoming iterator owner, including a late incoming duplex', async () => {
  const next = Promise.withResolvers<IteratorResult<NaidanRpcDuplex>>(), returned = Promise.withResolvers<IteratorResult<NaidanRpcDuplex>>();
  const abort = vi.fn();
  const transport: NaidanRpcTransport = {
    ended: new Promise(() => {}),
    closed: new Promise(() => {}),
    openStream: async () => {
      throw new Error('No outgoing calls');
    },
    incomingStreams: {
      [Symbol.asyncIterator]() {
        return { next: () => next.promise, return: () => returned.promise };
      },
    },
  };
  const peer = new NaidanRpcPeer({ transport, exports: [], limits: { maxCalls: 2, maxCallTimeoutMs: undefined }, signal: new AbortController().signal });
  let ended = false; const retiring = peer.retire().then(() => {
    ended = true;
  });
  await new Promise(resolve => setTimeout(resolve, 0)); const endedBeforeInput = ended;
  next.resolve({ done: false, value: { readable: new ReadableStream(), writable: new WritableStream(), closed: Promise.resolve(), abort } });
  returned.resolve({ done: true, value: undefined }); await retiring; await peer.closed;
  expect(endedBeforeInput).toBe(false); expect(abort).toHaveBeenCalledOnce();
});

it('joins asynchronous iterator return cleanup even after next has finished', async () => {
  const next = Promise.withResolvers<IteratorResult<NaidanRpcDuplex>>(), returned = Promise.withResolvers<IteratorResult<NaidanRpcDuplex>>();
  const peer = new NaidanRpcPeer({
    transport: {
      ended: new Promise(() => {}),
      closed: new Promise(() => {}),
      openStream: async () => {
        throw new Error('No outgoing calls');
      },
      incomingStreams: {
        [Symbol.asyncIterator]() {
          return {
            next: () => next.promise,
            return() {
              next.resolve({ done: true, value: undefined }); return returned.promise;
            },
          };
        },
      },
    },
    exports: [],
    limits: { maxCalls: 2, maxCallTimeoutMs: undefined },
    signal: new AbortController().signal,
  });
  let ended = false; const retiring = peer.retire().then(() => {
    ended = true;
  });
  await peer.closed; await new Promise(resolve => setTimeout(resolve, 0)); const endedBeforeReturn = ended;
  returned.resolve({ done: true, value: undefined }); await retiring;
  expect(endedBeforeReturn).toBe(false);
});

it('a failed iterator cleanup is reported only after a late outgoing duplex is retired', async () => {
  const next = Promise.withResolvers<IteratorResult<NaidanRpcDuplex>>();
  const opening = Promise.withResolvers<NaidanRpcDuplex>();
  const failure = new Error('Iterator cleanup failed');
  const peer = new NaidanRpcPeer({
    transport: {
      ended: new Promise(() => {}),
      closed: new Promise(() => {}),
      openStream: () => opening.promise,
      incomingStreams: {
        [Symbol.asyncIterator]() {
          return {
            next: () => next.promise,
            return() {
              next.resolve({ done: true, value: undefined }); return Promise.reject(failure);
            },
          };
        },
      },
    },
    exports: [],
    limits: { maxCalls: 2, maxCallTimeoutMs: undefined },
    signal: new AbortController().signal,
  });
  const call = peer.client({ contract: definition }).run({ input: {}, on: {}, signal: undefined, timeoutMs: undefined });
  const resultFailure = expect(call.result).rejects.toBeDefined(), callFailure = expect(call.closed).rejects.toBeDefined();
  let settled = false;
  const retirement = peer.retire();
  const rejected = expect(retirement).rejects.toBe(failure);
  void retirement.then(() => {
    settled = true;
  }, () => {
    settled = true;
  });
  await peer.closed; await new Promise(resolve => setTimeout(resolve, 0)); const settledBeforeOpen = settled;
  const abort = vi.fn(); opening.resolve({ readable: new ReadableStream(), writable: new WritableStream(), closed: Promise.resolve(), abort });
  await rejected; await resultFailure; await callFailure;
  expect(settledBeforeOpen).toBe(false); expect(abort).toHaveBeenCalledOnce();
  await expect(peer.retire()).rejects.toBe(failure);
});

it('reports a synchronous iterator return failure through retirement without dropping it', async () => {
  const next = Promise.withResolvers<IteratorResult<NaidanRpcDuplex>>();
  const failure = new Error('Synchronous return failure');
  const peer = new NaidanRpcPeer({
    transport: {
      ended: new Promise(() => {}),
      closed: new Promise(() => {}),
      openStream: async () => {
        throw new Error('No outgoing calls');
      },
      incomingStreams: {
        [Symbol.asyncIterator]() {
          return {
            next: () => next.promise,
            return() {
              next.resolve({ done: true, value: undefined }); throw failure;
            },
          };
        },
      },
    },
    exports: [],
    limits: { maxCalls: 1, maxCallTimeoutMs: undefined },
    signal: new AbortController().signal,
  });
  await expect(peer.retire()).rejects.toBe(failure);
  await expect(peer.retire()).rejects.toBe(failure);
});

it('closes an iterator even when creating it synchronously aborts the parent lifetime', async () => {
  const lifetime = new AbortController();
  const cleanup = vi.fn(async () => ({ done: true as const, value: undefined }));
  const peer = new NaidanRpcPeer({
    transport: {
      ended: new Promise(() => {}),
      closed: new Promise(() => {}),
      openStream: async () => {
        throw new Error('No outgoing calls');
      },
      incomingStreams: {
        [Symbol.asyncIterator]() {
          lifetime.abort();
          return { next: async () => ({ done: true as const, value: undefined }), return: cleanup };
        },
      },
    },
    exports: [],
    limits: { maxCalls: 1, maxCallTimeoutMs: undefined },
    signal: lifetime.signal,
  });
  await peer.retire(); expect(cleanup).toHaveBeenCalledOnce();
});

it('aborts an outgoing duplex when it cannot acquire the framed stream writers', async () => {
  const writable = new WritableStream<Uint8Array>(), locked = writable.getWriter(), abort = vi.fn();
  const readable = new ReadableStream<Uint8Array>();
  const peer = new NaidanRpcPeer({
    transport: {
      incomingStreams: idleIncoming(),
      ended: new Promise(() => {}),
      closed: new Promise(() => {}),
      openStream: async () => ({ readable, writable, closed: Promise.resolve(), abort }),
    },
    exports: [],
    limits: { maxCalls: 1, maxCallTimeoutMs: undefined },
    signal: new AbortController().signal,
  });
  const call = peer.client({ contract: definition }).run({ input: {}, on: {}, signal: undefined, timeoutMs: undefined });
  try {
    await expect(call.result).rejects.toBeInstanceOf(TypeError); await expect(call.closed).rejects.toBeInstanceOf(TypeError);
    await peer.retire();
    expect(abort).toHaveBeenCalledOnce(); expect(readable.locked).toBe(false);
  } finally {
    locked.releaseLock(); await peer.retire();
  }
});

it('retains a failed late-duplex abort while still joining the other pending opens', async () => {
  const failure = new Error('Could not abort the late duplex');
  const openings = [Promise.withResolvers<NaidanRpcDuplex>(), Promise.withResolvers<NaidanRpcDuplex>()];
  let at = 0;
  const peer = new NaidanRpcPeer({
    transport: {
      incomingStreams: idleIncoming(),
      ended: new Promise(() => {}),
      closed: new Promise(() => {}),
      openStream: () => openings[at++]!.promise,
    },
    exports: [],
    limits: { maxCalls: 2, maxCallTimeoutMs: undefined },
    signal: new AbortController().signal,
  });
  const calls = [0, 1].map(() => peer.client({ contract: definition }).run({ input: {}, on: {}, signal: undefined, timeoutMs: undefined }));
  for (const call of calls) {
    void call.result.catch(() => {}); void call.closed.catch(() => {});
  }
  const retirement = peer.retire(); let settled = false;
  void retirement.then(() => {
    settled = true;
  }, () => {
    settled = true;
  });
  const abort = vi.fn(() => {
      throw failure;
    }), otherAbort = vi.fn();
  try {
    openings[0]!.resolve({ readable: new ReadableStream(), writable: new WritableStream(), closed: Promise.resolve(), abort });
    await vi.waitFor(() => expect(abort).toHaveBeenCalledOnce());
    expect(settled).toBe(false);
    openings[1]!.resolve({ readable: new ReadableStream(), writable: new WritableStream(), closed: Promise.resolve(), abort: otherAbort });
    await expect(retirement).rejects.toBe(failure);
    expect(otherAbort).toHaveBeenCalledOnce();
    await expect(peer.retire()).rejects.toBe(failure);
  } finally {
    for (const opening of openings) opening.resolve({ readable: new ReadableStream(), writable: new WritableStream(), closed: Promise.resolve(), abort: () => {} });
    await retirement.catch(() => {});
  }
});

it('does not report retirement success if an incoming duplex rejected during shutdown cannot be aborted', async () => {
  const next = Promise.withResolvers<IteratorResult<NaidanRpcDuplex>>();
  const returned = Promise.withResolvers<IteratorResult<NaidanRpcDuplex>>();
  const failure = new Error('Rejected incoming duplex cleanup failed');
  const peer = new NaidanRpcPeer({
    transport: {
      incomingStreams: {
        [Symbol.asyncIterator]() {
          return { next: () => next.promise, return: () => returned.promise };
        },
      },
      ended: new Promise(() => {}),
      closed: new Promise(() => {}),
      openStream: async () => {
        throw new Error('Not used');
      },
    },
    exports: [],
    limits: { maxCalls: 1, maxCallTimeoutMs: undefined },
    signal: new AbortController().signal,
  });
  const retirement = peer.retire(); void retirement.catch(() => {});
  next.resolve({
    done: false,
    value: {
      readable: new ReadableStream(),
      writable: new WritableStream(),
      closed: Promise.resolve(),
      abort() {
        throw failure;
      },
    },
  });
  returned.resolve({ done: true, value: undefined });
  await expect(retirement).rejects.toBe(failure);
  await expect(peer.retire()).rejects.toBe(failure);
});

it('retains adopted duplex abort failures and waits for framed cleanup before rejecting retirement', async () => {
  const failure = new Error('Adopted duplex abort failed');
  const ending = Promise.withResolvers<void>(), written = Promise.withResolvers<void>();
  const cancelled = vi.fn(async () => {}), writeAbort = vi.fn(() => ending.promise);
  const peer = new NaidanRpcPeer({
    transport: {
      incomingStreams: idleIncoming(),
      ended: new Promise(() => {}),
      closed: new Promise(() => {}),
      openStream: async () => ({
        readable: new ReadableStream<Uint8Array>({ cancel: cancelled }),
        writable: new WritableStream<Uint8Array>({
          write() {
            written.resolve();
          },
          abort: writeAbort,
        }),
        closed: new Promise(() => {}),
        abort() {
          throw failure;
        },
      }),
    },
    exports: [],
    limits: { maxCalls: 1, maxCallTimeoutMs: undefined },
    signal: new AbortController().signal,
  });
  const call = peer.client({ contract: definition }).run({ input: {}, on: {}, signal: undefined, timeoutMs: undefined });
  void call.result.catch(() => {}); void call.closed.catch(() => {});
  try {
    await written.promise; call.cancel({ reason: 'Caller cancelled an adopted call' });
    await expect(call.result).rejects.toMatchObject({ code: 'CANCELLED' });
    const retirement = peer.retire(); let settled = false;
    void retirement.then(() => {
      settled = true;
    }, () => {
      settled = true;
    });
    await vi.waitFor(() => expect(writeAbort).toHaveBeenCalledOnce());
    expect(cancelled).toHaveBeenCalledOnce(); expect(settled).toBe(false);
    ending.resolve(); await expect(retirement).rejects.toBe(failure);
    await expect(peer.retire()).rejects.toBe(failure);
  } finally {
    ending.resolve(); await peer.retire().catch(() => {});
  }
});

it('failed outgoing adoption retains capacity until its owned discard completes', async () => {
  const gate = Promise.withResolvers<void>(), entered = Promise.withResolvers<void>();
  const readable = new ReadableStream<Uint8Array>({
    cancel() {
      entered.resolve(); return gate.promise;
    },
  });
  const writable = new WritableStream<Uint8Array>(), writer = writable.getWriter();
  const open = vi.fn(async () => ({ readable, writable, closed: Promise.resolve(), abort() {} }));
  const peer = new NaidanRpcPeer({
    transport: { incomingStreams: idleIncoming(), ended: new Promise(() => {}), closed: new Promise(() => {}), openStream: open },
    exports: [],
    limits: { maxCalls: 1, maxCallTimeoutMs: undefined },
    signal: new AbortController().signal,
  });
  const client = peer.client({ contract: definition });
  const first = client.run({ input: {}, on: {}, signal: undefined, timeoutMs: undefined });
  await expect(first.result).rejects.toBeInstanceOf(TypeError); await expect(first.closed).rejects.toBeInstanceOf(TypeError);
  await entered.promise;
  const second = client.run({ input: {}, on: {}, signal: undefined, timeoutMs: undefined });
  await expect(second.result).rejects.toMatchObject({ code: 'RESOURCE_EXHAUSTED' });
  await expect(second.closed).rejects.toMatchObject({ code: 'RESOURCE_EXHAUSTED' }); expect(open).toHaveBeenCalledOnce();
  gate.resolve(); writer.releaseLock(); await peer.retire();
});

it.each(['caller', 'callee'] as const)('retains partial constructor release failure for %s', async role => {
  const failure = new Error('Partial reader release failed');
  const readable = new ReadableStream<Uint8Array>(), reader = readable.getReader();
  const release = reader.releaseLock.bind(reader); release();
  const original = readable.getReader.bind(readable);
  let held: ReadableStreamDefaultReader<Uint8Array> | undefined;
  vi.spyOn(readable, 'getReader').mockImplementation(() => {
    held = original(); vi.spyOn(held, 'releaseLock').mockImplementation(() => {
      throw failure;
    }); return held;
  });
  const writable = new WritableStream<Uint8Array>(), writer = writable.getWriter();
  const duplex = { readable, writable, closed: Promise.resolve(), abort() {} };
  const next = Promise.withResolvers<IteratorResult<NaidanRpcDuplex>>();
  const peer = new NaidanRpcPeer({
    transport: {
      ended: new Promise(() => {}),
      closed: new Promise(() => {}),
      openStream: async () => duplex,
      incomingStreams: {
        [Symbol.asyncIterator]() {
          return {
            next: () => next.promise,
            async return() {
              return { done: true as const, value: undefined };
            },
          };
        },
      },
    },
    exports: [],
    limits: { maxCalls: 1, maxCallTimeoutMs: undefined },
    signal: new AbortController().signal,
  });
  if (role === 'caller') {
    const call = peer.client({ contract: definition }).run({ input: {}, on: {}, signal: undefined, timeoutMs: undefined });
    await expect(call.result).rejects.toMatchObject({ cause: failure }); await expect(call.closed).rejects.toMatchObject({ cause: failure });
    next.resolve({ done: true, value: undefined });
  } else next.resolve({ done: false, value: duplex });
  expect((await peer.ended).error).toBe(failure);
  await expect(peer.retire()).rejects.toBe(failure);
  vi.restoreAllMocks(); held?.releaseLock(); writer.releaseLock();
});

it('logical peer termination preserves the first opaque cause independently of retirement', async () => {
  const lowerEnd = Promise.withResolvers<{ error: unknown }>(), returned = Promise.withResolvers<IteratorResult<NaidanRpcDuplex>>();
  const peer = new NaidanRpcPeer({
    transport: {
      ended: lowerEnd.promise,
      closed: new Promise(() => {}),
      openStream: async () => {
        throw new Error('Unused');
      },
      incomingStreams: {
        [Symbol.asyncIterator]() {
          return { next: () => Promise.reject(null), return: () => returned.promise };
        },
      },
    },
    exports: [],
    limits: { maxCalls: 1, maxCallTimeoutMs: undefined },
    signal: new AbortController().signal,
  });
  const ended = await peer.ended; expect(ended.error).toBe(null); expect(Object.isFrozen(ended)).toBe(true);
  lowerEnd.resolve({ error: new Error('Later lower error') }); peer.dispose();
  expect(await peer.ended).toBe(ended);
  let retired = false; const retirement = peer.retire().then(() => {
    retired = true;
  });
  await Promise.resolve(); expect(retired).toBe(false);
  returned.resolve({ done: true, value: undefined }); await retirement;
  await expect(peer.closed).rejects.toBe(null);
});
