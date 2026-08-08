import type {
  CrossRealmLockLease,
  CrossRealmLockMode,
  CrossRealmLockPort,
} from "@/00-storage/service/hizofs/runtime/cross-realm-lock-coordinator";

type PendingRequest = {
  mode: CrossRealmLockMode;
  resolve: ({ lease }: { lease: CrossRealmLockLease }) => void;
};

type LockState = {
  exclusiveHeld: boolean;
  pending: PendingRequest[];
  sharedHolders: number;
};

export class InMemoryCrossRealmLockPort implements CrossRealmLockPort {
  private locks = new Map<string, LockState>();

  private state({ name }: { name: string }): LockState {
    const existing = this.locks.get(name);
    if (existing !== undefined) return existing;
    const created: LockState = { exclusiveHeld: false, pending: [], sharedHolders: 0 };
    this.locks.set(name, created);
    return created;
  }

  private lease({ mode, name, state }: {
    mode: CrossRealmLockMode;
    name: string;
    state: LockState;
  }): CrossRealmLockLease {
    switch (mode) {
    case "exclusive": state.exclusiveHeld = true; break;
    case "shared": state.sharedHolders += 1; break;
    default: mode satisfies never;
    }
    const completion = Promise.withResolvers<void>();
    let active = true;
    return {
      release: () => {
        if (!active) return;
        active = false;
        try {
          switch (mode) {
          case "exclusive":
            if (!state.exclusiveHeld) throw new Error("exclusive in-memory lock accounting became inconsistent");
            state.exclusiveHeld = false;
            break;
          case "shared":
            if (state.sharedHolders < 1) throw new Error("shared in-memory lock accounting became inconsistent");
            state.sharedHolders -= 1;
            break;
          default: mode satisfies never;
          }
          this.drain({ name, state });
          completion.resolve();
        } catch (cause: unknown) {
          completion.reject(cause);
          throw cause;
        }
      },
      released: completion.promise,
    };
  }

  private drain({ name, state }: { name: string; state: LockState }): void {
    if (state.exclusiveHeld) return;
    const first = state.pending[0];
    if (first === undefined) {
      if (state.sharedHolders === 0) this.locks.delete(name);
      return;
    }
    switch (first.mode) {
    case "exclusive":
      if (state.sharedHolders !== 0) return;
      state.pending.shift();
      first.resolve({ lease: this.lease({ mode: "exclusive", name, state }) });
      return;
    case "shared": break;
    default: first.mode satisfies never;
    }
    while (!state.exclusiveHeld) {
      const request = state.pending[0];
      if (request === undefined) return;
      switch (request.mode) {
      case "exclusive": return;
      case "shared":
        state.pending.shift();
        request.resolve({ lease: this.lease({ mode: "shared", name, state }) });
        break;
      default: request.mode satisfies never;
      }
    }
  }

  private canAcquireImmediately({ mode, state }: {
    mode: CrossRealmLockMode;
    state: LockState;
  }): boolean {
    const modeAllowsImmediate = (() => {
      switch (mode) {
      case "shared": return true;
      case "exclusive": return state.sharedHolders === 0;
      default: return mode satisfies never;
      }
    })();
    return state.pending.length === 0 && !state.exclusiveHeld && modeAllowsImmediate;
  }

  async acquire({ mode, name }: {
    mode: CrossRealmLockMode;
    name: string;
  }): Promise<CrossRealmLockLease> {
    const state = this.state({ name });
    if (this.canAcquireImmediately({ mode, state })) return this.lease({ mode, name, state });
    return await new Promise<CrossRealmLockLease>(resolvePromise => {
      state.pending.push({ mode, resolve: ({ lease }) => resolvePromise(lease) });
      this.drain({ name, state });
    });
  }

  async tryAcquire({ mode, name }: {
    mode: CrossRealmLockMode;
    name: string;
  }): Promise<CrossRealmLockLease | undefined> {
    const state = this.state({ name });
    if (!this.canAcquireImmediately({ mode, state })) return undefined;
    return this.lease({ mode, name, state });
  }

  async queryHeldLockNames(): Promise<readonly string[]> {
    return [...this.locks.entries()]
      .filter(([, state]) => state.exclusiveHeld || state.sharedHolders > 0)
      .map(([name]) => name)
      .sort();
  }
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
