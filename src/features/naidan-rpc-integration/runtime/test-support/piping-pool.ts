type FetchArguments = { input: Parameters<typeof fetch>[0]; init: Parameters<typeof fetch>[1] };
type Queued = {
  args: FetchArguments;
  signal: AbortSignal;
  state: 'queued' | 'active' | 'settled';
  resolve: ReturnType<typeof Promise.withResolvers<Response>>['resolve'];
  reject: ReturnType<typeof Promise.withResolvers<Response>>['reject'];
  removeAbort(): void;
};
/** Test-only FIFO connection pool. FiniteEndpoint creates its deadline before
 * this queue, and MemoryRelay returns only completely transferred finite bodies. */
export function createPipingFetchPool({ capacity, request }: {
  capacity: number;
  request({ input, init }: FetchArguments): Promise<Response>;
}) {
  const queue: Queued[] = [];
  let active = 0, peak = 0;
  const drain = () => {
    while (active < capacity && queue.length) {
      const item = queue.shift()!;
      if (item.signal.aborted) {
        item.state = 'settled'; item.removeAbort(); item.reject(item.signal.reason); continue;
      }
      item.state = 'active'; item.removeAbort(); active++; peak = Math.max(peak, active);
      // The relay owns active abort cleanup; do not release the slot early.
      void Promise.resolve().then(() => request(item.args)).then(response => {
        item.state = 'settled'; active--; item.resolve(response); drain();
      }, error => {
        item.state = 'settled'; active--; item.reject(error); drain();
      });
    }
  };
  return {
    get stats() {
      return { active, queued: queue.length, peak };
    },
    request({ input, init }: FetchArguments): Promise<Response> {
      const args = { input, init };
      const signal = args.init?.signal;
      if (!signal) return Promise.reject(new Error('Finite relay requests require a signal'));
      signal.throwIfAborted();
      return new Promise((resolve, reject) => {
        const abort = () => {
          switch (item.state) {
          case 'queued': break;
          case 'active': case 'settled': return;
          default: { const exhaustive: never = item.state; throw new Error(String(exhaustive)); }
          }
          const index = queue.indexOf(item); if (index >= 0) queue.splice(index, 1);
          item.state = 'settled'; item.removeAbort(); reject(signal.reason);
        };
        const item: Queued = {
          args,
          signal,
          state: 'queued',
          resolve,
          reject,
          removeAbort: () => signal.removeEventListener('abort', abort),
        };
        signal.addEventListener('abort', abort, { once: true }); queue.push(item);
        if (signal.aborted) abort(); else drain();
      });
    },
  };
}
export const TEST_ONLY = {
};
