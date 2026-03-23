/**
 * A virtual read-only root directory for the wesh filesystem.
 *
 * Used in place of a real OPFS directory handle when the root `/` should be
 * empty and read-only. All reads return empty results; all write operations
 * throw. The VFS still shows mounted sub-directories (like /tmp) via its mount
 * table — those come from the mounts array, not from this handle.
 *
 * This class duck-types FileSystemDirectoryHandle so the VFS can use it
 * without modification; cast to FileSystemDirectoryHandle where needed.
 */
export class VirtualReadonlyRoot {
  readonly kind = 'directory' as const;
  readonly name = 'root';

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
