import {
  fileSystemIdToNaidanContainerToken,
  type NaidanPersistenceModeV1,
} from "@/00-storage/service/naidan-persistence-control/00-format";
import type {
  NaidanPersistenceControlExclusiveGate,
} from "@/00-storage/service/naidan-opfs/opfs-transition-progress-physical-port";

type HizoFSMode = Extract<NaidanPersistenceModeV1, { readonly type: "hizofs" }>;
type FileSystemId = HizoFSMode["activeFileSystemId"];

export const NAIDAN_OPFS_STORAGE_DIRECTORY_NAME = "naidan-storage";

export type NaidanOpfsContainerDirectoryReservation =
  | Readonly<{ type: "collision" }>
  | Readonly<{
      cleanup(): Promise<void>;
      containerRoot: FileSystemDirectoryHandle;
      type: "reserved";
    }>;

function isNotFoundError({ cause }: { cause: unknown }): boolean {
  return cause instanceof DOMException
    ? cause.name === "NotFoundError"
    : cause instanceof Error
      && (cause.name === "NotFoundError" || cause.message.startsWith("NotFoundError"));
}

declare const naidanOpfsContainerOriginRelativePathBrand: unique symbol;

/** Runtime-only canonical backing location inside one origin-private OPFS root. */
export type NaidanOpfsContainerOriginRelativePath = string & {
  readonly [naidanOpfsContainerOriginRelativePathBrand]: true;
};

export function naidanOpfsContainerOriginRelativePathComponents({ fileSystemId }: {
  fileSystemId: FileSystemId;
}): readonly [string, string] {
  return Object.freeze([
    NAIDAN_OPFS_STORAGE_DIRECTORY_NAME,
    fileSystemIdToNaidanContainerToken({ id: fileSystemId }),
  ]);
}

export function naidanOpfsContainerOriginRelativePath({ fileSystemId }: {
  fileSystemId: FileSystemId;
}): NaidanOpfsContainerOriginRelativePath {
  return naidanOpfsContainerOriginRelativePathComponents({ fileSystemId })
    .join('/') as NaidanOpfsContainerOriginRelativePath;
}


/** Opens an existing HizoFS container directory without creating routing state. */
/**
 * Reserves one unreferenced container directory under the Persistence Control
 * authority gate. OPFS has no create-exclusive directory operation, so the
 * gate makes the check-and-create sequence atomic for cooperating Naidan
 * realms; the random File System ID remains the cross-implementation collision
 * defense. Cleanup removes only the directory reserved by this attempt.
 */
export async function reserveNaidanOpfsContainerDirectory({
  exclusiveGate,
  fileSystemId,
  storageRoot,
}: {
  exclusiveGate: NaidanPersistenceControlExclusiveGate;
  fileSystemId: FileSystemId;
  storageRoot: FileSystemDirectoryHandle;
}): Promise<NaidanOpfsContainerDirectoryReservation> {
  const token = fileSystemIdToNaidanContainerToken({ id: fileSystemId });
  return await exclusiveGate.runExclusive({
    operation: async () => {
      const nativeStorageRoot = await storageRoot.getDirectoryHandle(
        NAIDAN_OPFS_STORAGE_DIRECTORY_NAME,
        { create: true },
      );
      try {
        await nativeStorageRoot.getDirectoryHandle(token, { create: false });
        return { type: "collision" };
      } catch (cause: unknown) {
        if (!isNotFoundError({ cause })) throw cause;
      }

      const containerRoot = await nativeStorageRoot.getDirectoryHandle(token, { create: true });
      let cleanupRequired = true;
      return {
        async cleanup() {
          if (!cleanupRequired) return;
          await exclusiveGate.runExclusive({
            operation: async () => {
              if (!cleanupRequired) return;
              try {
                await nativeStorageRoot.removeEntry(token, { recursive: true });
              } catch (cause: unknown) {
                if (!isNotFoundError({ cause })) throw cause;
              }
              cleanupRequired = false;
            },
          });
        },
        containerRoot,
        type: "reserved",
      };
    },
  });
}

export async function removeNaidanOpfsContainerDirectory({
  exclusiveGate,
  fileSystemId,
  storageRoot,
}: {
  exclusiveGate: NaidanPersistenceControlExclusiveGate;
  fileSystemId: FileSystemId;
  storageRoot: FileSystemDirectoryHandle;
}): Promise<void> {
  const token = fileSystemIdToNaidanContainerToken({ id: fileSystemId });
  await exclusiveGate.runExclusive({
    operation: async () => {
      let nativeStorageRoot: FileSystemDirectoryHandle;
      try {
        nativeStorageRoot = await storageRoot.getDirectoryHandle(
          NAIDAN_OPFS_STORAGE_DIRECTORY_NAME,
          { create: false },
        );
      } catch (cause: unknown) {
        if (isNotFoundError({ cause })) return;
        throw cause;
      }
      try {
        await nativeStorageRoot.removeEntry(token, { recursive: true });
      } catch (cause: unknown) {
        if (!isNotFoundError({ cause })) throw cause;
      }
    },
  });
}

export async function openNaidanOpfsContainerDirectory({ fileSystemId, storageRoot }: {
  fileSystemId: FileSystemId;
  storageRoot: FileSystemDirectoryHandle;
}): Promise<FileSystemDirectoryHandle> {
  const nativeStorageRoot = await storageRoot.getDirectoryHandle(
    NAIDAN_OPFS_STORAGE_DIRECTORY_NAME,
    { create: false },
  );
  return await nativeStorageRoot.getDirectoryHandle(
    fileSystemIdToNaidanContainerToken({ id: fileSystemId }),
    { create: false },
  );
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
