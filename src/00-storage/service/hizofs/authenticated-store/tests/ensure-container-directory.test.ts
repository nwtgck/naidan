import type { CanonicalContainerDirectory } from "@/00-storage/service/hizofs/physical-store/paths";
import {
  canonicalContainerDirectory,
  canonicalContainerPath,
  containerPathSegments,
} from "@/00-storage/service/hizofs/physical-store/paths";
import { InMemoryCrashDurabilityBackend } from "@/00-storage/service/hizofs/physical-store/testing/in-memory-crash-durability-backend";
import type { AuthenticatedHizoFSPhysicalBytes } from "@/00-storage/service/hizofs/authenticated-store/physical-bytes";
import {
  ensureAuthenticatedContainerDirectory,
  ensureAuthenticatedContainerDirectoryHierarchy,
} from "@/00-storage/service/hizofs/authenticated-store/ensure-container-directory";
import { describe, expect, it, vi } from "vitest";

class ObservedBackend extends InMemoryCrashDurabilityBackend<AuthenticatedHizoFSPhysicalBytes> {
  public directoryCreateCalls = 0;
  readonly syncedParents: CanonicalContainerDirectory[] = [];

  public override async createDirectoryExclusive({ path }: {
    path: CanonicalContainerDirectory;
  }): Promise<Readonly<{ parentEntrySyncRequired: boolean }>> {
    this.directoryCreateCalls += 1;
    return await super.createDirectoryExclusive({ path });
  }

  public override async syncDirectoryEntries({ parent }: { parent: CanonicalContainerDirectory }): Promise<void> {
    this.syncedParents.push(parent);
    await super.syncDirectoryEntries({ parent });
  }
}

class HierarchyObservedBackend extends ObservedBackend {
  public hierarchyCalls = 0;

  public async provisionDirectoryHierarchy({ path }: {
    path: CanonicalContainerDirectory;
  }): Promise<Readonly<{ parentEntriesRequiringSync: readonly CanonicalContainerDirectory[] }>> {
    this.hierarchyCalls += 1;
    const parentEntriesRequiringSync: CanonicalContainerDirectory[] = [];
    const segments = containerPathSegments({ path });
    for (let length = 1; length <= segments.length; length += 1) {
      const child = canonicalContainerDirectory({ value: segments.slice(0, length).join("/") });
      const { parentEntrySyncRequired } = await super.createDirectoryExclusive({ path: child });
      if (parentEntrySyncRequired) {
        parentEntriesRequiringSync.push(canonicalContainerDirectory({
          value: segments.slice(0, length - 1).join("/"),
        }));
      }
    }
    return { parentEntriesRequiringSync };
  }
}

