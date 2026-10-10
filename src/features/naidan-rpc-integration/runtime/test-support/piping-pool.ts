type FetchArguments = { input: Parameters<typeof fetch>[0]; init: Parameters<typeof fetch>[1] };
type Queued = {
  args: FetchArguments;
  signal: AbortSignal;
  state: 'queued' | 'active' | 'settled';
  resolve: ReturnType<typeof Promise.withResolvers<Response>>['resolve'];
  reject: ReturnType<typeof Promise.withResolvers<Response>>['reject'];
  removeAbort(): void;
};

/** Test-only FIFO pool: headers do not release a socket. The response body
 * must finish or cancel before another operation can use its slot. */
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
      const release = () => {
        switch (item.state) {
        case 'active': break;
        case 'queued': case 'settled': return;
        default: { const exhaustive: never = item.state; throw new Error(String(exhaustive)); }
        } item.state = 'settled'; active--; drain();
      };
      void Promise.resolve().then(() => request(item.args)).then(response => {
        if (!response.body) {
          release(); item.resolve(response); return;
        }
        const reader = response.body.getReader();
        item.resolve(new Response(new ReadableStream<Uint8Array>({
          async pull(controller) {
            try {
              const part = await reader.read();
              if (part.done) {
                reader.releaseLock(); release(); controller.close();
              } else controller.enqueue(part.value);
            } catch (error) {
              reader.releaseLock(); release(); controller.error(error);
            }
          },
          async cancel(reason) {
            try {
              await reader.cancel(reason);
            } finally {
              reader.releaseLock(); release();
            }
          },
        }, { highWaterMark: 0 }), { status: response.status, headers: response.headers }));
      }, error => {
        release(); item.reject(error);
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
