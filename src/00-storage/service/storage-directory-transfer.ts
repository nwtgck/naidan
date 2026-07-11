import type { StorageVolumeAccess } from './volume-access';
import { writeReadableStreamToFileHandle } from '@/utils/file-system-stream';

interface FileSystemFileHandleWithWritable extends FileSystemFileHandle {
  createWritable(): Promise<FileSystemWritableFileStream>,
}

export type StorageDirectoryTransferEntry =
  | {
      readonly type: 'file',
      readonly name: string,
      readonly size: number,
      readonly modifiedAt: number,
      readonly open: () => Promise<ReadableStream<Uint8Array>>,
    }
  | {
      readonly type: 'directory',
      readonly name: string,
    }
  | {
      readonly type: 'symlink',
      readonly name: string,
      readonly targetPath: string,
      readonly modifiedAt: number,
    };

export interface StorageDirectoryTransferSource {
  readDirectory({ path }: { path: string }): AsyncIterable<StorageDirectoryTransferEntry>,
}

export interface StorageDirectoryTransferTarget {
  createDirectory({ path }: { path: string }): Promise<void>,
  writeFile({
    path,
    size,
    modifiedAt,
    source,
    signal,
  }: {
    path: string,
    size: number,
    modifiedAt: number,
    source: ReadableStream<Uint8Array>,
    signal: AbortSignal | undefined,
  }): Promise<void>,
  createSymlink({
    path,
    targetPath,
    modifiedAt,
  }: {
    path: string,
    targetPath: string,
    modifiedAt: number,
  }): Promise<void>,
}

function joinPath({ parent, name }: { parent: string, name: string }): string {
  return parent === '/' ? `/${name}` : `${parent}/${name}`;
}

async function resolveDirectDirectory({
  root,
  path,
  create,
}: {
  root: FileSystemDirectoryHandle,
  path: string,
  create: boolean,
}): Promise<FileSystemDirectoryHandle> {
  let current = root;
  for (const part of path.split('/').filter(Boolean)) {
    current = await current.getDirectoryHandle(part, { create });
  }
  return current;
}

export function createDirectStorageDirectoryTransferSource({
  root,
}: {
  root: FileSystemDirectoryHandle,
}): StorageDirectoryTransferSource {
  return {
    async *readDirectory({ path }) {
      const directory = await resolveDirectDirectory({
        root,
        path,
        create: false,
      });
      for await (const entry of directory.values()) {
        switch (entry.kind) {
        case 'directory':
          yield { type: 'directory', name: entry.name };
          break;
        case 'file': {
          const file = await entry.getFile();
          yield {
            type: 'file',
            name: entry.name,
            size: file.size,
            modifiedAt: file.lastModified,
            open: async () => file.stream(),
          };
          break;
        }
        default: {
          const _ex: never = entry;
          throw new Error(`Unhandled direct directory entry: ${String(_ex)}`);
        }
        }
      }
    },
  };
}

/**
 * Creates a transfer source without statically importing encryption code.
 *
 * Plain OPFS startup only reaches the direct branch. The encrypted transfer
 * implementation is loaded as a separate chunk only when encrypted storage is
 * actually opened or migrated.
 */
export async function createStorageDirectoryTransferSource({
  access,
}: {
  access: StorageVolumeAccess,
}): Promise<StorageDirectoryTransferSource> {
  switch (access.type) {
  case 'direct_directory':
    return createDirectStorageDirectoryTransferSource({ root: access.handle });
  case 'encrypted_directory': {
    const { createEncryptedStorageDirectoryTransferSource } = await import(
      './opfs-encryption/encrypted-storage-directory-transfer'
    );
    return createEncryptedStorageDirectoryTransferSource({ access });
  }
  default: {
    const _ex: never = access;
    throw new Error(`Unhandled storage directory access: ${String(_ex)}`);
  }
  }
}

export function createDirectStorageDirectoryTransferTarget({
  root,
}: {
  root: FileSystemDirectoryHandle,
}): StorageDirectoryTransferTarget {
  return {
    async createDirectory({ path }) {
      await resolveDirectDirectory({ root, path, create: true });
    },
    async writeFile({ path, source, signal }) {
      const parts = path.split('/').filter(Boolean);
      const name = parts.pop();
      if (name === undefined) {
        throw new Error(`Direct transfer file path has no name: ${path}`);
      }
      const directory = await resolveDirectDirectory({
        root,
        path: `/${parts.join('/')}`,
        create: true,
      });
      const fileHandle = await directory.getFileHandle(name, {
        create: true,
      }) as FileSystemFileHandleWithWritable;
      await writeReadableStreamToFileHandle({
        source,
        targetHandle: fileHandle,
        signal,
      });
    },
    async createSymlink({ path }) {
      throw new Error(`Direct OPFS cannot represent symbolic link: ${path}`);
    },
  };
}

export async function copyStorageDirectory({
  source,
  target,
  signal,
  onFile,
  path = '/',
}: {
  source: StorageDirectoryTransferSource,
  target: StorageDirectoryTransferTarget,
  signal: AbortSignal | undefined,
  onFile?: () => void,
  path?: string,
}): Promise<void> {
  await target.createDirectory({ path });
  for await (const entry of source.readDirectory({ path })) {
    signal?.throwIfAborted();
    const childPath = joinPath({ parent: path, name: entry.name });
    switch (entry.type) {
    case 'directory':
      await copyStorageDirectory({
        source,
        target,
        signal,
        onFile,
        path: childPath,
      });
      break;
    case 'file':
      await target.writeFile({
        path: childPath,
        size: entry.size,
        modifiedAt: entry.modifiedAt,
        source: await entry.open(),
        signal,
      });
      onFile?.();
      break;
    case 'symlink':
      await target.createSymlink({
        path: childPath,
        targetPath: entry.targetPath,
        modifiedAt: entry.modifiedAt,
      });
      break;
    default: {
      const _ex: never = entry;
      throw new Error(`Unhandled storage transfer entry: ${String(_ex)}`);
    }
    }
  }
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
  joinPath,
  resolveDirectDirectory,
};
