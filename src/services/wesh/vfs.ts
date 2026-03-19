import type {
  WeshIVirtualFileSystem,
  WeshFileHandle,
  WeshFileType,
  WeshStat,
  WeshIOResult,
  WeshWriteResult,
  WeshOpenFlags
} from './types';
import {
  WeshRegistryEntrySchemaDto,
  type WeshRegistryEntryDto,
  WESH_SYSTEM_DIR,
  METADATA_DIR
} from './dto';

// --- Domain Models ---

interface RegistryEntry {
  type: 'fifo' | 'chardev' | 'symlink';
  mode: number;
  targetPath?: string;
  uid?: number;
  gid?: number;
  mtime?: number;
}

// --- Mappers ---

function mapDtoToDomain(dto: WeshRegistryEntryDto): RegistryEntry {
  switch (dto.type) {
  case 'symlink':
    return {
      type: 'symlink',
      mode: dto.mode,
      targetPath: dto.targetPath,
      uid: dto.uid,
      gid: dto.gid,
      mtime: dto.mtime,
    };
  case 'fifo':
    return {
      type: 'fifo',
      mode: dto.mode,
      uid: dto.uid,
      gid: dto.gid,
      mtime: dto.mtime,
    };
  case 'chardev':
    return {
      type: 'chardev',
      mode: dto.mode,
      uid: dto.uid,
      gid: dto.gid,
      mtime: dto.mtime,
    };
  default: {
    const _ex: never = dto;
    throw new Error(`Unhandled DTO: ${_ex}`);
  }
  }
}

function mapDomainToDto(entry: RegistryEntry): WeshRegistryEntryDto {
  switch (entry.type) {
  case 'symlink':
    return {
      type: 'symlink',
      mode: entry.mode,
      targetPath: entry.targetPath ?? '',
      uid: entry.uid,
      gid: entry.gid,
      mtime: entry.mtime,
    };
  case 'fifo':
    return {
      type: 'fifo',
      mode: entry.mode,
      uid: entry.uid,
      gid: entry.gid,
      mtime: entry.mtime,
    };
  case 'chardev':
    return {
      type: 'chardev',
      mode: entry.mode,
      uid: entry.uid,
      gid: entry.gid,
      mtime: entry.mtime,
    };
  default: {
    const _ex: never = entry.type;
    throw new Error(`Unknown entry type: ${_ex}`);
  }
  }
}

// --- File Handles ---

class StandardFileHandle implements WeshFileHandle {
  private handle: FileSystemFileHandle;
  private readOnly: boolean;
  private _cursor = 0;

  constructor({ handle, readOnly, append }: { handle: FileSystemFileHandle; readOnly: boolean; append: boolean }) {
    this.handle = handle;
    this.readOnly = readOnly;
    if (append) {
      this.initAppend();
    }
  }

  private async initAppend() {
    const file = await this.handle.getFile();
    this._cursor = file.size;
  }

  async read(options: {
    buffer: Uint8Array;
    offset?: number;
    length?: number;
    position?: number;
  }): Promise<WeshIOResult> {
    const file = await this.handle.getFile();
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

    const writable = await this.handle.createWritable({ keepExistingData: true });
    try {
      await writable.seek(pos);
      await writable.write(dataToWrite as BufferSource);
    } finally {
      await writable.close();
    }

    if (options.position === undefined) {
      this._cursor += length;
    }

    return { bytesWritten: length };
  }

  async close(): Promise<void> {}

  async stat(): Promise<WeshStat> {
    const file = await this.handle.getFile();
    return {
      size: file.size,
      mode: 0o644,
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
    return { ret: -1 };
  }
}

class FifoHandle implements WeshFileHandle {
  private buffer: Uint8Array[] = [];
  private waiters: Array<(val: void) => void> = [];
  private closed = false;

