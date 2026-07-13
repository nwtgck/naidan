import { bytesEqual, toExactArrayBuffer } from '@/00-storage/service/encrypted-opfs/bytes';
import type {
  EncryptedOpfsBackingStore,
  EncryptedOpfsBackingStoreEntry,
} from './backing-store';

interface FileHandleWithWritable extends FileSystemFileHandle {
  createWritable(options?: FileSystemCreateWritableOptions): Promise<FileSystemWritableFileStream>;
}

function validatePath({ path }: {
  path: readonly string[];
}): void {
  if (path.length === 0) {
    throw new Error('EncryptedOpfs backing-store file path must not be empty');
  }
  for (const segment of path) {
    if (segment.length === 0 || segment === '.' || segment === '..' || segment.includes('/')) {
      throw new Error(`Invalid EncryptedOpfs backing-store path segment: ${segment}`);
    }
  }
}

function isNotFoundError({ error }: {
  error: unknown;
}): boolean {
  return error instanceof DOMException
    ? error.name === 'NotFoundError'
    : error instanceof Error
      && (error.name === 'NotFoundError' || error.message.startsWith('NotFoundError'));
}

export class NativeOpfsEncryptedOpfsBackingStore implements EncryptedOpfsBackingStore {
  constructor({ root }: {
    root: FileSystemDirectoryHandle;
  }) {
    this.root = root;
  }

  private readonly root: FileSystemDirectoryHandle;

  async read({ path }: {
    path: readonly string[];
  }): Promise<Uint8Array | undefined> {
    validatePath({ path });
    try {
      const { directory, name } = await this.resolveParent({ path, create: false });
      const handle = await directory.getFileHandle(name);
      return new Uint8Array(await (await handle.getFile()).arrayBuffer());
    } catch (error) {
      if (isNotFoundError({ error })) {
        return undefined;
      }
      throw error;
    }
  }

  async write({ path, bytes }: {
    path: readonly string[];
    bytes: Uint8Array;
  }): Promise<void> {
    validatePath({ path });
    const { directory, name } = await this.resolveParent({ path, create: true });
    const handle = await directory.getFileHandle(name, { create: true }) as FileHandleWithWritable;
    const writable = await handle.createWritable({ keepExistingData: false });
    try {
      await writable.write(toExactArrayBuffer({ bytes }));
      await writable.close();
    } catch (error) {
      try {
        await writable.abort(error);
      } catch {
        // Preserve the original write error.
      }

      try {
        const persisted = new Uint8Array(await (await handle.getFile()).arrayBuffer());
        if (bytesEqual({ left: persisted, right: bytes })) {
          // A failed close may still have durably committed the complete replacement.
          return;
        }
      } catch {
        // Preserve the original error when exact durable completion cannot be proven.
      }
      throw error;
    }
  }

  async remove({ path, recursive }: {
    path: readonly string[];
    recursive: boolean;
  }): Promise<void> {
    validatePath({ path });
    try {
      const { directory, name } = await this.resolveParent({ path, create: false });
      await directory.removeEntry(name, { recursive });
    } catch (error) {
      if (!isNotFoundError({ error })) {
        throw error;
      }
    }
  }

  async *list({ path }: {
    path: readonly string[];
  }): AsyncIterable<EncryptedOpfsBackingStoreEntry> {
    let directory = this.root;
    for (const segment of path) {
      if (segment.length === 0 || segment === '.' || segment === '..' || segment.includes('/')) {
        throw new Error(`Invalid EncryptedOpfs backing-store path segment: ${segment}`);
      }
      directory = await directory.getDirectoryHandle(segment);
    }

    for await (const [name, handle] of directory.entries()) {
      switch (handle.kind) {
      case 'file':
        yield { name, kind: 'file' };
        break;
      case 'directory':
        yield { name, kind: 'directory' };
        break;
      default: {
        const _ex: never = handle;
        throw new Error(`Unhandled backing-store entry kind: ${String(_ex)}`);
      }
      }
    }
  }

  private async resolveParent({ path, create }: {
    path: readonly string[];
    create: boolean;
  }): Promise<{
    readonly directory: FileSystemDirectoryHandle;
    readonly name: string;
  }> {
    const name = path.at(-1);
    if (name === undefined) {
      throw new Error('EncryptedOpfs backing-store file path must not be empty');
    }

    let directory = this.root;
    for (const segment of path.slice(0, -1)) {
      directory = await directory.getDirectoryHandle(segment, { create });
    }
    return { directory, name };
  }
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
