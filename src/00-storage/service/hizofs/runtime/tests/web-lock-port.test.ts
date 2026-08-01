import { describe, expect, it } from "vitest";
import {
  createBrowserWebLockManagerPort,
  WebLocksCrossRealmLockPort,
  type WebLockManagerPort,
} from "@/00-storage/service/hizofs/runtime/web-lock-port";

function deferred<T>() {
  let reject!: (reason?: unknown) => void;
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    reject = rejectPromise;
    resolve = resolvePromise;
  });
  return { promise, reject, resolve };
}

class FakeWebLockManager implements WebLockManagerPort {
  held = new Set<string>();
  requestFinished = deferred<void>();
  requestStarted = deferred<void>();

  async query(): Promise<{ held: readonly { name: string | null }[] }> {
    return { held: [...this.held].map(name => ({ name })) };
  }

  async request<T>({ callback, mode: _mode, name }: {
    callback: () => Promise<T>;
    mode: "exclusive" | "shared";
    name: string;
  }): Promise<T> {
    this.held.add(name);
    this.requestStarted.resolve(undefined);
    try {
      return await callback();
    } finally {
      this.held.delete(name);
      this.requestFinished.resolve(undefined);
    }
  }
}

function browserRequest({ onRequest }: {
  onRequest?: ({ name, options }: { name: string; options: LockOptions }) => void;
} = {}): LockManager["request"] {
  const request = async <T>(
    name: string,
    optionsOrCallback: LockOptions | LockGrantedCallback<T>,
    maybeCallback?: LockGrantedCallback<T>,
  ): Promise<Awaited<T>> => {
    const options = typeof optionsOrCallback === "function" ? {} : optionsOrCallback;
    const callback = typeof optionsOrCallback === "function" ? optionsOrCallback : maybeCallback;
    if (callback === undefined) throw new Error("browser lock callback is required");
    onRequest?.({ name, options });
    return await callback(null);
  };
  return request as LockManager["request"];
}

describe("Web Locks cross-realm port", () => {
  it("holds a browser lock until the returned lease is released", async () => {
    const manager = new FakeWebLockManager();
    const port = new WebLocksCrossRealmLockPort({ manager });
    const lease = await port.acquire({ mode: "shared", name: "reader" });
    await manager.requestStarted.promise;
    expect(await port.queryHeldLockNames()).toEqual(["reader"]);
    lease.release();
    lease.release();
    await lease.released;
    await manager.requestFinished.promise;
    expect(await port.queryHeldLockNames()).toEqual([]);
  });

  it("adapts the browser LockManager positional request contract exactly", async () => {
    const calls: unknown[] = [];
    const manager = createBrowserWebLockManagerPort({ manager: {
      query: async () => ({ held: [] }),
      request: browserRequest({ onRequest: call => {
        calls.push(call);
      } }),
    } });
    await expect(manager.request({
      callback: async () => "held",
      mode: "exclusive",
      name: "container-authority",
    })).resolves.toBe("held");
    expect(calls).toEqual([{
      name: "container-authority",
      options: { mode: "exclusive" },
    }]);
  });

  it("returns a unique sorted held-name snapshot", async () => {
    const manager: WebLockManagerPort = {
      query: async () => ({ held: [{ name: "z" }, { name: "a" }, { name: "z" }] }),
      request: async ({ callback }) => await callback(),
    };
    const port = new WebLocksCrossRealmLockPort({ manager });
    await expect(port.queryHeldLockNames()).resolves.toEqual(["a", "z"]);
  });

  it("fails closed when held lock enumeration has no canonical name", async () => {
    const manager: WebLockManagerPort = {
      query: async () => ({ held: [{ name: null }] }),
      request: async ({ callback }) => await callback(),
    };
    const port = new WebLocksCrossRealmLockPort({ manager });
    await expect(port.queryHeldLockNames()).rejects.toMatchObject({ code: "invalid_lock_query" });
  });

  it("propagates acquisition failure without returning a lease", async () => {
    const manager: WebLockManagerPort = {
      query: async () => ({ held: [] }),
      request: async () => {
        throw new Error("browser lock unavailable");
      },
    };
    const port = new WebLocksCrossRealmLockPort({ manager });
    await expect(port.acquire({ mode: "exclusive", name: "writer" }))
      .rejects.toThrow("browser lock unavailable");
  });
});
