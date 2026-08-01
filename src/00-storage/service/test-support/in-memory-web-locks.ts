type PendingLockRequest = Readonly<{
  callback: LockGrantedCallback<unknown>;
  mode: LockMode;
  name: string;
  settlement: ReturnType<typeof Promise.withResolvers<unknown>>;
  signal: AbortSignal | undefined;
}>;

type HeldLockState = {
  exclusive: boolean;
  sharedCount: number;
};

function lockObject({ mode, name }: { mode: LockMode; name: string }): Lock {
  return { mode, name } as Lock;
}

/**
 * Deterministic Web Locks test platform with browser-like queueing semantics.
 *
 * It intentionally models only the standardized LockManager surface. Product
 * code must not reach into this object for shortcuts, so the same application
 * composition can run against this implementation or the browser API.
 */
export class InMemoryWebLockManager implements LockManager {
  private readonly held = new Map<string, HeldLockState>();
  private readonly queues = new Map<string, PendingLockRequest[]>();

  // eslint-disable-next-line local-rules-named-args/require-named-args -- Implements the browser LockManager positional overloads.
  readonly request = ((
    name: string,
    optionsOrCallback: LockOptions | LockGrantedCallback<unknown>,
    maybeCallback?: LockGrantedCallback<unknown>,
  ): Promise<unknown> => {
    const options = typeof optionsOrCallback === "function" ? {} : optionsOrCallback;
    const callback = typeof optionsOrCallback === "function" ? optionsOrCallback : maybeCallback;
    if (callback === undefined) {
      return Promise.reject(new TypeError("Web Locks request callback is required"));
    }
    return this.requestLock({ callback, name, options });
  }) as LockManager["request"];

  async query(): Promise<LockManagerSnapshot> {
    const held: LockInfo[] = [];
    for (const [name, state] of this.held) {
      if (state.exclusive) held.push({ mode: "exclusive", name });
      for (let index = 0; index < state.sharedCount; index += 1) {
        held.push({ mode: "shared", name });
      }
    }
    const pending = [...this.queues.values()].flatMap(queue => queue.map(({ mode, name }) => ({ mode, name })));
    return { held, pending };
  }

  private async requestLock({ callback, name, options }: {
    callback: LockGrantedCallback<unknown>;
    name: string;
    options: LockOptions;
  }): Promise<unknown> {
    options.signal?.throwIfAborted();
    const mode = options.mode ?? "exclusive";
    const queue = this.queues.get(name) ?? [];
    if ((options.ifAvailable ?? false) && !this.canGrantImmediately({ mode, name, queue })) {
      return await callback(null);
    }

    const settlement = Promise.withResolvers<unknown>();
    const request: PendingLockRequest = {
      callback,
      mode,
      name,
      settlement,
      signal: options.signal,
    };
    queue.push(request);
    this.queues.set(name, queue);
    if (options.signal !== undefined) {
      options.signal.addEventListener("abort", () => {
        const pending = this.queues.get(name);
        const index = pending?.indexOf(request) ?? -1;
        if (index < 0 || pending === undefined) return;
        pending.splice(index, 1);
        settlement.reject(options.signal?.reason);
        this.drain({ name });
      }, { once: true });
    }
    this.drain({ name });
    return await settlement.promise;
  }

  private canGrantImmediately({ mode, name, queue }: {
    mode: LockMode;
    name: string;
    queue: readonly PendingLockRequest[];
  }): boolean {
    if (queue.length > 0) return false;
    const state = this.held.get(name);
    if (state === undefined) return true;
    switch (mode) {
    case "exclusive": return false;
    case "shared": return !state.exclusive;
    default: return mode satisfies never;
    }
  }

  private drain({ name }: { name: string }): void {
    const queue = this.queues.get(name);
    if (queue === undefined || queue.length === 0) {
      this.queues.delete(name);
      return;
    }
    const state = this.held.get(name) ?? { exclusive: false, sharedCount: 0 };
    if (state.exclusive) return;

    const first = queue[0];
    if (first === undefined) return;
    switch (first.mode) {
    case "exclusive":
      if (state.sharedCount > 0) return;
      queue.shift();
      state.exclusive = true;
      this.held.set(name, state);
      this.runGranted({ request: first });
      return;
    case "shared":
      while (queue[0]?.mode === "shared" && !state.exclusive) {
        const request = queue.shift();
        if (request === undefined) break;
        state.sharedCount += 1;
        this.held.set(name, state);
        this.runGranted({ request });
      }
      return;
    default: return first.mode satisfies never;
    }
  }

  private runGranted({ request }: { request: PendingLockRequest }): void {
    void Promise.resolve()
      .then(async () => await request.callback(lockObject({ mode: request.mode, name: request.name })))
      .then(request.settlement.resolve, request.settlement.reject)
      .finally(() => {
        const state = this.held.get(request.name);
        if (state === undefined) return;
        switch (request.mode) {
        case "exclusive":
          state.exclusive = false;
          break;
        case "shared":
          state.sharedCount -= 1;
          break;
        default: request.mode satisfies never;
        }
        if (!state.exclusive && state.sharedCount === 0) {
          this.held.delete(request.name);
        }
        this.drain({ name: request.name });
      });
  }
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
