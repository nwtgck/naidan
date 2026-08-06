import { describe, expect, it, vi } from "vitest";
import { createContainerCoordinationScope, parseContainerCoordinationScopeToken } from "@/00-storage/service/hizofs/runtime/container-coordination-scope";
import type { ContainerRuntimeHostDisposalResult } from "@/00-storage/service/hizofs/runtime/container-runtime";
import { DEFAULT_HIZOFS_LAZY_DURABILITY_POLICY, type HizoFSRuntimePolicy } from "@/00-storage/service/hizofs/runtime/runtime-policy";
import {
  HizoFSRuntimeHostRegistry,
  HizoFSRuntimeHostRegistryError,
} from "@/00-storage/service/hizofs/worker/runtime-host-registry";

const policy: HizoFSRuntimePolicy = {
  lazyDurability: DEFAULT_HIZOFS_LAZY_DURABILITY_POLICY,
  maxDirectoryIteratorEntries: 32,
  maxHeldLockNames: 64,
  maxMaintenanceRootRegistrations: 32,
  maxReaderPins: 16,
  maxSegmentReferences: 16,
};

function scope({ fill }: { fill: number }) {
  return createContainerCoordinationScope({
    token: parseContainerCoordinationScopeToken({
      value: Buffer.from(new Uint8Array(32).fill(fill)).toString("base64url"),
    }),
  });
}

function host({ id, result = Object.freeze({ status: "disposed" }) }: {
  id: number;
  result?: ContainerRuntimeHostDisposalResult;
}) {
  return Object.freeze({
    disposeIfIdleAndSafe: vi.fn(async () => result),
    flushAndDisposeIfIdleAndSafe: vi.fn(async () => result),
    id,
  });
}

function deferred<T>() {
  const completion = Promise.withResolvers<T>();
  return completion;
}

