import type { CanonicalContainerDirectory } from "@/00-storage/service/hizofs/physical-store/paths";
import {
  canonicalContainerDirectory,
  canonicalContainerPath,
} from "@/00-storage/service/hizofs/physical-store/paths";
import { InMemoryCrashDurabilityBackend } from "@/00-storage/service/hizofs/physical-store/testing/in-memory-crash-durability-backend";
import type { AuthenticatedHizoFSPhysicalBytes } from "@/00-storage/service/hizofs/authenticated-store/physical-bytes";
import { ensureAuthenticatedContainerDirectory } from "@/00-storage/service/hizofs/authenticated-store/ensure-container-directory";
import { describe, expect, it } from "vitest";

class ObservedBackend extends InMemoryCrashDurabilityBackend<AuthenticatedHizoFSPhysicalBytes> {
  readonly syncedParents: CanonicalContainerDirectory[] = [];

  public override async syncDirectoryEntries({ parent }: { parent: CanonicalContainerDirectory }): Promise<void> {
    this.syncedParents.push(parent);
    await super.syncDirectoryEntries({ parent });
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
});
