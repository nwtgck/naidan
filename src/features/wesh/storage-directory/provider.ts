import type {
  WeshDirEntry,
  WeshFileHandle,
  WeshIOResult,
  WeshOpenFlags,
  WeshStat,
  WeshVirtualMountProvider,
  WeshWriteResult,
} from '@/features/wesh/types';
import type { WeshStorageDirectoryRemote } from './types';

class RemoteStorageDirectoryFileHandle implements WeshFileHandle {
  constructor({ remote, handleId }: {
    remote: WeshStorageDirectoryRemote;
    handleId: string;
  }) {
    this.remote = remote;
    this.handleId = handleId;
  }

  private readonly remote: WeshStorageDirectoryRemote;
  private readonly handleId: string;
  private closed = false;

  async read({ buffer, offset: requestedOffset, length: requestedLength, position }: {
    buffer: Uint8Array;
    offset?: number;
    length?: number;
    position?: number;
  }): Promise<WeshIOResult> {
    this.assertOpen();
    const offset = requestedOffset ?? 0;
    const length = requestedLength ?? buffer.byteLength - offset;
    const result = await this.remote.read({
      handleId: this.handleId,
      length,
      position,
    });
    buffer.set(new Uint8Array(result.buffer, 0, result.bytesRead), offset);
    return { bytesRead: result.bytesRead };
  }

  async write({ buffer, offset: requestedOffset, length: requestedLength, position }: {
    buffer: Uint8Array;
    offset?: number;
    length?: number;
    position?: number;
  }): Promise<WeshWriteResult> {
    this.assertOpen();
    const offset = requestedOffset ?? 0;
    const length = requestedLength ?? buffer.byteLength - offset;
    const copied = buffer.slice(offset, offset + length);
    return this.remote.write({
      handleId: this.handleId,
      buffer: copied.buffer,
      position,
    });
  }

  async close(): Promise<void> {
    if (this.closed) {
      return;
    }
    this.closed = true;
    await this.remote.close({ handleId: this.handleId });
  }

  stat(): Promise<WeshStat> {
    this.assertOpen();
    return this.remote.statHandle({ handleId: this.handleId });
  }

  truncate({ size }: { size: number }): Promise<void> {
    this.assertOpen();
    return this.remote.truncate({ handleId: this.handleId, size });
  }

  async ioctl(): Promise<{ ret: number }> {
    this.assertOpen();
    return { ret: 0 };
  }

  private assertOpen(): void {
    if (this.closed) {
      throw new Error('The remote storage directory file handle is closed');
    }
  }
}

export class RemoteStorageDirectoryWeshProvider implements WeshVirtualMountProvider {
  constructor({ remote, mountPath }: {
    remote: WeshStorageDirectoryRemote;
    mountPath: string;
  }) {
    this.remote = remote;
    this.mountPath = mountPath;
  }

  private readonly remote: WeshStorageDirectoryRemote;
  private readonly mountPath: string;

  async open({ path, flags }: {
    path: string;
    flags: WeshOpenFlags;
    mode?: number;
  }): Promise<WeshFileHandle> {
    const result = await this.remote.open({
      mountPath: this.mountPath,
      path: this.toRelativePath({ path }),
      flags,
    });
    return new RemoteStorageDirectoryFileHandle({
      remote: this.remote,
      handleId: result.handleId,
    });
  }

  stat({ path }: { path: string }): Promise<WeshStat> {
    return this.remote.stat({
      mountPath: this.mountPath,
      path: this.toRelativePath({ path }),
      followFinalSymlink: true,
    });
  }

  lstat({ path }: { path: string }): Promise<WeshStat> {
    return this.remote.stat({
      mountPath: this.mountPath,
      path: this.toRelativePath({ path }),
      followFinalSymlink: false,
    });
  }

  async *readDir({ path }: { path: string }): AsyncIterable<WeshDirEntry> {
    const entries = await this.remote.readDir({
      mountPath: this.mountPath,
      path: this.toRelativePath({ path }),
    });
    for (const entry of entries) {
      yield {
        ...entry,
        fullPath: this.toMountedPath({ relativePath: entry.fullPath }),
      };
    }
  }

  readlink({ path }: { path: string }): Promise<string> {
    return this.remote.readlink({
      mountPath: this.mountPath,
      path: this.toRelativePath({ path }),
    });
  }

  mkdir({ path, recursive }: { path: string; recursive: boolean }): Promise<void> {
    return this.remote.mkdir({
      mountPath: this.mountPath,
      path: this.toRelativePath({ path }),
      recursive,
    });
  }

  symlink({ path, targetPath }: { path: string; targetPath: string }): Promise<void> {
    return this.remote.symlink({
      mountPath: this.mountPath,
      path: this.toRelativePath({ path }),
      targetPath,
    });
  }

  unlink({ path }: { path: string }): Promise<void> {
    return this.remote.unlink({
      mountPath: this.mountPath,
      path: this.toRelativePath({ path }),
    });
  }

  rmdir({ path }: { path: string }): Promise<void> {
    return this.remote.rmdir({
      mountPath: this.mountPath,
      path: this.toRelativePath({ path }),
    });
  }

  rename({ oldPath, newPath }: { oldPath: string; newPath: string }): Promise<void> {
    return this.remote.rename({
      mountPath: this.mountPath,
      oldPath: this.toRelativePath({ path: oldPath }),
      newPath: this.toRelativePath({ path: newPath }),
    });
  }

  private toRelativePath({ path }: { path: string }): string {
    if (this.mountPath === '/') {
      return path;
    }
    if (path === this.mountPath) {
      return '/';
    }
    const prefix = `${this.mountPath}/`;
    if (!path.startsWith(prefix)) {
      throw new Error(`Path is outside storage directory mount: ${path}`);
    }
    return `/${path.slice(prefix.length)}`;
  }

  private toMountedPath({ relativePath }: { relativePath: string }): string {
    if (this.mountPath === '/') {
      return relativePath;
    }
    return relativePath === '/'
      ? this.mountPath
      : `${this.mountPath}${relativePath}`;
  }
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
