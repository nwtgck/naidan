import type { HizoFSWritableBackend, HizoFSReadableBackend } from "@/00-storage/service/hizofs/physical-store/backend";
import type { CanonicalContainerPath } from "@/00-storage/service/hizofs/physical-store/paths";
import { parentContainerDirectory } from "@/00-storage/service/hizofs/physical-store/paths";
import type { AuthenticatedHizoFSPhysicalBytes } from "./physical-bytes";

import { runAndCloseAuthenticatedFile } from "./file-operation";

export async function createAuthenticatedWholeFile({ backend, bytes, path }: {
  backend: HizoFSWritableBackend<AuthenticatedHizoFSPhysicalBytes>;
  bytes: AuthenticatedHizoFSPhysicalBytes;
  path: CanonicalContainerPath;
}): Promise<void> {
  const file = await backend.createFileExclusive({ path });
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
  await backend.syncDirectoryEntries({ parent: parentContainerDirectory({ path }) });
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
  if (!existed) await backend.syncDirectoryEntries({ parent: parentContainerDirectory({ path }) });
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
