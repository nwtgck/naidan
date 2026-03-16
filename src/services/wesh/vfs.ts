import type {
  WeshIVirtualFileSystem,
  WeshFileHandle,
  WeshFileType,
  WeshStat,
  WeshIOResult,
  WeshWriteResult
} from './types';

// --- Registry Interface ---
interface WeshRegistryEntry {
  type: WeshFileType;
  mode: number;
}

interface WeshRegistry {
  [path: string]: WeshRegistryEntry;
}

// --- Utils ---
const REGISTRY_FILE = '.wesh_registry';

class StandardFileHandle implements WeshFileHandle {
  private handle: FileSystemFileHandle;
  private readOnly: boolean;

  constructor({ handle, readOnly }: { handle: FileSystemFileHandle; readOnly: boolean }) {
    this.handle = handle;
    this.readOnly = readOnly;
  }

  async read(options: {
    buffer: Uint8Array;
    offset?: number;
    length?: number;
    position?: number;
  }): Promise<WeshIOResult> {
    const file = await this.handle.getFile();
    const position = options.position ?? 0; // Default to 0 if not provided? Or maintain internal cursor?
    // The interface says "If undefined, use current cursor."
    // StandardFileHandle should probably maintain a cursor if it's stateful,
    // but the previous implementation was stateless regarding cursor.
    // However, POSIX file descriptors have state (cursor).
    // The VFS.open returns a Handle. If this handle is shared, cursor is shared.
    // Let's implement cursor.

    // Actually, `WeshFileHandle` in types.ts implies we might pass position.
    // If position is undefined, we use internal cursor.

    const pos = options.position ?? this._cursor;

    if (pos >= file.size) return { bytesRead: 0 };

    const bufferOffset = options.offset ?? 0;
    const maxLen = options.length ?? (options.buffer.length - bufferOffset);
    const end = Math.min(pos + maxLen, file.size);

    const slice = file.slice(pos, end);
    const arrayBuffer = await slice.arrayBuffer();
    const result = new Uint8Array(arrayBuffer);

    options.buffer.set(result, bufferOffset);

    if (options.position === undefined) {
      this._cursor += result.length;
    }

    return { bytesRead: result.length };
  }

  private _cursor = 0;

  async write(options: {
    buffer: Uint8Array;
    offset?: number;
    length?: number;
    position?: number
  }): Promise<WeshWriteResult> {
    if (this.readOnly) throw new Error('File is read-only');

    const bufferOffset = options.offset ?? 0;
    const length = options.length ?? (options.buffer.length - bufferOffset);
    const dataToWrite = options.buffer.subarray(bufferOffset, bufferOffset + length);

    const pos = options.position ?? this._cursor;

    // keepExistingData: true is crucial.
    const writable = await this.handle.createWritable({ keepExistingData: true });
    try {
      await writable.seek(pos);
      await writable.write(dataToWrite);
    } finally {
      await writable.close();
    }

    if (options.position === undefined) {
      this._cursor += length;
    }

    return { bytesWritten: length };
  }

  async close(): Promise<void> {
    // No-op for File System Access API
  }

  async stat(): Promise<WeshStat> {
    const file = await this.handle.getFile();
    return {
      size: file.size,
      mode: 0o644, // Default for regular files
      type: 'file',
      mtime: file.lastModified,
      ino: 0,
      uid: 0,
      gid: 0
    };
  }

  async truncate(options: { size: number }): Promise<void> {
    if (this.readOnly) throw new Error('File is read-only');
    const writable = await this.handle.createWritable({ keepExistingData: true });
    try {
      await writable.truncate(options.size);
    } finally {
      await writable.close();
    }
  }

  async ioctl(): Promise<{ ret: number }> {
    return { ret: -1 }; // Not supported
  }
}

class FifoHandle implements WeshFileHandle {
  private buffer: Uint8Array[] = [];
  private waiters: Array<(val: void) => void> = [];
  private closed = false;
  private _cursor = 0; // Meaningless for FIFO, but satisfying interface

