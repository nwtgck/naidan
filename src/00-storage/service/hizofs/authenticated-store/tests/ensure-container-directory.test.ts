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
import { describe, expect, it } from "vitest";

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
});
