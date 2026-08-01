import { describe, expect, it, vi } from "vitest";
import { InMemoryWebLockManager } from "@/00-storage/service/test-support/in-memory-web-locks";

describe("in-memory Web Locks platform", () => {
  it("queues exclusive work behind shared holders", async () => {
    const manager = new InMemoryWebLockManager();
    const releaseShared = Promise.withResolvers<void>();
    const shared = manager.request("storage", { mode: "shared" }, async () => await releaseShared.promise);
    await vi.waitFor(async () => {
      expect((await manager.query()).held).toEqual([{ mode: "shared", name: "storage" }]);
    });

    const exclusiveRun = vi.fn(async () => "done");
    const exclusive = manager.request("storage", { mode: "exclusive" }, exclusiveRun);
    await Promise.resolve();
    expect(exclusiveRun).not.toHaveBeenCalled();

    releaseShared.resolve();
    await shared;
    await expect(exclusive).resolves.toBe("done");
  });

  it("returns null immediately for unavailable opportunistic requests", async () => {
    const manager = new InMemoryWebLockManager();
    const releaseShared = Promise.withResolvers<void>();
    const shared = manager.request("storage", { mode: "shared" }, async () => await releaseShared.promise);
    await vi.waitFor(async () => {
      expect((await manager.query()).held).toHaveLength(1);
    });

    const callback = vi.fn(async (lock: Lock | null) => lock === null ? "deferred" : "unexpected");
    await expect(manager.request("storage", {
      ifAvailable: true,
      mode: "exclusive",
    }, callback)).resolves.toBe("deferred");
    expect(callback).toHaveBeenCalledWith(null);

    releaseShared.resolve();
    await shared;
  });

  it("removes an aborted queued request without running it", async () => {
    const manager = new InMemoryWebLockManager();
    const releaseExclusive = Promise.withResolvers<void>();
    const held = manager.request("storage", { mode: "exclusive" }, async () => await releaseExclusive.promise);
    await vi.waitFor(async () => {
      expect((await manager.query()).held).toHaveLength(1);
    });
    const controller = new AbortController();
    const run = vi.fn(async () => undefined);
    const queued = manager.request("storage", {
      mode: "exclusive",
      signal: controller.signal,
    }, run);
    const reason = new Error("cancelled");
    controller.abort(reason);

    await expect(queued).rejects.toBe(reason);
    expect(run).not.toHaveBeenCalled();
    releaseExclusive.resolve();
    await held;
  });
});