  async read(options: { buffer: Uint8Array; offset?: number; length?: number }): Promise<WeshIOResult> {
    if (this.buffer.length === 0 && this.closed) return { bytesRead: 0 };

    while (this.buffer.length === 0) {
      if (this.closed) return { bytesRead: 0 };
      await new Promise<void>(resolve => this.waiters.push(resolve));
    }

    const chunk = this.buffer.shift()!;
    // Simple implementation: Return one chunk (or part of it)
    // Real implementation should fill buffer as much as possible.

    const bufferOffset = options.offset ?? 0;
    const maxLen = options.length ?? (options.buffer.length - bufferOffset);
    const copyLen = Math.min(chunk.length, maxLen);

    options.buffer.set(chunk.subarray(0, copyLen), bufferOffset);

    if (chunk.length > copyLen) {
      // Unshift remaining
      this.buffer.unshift(chunk.subarray(copyLen));
    }

    return { bytesRead: copyLen };
  }

  async write(options: { buffer: Uint8Array; offset?: number; length?: number }): Promise<WeshWriteResult> {
    if (this.closed) throw new Error('Broken pipe');

    const bufferOffset = options.offset ?? 0;
    const length = options.length ?? (options.buffer.length - bufferOffset);
    const data = new Uint8Array(options.buffer.subarray(bufferOffset, bufferOffset + length)); // Copy

    this.buffer.push(data);

    // Wake up readers
    const waiters = this.waiters;
    this.waiters = [];
    waiters.forEach(w => w());

    return { bytesWritten: length };
  }

  async close(): Promise<void> {
    this.closed = true;
    const waiters = this.waiters;
    this.waiters = [];
    waiters.forEach(w => w());
  }

  async stat(): Promise<WeshStat> {
    return {
      size: this.buffer.reduce((acc, b) => acc + b.length, 0),
      mode: 0o600,
      type: 'fifo',
      mtime: Date.now(),
      ino: 0,
      uid: 0,
      gid: 0
    };
  }

  async truncate(): Promise<void> {}
  async ioctl(): Promise<{ ret: number }> {
    return { ret: 0 };
  }
}

// Special Device Handles (Memory-based)
class DevNullHandle implements WeshFileHandle {
  async read(): Promise<WeshIOResult> {
    return { bytesRead: 0 };
  }
  async write(options: { length?: number; buffer: Uint8Array; offset?: number }): Promise<WeshWriteResult> {
    const len = options.length ?? (options.buffer.length - (options.offset ?? 0));
    return { bytesWritten: len };
  }
  async close() {}
  async stat(): Promise<WeshStat> {
    return { size: 0, mode: 0o666, type: 'chardev', mtime: 0, ino: 0, uid: 0, gid: 0 };
  }
  async truncate() {}
  async ioctl() {
    return { ret: 0 };
  }
}

class DevZeroHandle implements WeshFileHandle {
  async read(options: { buffer: Uint8Array; offset?: number; length?: number }): Promise<WeshIOResult> {
    const offset = options.offset ?? 0;
    const length = options.length ?? (options.buffer.length - offset);
    options.buffer.fill(0, offset, offset + length);
    return { bytesRead: length };
  }
  async write(options: { length?: number; buffer: Uint8Array; offset?: number }): Promise<WeshWriteResult> {
    const len = options.length ?? (options.buffer.length - (options.offset ?? 0));
    return { bytesWritten: len };
  }
  async close() {}
  async stat(): Promise<WeshStat> {
    return { size: 0, mode: 0o666, type: 'chardev', mtime: 0, ino: 0, uid: 0, gid: 0 };
  }
  async truncate() {}
  async ioctl() {
    return { ret: 0 };
  }
}

interface MountEntry {
  path: string;
  handle: FileSystemDirectoryHandle;
  readOnly: boolean;
  registry?: WeshRegistry; // Cache
}

export class WeshVFS implements WeshIVirtualFileSystem {
  private mounts: MountEntry[] = [];
  private specialFiles: Map<string, () => WeshFileHandle> = new Map();
  private openFifos: Map<string, FifoHandle> = new Map(); // Shared state for named pipes

  constructor({ rootHandle }: { rootHandle: FileSystemDirectoryHandle }) {
    this.mount({ path: '/', handle: rootHandle, readOnly: false });

    this.registerSpecialFile({ path: '/dev/null', handler: () => new DevNullHandle() });
    this.registerSpecialFile({ path: '/dev/zero', handler: () => new DevZeroHandle() });
  }