  async read(options: { buffer: Uint8Array; offset?: number; length?: number }): Promise<WeshIOResult> {
    if (this.buffer.length === 0 && this.closed) return { bytesRead: 0 };

    while (this.buffer.length === 0) {
      if (this.closed) return { bytesRead: 0 };
      await new Promise<void>(resolve => this.waiters.push(resolve));
    }

    const chunk = this.buffer.shift()!;
    const bufferOffset = options.offset ?? 0;
    const maxLen = options.length ?? (options.buffer.length - bufferOffset);
    const copyLen = Math.min(chunk.length, maxLen);

    options.buffer.set(chunk.subarray(0, copyLen), bufferOffset);

    if (chunk.length > copyLen) {
      this.buffer.unshift(chunk.subarray(copyLen));
    }

    return { bytesRead: copyLen };
  }

  async write(options: { buffer: Uint8Array; offset?: number; length?: number }): Promise<WeshWriteResult> {
    if (this.closed) throw new Error('Broken pipe');

    const bufferOffset = options.offset ?? 0;
    const length = options.length ?? (options.buffer.length - bufferOffset);
    const data = new Uint8Array(options.buffer.subarray(bufferOffset, bufferOffset + length));

    this.buffer.push(data);

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

// --- VFS Implementation ---

interface MountEntry {
  path: string;
  handle: FileSystemDirectoryHandle;
  readOnly: boolean;
  registryCache: Map<string, RegistryEntry>;
}

export class WeshVFS implements WeshIVirtualFileSystem {
  private mounts: MountEntry[] = [];
  private specialFiles: Map<string, () => WeshFileHandle> = new Map();
  private openFifos: Map<string, FifoHandle> = new Map();

  constructor({ rootHandle }: { rootHandle: FileSystemDirectoryHandle }) {
    this.mount({ path: '/', handle: rootHandle, readOnly: false });

    this.registerSpecialFile({ path: '/dev/null', handler: () => new DevNullHandle() });
    this.registerSpecialFile({ path: '/dev/zero', handler: () => new DevZeroHandle() });
  }

  async mount({ path, handle, readOnly }: { path: string; handle: FileSystemDirectoryHandle; readOnly?: boolean }): Promise<void> {
    const normalizedPath = this.normalizePath({ path });
    this.mounts = this.mounts.filter((m) => m.path !== normalizedPath);

    const registryCache = new Map<string, RegistryEntry>();
    try {
      const systemDir = await handle.getDirectoryHandle(WESH_SYSTEM_DIR);
      const metaDir = await systemDir.getDirectoryHandle(METADATA_DIR);
      await this.scanRegistryRecursive(metaDir, '', registryCache);
    } catch {
      // No metadata dir
    }

    this.mounts.push({ path: normalizedPath, handle, readOnly: !!readOnly, registryCache });
    this.mounts.sort((a, b) => b.path.length - a.path.length);
  }

  private async scanRegistryRecursive(
    dirHandle: FileSystemDirectoryHandle,
    relPath: string,
    cache: Map<string, RegistryEntry>
  ) {
    for await (const [name, handle] of dirHandle.entries()) {
      const itemPath = relPath ? `${relPath}/${name}` : name;
      switch (handle.kind) {
      case 'file': {
        const file = await (handle as FileSystemFileHandle).getFile();
        try {
          const text = await file.text();
          const json = JSON.parse(text);
          const dto = WeshRegistryEntrySchemaDto.parse(json);
          cache.set(itemPath, mapDtoToDomain(dto));
        } catch (e) {
          console.warn(`Failed to parse registry entry ${itemPath}:`, e);
        }
        break;
      }
      case 'directory':
        await this.scanRegistryRecursive(handle as FileSystemDirectoryHandle, itemPath, cache);
        break;
      default: {
        const _ex: never = handle.kind;
        throw new Error(`Unhandled case: ${_ex}`);
      }
      }
    }
  }

  async unmount({ path }: { path: string }): Promise<void> {
    const normalizedPath = this.normalizePath({ path });
    if (normalizedPath === '/') throw new Error('Cannot unmount root');
    this.mounts = this.mounts.filter((m) => m.path !== normalizedPath);
  }

  registerSpecialFile({ path, handler }: { path: string; handler: () => WeshFileHandle }): void {
    this.specialFiles.set(this.normalizePath({ path }), handler);
  }

  unregisterSpecialFile({ path }: { path: string }): void {
    this.specialFiles.delete(this.normalizePath({ path }));
  }

  async open(options: { path: string; flags: WeshOpenFlags; mode?: number }): Promise<WeshFileHandle> {
    const normalized = this.normalizePath({ path: options.path });

    if (this.specialFiles.has(normalized)) {
      return this.specialFiles.get(normalized)!();
    }

    const mount = this.findMount({ path: normalized });
    if (mount) {
      const relPath = this.getRelativePath({ path: normalized, mount });
      const regEntry = mount.registryCache.get(relPath);

      if (regEntry) {
        switch (regEntry.type) {
        case 'fifo':
          if (!this.openFifos.has(normalized)) {
            this.openFifos.set(normalized, new FifoHandle());
          }
          return this.openFifos.get(normalized)!;
        case 'chardev':
        case 'symlink':
          throw new Error(`Open not implemented for ${regEntry.type}`);
        default: {
          const _ex: never = regEntry.type;
          throw new Error(`Unhandled registry entry type: ${_ex}`);
        }
        }
      }
    }

    const create = options.flags.creation !== 'never';
    const truncate = options.flags.truncate === 'truncate';

    let handleRes: { handle: FileSystemHandle; readOnly: boolean; fullPath: string };

    try {
      handleRes = await this._resolve({ path: normalized });
      switch (options.flags.creation) {
      case 'always':
        throw new Error(`File exists: ${normalized}`);
      case 'never':
      case 'if-needed':
        break;
      default: {
        const _ex: never = options.flags.creation;
        throw new Error(`Unhandled creation flag: ${_ex}`);
      }
      }
    } catch (e) {
      if (create) {
        const parts = normalized.split('/');
        const name = parts.pop();
        if (name === undefined) throw new Error(`Invalid path: ${normalized}`);
        const parentPath = parts.join('/') || '/';
        const parent = await this._resolve({ path: parentPath });
        if (parent.readOnly) throw new Error(`Read-only file system: ${parentPath}`);

        const newHandle = await (parent.handle as FileSystemDirectoryHandle).getFileHandle(name, { create: true });
        handleRes = { handle: newHandle, readOnly: false, fullPath: normalized };
      } else {
        throw e;
      }
    }

    switch (handleRes.handle.kind) {
    case 'file':
      break;
    case 'directory':
      throw new Error(`Not a file: ${normalized}`);
    default: {
      const _ex: never = handleRes.handle.kind;
      throw new Error(`Unhandled handle kind: ${_ex}`);
    }
    }

    const fileHandle = new StandardFileHandle({
      handle: handleRes.handle as FileSystemFileHandle,
      readOnly: handleRes.readOnly || options.flags.access === 'read',
      append: options.flags.append === 'append'
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

    let resolved: { handle: FileSystemHandle; readOnly: boolean; fullPath: string } | undefined;
    try {
      resolved = await this._resolve({ path: normalized });
    } catch (error) {
      if (this.getDirectMountChildren({ path: normalized }).length > 0) {
        return {
          size: 0,
          mode: 0o755,
          type: 'directory',
          mtime: Date.now(),
          ino: 0,
          uid: 0,
          gid: 0,
        };
      }
      throw error;
    }

    const { handle, readOnly } = resolved;

    const mount = this.findMount({ path: normalized });
    if (mount) {
      const relPath = this.getRelativePath({ path: normalized, mount });
      const regEntry = mount.registryCache.get(relPath);
      if (regEntry) {
        return {
          size: 0,
          mode: regEntry.mode,
          type: regEntry.type,
          mtime: Date.now(),
          ino: 0, uid: 0, gid: 0
        };
      }
    }

    switch (handle.kind) {
    case 'file': {
      const file = await (handle as FileSystemFileHandle).getFile();
      return {
        size: file.size,
        mode: readOnly ? 0o444 : 0o644,
        type: 'file',
        mtime: file.lastModified,
        ino: 0, uid: 0, gid: 0
      };
    }
    case 'directory':
      return {
        size: 0,
        mode: readOnly ? 0o555 : 0o755,
        type: 'directory',
        mtime: Date.now(),
        ino: 0, uid: 0, gid: 0
      };
    default: {
      const _ex: never = handle.kind;
      throw new Error(`Unhandled handle kind: ${_ex}`);
    }
    }
  }

  async resolve(options: { path: string }): Promise<{ fullPath: string; stat: WeshStat }> {
    const normalized = this.normalizePath({ path: options.path });
    const s = await this.stat({ path: normalized });
    return { fullPath: normalized, stat: s };
  }

  async readDir(options: { path: string }): Promise<Array<{ name: string; type: WeshFileType }>> {
    const normalized = this.normalizePath({ path: options.path });

    if (normalized === '/dev') {
      return Array.from(this.specialFiles.keys())
        .filter(k => k.startsWith('/dev/'))
        .map(k => ({ name: k.split('/').pop()!, type: 'chardev' }));
    }

    const entries = new Map<string, WeshFileType>();

    try {
      const { handle } = await this._resolve({ path: normalized });
      switch (handle.kind) {
      case 'directory':
        break;
      case 'file':
        throw new Error(`Not a directory: ${normalized}`);
      default: {
        const _ex: never = handle.kind;
        throw new Error(`Unhandled case: ${_ex}`);
      }
      }

      const dirHandle = handle as FileSystemDirectoryHandle;
      const mount = this.findMount({ path: normalized });

      for await (const [name, entry] of dirHandle.entries()) {
        if (name === WESH_SYSTEM_DIR) continue;

        let type: WeshFileType;
        switch (entry.kind) {
        case 'directory':
          type = 'directory';
          break;
        case 'file':
          type = 'file';
          break;
        default: {
          const _ex: never = entry.kind;
          throw new Error(`Unhandled file kind: ${_ex}`);
        }
        }

        if (mount) {
          const relPath = this.getRelativePath({ path: normalized === '/' ? `/${name}` : `${normalized}/${name}`, mount });
          const regEntry = mount.registryCache.get(relPath);
          if (regEntry) {
            type = regEntry.type;
          }
        }
        entries.set(name, type);
      }
    } catch (error) {
      if (this.getDirectMountChildren({ path: normalized }).length === 0) {
        throw error;
      }
    }

    for (const name of this.getDirectMountChildren({ path: normalized })) {
      if (!entries.has(name)) {
        entries.set(name, 'directory');
      }
    }

    return Array.from(entries.entries()).map(([name, type]) => ({ name, type }));
  }

  async mkdir(options: { path: string; mode?: number; recursive?: boolean }): Promise<void> {
    const normalized = this.normalizePath({ path: options.path });
    const parts = normalized.split('/').filter(p => p);

    let currentPath = '';
    for (let i = 0; i < parts.length; i++) {
      const nextPart = parts[i];
      if (nextPart === undefined) continue;
      const checkPath = currentPath + '/' + nextPart;
      try {
        const res = await this._resolve({ path: checkPath });
        switch (res.handle.kind) {
        case 'file':
          throw new Error(`File exists: ${checkPath}`);
        case 'directory':
          break;
        default: {
          const _ex: never = res.handle.kind;
          throw new Error(`Unhandled handle kind: ${_ex}`);
        }
        }
      } catch {
        if (!options.recursive && i < parts.length - 1) throw new Error(`No such file or directory: ${currentPath}`);
        const parent = await this._resolve({ path: currentPath || '/' });
        if (parent.readOnly) throw new Error(`Read-only fs: ${currentPath || '/'}`);
        await (parent.handle as FileSystemDirectoryHandle).getDirectoryHandle(nextPart, { create: true });
      }
      currentPath = checkPath;
    }
  }

  async unlink(options: { path: string }): Promise<void> {
    const normalized = this.normalizePath({ path: options.path });
    const mount = this.findMount({ path: normalized });
    if (mount) {
      const relPath = this.getRelativePath({ path: normalized, mount });
      if (mount.registryCache.has(relPath)) {
        mount.registryCache.delete(relPath);
        await this.deleteRegistryEntry(mount, relPath);
      }
    }
    const parts = normalized.split('/');
    const name = parts.pop();
    if (name === undefined) throw new Error(`Invalid path: ${normalized}`);
    const parentPath = parts.join('/') || '/';
    const parent = await this._resolve({ path: parentPath });

    switch (parent.handle.kind) {
    case 'directory':
      await (parent.handle as FileSystemDirectoryHandle).removeEntry(name);
      break;
    case 'file':
      throw new Error(`Not a directory: ${parentPath}`);
    default: {
      const _ex: never = parent.handle.kind;
      throw new Error(`Unhandled handle kind: ${_ex}`);
    }
    }
  }
  async rmdir(options: { path: string }): Promise<void> {
    await this.unlink(options);
  }

  async mknod(options: { path: string; type: WeshFileType; mode?: number }): Promise<void> {
    const normalized = this.normalizePath({ path: options.path });
    const mount = this.findMount({ path: normalized });
    if (!mount) throw new Error(`No mount point for ${normalized}`);
    if (mount.readOnly) throw new Error(`Read-only filesystem`);

    const relPath = this.getRelativePath({ path: normalized, mount });
    const parts = normalized.split('/');
    const name = parts.pop()!;
    const parentPath = parts.join('/') || '/';
    const parent = await this._resolve({ path: parentPath });
    await (parent.handle as FileSystemDirectoryHandle).getFileHandle(name, { create: true });

    let entry: RegistryEntry;
    switch (options.type) {
    case 'fifo':
    case 'chardev':
      entry = { type: options.type, mode: options.mode ?? 0o644 };
      break;
    case 'symlink':
      throw new Error("Use ln -s for symlinks");
    case 'file':
    case 'directory':
      return;
    default: {
      const _ex: never = options.type;
      throw new Error(`Unhandled option type: ${_ex}`);
    }
    }

    mount.registryCache.set(relPath, entry);
    await this.saveRegistryEntry(mount, relPath, entry);
  }

  async rename(options: { oldPath: string; newPath: string }): Promise<void> {
    const oldNormalized = this.normalizePath({ path: options.oldPath });
    const newNormalized = this.normalizePath({ path: options.newPath });

    const oldRes = await this._resolve({ path: oldNormalized });
    if (oldRes.readOnly) throw new Error(`Read-only source: ${oldNormalized}`);

    const newParts = newNormalized.split('/');
    const newName = newParts.pop();
    if (newName === undefined) throw new Error(`Invalid path: ${newNormalized}`);
    const newParentPath = newParts.join('/') || '/';
    const newParentRes = await this._resolve({ path: newParentPath });
    if (newParentRes.readOnly) throw new Error(`Read-only destination: ${newParentPath}`);

    switch (oldRes.handle.kind) {
    case 'file': {
      const oldFileHandle = oldRes.handle as FileSystemFileHandle;
      const newParentDir = newParentRes.handle as FileSystemDirectoryHandle;

      // @ts-expect-error - move() is relatively new
      if (typeof oldFileHandle.move === 'function') {
        // @ts-expect-error - move() is relatively new
        await oldFileHandle.move(newParentDir, newName);
      } else {
        const newFileHandle = await newParentDir.getFileHandle(newName, { create: true });
        const writable = await newFileHandle.createWritable();
        const file = await oldFileHandle.getFile();
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        await writable.write(file as any);
        await writable.close();

        const oldParts = oldNormalized.split('/');
        const oldName = oldParts.pop();
        if (oldName === undefined) throw new Error(`Invalid path: ${oldNormalized}`);
        const oldParentPath = oldParts.join('/') || '/';
        const oldParentRes = await this._resolve({ path: oldParentPath });
        await (oldParentRes.handle as FileSystemDirectoryHandle).removeEntry(oldName);
      }
      break;
    }
    case 'directory':
      throw new Error('Directory rename not yet implemented');
    default: {
      const _ex: never = oldRes.handle.kind;
      throw new Error(`Unhandled kind: ${_ex}`);
    }
    }
  }

  // --- Registry Persistence Helpers ---

  private async saveRegistryEntry(mount: MountEntry, relPath: string, entry: RegistryEntry) {
    if (mount.readOnly) return;

    const systemDir = await mount.handle.getDirectoryHandle(WESH_SYSTEM_DIR, { create: true });
    const metaDir = await systemDir.getDirectoryHandle(METADATA_DIR, { create: true });

    const parts = relPath.split('/');
    const fileName = parts.pop();
    if (fileName === undefined) throw new Error(`Invalid relPath: ${relPath}`);
    let currentDir = metaDir;
    for (const part of parts) {
      currentDir = await currentDir.getDirectoryHandle(part, { create: true });
    }
    const fileHandle = await currentDir.getFileHandle(fileName, { create: true });
    const writable = await fileHandle.createWritable();
    const dto = mapDomainToDto(entry);
    await writable.write(JSON.stringify(dto));
    await writable.close();
  }

  private async deleteRegistryEntry(mount: MountEntry, relPath: string) {
    if (mount.readOnly) return;
    try {
      const systemDir = await mount.handle.getDirectoryHandle(WESH_SYSTEM_DIR);
      const metaDir = await systemDir.getDirectoryHandle(METADATA_DIR);
      const parts = relPath.split('/');
      const fileName = parts.pop();
      if (fileName === undefined) throw new Error(`Invalid relPath: ${relPath}`);
      let currentDir = metaDir;
      for (const part of parts) {
        currentDir = await currentDir.getDirectoryHandle(part);
      }
      await currentDir.removeEntry(fileName);
    } catch (e: unknown) {
      console.warn('Failed to delete registry entry:', e);
    }
  }

  // --- Path Helpers ---

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

  private getDirectMountChildren({ path }: { path: string }): string[] {
    const normalized = this.normalizePath({ path });
    const childNames = new Set<string>();

    for (const mount of this.mounts) {
      if (mount.path === normalized) {
        continue;
      }

      const prefix = normalized === '/' ? '/' : `${normalized}/`;
      if (!mount.path.startsWith(prefix)) {
        continue;
      }

      const remainder = mount.path.slice(prefix.length);
      if (remainder.length === 0) {
        continue;
      }

      const childName = remainder.split('/')[0];
      if (childName !== undefined && childName.length > 0) {
        childNames.add(childName);
      }
    }

    return Array.from(childNames).sort();
  }

  private async _resolve({ path }: { path: string }): Promise<{ handle: FileSystemHandle; readOnly: boolean; fullPath: string }> {
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
      const part = parts[i];
      if (part === undefined) continue;
      current = await current.getDirectoryHandle(part);
    }
    const lastPart = parts[parts.length - 1];
    if (lastPart === undefined) return { handle: current, readOnly: mount.readOnly, fullPath: normalized };
    try {
      const fileHandle = await current.getFileHandle(lastPart);
      return { handle: fileHandle, readOnly: mount.readOnly, fullPath: normalized };
    } catch {
      const dirHandle = await current.getDirectoryHandle(lastPart);
      switch (dirHandle.kind) {
      case 'directory':
        return { handle: dirHandle, readOnly: mount.readOnly, fullPath: normalized };
      default: {
        const _ex: never = dirHandle.kind;
        throw new Error(`Unhandled handle kind: ${_ex}`);
      }
      }
    }
  }
}
