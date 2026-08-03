import { describe, expect, it } from "vitest";
import { syncCreatedFileEntry } from "@/00-storage/service/hizofs/authenticated-store/sync-created-file-entry";
import type { AuthenticatedHizoFSPhysicalBytes } from "@/00-storage/service/hizofs/authenticated-store/physical-bytes";
import { parentContainerDirectory, canonicalContainerPath, type CanonicalContainerDirectory, type CanonicalContainerPath } from "@/00-storage/service/hizofs/physical-store/paths";
import { InMemoryCrashDurabilityBackend } from "@/00-storage/service/hizofs/physical-store/testing/in-memory-crash-durability-backend";

class ExactEntryBackend extends InMemoryCrashDurabilityBackend<AuthenticatedHizoFSPhysicalBytes> {
  public readonly exactPaths: CanonicalContainerPath[] = [];
  public readonly fallbackParents: CanonicalContainerDirectory[] = [];

  public async syncFileDirectoryEntry({ path }: { path: CanonicalContainerPath }): Promise<void> {
    this.exactPaths.push(path);
  }

  public override async syncDirectoryEntries({ parent }: { parent: CanonicalContainerDirectory }): Promise<void> {
    this.fallbackParents.push(parent);
  }
}

class FallbackEntryBackend extends InMemoryCrashDurabilityBackend<AuthenticatedHizoFSPhysicalBytes> {
  public readonly fallbackParents: CanonicalContainerDirectory[] = [];

  public override async syncDirectoryEntries({ parent }: { parent: CanonicalContainerDirectory }): Promise<void> {
    this.fallbackParents.push(parent);
  }
}

describe("created-file entry confirmation", () => {
  it("prefers an exact backend capability", async () => {
    const backend = new ExactEntryBackend({});
    const path = canonicalContainerPath({ value: "segments/metadata/aa/target.enc" });

    await syncCreatedFileEntry({ backend, path });

    expect(backend.exactPaths).toEqual([path]);
    expect(backend.fallbackParents).toEqual([]);
  });

  it("retains parent-directory confirmation as the canonical fallback", async () => {
    const backend = new FallbackEntryBackend({});
    const path = canonicalContainerPath({ value: "segments/metadata/aa/target.enc" });

    await syncCreatedFileEntry({ backend, path });

    expect(backend.fallbackParents).toEqual([parentContainerDirectory({ path })]);
  });
});
