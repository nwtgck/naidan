import { deferred, check } from '@/features/naidan-rpc/primitives';
import type { NaidanRpcTransport, NaidanRpcDuplex } from '@/features/naidan-rpc/transport';

export function transportPair({ capacity, fragmentBytes }: { capacity: number; fragmentBytes: number }) {
  const pending: NaidanRpcDuplex[][] = [[], []], wake = [deferred<void>(), deferred<void>()];
  const ended = [false, false], lifetime = deferred<void>();
  let active = 0, total = 0;
  const aborters = new Set<() => void>();
  const create = () => {
    const final = deferred<void>(), finished = [false, false]; let done = false;
    const controls: TransformStreamDefaultController<Uint8Array>[] = [];
    const flows = [0, 1].map(() => new TransformStream<Uint8Array, Uint8Array>({
      start(controller) {
      controls.push(controller);
    },
    }, { highWaterMark: 1 }, { highWaterMark: 1 }));
    const abort = () => {
      if (done) return; done = true; active--; aborters.delete(abort);
      const error = new Error('Memory duplex aborted'); for (const control of controls) control.error(error); final.reject(error);
    };
    aborters.add(abort);
    const duplexes = [0, 1].map(side => {
      const writer = flows[side]!.writable.getWriter();
      return {
        readable: flows[1 - side]!.readable,
        writable: new WritableStream<Uint8Array>({
          async write(bytes) {
            for (let at = 0; at < bytes.length; at += fragmentBytes) await writer.write(bytes.slice(at, at + fragmentBytes));
          },
          async close() {
            await writer.close(); finished[side] = true;
            if (finished.every(Boolean) && !done) {
              done = true; active--; aborters.delete(abort); final.resolve();
            }
          },
          abort,
        }),
        closed: final.promise,
        abort({ reason }: { reason: string }) {
          void reason; abort();
        },
      } satisfies NaidanRpcDuplex;
    });
    return duplexes;
  };
  const transports = [0, 1].map(side => ({
    closed: lifetime.promise,
    async openStream({ signal }: { signal: AbortSignal | undefined }) {
      signal?.throwIfAborted(); check({ condition: !ended[1 - side] && active < capacity, code: 'RESOURCE_EXHAUSTED' });
      active++; total++; const pair = create();
      pending[1 - side]!.push(pair[1 - side]!); wake[1 - side]!.resolve(); return pair[side]!;
    },
    incomingStreams: {
      [Symbol.asyncIterator]() {
        return {
          async next(): Promise<IteratorResult<NaidanRpcDuplex>> {
            while (!ended[side]) {
              const next = pending[side]!.shift(); if (next) return { done: false, value: next };
              const waiting = wake[side]!; await waiting.promise;
              if (waiting === wake[side]) wake[side] = deferred<void>();
            }
            return { done: true, value: undefined };
          },
          async return(): Promise<IteratorResult<NaidanRpcDuplex>> {
            ended[side] = true; for (const stream of pending[side]!.splice(0)) stream.abort({ reason: 'Iterator ended' });
            wake[side]!.resolve(); return { done: true, value: undefined };
          },
        };
      },
    },
  } satisfies NaidanRpcTransport));
  return {
    a: transports[0]!,
    b: transports[1]!,
    stats: () => ({ active, total }),
    close() {
      for (const abort of [...aborters]) abort(); for (const side of [0, 1]) {
        ended[side] = true; wake[side]!.resolve();
      } lifetime.resolve();
    },
  };
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
