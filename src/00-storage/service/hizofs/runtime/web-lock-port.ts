import type {
  CrossRealmLockLease,
  CrossRealmLockMode,
  CrossRealmLockPort,
} from "@/00-storage/service/hizofs/runtime/cross-realm-lock-coordinator";

export type BrowserWebLockManager = Pick<LockManager, "query" | "request">;

export interface WebLockManagerPort {
  query(): Promise<Readonly<{
    held: readonly Readonly<{ name: string | null }>[];
  }>>;
  request<T>({ callback, ifAvailable, mode, name }: {
    callback: ({ granted }: { granted: boolean }) => Promise<T>;
    ifAvailable?: boolean;
    mode: CrossRealmLockMode;
    name: string;
  }): Promise<T>;
}

export function createBrowserWebLockManagerPort({ manager }: {
  manager: BrowserWebLockManager;
}): WebLockManagerPort {
  return {
    query: async () => {
      const snapshot = await manager.query();
      return {
        held: (snapshot.held ?? []).map(({ name }) => ({ name: name ?? null })),
      };
    },
    request: async ({ callback, ifAvailable, mode, name }) => {
      const options: LockOptions = ifAvailable === undefined ? { mode } : { ifAvailable, mode };
      return await manager.request(name, options, async lock => await callback({ granted: lock !== null }));
    },
  };
}

export type WebLocksCrossRealmLockPortErrorCode =
  | "invalid_lock_query"
  | "unexpected_lock_unavailable";

export class WebLocksCrossRealmLockPortError extends Error {
  readonly code: WebLocksCrossRealmLockPortErrorCode;

  constructor({ code, message }: {
    code: WebLocksCrossRealmLockPortErrorCode;
    message: string;
  }) {
    super(message);
    this.name = "WebLocksCrossRealmLockPortError";
    this.code = code;
  }
}

/**
 * Adapts the browser Web Locks lifetime callback to an explicit lease. The
 * callback remains pending until release(), and released resolves only after
 * the browser request has actually left the held-lock set. Session close can
 * therefore prove resource release instead of merely scheduling it.
 */
export class WebLocksCrossRealmLockPort implements CrossRealmLockPort {
  #manager: WebLockManagerPort;

  constructor({ manager }: { manager: WebLockManagerPort }) {
    this.#manager = manager;
  }

  async #requestLease({ ifAvailable, mode, name }: {
    ifAvailable: boolean;
    mode: CrossRealmLockMode;
    name: string;
  }): Promise<CrossRealmLockLease | undefined> {
    const granted = Promise.withResolvers<boolean>();
    const releaseRequested = Promise.withResolvers<void>();
    const request = this.#manager.request({
      callback: async ({ granted: lockGranted }) => {
        granted.resolve(lockGranted);
        if (!lockGranted) return;
        await releaseRequested.promise;
      },
      ifAvailable: ifAvailable ? true : undefined,
      mode,
      name,
    });
    void request.catch(cause => {
      granted.reject(cause);
    });
    const lockGranted = await granted.promise;
    if (!lockGranted) {
      await request;
      return undefined;
    }
    let active = true;
    return {
      release: () => {
        if (!active) return;
        active = false;
        releaseRequested.resolve();
      },
      released: request.then(() => undefined),
    };
  }

  async acquire({ mode, name }: {
    mode: CrossRealmLockMode;
    name: string;
  }): Promise<CrossRealmLockLease> {
    const lease = await this.#requestLease({ ifAvailable: false, mode, name });
    if (lease !== undefined) return lease;
    throw new WebLocksCrossRealmLockPortError({
      code: "unexpected_lock_unavailable",
      message: "blocking Web Locks acquisition completed without granting a lock",
    });
  }

  async tryAcquire({ mode, name }: {
    mode: CrossRealmLockMode;
    name: string;
  }): Promise<CrossRealmLockLease | undefined> {
    return await this.#requestLease({ ifAvailable: true, mode, name });
  }

  async queryHeldLockNames(): Promise<readonly string[]> {
    const snapshot = await this.#manager.query();
    const names = new Set<string>();
    for (const entry of snapshot.held) {
      if (typeof entry.name !== "string" || entry.name.length === 0) {
        throw new WebLocksCrossRealmLockPortError({
          code: "invalid_lock_query",
          message: "Web Locks held-lock enumeration contained an unnamed lock",
        });
      }
      names.add(entry.name);
    }
    return [...names].sort();
  }
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