  async mount({ path, handle, readOnly }: { path: string; handle: FileSystemDirectoryHandle; readOnly?: boolean }): Promise<void> {
    const normalizedPath = this.normalizePath({ path });
    // Remove existing if any (simplification)
    this.mounts = this.mounts.filter((m) => m.path !== normalizedPath);

    // Load registry if exists
    let registry: WeshRegistry | undefined;
    try {
      const regFile = await handle.getFileHandle(REGISTRY_FILE);
      const file = await regFile.getFile();
      const text = await file.text();
      registry = JSON.parse(text);
    } catch {
      // Registry doesn't exist or invalid
    }

    this.mounts.push({ path: normalizedPath, handle, readOnly: !!readOnly, registry });
    this.mounts.sort((a, b) => b.path.length - a.path.length);
  }

  async unmount({ path }: { path: string }): Promise<void> {
    const normalizedPath = this.normalizePath({ path });
    if (normalizedPath === '/') throw new Error('Cannot unmount root');
    this.mounts = this.mounts.filter((m) => m.path !== normalizedPath);
  }

  private registerSpecialFile({ path, handler }: { path: string; handler: () => WeshFileHandle }): void {
    this.specialFiles.set(this.normalizePath({ path }), handler);
  }

  async open(options: { path: string; flags: number; mode?: number }): Promise<WeshFileHandle> {
    const normalized = this.normalizePath({ path: options.path });

    if (this.specialFiles.has(normalized)) {
      return this.specialFiles.get(normalized)!();
    }

    // Check if it's a known FIFO
    const mount = this.findMount({ path: normalized });
    if (mount) {
      const relPath = this.getRelativePath({ path: normalized, mount });
      const regEntry = mount.registry?.[relPath];

      if (regEntry?.type === 'fifo') {
        if (!this.openFifos.has(normalized)) {
          this.openFifos.set(normalized, new FifoHandle());
        }
        return this.openFifos.get(normalized)!;
      }
    }

    // Regular file open
    // 'w' implies truncate, 'a' implies append (handled by VFS/StandardHandle logic)
    // Flags mapping:
    // This is simplified. 'flags' arg in interface is number, but we need to parse it?
    // For now, I'll rely on a simpler 'mode' string equivalent logic if I were using strings.
    // Wait, interface says `flags: number`. I should use constants like O_RDONLY?
    // Since I haven't exported constants, I'll assume standard behavior or add a helper.
    // Actually, let's assume `flags` is unused for now and rely on intention,
    // or better: I need to know if it's creation or not.

    // Let's assume the caller uses O_CREAT (decimal 64) if they want to create.
    const O_CREAT = 64;
    const O_TRUNC = 512;
    // const O_APPEND = 1024;

    const create = (options.flags & O_CREAT) !== 0;
    const truncate = (options.flags & O_TRUNC) !== 0;

    let handleRes: { handle: FileSystemHandle; readOnly: boolean; fullPath: string };

    try {
      handleRes = await this.resolve({ path: normalized });
    } catch (e) {
      if (create) {
        // Create file
        const parts = normalized.split('/');
        const name = parts.pop()!;
        const parentPath = parts.join('/') || '/';
        const parent = await this.resolve({ path: parentPath });
        if (parent.readOnly) throw new Error(`Read-only file system: ${parentPath}`);

        const newHandle = await (parent.handle as FileSystemDirectoryHandle).getFileHandle(name, { create: true });
        handleRes = { handle: newHandle, readOnly: false, fullPath: normalized };
      } else {
        throw e;
      }
    }

    if (handleRes.handle.kind !== 'file') throw new Error(`Not a file: ${normalized}`);
    if (create && handleRes.readOnly) throw new Error(`Read-only file system: ${normalized}`);

    const fileHandle = new StandardFileHandle({
      handle: handleRes.handle as FileSystemFileHandle,
      readOnly: handleRes.readOnly
    });

    if (truncate) {
      await fileHandle.truncate({ size: 0 });
    }

    return fileHandle;
  }

