import type { WeshIVirtualFileSystem, WeshFileHandle } from './types';

interface MountEntry {
  path: string;
  handle: FileSystemDirectoryHandle;
  readOnly: boolean;
}

class StandardFileHandle implements WeshFileHandle {
  private handle: FileSystemFileHandle;
  private readOnly: boolean;

  constructor({ handle, readOnly }: { handle: FileSystemFileHandle; readOnly: boolean }) {
    this.handle = handle;
    this.readOnly = readOnly;
  }

  async read({ buffer, position = 0 }: { buffer: Uint8Array; position?: number }): Promise<{ bytesRead: number }> {
    const file = await this.handle.getFile();
    if (position >= file.size) return { bytesRead: 0 };

    const end = Math.min(position + buffer.length, file.size);
    const slice = file.slice(position, end);
    const arrayBuffer = await slice.arrayBuffer();
    const result = new Uint8Array(arrayBuffer);
    buffer.set(result);
    return { bytesRead: result.length };
  }

  async write({ buffer, position = 0 }: { buffer: Uint8Array; position?: number }): Promise<{ bytesWritten: number }> {
    if (this.readOnly) throw new Error('File is read-only');
    
    // In File System Access API, we must create a writer. 
    // keepExistingData: true is crucial for random access / appending.
    const writable = await this.handle.createWritable({ keepExistingData: true });
    try {
      await writable.seek(position);
      await writable.write(buffer);
    } finally {
      await writable.close();
    }
    return { bytesWritten: buffer.length };
  }

  async close(): Promise<void> {
    // No explicit close needed for handles, but good for cleanup hooks if needed later
  }

  async stat(): Promise<{ size: number; kind: 'file' | 'directory' }> {
    const file = await this.handle.getFile();
    return { size: file.size, kind: 'file' };
  }

  async truncate({ size }: { size: number }): Promise<void> {
    if (this.readOnly) throw new Error('File is read-only');
    const writable = await this.handle.createWritable({ keepExistingData: true });
    try {
      await writable.truncate(size);
    } finally {
      await writable.close();
    }
  }
}

class DevNullHandle implements WeshFileHandle {
  async read({ buffer }: { buffer: Uint8Array; position?: number }): Promise<{ bytesRead: number }> {
    return { bytesRead: 0 }; // EOF
  }
  async write({ buffer }: { buffer: Uint8Array; position?: number }): Promise<{ bytesWritten: number }> {
    return { bytesWritten: buffer.length }; // Discard
  }
  async close() {}
  async stat() { return { size: 0, kind: 'file' as const }; }
  async truncate() {}
}

class DevZeroHandle implements WeshFileHandle {
  async read({ buffer }: { buffer: Uint8Array; position?: number }): Promise<{ bytesRead: number }> {
    buffer.fill(0);
    return { bytesRead: buffer.length };
  }
  async write({ buffer }: { buffer: Uint8Array; position?: number }): Promise<{ bytesWritten: number }> {
    return { bytesWritten: buffer.length };
  }
  async close() {}
  async stat() { return { size: 0, kind: 'file' as const }; }
  async truncate() {}
}

class DevFullHandle implements WeshFileHandle {
  async read({ buffer }: { buffer: Uint8Array; position?: number }): Promise<{ bytesRead: number }> {
    buffer.fill(0);
    return { bytesRead: buffer.length };
  }
  async write(): Promise<{ bytesWritten: number }> {
    throw new Error('No space left on device');
  }
  async close() {}
  async stat() { return { size: 0, kind: 'file' as const }; }
  async truncate() {}
}

class DevRandomHandle implements WeshFileHandle {
  async read({ buffer }: { buffer: Uint8Array; position?: number }): Promise<{ bytesRead: number }> {
    crypto.getRandomValues(buffer);
    return { bytesRead: buffer.length };
  }
  async write({ buffer }: { buffer: Uint8Array; position?: number }): Promise<{ bytesWritten: number }> {
    return { bytesWritten: buffer.length };
  }
  async close() {}
  async stat() { return { size: 0, kind: 'file' as const }; }
  async truncate() {}
}

export class WeshVFS implements WeshIVirtualFileSystem {
  private mounts: MountEntry[] = [];
  private specialFiles: Map<string, () => WeshFileHandle> = new Map();

  constructor({ rootHandle }: { rootHandle: FileSystemDirectoryHandle }) {
    this.mount({ path: '/', handle: rootHandle, readOnly: false });
    this.registerSpecialFile({ path: '/dev/null', handler: () => new DevNullHandle() });
    this.registerSpecialFile({ path: '/dev/zero', handler: () => new DevZeroHandle() });
    this.registerSpecialFile({ path: '/dev/full', handler: () => new DevFullHandle() });
    this.registerSpecialFile({ path: '/dev/random', handler: () => new DevRandomHandle() });
    this.registerSpecialFile({ path: '/dev/urandom', handler: () => new DevRandomHandle() });
  }