describe("HizoFS runtime host registry", () => {
  it("reuses one host for the same LockManager and canonical container scope", () => {
    const registry = new HizoFSRuntimeHostRegistry<object, ReturnType<typeof host>>();
    const lockManager = {};
    const createHost = vi.fn(() => host({ id: 1 }));
    const firstScope = scope({ fill: 1 });
    const secondScope = scope({ fill: 1 });

    const first = registry.getOrCreate({ createHost, lockManager, policy, scope: firstScope });
    const second = registry.getOrCreate({ createHost, lockManager, policy, scope: secondScope });

    expect(second).toBe(first);
    expect(createHost).toHaveBeenCalledOnce();
    expect(createHost).toHaveBeenCalledWith({ lockManager, policy, scope: firstScope });
  });

  it("keeps independent hosts for different LockManagers or container scopes", () => {
    const registry = new HizoFSRuntimeHostRegistry<object, ReturnType<typeof host>>();
    let nextId = 0;
    const createHost = vi.fn(() => host({ id: ++nextId }));
    const firstLockManager = {};
    const secondLockManager = {};

    const first = registry.getOrCreate({ createHost, lockManager: firstLockManager, policy, scope: scope({ fill: 1 }) });
    const otherScope = registry.getOrCreate({ createHost, lockManager: firstLockManager, policy, scope: scope({ fill: 2 }) });
    const otherManager = registry.getOrCreate({ createHost, lockManager: secondLockManager, policy, scope: scope({ fill: 1 }) });

    expect(new Set([first, otherScope, otherManager])).toHaveLength(3);
    expect(createHost).toHaveBeenCalledTimes(3);
  });

  it("rejects a conflicting policy instead of creating a second authority host", () => {
    const registry = new HizoFSRuntimeHostRegistry<object, ReturnType<typeof host>>();
    const lockManager = {};
    const createHost = vi.fn(() => host({ id: 1 }));
    const containerScope = scope({ fill: 1 });
    registry.getOrCreate({ createHost, lockManager, policy, scope: containerScope });

    expect(() => registry.getOrCreate({
      createHost,
      lockManager,
      policy: { ...policy, maxReaderPins: policy.maxReaderPins + 1 },
      scope: containerScope,
    })).toThrowError(expect.objectContaining({ code: "runtime_policy_conflict" }));
    expect(() => registry.getOrCreate({
      createHost,
      lockManager,
      policy: { ...policy, maxReaderPins: policy.maxReaderPins + 1 },
      scope: containerScope,
    })).toThrowError(HizoFSRuntimeHostRegistryError);
    expect(createHost).toHaveBeenCalledOnce();
  });

  it("retains an entry when the host cannot prove safe disposal", async () => {
    const registry = new HizoFSRuntimeHostRegistry<object, ReturnType<typeof host>>();
    const lockManager = {};
    const containerScope = scope({ fill: 3 });
    const retainedHost = host({
      id: 1,
      result: Object.freeze({ blocker: "working_candidate_not_empty", status: "retained" }),
    });
    const createHost = vi.fn(() => retainedHost);

    registry.getOrCreate({ createHost, lockManager, policy, scope: containerScope });
    await expect(registry.disposeScopeIfIdleAndSafe({ lockManager, scope: containerScope })).resolves.toEqual({
      blocker: "working_candidate_not_empty",
      status: "retained",
    });
    expect(registry.getOrCreate({ createHost, lockManager, policy, scope: containerScope })).toBe(retainedHost);
    expect(createHost).toHaveBeenCalledOnce();
  });

  it("gracefully flushes before evicting a runtime host", async () => {
    const registry = new HizoFSRuntimeHostRegistry<object, ReturnType<typeof host>>();
    const lockManager = {};
    const containerScope = scope({ fill: 8 });
    const gracefulHost = host({ id: 1 });
    registry.getOrCreate({ createHost: () => gracefulHost, lockManager, policy, scope: containerScope });

    await expect(registry.flushAndDisposeScopeIfIdleAndSafe({ lockManager, scope: containerScope })).resolves.toEqual({
      status: "evicted",
    });
    expect(gracefulHost.flushAndDisposeIfIdleAndSafe).toHaveBeenCalledOnce();
    expect(gracefulHost.disposeIfIdleAndSafe).not.toHaveBeenCalled();
  });

  it("evicts only after the host proves safe disposal", async () => {
    const registry = new HizoFSRuntimeHostRegistry<object, ReturnType<typeof host>>();
    const lockManager = {};
    const containerScope = scope({ fill: 4 });
    let nextId = 0;
    const createHost = vi.fn(() => host({ id: ++nextId }));
    const first = registry.getOrCreate({ createHost, lockManager, policy, scope: containerScope });

    await expect(registry.disposeScopeIfIdleAndSafe({ lockManager, scope: containerScope })).resolves.toEqual({
      status: "evicted",
    });
    const second = registry.getOrCreate({ createHost, lockManager, policy, scope: containerScope });
    expect(second).not.toBe(first);
    expect(createHost).toHaveBeenCalledTimes(2);
  });

  it("shares one disposal decision across concurrent callers", async () => {
    const registry = new HizoFSRuntimeHostRegistry<object, ReturnType<typeof host>>();
    const lockManager = {};
    const containerScope = scope({ fill: 5 });
    const disposal = deferred<ContainerRuntimeHostDisposalResult>();
    const disposingHost = Object.freeze({
      disposeIfIdleAndSafe: vi.fn(async () => await disposal.promise),
      flushAndDisposeIfIdleAndSafe: vi.fn(async () => await disposal.promise),
      id: 1,
    });
    registry.getOrCreate({ createHost: () => disposingHost, lockManager, policy, scope: containerScope });

    const first = registry.disposeScopeIfIdleAndSafe({ lockManager, scope: containerScope });
    const second = registry.disposeScopeIfIdleAndSafe({ lockManager, scope: containerScope });
    expect(disposingHost.disposeIfIdleAndSafe).toHaveBeenCalledOnce();
    disposal.resolve(Object.freeze({ blocker: "working_candidate_not_empty", status: "retained" }));
    await expect(Promise.all([first, second])).resolves.toEqual([
      { blocker: "working_candidate_not_empty", status: "retained" },
      { blocker: "working_candidate_not_empty", status: "retained" },
    ]);
  });

  it("does not return a host while its disposal decision is in progress", async () => {
    const registry = new HizoFSRuntimeHostRegistry<object, ReturnType<typeof host>>();
    const lockManager = {};
    const containerScope = scope({ fill: 5 });
    const disposal = deferred<ContainerRuntimeHostDisposalResult>();
    const disposingHost = Object.freeze({
      disposeIfIdleAndSafe: vi.fn(async () => await disposal.promise),
      flushAndDisposeIfIdleAndSafe: vi.fn(async () => await disposal.promise),
      id: 1,
    });
    const createHost = vi.fn(() => disposingHost);
    registry.getOrCreate({ createHost, lockManager, policy, scope: containerScope });

    const disposing = registry.disposeScopeIfIdleAndSafe({ lockManager, scope: containerScope });
    expect(() => registry.getOrCreate({ createHost, lockManager, policy, scope: containerScope }))
      .toThrowError(expect.objectContaining({ code: "runtime_disposal_in_progress" }));
    disposal.resolve(Object.freeze({ status: "disposed" }));
    await expect(disposing).resolves.toEqual({ status: "evicted" });
  });

  it("reports an absent scope without creating a host", async () => {
    const registry = new HizoFSRuntimeHostRegistry<object, ReturnType<typeof host>>();
    await expect(registry.disposeScopeIfIdleAndSafe({
      lockManager: {},
      scope: scope({ fill: 6 }),
    })).resolves.toEqual({ status: "absent" });
  });

  it("rejects a conflicting lazy-durability policy for the same scope", () => {
    const registry = new HizoFSRuntimeHostRegistry<object, ReturnType<typeof host>>();
    const lockManager = {};
    const containerScope = scope({ fill: 7 });
    const createHost = vi.fn(() => host({ id: 1 }));
    const first = registry.getOrCreate({
      createHost,
      lockManager,
      policy,
      scope: containerScope,
    });

    expect(() => registry.getOrCreate({
      createHost,
      lockManager,
      policy: {
        ...policy,
        lazyDurability: {
          ...policy.lazyDurability,
          maximumSyncWaiters: policy.lazyDurability.maximumSyncWaiters + 1,
        },
      },
      scope: containerScope,
    })).toThrowError(expect.objectContaining({ code: "runtime_policy_conflict" }));
    expect(registry.getOrCreate({
      createHost,
      lockManager,
      policy,
      scope: containerScope,
    })).toBe(first);
    expect(createHost).toHaveBeenCalledOnce();
  });

});
