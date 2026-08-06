import { describe, expect, it, vi } from "vitest";
import type { CrossRealmRuntimeOwnerLease } from "@/00-storage/service/hizofs/runtime/cross-realm-lock-coordinator";
import {
  RuntimeOwnerCoordinator,
  RuntimeOwnerCoordinatorError,
} from "@/00-storage/service/hizofs/runtime/runtime-owner-coordinator";

function lease() {
  const released = Promise.withResolvers<void>();
  let active = true;
  const value: CrossRealmRuntimeOwnerLease = {
    release: vi.fn(() => {
      if (!active) return;
      active = false;
      released.resolve();
    }),
    released: released.promise,
  };
  return { value };
}

describe("runtime owner coordinator", () => {
  it("shares one lease and releases it after the final clean attachment closes", async () => {
    const acquired = lease();
    const acquireLease = vi.fn(async () => acquired.value);
    const coordinator = new RuntimeOwnerCoordinator({
      acquireLease,
      isReleaseSafe: () => true,
    });

    const first = await coordinator.attach();
    const second = await coordinator.attach();
    expect(coordinator.state()).toBe("owned");
    expect(coordinator.attachmentCount()).toBe(2);
    expect(acquireLease).toHaveBeenCalledOnce();

    await first.release();
    expect(acquired.value.release).not.toHaveBeenCalled();
    expect(coordinator.attachmentCount()).toBe(1);

    await second.release();
    expect(acquired.value.release).toHaveBeenCalledOnce();
    expect(coordinator.state()).toBe("idle");
    expect(coordinator.attachmentCount()).toBe(0);
  });

  it("retains ownership while the durable head is not safe to hand off", async () => {
    const acquired = lease();
    let releaseSafe = false;
    const coordinator = new RuntimeOwnerCoordinator({
      acquireLease: async () => acquired.value,
      isReleaseSafe: () => releaseSafe,
    });

    const attachment = await coordinator.attach();
    await attachment.release();
    expect(coordinator.state()).toBe("owned");
    expect(acquired.value.release).not.toHaveBeenCalled();

    releaseSafe = true;
    await coordinator.releaseIfIdleAndSafe();
    expect(acquired.value.release).toHaveBeenCalledOnce();
    expect(coordinator.state()).toBe("idle");
  });

  it("poisons future attachments when lease release fails", async () => {
    const releaseFailure = new Error("release failed");
    const value: CrossRealmRuntimeOwnerLease = {
      release: () => {
        throw releaseFailure;
      },
      released: Promise.resolve(),
    };
    const coordinator = new RuntimeOwnerCoordinator({
      acquireLease: async () => value,
      isReleaseSafe: () => true,
    });

    const attachment = await coordinator.attach();
    await expect(attachment.release()).rejects.toMatchObject({ code: "coordinator_failed" });
    expect(coordinator.state()).toBe("failed");
    await expect(coordinator.attach()).rejects.toBeInstanceOf(RuntimeOwnerCoordinatorError);
  });

  it("returns unavailable without starting a blocking owner acquisition", async () => {
    const acquireLease = vi.fn(async () => lease().value);
    const tryAcquireLease = vi.fn(async () => undefined);
    const coordinator = new RuntimeOwnerCoordinator({
      acquireLease,
      isReleaseSafe: () => true,
      tryAcquireLease,
    });
    await expect(coordinator.tryAttach()).resolves.toBeUndefined();
    expect(tryAcquireLease).toHaveBeenCalledOnce();
    expect(acquireLease).not.toHaveBeenCalled();
    expect(coordinator.state()).toBe("idle");
  });

  it("shares an already-owned lease through non-blocking attachment", async () => {
    const acquired = lease();
    const tryAcquireLease = vi.fn(async () => acquired.value);
    const coordinator = new RuntimeOwnerCoordinator({
      acquireLease: async () => acquired.value,
      isReleaseSafe: () => true,
      tryAcquireLease,
    });
    const first = await coordinator.tryAttach();
    const second = await coordinator.tryAttach();
    expect(first).toBeDefined();
    expect(second).toBeDefined();
    expect(tryAcquireLease).toHaveBeenCalledOnce();
    await first?.release();
    expect(acquired.value.release).not.toHaveBeenCalled();
    await second?.release();
    expect(acquired.value.release).toHaveBeenCalledOnce();
  });

  it("fails explicitly when non-blocking attachment is unsupported", async () => {
    const coordinator = new RuntimeOwnerCoordinator({
      acquireLease: async () => lease().value,
      isReleaseSafe: () => true,
    });
    await expect(coordinator.tryAttach()).rejects.toMatchObject({ code: "try_attach_unsupported" });
  });


  it("shares one pending non-blocking acquisition across concurrent attachments", async () => {
    const acquired = lease();
    const pending = Promise.withResolvers<CrossRealmRuntimeOwnerLease | undefined>();
    const tryAcquireLease = vi.fn(async () => await pending.promise);
    const coordinator = new RuntimeOwnerCoordinator({
      acquireLease: async () => acquired.value,
      isReleaseSafe: () => true,
      tryAcquireLease,
    });
    const firstPromise = coordinator.tryAttach();
    const secondPromise = coordinator.tryAttach();
    pending.resolve(acquired.value);
    const first = await firstPromise;
    const second = await secondPromise;
    expect(first).toBeDefined();
    expect(second).toBeDefined();
    expect(tryAcquireLease).toHaveBeenCalledOnce();
    expect(coordinator.attachmentCount()).toBe(2);
    await first?.release();
    await second?.release();
  });

  it("lets a blocking attachment fall back after a non-blocking busy result", async () => {
    const acquired = lease();
    const pending = Promise.withResolvers<CrossRealmRuntimeOwnerLease | undefined>();
    const acquireLease = vi.fn(async () => acquired.value);
    const coordinator = new RuntimeOwnerCoordinator({
      acquireLease,
      isReleaseSafe: () => true,
      tryAcquireLease: async () => await pending.promise,
    });
    const tryPromise = coordinator.tryAttach();
    const blockingPromise = coordinator.attach();
    pending.resolve(undefined);
    await expect(tryPromise).resolves.toBeUndefined();
    const blocking = await blockingPromise;
    expect(acquireLease).toHaveBeenCalledOnce();
    await blocking.release();
  });

});
