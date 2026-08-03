import type { HizoFSWritableBackend } from "@/00-storage/service/hizofs/physical-store/backend";
import { PhysicalStoreError } from "@/00-storage/service/hizofs/physical-store/errors";
import {
  CANONICAL_CONTAINER_ROOT,
  canonicalContainerPath,
  canonicalContainerDirectory,
  containerPathSegments,
  parentContainerDirectory,
  type CanonicalContainerDirectory,
} from "@/00-storage/service/hizofs/physical-store/paths";
import { authenticatedStoreError } from "./errors";
import type { AuthenticatedHizoFSPhysicalBytes } from "./physical-bytes";

export async function ensureAuthenticatedContainerDirectory({ backend, path }: {
  backend: HizoFSWritableBackend<AuthenticatedHizoFSPhysicalBytes>;
  path: CanonicalContainerDirectory;
}): Promise<void> {
  if (path === CANONICAL_CONTAINER_ROOT) return;
  const parent = parentContainerDirectory({ path: canonicalContainerPath({ value: path }) });
  let parentEntrySyncRequired: boolean;
  try {
    ({ parentEntrySyncRequired } = await backend.createDirectoryExclusive({ path }));
  } catch (cause: unknown) {
    if (cause instanceof PhysicalStoreError && cause.code === "not_directory") {
      throw authenticatedStoreError({
        cause,
        code: "control_plane_corrupt",
        message: `required segment directory ${path} is occupied by a file`,
      });
    }
    throw cause;
  }
  if (parentEntrySyncRequired) await backend.syncDirectoryEntries({ parent });
}

export async function ensureAuthenticatedContainerDirectoryHierarchy({ backend, path }: {
  backend: HizoFSWritableBackend<AuthenticatedHizoFSPhysicalBytes>;
  path: CanonicalContainerDirectory;
}): Promise<void> {
  if (path === CANONICAL_CONTAINER_ROOT) return;
  if (backend.provisionDirectoryHierarchy !== undefined) {
    let parents: readonly CanonicalContainerDirectory[];
    try {
      ({ parentEntriesRequiringSync: parents } = await backend.provisionDirectoryHierarchy({ path }));
    } catch (cause: unknown) {
      if (cause instanceof PhysicalStoreError && cause.code === "not_directory") {
        throw authenticatedStoreError({
          cause,
          code: "control_plane_corrupt",
          message: `required segment directory ${path} is occupied by a file`,
        });
      }
      throw cause;
    }
    for (const parent of parents) await backend.syncDirectoryEntries({ parent });
    return;
  }

  const segments = containerPathSegments({ path });
  for (let length = 1; length <= segments.length; length += 1) {
    await ensureAuthenticatedContainerDirectory({
      backend,
      path: canonicalContainerDirectory({ value: segments.slice(0, length).join("/") }),
    });
  }
}

export const TEST_ONLY = {
};
