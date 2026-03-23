/**
 * A virtual read-only directory handle for the wesh filesystem.
 *
 * Can be used anywhere a FileSystemDirectoryHandle is expected but the
 * directory should be empty and immutable. All reads return empty results;
 * all write operations throw. Useful as the wesh root `/` so that only
 * explicitly mounted paths are accessible.
 *
 * This class duck-types FileSystemDirectoryHandle so the VFS can use it
 * without modification; cast to FileSystemDirectoryHandle where needed.
 */
export class ReadonlyDirectoryHandle {
  readonly kind = 'directory' as const;
  readonly name = 'readonly';

  isSameEntry(_other: FileSystemHandle): Promise<boolean> {
    return Promise.resolve(false);
  }

  getFileHandle(_name: string, _options?: FileSystemGetFileOptions): Promise<never> {
    return Promise.reject(new DOMException('No such file or directory', 'NotFoundError'));
  }

  getDirectoryHandle(_name: string, _options?: FileSystemGetDirectoryOptions): Promise<never> {
    return Promise.reject(new DOMException('No such file or directory', 'NotFoundError'));
  }

  removeEntry(_name: string, _options?: FileSystemRemoveOptions): Promise<void> {
    return Promise.reject(new DOMException('Read-only file system', 'NotAllowedError'));
  }

  resolve(_possibleDescendant: FileSystemHandle): Promise<null> {
    return Promise.resolve(null);
  }

  entries(): AsyncIterableIterator<[string, FileSystemHandle]> {
    return (async function* (): AsyncGenerator<[string, FileSystemHandle]> {})();
  }

  keys(): AsyncIterableIterator<string> {
    return (async function* (): AsyncGenerator<string> {})();
  }

  values(): AsyncIterableIterator<FileSystemHandle> {
    return (async function* (): AsyncGenerator<FileSystemHandle> {})();
  }

  [Symbol.asyncIterator](): AsyncIterableIterator<[string, FileSystemHandle]> {
    return this.entries();
  }
}
