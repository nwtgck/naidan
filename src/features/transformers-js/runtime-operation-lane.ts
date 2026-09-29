/** One service owns one runtime; this is not a runtime pool or global scheduler. */
export interface TransformersJsRuntimeOperation {
  readonly signal: AbortSignal,
  assertActive(): void,
  isActive(): boolean,
  abort(): void,
}

export function createTransformersJsRuntimeLane() {
  type Entry = {
    owner: TransformersJsRuntimeOperation,
    controller: AbortController,
    result: ReturnType<typeof Promise.withResolvers<void>>,
    operation: ({ owner }: { owner: TransformersJsRuntimeOperation }) => Promise<void>,
    detach(): void,
  };
  const waiting: Entry[] = [];
  let active: Entry | undefined;
  let closed: Error | undefined;

  function startNext(): void {
    if (closed !== undefined || active !== undefined) return;
    const entry = waiting.shift();
    if (entry === undefined) return;
    active = entry;
    // Register both outcomes immediately, including callbacks which throw before
    // returning a promise. Closing may reject the public result before this work
    // settles, but never leaves its eventual rejection unowned.
    void (async () => {
      try {
        entry.owner.assertActive();
        await entry.operation({ owner: entry.owner });
        entry.owner.assertActive();
        entry.result.resolve();
      } catch (error) {
        entry.result.reject(closed ?? (entry.controller.signal.aborted ? entry.controller.signal.reason : error));
      } finally {
        entry.detach();
        if (active === entry) active = undefined;
        startNext();
      }
    })();
  }

  return {
    run({ signal, operation }: {
      signal: AbortSignal | undefined,
      operation: Entry['operation'],
    }): Promise<void> {
      if (closed !== undefined) return Promise.reject(closed);
      const controller = new AbortController();
      const aborted = new DOMException('Generation aborted', 'AbortError');
      const result = Promise.withResolvers<void>();
      const entry: Entry = {
        controller, result, operation,
        owner: {
          signal: controller.signal,
          isActive() {
            return closed === undefined && active === entry && !controller.signal.aborted;
          },
          assertActive() {
            if (closed !== undefined) throw closed;
            if (controller.signal.aborted) throw aborted;
            if (active !== entry) throw new Error('Transformers.js runtime operation is no longer active');
          },
          abort() {
            controller.abort(aborted);
          },
        },
        detach() {
          signal?.removeEventListener('abort', onAbort);
        },
      };
      function onAbort(): void {
        entry.owner.abort();
        const index = waiting.indexOf(entry);
        if (index !== -1) {
          waiting.splice(index, 1);
          entry.detach();
          result.reject(aborted);
        }
      }
      if (signal?.aborted === true) return Promise.reject(aborted);
      waiting.push(entry);
      signal?.addEventListener('abort', onAbort, { once: true });
      startNext();
      return result.promise;
    },
    getActive(): TransformersJsRuntimeOperation | undefined {
      return active?.owner;
    },
    close({ error }: { error: Error }): void {
      if (closed !== undefined) return;
      closed = error;
      for (const entry of waiting.splice(0)) {
        entry.detach();
        entry.controller.abort(error);
        entry.result.reject(error);
      }
      if (active !== undefined) {
        active.detach();
        active.controller.abort(error);
        active.result.reject(error);
      }
    },
  };
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
export const TEST_ONLY = {
};
