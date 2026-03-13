import type { IVirtualFileSystem } from './types';

interface MountEntry {
  path: string;
  handle: FileSystemDirectoryHandle;
  readOnly: boolean;
}

export class VFS implements IVirtualFileSystem {
  private mounts: MountEntry[] = [];

  constructor({ rootHandle }: { rootHandle: FileSystemDirectoryHandle }) {
    this.mount({ path: '/', handle: rootHandle, readOnly: false });
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

  async resolve({ path }: { path: string }): Promise<{ handle: FileSystemHandle; readOnly: boolean; fullPath: string }> {
    const normalized = this.normalizePath({ path });

    /** Intercept virtual devices */
    if (normalized.startsWith('/dev/')) {
      return {
        handle: { name: normalized.split('/').pop()!, kind: 'file' } as FileSystemHandle,
        readOnly: false,
        fullPath: normalized
      };
    }

    const mount = this.mounts.find((m) => normalized === m.path || normalized.startsWith(m.path + '/'));
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
      return [
        { name: 'null', kind: 'file' },
        { name: 'zero', kind: 'file' },
        { name: 'random', kind: 'file' },
        { name: 'urandom', kind: 'file' },
        { name: 'full', kind: 'file' },
      ];
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

  async readFile({ path }: { path: string }): Promise<ReadableStream<Uint8Array>> {
    const normalized = this.normalizePath({ path });

    if (normalized === '/dev/null') {
      return new ReadableStream({ start(c) {
        c.close();
      } });
    }
    if (normalized === '/dev/zero' || normalized === '/dev/full') {
      return new ReadableStream({
        pull(c) {
          c.enqueue(new Uint8Array(1024).fill(0));
        }
      });
    }
    if (normalized === '/dev/random' || normalized === '/dev/urandom') {
      return new ReadableStream({
        pull(c) {
          const buf = new Uint8Array(1024);
          crypto.getRandomValues(buf);
          c.enqueue(buf);
        }
      });
    }

    const { handle } = await this.resolve({ path });
    switch (handle.kind) {
    case 'file':
      break;
    case 'directory':
      throw new Error(`Not a file: ${path}`);
    default: {
      const _ex: never = handle.kind;
      throw new Error(`Unexpected handle kind: ${_ex}`);
    }
    }
    const file = await (handle as FileSystemFileHandle).getFile();
    return file.stream() as ReadableStream<Uint8Array>;
  }

  async writeFile({ path, stream }: { path: string; stream: ReadableStream<Uint8Array> }): Promise<void> {
    const normalized = this.normalizePath({ path });

    if (normalized === '/dev/null' || normalized === '/dev/zero' || normalized === '/dev/random' || normalized === '/dev/urandom') {
      const reader = stream.getReader();
      while (true) {
        const { done } = await reader.read();
        if (done) break;
      }
      return;
    }
    if (normalized === '/dev/full') {
      throw new Error('No space left on device');
    }

    const { handle, readOnly } = await this.resolve({ path }).catch(async () => {
      const parts = this.normalizePath({ path }).split('/');
      const name = parts.pop()!;
      const parentPath = parts.join('/') || '/';
      const parent = await this.resolve({ path: parentPath });
      if (parent.readOnly) throw new Error(`Read-only file system: ${parentPath}`);
      const newFileHandle = await (parent.handle as FileSystemDirectoryHandle).getFileHandle(name, { create: true });
      return { handle: newFileHandle, readOnly: false, fullPath: path };
    });

    if (readOnly) throw new Error(`Read-only file system: ${path}`);
    switch (handle.kind as 'file' | 'directory') {
    case 'file':
      break;
    case 'directory':
      throw new Error(`Not a file: ${path}`);
    default: {
      const _ex: never = handle.kind as never;
      throw new Error(`Unexpected handle kind: ${_ex}`);
    }
    }

    const writable = await (handle as FileSystemFileHandle).createWritable();
    await stream.pipeTo(writable);
  }

  async stat({ path }: { path: string }): Promise<{ size: number; kind: 'file' | 'directory'; readOnly: boolean }> {
    const normalized = this.normalizePath({ path });
    if (normalized.startsWith('/dev/')) {
      return { size: 0, kind: 'file', readOnly: false };
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
    if (normalized.startsWith('/dev/')) throw new Error('Permission denied');

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
      return false;
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