  async stat(options: { path: string }): Promise<WeshStat> {
    const normalized = this.normalizePath({ path: options.path });

    if (this.specialFiles.has(normalized)) {
      const h = this.specialFiles.get(normalized)!();
      const s = await h.stat();
      await h.close();
      return s;
    }

    const { handle, readOnly } = await this.resolve({ path: normalized });

    // Check registry for special type overrides
    const mount = this.findMount({ path: normalized });
    if (mount) {
      const relPath = this.getRelativePath({ path: normalized, mount });
      const regEntry = mount.registry?.[relPath];
      if (regEntry) {
        // It's a special file (e.g. FIFO), but represented by a file on disk (0 byte placeholder)
        // We return the special type.
        // Real size is 0 (placeholder), but for FIFO we might want to show buffer size if opened?
        // For stat, we just return type.
        return {
          size: 0,
          mode: regEntry.mode,
          type: regEntry.type,
          mtime: Date.now(), // approximation
          ino: 0, uid: 0, gid: 0
        };
      }
    }

    if (handle.kind === 'file') {
      const file = await (handle as FileSystemFileHandle).getFile();
      return {
        size: file.size,
        mode: readOnly ? 0o444 : 0o644,
        type: 'file',
        mtime: file.lastModified,
        ino: 0, uid: 0, gid: 0
      };
    } else {
      return {
        size: 0,
        mode: readOnly ? 0o555 : 0o755,
        type: 'directory',
        mtime: Date.now(),
        ino: 0, uid: 0, gid: 0
      };
    }
  }

  async readDir(options: { path: string }): Promise<Array<{ name: string; type: WeshFileType }>> {
    const normalized = this.normalizePath({ path: options.path });

    if (normalized === '/dev') {
      return Array.from(this.specialFiles.keys())
        .filter(k => k.startsWith('/dev/'))
        .map(k => ({ name: k.split('/').pop()!, type: 'chardev' }));
    }

    const { handle } = await this.resolve({ path: normalized });
    if (handle.kind !== 'directory') throw new Error(`Not a directory: ${normalized}`);

    const dirHandle = handle as FileSystemDirectoryHandle;
    const entries: Array<{ name: string; type: WeshFileType }> = [];

    const mount = this.findMount({ path: normalized });
    const registry = mount?.registry || {};

    for await (const [name, entry] of dirHandle.entries()) {
      if (name === REGISTRY_FILE) continue; // Hide registry file

      let type: WeshFileType = entry.kind === 'directory' ? 'directory' : 'file';

      // Check registry
      const entryPath = normalized === '/' ? name : `${normalized}/${name}`; // This is absolute path
      // Registry stores relative paths to mount?
      // Yes.
      if (mount) {
        const relPath = this.getRelativePath({ path: normalized === '/' ? `/${name}` : `${normalized}/${name}`, mount });
        if (registry[relPath]) {
          type = registry[relPath].type;
        }
      }

      entries.push({ name, type });
    }
    return entries;
  }

  async mkdir(options: { path: string; mode?: number; recursive?: boolean }): Promise<void> {
    // Implementation similar to previous, using resolve loop
    const normalized = this.normalizePath({ path: options.path });
    const parts = normalized.split('/').filter(p => p);

    let currentPath = '';
    for (let i = 0; i < parts.length; i++) {
      const nextPart = parts[i];
      const checkPath = currentPath + '/' + nextPart;

      try {
        const res = await this.resolve({ path: checkPath });
        if (res.handle.kind === 'file') throw new Error(`File exists: ${checkPath}`);
      } catch {
        if (!options.recursive && i < parts.length - 1) throw new Error(`No such file or directory: ${currentPath}`);

        // Create directory
        const parent = await this.resolve({ path: currentPath || '/' });
        if (parent.readOnly) throw new Error(`Read-only fs: ${currentPath || '/'}`);
        await (parent.handle as FileSystemDirectoryHandle).getDirectoryHandle(nextPart, { create: true });
      }
      currentPath = checkPath;
    }
  }

