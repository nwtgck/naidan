import type { HizoFSWritableBackend } from "@/00-storage/service/hizofs/physical-store/backend";
import type { CanonicalContainerPath } from "@/00-storage/service/hizofs/physical-store/paths";
import { parentContainerDirectory } from "@/00-storage/service/hizofs/physical-store/paths";
import type { AuthenticatedHizoFSPhysicalBytes } from "./physical-bytes";

export async function syncCreatedFileEntry({ backend, path }: {
  backend: HizoFSWritableBackend<AuthenticatedHizoFSPhysicalBytes>;
  path: CanonicalContainerPath;
}): Promise<void> {
  const syncFileDirectoryEntry = backend.syncFileDirectoryEntry;
  if (syncFileDirectoryEntry !== undefined) {
    await syncFileDirectoryEntry.call(backend, { path });
    return;
  }
  await backend.syncDirectoryEntries({ parent: parentContainerDirectory({ path }) });
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