  mount({ path, handle, readOnly }: { path: string; handle: FileSystemDirectoryHandle; readOnly: boolean }): void {
    const normalizedPath = this.normalizePath({ path });
    this.mounts = this.mounts.filter((m) => m.path !== normalizedPath);
    this.mounts.push({ path: normalizedPath, handle, readOnly });
    this.mounts.sort((a, b) => b.path.length - a.path.length);
  }

  unmount({ path }: { path: string }): void {
    const normalizedPath = this.normalizePath({ path });
    if (normalizedPath === '/') {
      throw new Error('Cannot unmount root');
    }
    this.mounts = this.mounts.filter((m) => m.path !== normalizedPath);
  }

  registerSpecialFile({ path, handler }: { path: string; handler: () => WeshFileHandle }): void {
    this.specialFiles.set(this.normalizePath({ path }), handler);
  }

  unregisterSpecialFile({ path }: { path: string }): void {
    this.specialFiles.delete(this.normalizePath({ path }));
  }

  async resolve({ path }: { path: string }): Promise<{ handle: FileSystemHandle; readOnly: boolean; fullPath: string }> {
    const normalized = this.normalizePath({ path });

    /** Special Files Interception */
    if (this.specialFiles.has(normalized)) {
       // Return a dummy handle for special files if needed by internal logic, 
       // but open() uses specialFiles map directly.
       return {
         handle: { name: normalized.split('/').pop()!, kind: 'file' } as FileSystemHandle,
         readOnly: false,
         fullPath: normalized
       };
    }

    const mount = this.mounts.find((m) => {
      if (normalized === m.path) return true;
      const prefix = m.path.endsWith('/') ? m.path : m.path + '/';
      return normalized.startsWith(prefix);
    });
    if (!mount) {
      throw new Error(`Path not found: ${path}`);
    }

    const relativePath = normalized === mount.path ? '' : normalized.slice(mount.path.length + (mount.path === '/' ? 0 : 1));
    if (relativePath === '') {
      return { handle: mount.handle, readOnly: mount.readOnly, fullPath: normalized };
    }

    const parts = relativePath.split('/');
    let current: FileSystemDirectoryHandle = mount.handle;

    for (let i = 0; i < parts.length - 1; i++) {
      current = await current.getDirectoryHandle(parts[i]!);
    }

    const lastPart = parts[parts.length - 1]!;
    try {
      const fileHandle = await current.getFileHandle(lastPart);
      return { handle: fileHandle, readOnly: mount.readOnly, fullPath: normalized };
    } catch {
      const dirHandle = await current.getDirectoryHandle(lastPart);
      return { handle: dirHandle, readOnly: mount.readOnly, fullPath: normalized };
    }
  }

  async readDir({ path }: { path: string }): Promise<Array<{ name: string; kind: 'file' | 'directory' }>> {
    const normalized = this.normalizePath({ path });
    if (normalized === '/dev') {
      return Array.from(this.specialFiles.keys())
        .filter(k => k.startsWith('/dev/'))
        .map(k => ({ name: k.split('/').pop()!, kind: 'file' }));
    }

    const { handle } = await this.resolve({ path });
    switch (handle.kind) {
    case 'directory':
      break;
    case 'file':
      throw new Error(`Not a directory: ${path}`);
    default: {
      const _ex: never = handle.kind;
      throw new Error(`Unexpected handle kind: ${_ex}`);
    }
    }

    const dirHandle = handle as FileSystemDirectoryHandle;
    const entries: Array<{ name: string; kind: 'file' | 'directory' }> = [];
    for await (const [name, entry] of dirHandle.entries()) {
      entries.push({ name, kind: entry.kind });
    }
    return entries;
  }

  async open({ path, mode }: { path: string; mode: 'r' | 'w' | 'rw' | 'a' }): Promise<WeshFileHandle> {
    const normalized = this.normalizePath({ path });

    if (this.specialFiles.has(normalized)) {
      return this.specialFiles.get(normalized)!();
    }

    const create = mode !== 'r';

    let handleRes: { handle: FileSystemHandle; readOnly: boolean; fullPath: string };
    try {
      handleRes = await this.resolve({ path });
    } catch (e) {
      if (create) {
        const parts = normalized.split('/');
        const name = parts.pop()!;
        const parentPath = parts.join('/') || '/';
        const parent = await this.resolve({ path: parentPath });
        if (parent.readOnly) throw new Error(`Read-only file system: ${parentPath}`);
        const newFileHandle = await (parent.handle as FileSystemDirectoryHandle).getFileHandle(name, { create: true });
        handleRes = { handle: newFileHandle, readOnly: false, fullPath: normalized };
      } else {
        throw e;
      }
    }

    if (create && handleRes.readOnly) throw new Error(`Read-only file system: ${path}`);
    if (handleRes.handle.kind !== 'file') throw new Error(`Not a file: ${path}`);

    const fileHandle = new StandardFileHandle({ handle: handleRes.handle as FileSystemFileHandle, readOnly: handleRes.readOnly });
    
    if (mode === 'w') {
      await fileHandle.truncate({ size: 0 });
    }
    
    return fileHandle;
  }

