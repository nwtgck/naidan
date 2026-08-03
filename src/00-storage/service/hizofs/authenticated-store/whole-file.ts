import type { HizoFSWritableBackend, HizoFSReadableBackend } from "@/00-storage/service/hizofs/physical-store/backend";
import { PhysicalStoreError, physicalStoreError } from "@/00-storage/service/hizofs/physical-store/errors";
import type { CanonicalContainerPath } from "@/00-storage/service/hizofs/physical-store/paths";
import type { AuthenticatedHizoFSPhysicalBytes } from "./physical-bytes";

import { runAndCloseAuthenticatedFile } from "./file-operation";
import { syncCreatedFileEntry } from "./sync-created-file-entry";

async function persistClaimedAuthenticatedWholeFile({ backend, bytes, file, path }: {
  backend: HizoFSWritableBackend<AuthenticatedHizoFSPhysicalBytes>;
  bytes: AuthenticatedHizoFSPhysicalBytes;
  file: Awaited<ReturnType<HizoFSWritableBackend<AuthenticatedHizoFSPhysicalBytes>["createFileExclusive"]>>;
  path: CanonicalContainerPath;
}): Promise<void> {
  await runAndCloseAuthenticatedFile({
    backend,
    file,
    operation: async () => {
      await backend.writeAt({ bytes, file, offset: 0n });
      await backend.truncate({ file, length: BigInt(bytes.byteLength) });
      await backend.syncFileData({ file });
    },
    operationLabel: "authenticated whole-file operation",
  });
  await syncCreatedFileEntry({ backend, path });
}

export async function tryCreateAuthenticatedWholeFile({ backend, bytes, path }: {
  backend: HizoFSWritableBackend<AuthenticatedHizoFSPhysicalBytes>;
  bytes: AuthenticatedHizoFSPhysicalBytes;
  path: CanonicalContainerPath;
}): Promise<boolean> {
  let file: Awaited<ReturnType<HizoFSWritableBackend<AuthenticatedHizoFSPhysicalBytes>["createFileExclusive"]>>;
  try {
    file = await backend.createFileExclusive({ path });
  } catch (cause) {
    if (cause instanceof PhysicalStoreError && cause.code === "already_exists") return false;
    throw cause;
  }
  await persistClaimedAuthenticatedWholeFile({ backend, bytes, file, path });
  return true;
}

export async function createAuthenticatedWholeFile({ backend, bytes, path }: {
  backend: HizoFSWritableBackend<AuthenticatedHizoFSPhysicalBytes>;
  bytes: AuthenticatedHizoFSPhysicalBytes;
  path: CanonicalContainerPath;
}): Promise<void> {
  if (await tryCreateAuthenticatedWholeFile({ backend, bytes, path })) return;
  throw physicalStoreError({
    code: "already_exists",
    message: `physical entry already exists: ${path}`,
    path,
  });
}


export async function overwriteAuthenticatedWholeFile({ backend, bytes, path }: {
  backend: HizoFSWritableBackend<AuthenticatedHizoFSPhysicalBytes>;
  bytes: AuthenticatedHizoFSPhysicalBytes;
  path: CanonicalContainerPath;
}): Promise<void> {
  const existed = await backend.getFileSize({ path }) !== undefined;
  const file = existed
    ? await backend.openFileForUpdate({ path })
    : await backend.createFileExclusive({ path });
  await runAndCloseAuthenticatedFile({
    backend,
    file,
    operation: async () => {
      await backend.writeAt({ bytes, file, offset: 0n });
      await backend.truncate({ file, length: BigInt(bytes.byteLength) });
      await backend.syncFileData({ file });
    },
    operationLabel: "authenticated whole-file overwrite",
  });
  if (!existed) await syncCreatedFileEntry({ backend, path });
}

export async function readAuthenticatedWholeFile({ backend, maximumByteLength, path }: {
  backend: HizoFSReadableBackend;
  maximumByteLength: number;
  path: CanonicalContainerPath;
}): Promise<Uint8Array | undefined> {
  return await backend.readFileBounded({ maximumByteLength, path });
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
