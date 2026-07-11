import type {
  StorageDirectoryTransferSource,
  StorageDirectoryTransferTarget,
} from '@/00-storage/service/storage-directory-transfer';
import type { StorageVolumeAccess } from '@/00-storage/service/volume-access';
import { EncryptedFileStore } from './encrypted-file-store';
import { EncryptedFileSystemStore } from './encrypted-file-system-store';
import { EncryptedObjectStore } from './encrypted-object-store';

type EncryptedDirectoryAccess = Extract<
  StorageVolumeAccess,
  { readonly type: 'encrypted_directory' }
>;

function createStores({ access }: { access: EncryptedDirectoryAccess }): {
  readonly fileStore: EncryptedFileStore,
  readonly fileSystemStore: EncryptedFileSystemStore,
} {
  const objectStore = new EncryptedObjectStore({
    storeDirectory: access.storeDirectory,
    keys: {
      objectEncryptionKey: access.objectEncryptionKey,
      objectAddressKey: access.objectAddressKey,
    },
  });
  const fileStore = new EncryptedFileStore({ objectStore });
  return {
    fileStore,
    fileSystemStore: new EncryptedFileSystemStore({
      objectStore,
      fileStore,
    }),
  };
}

export function createEncryptedStorageDirectoryTransferSource({
  access,
}: {
  access: EncryptedDirectoryAccess,
}): StorageDirectoryTransferSource {
  const { fileStore, fileSystemStore } = createStores({ access });
  return {
    async *readDirectory({ path }) {
      const resolved = await fileSystemStore.resolve({
        rootDirectoryId: access.rootDirectoryId,
        path,
      });
      const directoryId = (() => {
        if (resolved.entry === undefined) {
          return access.rootDirectoryId;
        }
        switch (resolved.entry.type) {
        case 'directory':
          return resolved.entry.directoryId;
        case 'file':
        case 'symlink':
          return undefined;
        default: {
          const _ex: never = resolved.entry;
          throw new Error(
            `Unhandled encrypted filesystem entry: ${((_ex satisfies never) as { readonly type: string }).type}`,
          );
        }
        }
      })();
      if (directoryId === undefined) {
        throw new Error(`Encrypted transfer path is not a directory: ${path}`);
      }
      for await (const entry of fileSystemStore.readDirectory({ directoryId })) {
        switch (entry.type) {
        case 'directory':
          yield { type: 'directory', name: entry.name };
          break;
        case 'symlink':
          yield {
            type: 'symlink',
            name: entry.name,
            targetPath: entry.targetPath,
            modifiedAt: entry.modifiedAt,
          };
          break;
        case 'file': {
          const manifest = await fileStore.readManifest({ fileId: entry.fileId });
          if (manifest === undefined) {
            throw new Error(`Encrypted transfer file is missing: ${entry.fileId}`);
          }
          yield {
            type: 'file',
            name: entry.name,
            size: manifest.logicalSize,
            modifiedAt: manifest.modifiedAt,
            open: async () => {
              const handle = await fileStore.open({
                fileId: entry.fileId,
                mimeType: 'application/octet-stream',
              });
              if (handle === null) {
                throw new Error(`Encrypted transfer file is missing: ${entry.fileId}`);
              }
              const stream = handle.stream({
                start: 0,
                end: undefined,
                signal: undefined,
              });
              return new ReadableStream<Uint8Array>({
                start(controller) {
                  const reader = stream.getReader();
                  void (async () => {
                    try {
                      while (true) {
                        const result = await reader.read();
                        if (result.done) {
                          controller.close();
                          break;
                        }
                        controller.enqueue(result.value);
                      }
                    } catch (error) {
                      controller.error(error);
                    } finally {
                      reader.releaseLock();
                      await handle.close();
                    }
                  })();
                },
              });
            },
          };
          break;
        }
        default: {
          const _ex: never = entry;
          throw new Error(`Unhandled encrypted transfer entry: ${String(_ex)}`);
        }
        }
      }
    },
  };
}

export function createEncryptedStorageDirectoryTransferTarget({
  access,
}: {
  access: EncryptedDirectoryAccess,
}): StorageDirectoryTransferTarget {
  const { fileSystemStore } = createStores({ access });
  return {
    async createDirectory({ path }) {
      await fileSystemStore.createDirectory({
        rootDirectoryId: access.rootDirectoryId,
        path,
        recursive: true,
      });
    },
    async writeFile({ path, size, modifiedAt, source, signal }) {
      const parts = path.split('/').filter(Boolean);
      parts.pop();
      await fileSystemStore.createDirectory({
        rootDirectoryId: access.rootDirectoryId,
        path: `/${parts.join('/')}`,
        recursive: true,
      });
      await fileSystemStore.writeFile({
        rootDirectoryId: access.rootDirectoryId,
        path,
        source,
        logicalSize: size,
        modifiedAt,
        signal,
      });
    },
    async createSymlink({ path, targetPath, modifiedAt }) {
      await fileSystemStore.createSymlink({
        rootDirectoryId: access.rootDirectoryId,
        path,
        targetPath,
        modifiedAt,
      });
    },
  };
}

// Export internal state and logic used only for testing here. Do not reference
// these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
