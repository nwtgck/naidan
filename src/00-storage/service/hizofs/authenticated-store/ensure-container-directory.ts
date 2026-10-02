import type { HizoFSPhysicalWriteBackend, HizoFSWritableBackend } from "@/00-storage/service/hizofs/physical-store/backend";
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

type DirectoryConfirmation = { confirmation: Promise<void> | undefined };
type DirectoryProvision = Readonly<{
  possibleCreations: readonly CanonicalContainerDirectory[];
  done: Promise<void>;
}>;
type DirectorySynchronizationState = {
  pending: Map<CanonicalContainerDirectory, DirectoryConfirmation>;
  provisions: Set<DirectoryProvision>;
};

// Only outstanding work is retained, not a cache of allegedly durable paths.
// A new backend cannot recover another backend lifetime's unconfirmed entries.
const stateByBackend = new WeakMap<HizoFSPhysicalWriteBackend<Uint8Array>, DirectorySynchronizationState>();

function directorySynchronizationState({ backend }: {
  backend: HizoFSPhysicalWriteBackend<Uint8Array>;
}): DirectorySynchronizationState {
  let state = stateByBackend.get(backend);
  if (state === undefined) {
    state = { pending: new Map(), provisions: new Set() };
    stateByBackend.set(backend, state);
  }
  return state;
}

/** Transparent wrappers must retain the underlying backend's outstanding work. */
export function shareAuthenticatedContainerDirectoryState({ backend, wrapper }: {
  backend: HizoFSPhysicalWriteBackend<Uint8Array>;
  wrapper: HizoFSPhysicalWriteBackend<Uint8Array>;
}): void {
  stateByBackend.set(wrapper, directorySynchronizationState({ backend }));
}

function directoryAncestry({ path }: {
  path: CanonicalContainerDirectory;
}): readonly CanonicalContainerDirectory[] {
  const segments = containerPathSegments({ path });
  return segments.map((_, index) => canonicalContainerDirectory({ value: segments.slice(0, index + 1).join("/") }));
}

function directoryParent({ path }: { path: CanonicalContainerDirectory }): CanonicalContainerDirectory {
  return parentContainerDirectory({ path: canonicalContainerPath({ value: path }) });
}

async function provisionAndConfirmDirectories({ ancestry, backend, possibleCreations, provision }: {
  ancestry: readonly CanonicalContainerDirectory[];
  backend: HizoFSWritableBackend<AuthenticatedHizoFSPhysicalBytes>;
  possibleCreations: readonly CanonicalContainerDirectory[];
  provision: () => Promise<readonly CanonicalContainerDirectory[]>;
}): Promise<void> {
  const state = directorySynchronizationState({ backend });
  const completion = Promise.withResolvers<void>();
  const active = { done: completion.promise, possibleCreations };
  state.provisions.add(active);
  try {
    for (const path of await provision()) state.pending.set(path, { confirmation: undefined });
  } catch (cause: unknown) {
    // A thrown create can leave visible entries even without a result to report them.
    for (const path of possibleCreations) state.pending.set(path, { confirmation: undefined });
    if (cause instanceof PhysicalStoreError && cause.code === "not_directory") {
      throw authenticatedStoreError({
        cause,
        code: "control_plane_corrupt",
        message: `required segment directory ${ancestry.at(-1)} is occupied by a file`,
      });
    }
    throw cause;
  } finally {
    state.provisions.delete(active);
    completion.resolve();
  }

  // Provisioning has now observed every required entry. Wait only for creations
  // already in flight, never for another ensure's whole confirmation protocol.
  const overlapping = [...state.provisions]
    .filter(other => other.possibleCreations.some(path => ancestry.includes(path)))
    .map(other => other.done);
  if (overlapping.length !== 0) await Promise.all(overlapping);

  for (const path of ancestry) {
    const pending = state.pending.get(path);
    if (pending === undefined) continue;
    if (pending.confirmation === undefined) {
      // Publish the shared Promise before entering the backend, including a
      // backend that throws synchronously. Each caller attempts confirmation once.
      pending.confirmation = Promise.resolve().then(async () => {
        try {
          await backend.syncDirectoryEntries({ parent: directoryParent({ path }) });
          if (state.pending.get(path) === pending) state.pending.delete(path);
        } catch (cause: unknown) {
          pending.confirmation = undefined;
          throw cause;
        }
      });
    }
    await pending.confirmation;
  }
  // Later idempotent creates cannot replace the observed directories: PhysicalStore
  // has no directory removal operation. A later uncertain token remains pending,
  // but does not revoke this call's successful confirmation of the same entry.
}

export async function ensureAuthenticatedContainerDirectory({ backend, path }: {
  backend: HizoFSWritableBackend<AuthenticatedHizoFSPhysicalBytes>;
  path: CanonicalContainerDirectory;
}): Promise<void> {
  if (path === CANONICAL_CONTAINER_ROOT) return;
  await provisionAndConfirmDirectories({
    ancestry: directoryAncestry({ path }),
    backend,
    possibleCreations: [path],
    provision: async () => {
      const { parentEntrySyncRequired } = await backend.createDirectoryExclusive({ path });
      return parentEntrySyncRequired ? [path] : [];
    },
  });
}

export async function ensureAuthenticatedContainerDirectoryHierarchy({ backend, path }: {
  backend: HizoFSWritableBackend<AuthenticatedHizoFSPhysicalBytes>;
  path: CanonicalContainerDirectory;
}): Promise<void> {
  if (path === CANONICAL_CONTAINER_ROOT) return;
  if (backend.provisionDirectoryHierarchy !== undefined) {
    const ancestry = directoryAncestry({ path });
    const provisionHierarchy = backend.provisionDirectoryHierarchy;
    await provisionAndConfirmDirectories({
      ancestry,
      backend,
      possibleCreations: ancestry,
      provision: async () => {
        const { parentEntriesRequiringSync } = await provisionHierarchy.call(backend, { path });
        return ancestry.filter(child => parentEntriesRequiringSync.includes(directoryParent({ path: child })));
      },
    });
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