describe("authenticated container directory provisioning", () => {
  it("syncs only a newly created parent entry and does not enumerate the parent", async () => {
    const backend = new ObservedBackend({});
    const path = canonicalContainerDirectory({ value: "segments" });

    await ensureAuthenticatedContainerDirectory({ backend, path });
    await ensureAuthenticatedContainerDirectory({ backend, path });

    expect(backend.directoryCreateCalls).toBe(2);
    expect(backend.syncedParents).toEqual([canonicalContainerDirectory({ value: "" })]);
    expect(await backend.list({ directory: canonicalContainerDirectory({ value: "" }) })).toEqual([
      { kind: "directory", name: "segments" },
    ]);
  });

  it("normalizes a file occupying the required directory into authenticated corruption", async () => {
    const backend = new ObservedBackend({});
    const file = await backend.createFileExclusive({ path: canonicalContainerPath({ value: "segments" }) });
    await backend.closeFile({ file });

    await expect(ensureAuthenticatedContainerDirectory({
      backend,
      path: canonicalContainerDirectory({ value: "segments" }),
    })).rejects.toMatchObject({ code: "control_plane_corrupt" });
    expect(backend.syncedParents).toEqual([]);
  });

  it("uses one hierarchy capability and confirms every newly observed parent entry", async () => {
    const backend = new HierarchyObservedBackend({});
    const path = canonicalContainerDirectory({ value: "segments/metadata/ab" });

    await ensureAuthenticatedContainerDirectoryHierarchy({ backend, path });
    await ensureAuthenticatedContainerDirectoryHierarchy({ backend, path });

    expect(backend.hierarchyCalls).toBe(2);
    expect(backend.directoryCreateCalls).toBe(6);
    expect(backend.syncedParents).toEqual([
      canonicalContainerDirectory({ value: "" }),
      canonicalContainerDirectory({ value: "segments" }),
      canonicalContainerDirectory({ value: "segments/metadata" }),
    ]);
  });

  it("falls back to canonical prefix provisioning when the backend has no hierarchy capability", async () => {
    const backend = new ObservedBackend({});
    const path = canonicalContainerDirectory({ value: "segments/metadata/ab" });

    await ensureAuthenticatedContainerDirectoryHierarchy({ backend, path });

    expect(backend.directoryCreateCalls).toBe(3);
    expect(backend.syncedParents).toEqual([
      canonicalContainerDirectory({ value: "" }),
      canonicalContainerDirectory({ value: "segments" }),
      canonicalContainerDirectory({ value: "segments/metadata" }),
    ]);
  });

  it.each([
    { Backend: ObservedBackend, name: "prefix" },
    { Backend: HierarchyObservedBackend, name: "hierarchy" },
  ])("retains a failed parent confirmation across $name retries and crash", async ({ Backend }) => {
    const backend = new Backend({});
    const path = canonicalContainerDirectory({ value: "segments/metadata/ab" });
    const failure = new Error("parent confirmation failed");
    const sync = vi.spyOn(backend, "syncDirectoryEntries").mockRejectedValueOnce(failure);

    await expect(ensureAuthenticatedContainerDirectoryHierarchy({ backend, path })).rejects.toBe(failure);
    await ensureAuthenticatedContainerDirectoryHierarchy({ backend, path });
    expect(sync.mock.calls.map(([{ parent }]) => parent)).toEqual(["", "", "segments", "segments/metadata"]);
    await backend.crashAndRecover();
    await expect(backend.list({ directory: path })).resolves.toEqual([]);
  });

  it("retains creation uncertainty when a create throws after its side effect", async () => {
    const backend = new ObservedBackend({});
    const path = canonicalContainerDirectory({ value: "segments" });
    const create = backend.createDirectoryExclusive.bind(backend);
    const failure = new Error("create response lost");
    vi.spyOn(backend, "createDirectoryExclusive").mockImplementationOnce(async request => {
      await create(request);
      throw failure;
    });
    await expect(ensureAuthenticatedContainerDirectory({ backend, path })).rejects.toBe(failure);
    await ensureAuthenticatedContainerDirectory({ backend, path });
    expect(backend.syncedParents).toEqual([""]);
    await backend.crashAndRecover();
    await expect(backend.list({ directory: path })).resolves.toEqual([]);
  });

  it("retains partial hierarchy creation when no parent list was returned", async () => {
    const backend = new HierarchyObservedBackend({});
    const path = canonicalContainerDirectory({ value: "segments/metadata/ab" });
    const failure = new Error("hierarchy creation interrupted");
    vi.spyOn(backend, "provisionDirectoryHierarchy").mockImplementationOnce(async () => {
      await backend.createDirectoryExclusive({ path: canonicalContainerDirectory({ value: "segments" }) });
      throw failure;
    });
    await expect(ensureAuthenticatedContainerDirectoryHierarchy({ backend, path })).rejects.toBe(failure);
    await ensureAuthenticatedContainerDirectoryHierarchy({ backend, path });
    expect(backend.syncedParents).toEqual(["", "segments", "segments/metadata"]);
    await backend.crashAndRecover();
    await expect(backend.list({ directory: path })).resolves.toEqual([]);
  });

  it("retains the remaining hierarchy obligations after a middle confirmation fails", async () => {
    const backend = new HierarchyObservedBackend({});
    const path = canonicalContainerDirectory({ value: "segments/metadata/ab" });
    const sync = backend.syncDirectoryEntries.bind(backend);
    const failure = new Error("middle parent confirmation failed");
    let failOnce = true;
    const observed = vi.spyOn(backend, "syncDirectoryEntries").mockImplementation(async request => {
      if (failOnce && request.parent === "segments") {
        failOnce = false;
        throw failure;
      }
      await sync(request);
    });
    await expect(ensureAuthenticatedContainerDirectoryHierarchy({ backend, path })).rejects.toBe(failure);
    await ensureAuthenticatedContainerDirectoryHierarchy({ backend, path });
    expect(observed.mock.calls.map(([{ parent }]) => parent)).toEqual(["", "segments", "segments", "segments/metadata"]);
    await backend.crashAndRecover();
    await expect(backend.list({ directory: path })).resolves.toEqual([]);
  });

  it("returns each failed confirmation once and preserves its obligation for a later call", async () => {
    const backend = new ObservedBackend({});
    const path = canonicalContainerDirectory({ value: "segments" });
    const failure = new Error("parent still unavailable");
    const sync = vi.spyOn(backend, "syncDirectoryEntries")
      .mockRejectedValueOnce(failure).mockRejectedValueOnce(failure);
    await expect(ensureAuthenticatedContainerDirectory({ backend, path })).rejects.toBe(failure);
    expect(sync).toHaveBeenCalledTimes(1);
    await expect(ensureAuthenticatedContainerDirectory({ backend, path })).rejects.toBe(failure);
    expect(sync).toHaveBeenCalledTimes(2);
    await ensureAuthenticatedContainerDirectory({ backend, path });
    expect(sync).toHaveBeenCalledTimes(3);
  });

  it("does not confirm or inherit failures from an unrelated pending shard", async () => {
    const backend = new ObservedBackend({});
    const healthy = canonicalContainerDirectory({ value: "segments/metadata/ab" });
    const pending = canonicalContainerDirectory({ value: "segments/metadata/cd" });
    await ensureAuthenticatedContainerDirectoryHierarchy({ backend, path: healthy });
    const failure = new Error("other shard confirmation failed");
    const sync = vi.spyOn(backend, "syncDirectoryEntries").mockRejectedValue(failure);
    await expect(ensureAuthenticatedContainerDirectoryHierarchy({ backend, path: pending })).rejects.toBe(failure);
    sync.mockClear();
    await ensureAuthenticatedContainerDirectoryHierarchy({ backend, path: healthy });
    expect(sync).not.toHaveBeenCalled();
  });

  it.each(["created", "response_lost"] as const)("waits for an overlapping %s provision and shares one confirmation", async outcome => {
    const backend = new ObservedBackend({});
    const path = canonicalContainerDirectory({ value: "segments" });
    const created = Promise.withResolvers<void>();
    const releaseProvision = Promise.withResolvers<void>();
    const observedExisting = Promise.withResolvers<void>();
    const syncStarted = Promise.withResolvers<void>();
    const releaseSync = Promise.withResolvers<void>();
    const events: string[] = [];
    const create = backend.createDirectoryExclusive.bind(backend);
    const failure = new Error("creation response lost");
    vi.spyOn(backend, "createDirectoryExclusive")
      .mockImplementationOnce(async request => {
        const result = await create(request);
        created.resolve();
        await releaseProvision.promise;
        if (outcome === "response_lost") throw failure;
        return result;
      })
      .mockImplementationOnce(async request => {
        const result = await create(request);
        observedExisting.resolve();
        return result;
      });
    const sync = backend.syncDirectoryEntries.bind(backend);
    const syncSpy = vi.spyOn(backend, "syncDirectoryEntries").mockImplementation(async request => {
      syncStarted.resolve();
      await releaseSync.promise;
      await sync(request);
      events.push("confirmed");
    });
    const first = ensureAuthenticatedContainerDirectory({ backend, path }).catch(cause => {
      expect(outcome).toBe("response_lost");
      expect(cause).toBe(failure);
    });
    await created.promise;
    const second = ensureAuthenticatedContainerDirectory({ backend, path }).then(() => {
      events.push("second succeeded");
    });
    await observedExisting.promise;
    releaseProvision.resolve();
    // A lost create response has no first caller left to start confirmation.
    // Both calls must still settle before this check on the unmodified owner.
    if (outcome === "created") await syncStarted.promise;
    releaseSync.resolve();
    await Promise.all([first, second]);
    expect(syncSpy).toHaveBeenCalledTimes(1);
    expect(events).toEqual(["confirmed", "second succeeded"]);
    await backend.crashAndRecover();
    await expect(backend.list({ directory: path })).resolves.toEqual([]);
  });

  it("does not clear a newer uncertainty token when an earlier confirmation finishes", async () => {
    const backend = new ObservedBackend({});
    const path = canonicalContainerDirectory({ value: "segments" });
    const syncStarted = Promise.withResolvers<void>();
    const releaseSync = Promise.withResolvers<void>();
    const sync = backend.syncDirectoryEntries.bind(backend);
    const syncSpy = vi.spyOn(backend, "syncDirectoryEntries").mockImplementationOnce(async request => {
      syncStarted.resolve();
      await releaseSync.promise;
      await sync(request);
    });
    const first = ensureAuthenticatedContainerDirectory({ backend, path });
    await syncStarted.promise;
    const failure = new Error("later provision response lost");
    vi.spyOn(backend, "createDirectoryExclusive").mockRejectedValueOnce(failure);
    await expect(ensureAuthenticatedContainerDirectory({ backend, path })).rejects.toBe(failure);
    releaseSync.resolve();
    await first;
    expect(syncSpy).toHaveBeenCalledTimes(1);
    await ensureAuthenticatedContainerDirectory({ backend, path });
    expect(syncSpy).toHaveBeenCalledTimes(2);
    await ensureAuthenticatedContainerDirectory({ backend, path });
    expect(syncSpy).toHaveBeenCalledTimes(2);
  });

  it("settles overlapping partial hierarchy failure before confirming the successful caller's ancestry", async () => {
    const backend = new HierarchyObservedBackend({});
    const path = canonicalContainerDirectory({ value: "segments/metadata/ab" });
    const created = Promise.withResolvers<void>();
    const releaseProvision = Promise.withResolvers<void>();
    const secondProvisioned = Promise.withResolvers<void>();
    const provision = backend.provisionDirectoryHierarchy.bind(backend);
    const failure = new Error("partial hierarchy response lost");
    vi.spyOn(backend, "provisionDirectoryHierarchy")
      .mockImplementationOnce(async () => {
        await backend.createDirectoryExclusive({ path: canonicalContainerDirectory({ value: "segments" }) });
        created.resolve();
        await releaseProvision.promise;
        throw failure;
      })
      .mockImplementationOnce(async request => {
        const result = await provision(request);
        secondProvisioned.resolve();
        return result;
      });
    const first = ensureAuthenticatedContainerDirectoryHierarchy({ backend, path }).catch(cause => {
      expect(cause).toBe(failure);
    });
    await created.promise;
    const second = ensureAuthenticatedContainerDirectoryHierarchy({ backend, path });
    await secondProvisioned.promise;
    releaseProvision.resolve();
    await Promise.all([first, second]);
    expect(backend.syncedParents).toEqual(["", "segments", "segments/metadata"]);
    await backend.crashAndRecover();
    await expect(backend.list({ directory: path })).resolves.toEqual([]);
  });
});