  /** @deprecated use open() */
  async readFile({ path }: { path: string }): Promise<ReadableStream<Uint8Array>> {
    const handle = await this.open({ path, mode: 'r' });
    
    let position = 0;
    return new ReadableStream({
      async pull(controller) {
        const buffer = new Uint8Array(64 * 1024); // 64KB chunks
        try {
          const { bytesRead } = await handle.read({ buffer, position });
          if (bytesRead === 0) {
            await handle.close();
            controller.close();
          } else {
            position += bytesRead;
            controller.enqueue(new Uint8Array(buffer.subarray(0, bytesRead)));
          }
        } catch (e) {
          await handle.close();
          controller.error(e);
        }
      },
      async cancel() {
        await handle.close();
      }
    });
  }

  /** @deprecated use open() */
  async writeFile({ path, stream }: { path: string; stream: ReadableStream<Uint8Array> }): Promise<void> {
    const handle = await this.open({ path, mode: 'w' });
    const reader = stream.getReader();
    let position = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        const { bytesWritten } = await handle.write({ buffer: value, position });
        position += bytesWritten;
      }
    } finally {
      await handle.close();
      reader.releaseLock();
    }
  }

  async stat({ path }: { path: string }): Promise<{ size: number; kind: 'file' | 'directory'; readOnly: boolean }> {
    const normalized = this.normalizePath({ path });
    if (this.specialFiles.has(normalized)) {
       const h = this.specialFiles.get(normalized)!();
       const s = await h.stat();
       await h.close();
       return { ...s, readOnly: false };
    }

    const { handle, readOnly } = await this.resolve({ path });
    switch (handle.kind) {
    case 'file': {
      const file = await (handle as FileSystemFileHandle).getFile();
      return { size: file.size, kind: 'file', readOnly };
    }
    case 'directory':
      return { size: 0, kind: 'directory', readOnly };
    default: {
      const _ex: never = handle.kind;
      throw new Error(`Unexpected handle kind: ${_ex}`);
    }
    }
  }

  async mkdir({ path, recursive }: { path: string; recursive: boolean }): Promise<void> {
    const parts = this.normalizePath({ path }).split('/');
    if (parts[0] === '') parts.shift();

    let currentPath = '';
    for (let i = 0; i < parts.length; i++) {
      const nextPart = parts[i]!;
      const checkPath = currentPath + '/' + nextPart;
      try {
        const res = await this.resolve({ path: checkPath });
        switch (res.handle.kind) {
        case 'directory':
          break;
        case 'file':
          throw new Error(`Path component is a file: ${checkPath}`);
        default: {
          const _ex: never = res.handle.kind;
          throw new Error(`Unexpected handle kind: ${_ex}`);
        }
        }
        currentPath = checkPath;
      } catch (e: unknown) {
        if (!recursive && i < parts.length - 1) throw e;
        const parent = await this.resolve({ path: currentPath || '/' });
        if (parent.readOnly) throw new Error(`Read-only file system: ${currentPath || '/'}`);
        await (parent.handle as FileSystemDirectoryHandle).getDirectoryHandle(nextPart, { create: true });
        currentPath = checkPath;
      }
    }
  }

  async rm({ path, recursive }: { path: string; recursive: boolean }): Promise<void> {
    const normalized = this.normalizePath({ path });
    if (normalized === '/') throw new Error('Cannot remove root');
    if (this.specialFiles.has(normalized)) throw new Error('Permission denied');

    const parts = normalized.split('/');
    const name = parts.pop()!;
    const parentPath = parts.join('/') || '/';

    const parent = await this.resolve({ path: parentPath });
    if (parent.readOnly) throw new Error(`Read-only file system: ${parentPath}`);
    await (parent.handle as FileSystemDirectoryHandle).removeEntry(name, { recursive });
  }

  async exists({ path }: { path: string }): Promise<boolean> {
    try {
      await this.resolve({ path });
      return true;
    } catch {
      return this.specialFiles.has(this.normalizePath({ path }));
    }
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
}
