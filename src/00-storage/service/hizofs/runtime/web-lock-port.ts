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
  request<T>({ callback, mode, name }: {
    callback: () => Promise<T>;
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
    request: async ({ callback, mode, name }) => await manager.request(name, { mode }, callback),
  };
}

export type WebLocksCrossRealmLockPortErrorCode =
  | "invalid_lock_query";

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

  async acquire({ mode, name }: {
    mode: CrossRealmLockMode;
    name: string;
  }): Promise<CrossRealmLockLease> {
    const granted = Promise.withResolvers<void>();
    const releaseRequested = Promise.withResolvers<void>();
    const request = this.#manager.request({
      callback: async () => {
        granted.resolve();
        await releaseRequested.promise;
      },
      mode,
      name,
    });
    void request.catch(cause => {
      granted.reject(cause);
    });
    await granted.promise;
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