  async unlink(options: { path: string }): Promise<void> {
    const normalized = this.normalizePath({ path: options.path });
    // Remove from registry if present
    const mount = this.findMount({ path: normalized });
    if (mount && mount.registry) {
      const relPath = this.getRelativePath({ path: normalized, mount });
      if (mount.registry[relPath]) {
        delete mount.registry[relPath];
        await this.saveRegistry(mount);
      }
    }

    // Remove actual file
    const parts = normalized.split('/');
    const name = parts.pop()!;
    const parentPath = parts.join('/') || '/';
    const parent = await this.resolve({ path: parentPath });
    await (parent.handle as FileSystemDirectoryHandle).removeEntry(name);
  }

  async rmdir(options: { path: string }): Promise<void> {
    // Same as unlink but check for directory
    await this.unlink(options);
  }

  async mknod(options: { path: string; type: WeshFileType; mode?: number }): Promise<void> {
    const normalized = this.normalizePath({ path: options.path });
    const mount = this.findMount({ path: normalized });
    if (!mount) throw new Error(`No mount point for ${normalized}`);

    if (mount.readOnly) throw new Error(`Read-only filesystem`);

    const relPath = this.getRelativePath({ path: normalized, mount });

    // Update registry
    mount.registry = mount.registry || {};
    mount.registry[relPath] = {
      type: options.type,
      mode: options.mode ?? 0o644
    };
    await this.saveRegistry(mount);

    // Create 0-byte placeholder
    const parts = normalized.split('/');
    const name = parts.pop()!;
    const parentPath = parts.join('/') || '/';
    const parent = await this.resolve({ path: parentPath });

    // Create empty file
    const handle = await (parent.handle as FileSystemDirectoryHandle).getFileHandle(name, { create: true });
    // Truncate to ensure empty? Default is empty on create.
  }

  async rename(options: { oldPath: string; newPath: string }): Promise<void> {
    // Not supported by File System Access API directly (requires move)
    // For now throw
    throw new Error('Rename not implemented');
  }

  // --- Helpers ---

  private async saveRegistry(mount: MountEntry) {
    if (!mount.registry) return;
    if (mount.readOnly) return;

    const fileHandle = await mount.handle.getFileHandle(REGISTRY_FILE, { create: true });
    const writable = await fileHandle.createWritable();
    await writable.write(JSON.stringify(mount.registry, null, 2));
    await writable.close();
  }

  private normalizePath({ path }: { path: string }): string {
    if (!path.startsWith('/')) path = '/' + path;
    const parts = path.split('/').filter((p) => p !== '' && p !== '.');
    const stack: string[] = [];
    for (const part of parts) {
      if (part === '..') stack.pop();
      else stack.push(part);
    }
    return '/' + stack.join('/');
  }

  private findMount({ path }: { path: string }): MountEntry | undefined {
    return this.mounts.find((m) => {
      if (path === m.path) return true;
      const prefix = m.path.endsWith('/') ? m.path : m.path + '/';
      return path.startsWith(prefix);
    });
  }

  private getRelativePath({ path, mount }: { path: string; mount: MountEntry }): string {
    if (path === mount.path) return '.';
    const prefix = mount.path.endsWith('/') ? mount.path : mount.path + '/';
    return path.substring(prefix.length);
  }

  private async resolve({ path }: { path: string }): Promise<{ handle: FileSystemHandle; readOnly: boolean; fullPath: string }> {
    const normalized = this.normalizePath({ path });
    const mount = this.findMount({ path: normalized });

    if (!mount) throw new Error(`Path not found: ${path}`);

    const relativePath = this.getRelativePath({ path: normalized, mount });

    if (relativePath === '.') {
      return { handle: mount.handle, readOnly: mount.readOnly, fullPath: normalized };
    }

    const parts = relativePath.split('/');
    let current: FileSystemDirectoryHandle = mount.handle;

    for (let i = 0; i < parts.length - 1; i++) {
      current = await current.getDirectoryHandle(parts[i]);
    }

    const lastPart = parts[parts.length - 1];
    try {
      const fileHandle = await current.getFileHandle(lastPart);
      return { handle: fileHandle, readOnly: mount.readOnly, fullPath: normalized };
    } catch {
      const dirHandle = await current.getDirectoryHandle(lastPart);
      return { handle: dirHandle, readOnly: mount.readOnly, fullPath: normalized };
    }
  }
}
