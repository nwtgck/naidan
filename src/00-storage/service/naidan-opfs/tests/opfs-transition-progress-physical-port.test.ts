import { describe, expect, it } from 'vitest';
import {
  NAIDAN_PERSISTENCE_CONTROL_FORMAT_CONSTANTS,
  NAIDAN_TRANSITION_PROGRESS_FORMAT_CONSTANTS,
} from '@/00-storage/service/naidan-persistence-control/00-format';
import {
  createBrowserNaidanPersistenceControlExclusiveGate,
  createOpfsTransitionProgressPhysicalPort,
  TEST_ONLY,
} from '@/00-storage/service/naidan-opfs/opfs-transition-progress-physical-port';

function notFound({ message }: { message: string }): Error {
  const error = new Error(message);
  error.name = 'NotFoundError';
  return error;
}

class MemoryWritable {
  readonly #file: MemoryFileHandle;
  #closed = false;
  #pending = new Uint8Array();

  constructor({ file }: { file: MemoryFileHandle }) {
    this.#file = file;
  }

  async abort(): Promise<void> {
    this.#closed = true;
  }

  async close(): Promise<void> {
    if (this.#closed) throw new Error('writable is closed');
    this.#file.bytes = Uint8Array.from(this.#pending);
    this.#closed = true;
  }

  async write(data: FileSystemWriteChunkType): Promise<void> {
    if (this.#closed) throw new Error('writable is closed');
    if (!(data instanceof Uint8Array)) throw new TypeError('test writable accepts Uint8Array only');
    this.#pending = Uint8Array.from(data);
  }
}

class MemoryFileHandle {
  readonly kind = 'file' as const;
  readonly name: string;
  bytes = new Uint8Array();
  arrayBufferReads = 0;

  constructor({ name }: { name: string }) {
    this.name = name;
  }

  async createWritable(): Promise<FileSystemWritableFileStream> {
    return new MemoryWritable({ file: this }) as unknown as FileSystemWritableFileStream;
  }

  async getFile(): Promise<File> {
    const snapshot = Uint8Array.from(this.bytes);
    return {
      arrayBuffer: async () => {
        this.arrayBufferReads += 1;
        return snapshot.buffer.slice(snapshot.byteOffset, snapshot.byteOffset + snapshot.byteLength);
      },
      size: snapshot.byteLength,
    } as File;
  }
}

class MemoryDirectoryHandle {
  readonly kind = 'directory' as const;
  readonly name: string;
  readonly directories = new Map<string, MemoryDirectoryHandle>();
  readonly files = new Map<string, MemoryFileHandle>();
  readonly directoryRequests: Array<readonly [string, boolean]> = [];
  readonly fileRequests: Array<readonly [string, boolean]> = [];
  readonly removed: string[] = [];

  constructor({ name }: { name: string }) {
    this.name = name;
  }

  async getDirectoryHandle(name: string, options?: { create?: boolean }): Promise<FileSystemDirectoryHandle> {
    const create = options?.create ?? false;
    this.directoryRequests.push([name, create]);
    let directory = this.directories.get(name);
    if (directory === undefined && create) {
      directory = new MemoryDirectoryHandle({ name });
      this.directories.set(name, directory);
    }
    if (directory === undefined) throw notFound({ message: `missing directory: ${name}` });
    return directory as unknown as FileSystemDirectoryHandle;
  }

  async getFileHandle(name: string, options?: { create?: boolean }): Promise<FileSystemFileHandle> {
    const create = options?.create ?? false;
    this.fileRequests.push([name, create]);
    let file = this.files.get(name);
    if (file === undefined && create) {
      file = new MemoryFileHandle({ name });
      this.files.set(name, file);
    }
    if (file === undefined) throw notFound({ message: `missing file: ${name}` });
    return file as unknown as FileSystemFileHandle;
  }

  async removeEntry(name: string): Promise<void> {
    if (!this.files.delete(name)) throw notFound({ message: `missing file: ${name}` });
    this.removed.push(name);
  }
}

function lockManager(): { lockNames: string[]; manager: Pick<LockManager, 'request'> } {
  const lockNames: string[] = [];
  const request = async <T>(name: string, _options: LockOptions, callback: LockGrantedCallback<T>): Promise<T> => {
    lockNames.push(name);
    return await callback({ mode: 'exclusive', name } as Lock);
  };
  return { lockNames, manager: { request: request as LockManager['request'] } };
}

function fixture() {
  const root = new MemoryDirectoryHandle({ name: 'naidan-storage' });
  const locks = lockManager();
  const exclusiveGate = createBrowserNaidanPersistenceControlExclusiveGate({ lockManager: locks.manager });
  const physical = createOpfsTransitionProgressPhysicalPort({
    exclusiveGate,
    storageRoot: root as unknown as FileSystemDirectoryHandle,
  });
  return { locks, physical, root };
}

function progressDirectory({ root }: { root: MemoryDirectoryHandle }): MemoryDirectoryHandle | undefined {
  return root.directories
    .get(NAIDAN_PERSISTENCE_CONTROL_FORMAT_CONSTANTS.storage.collectionDirectoryName)
    ?.directories.get(NAIDAN_TRANSITION_PROGRESS_FORMAT_CONSTANTS.storage.directoryName);
}

describe('native OPFS transition-progress physical port', () => {
  it('creates and reads only the fixed nested A/B path', async () => {
    const { physical, root } = fixture();
    await physical.publishWholeFileDurably({ bytes: Uint8Array.of(1, 2, 3), copy: 1 });
    await expect(physical.readFileBounded({ copy: 1, maximumByteLength: 3 }))
      .resolves.toEqual(Uint8Array.of(1, 2, 3));

    const directory = progressDirectory({ root });
    expect(directory?.fileRequests).toEqual([
      [NAIDAN_TRANSITION_PROGRESS_FORMAT_CONSTANTS.storage.files[1], true],
      [NAIDAN_TRANSITION_PROGRESS_FORMAT_CONSTANTS.storage.files[1], false],
    ]);
  });

  it('does not create entries while reading an absent companion', async () => {
    const { physical, root } = fixture();
    await expect(physical.readFileBounded({ copy: 0, maximumByteLength: 10 })).resolves.toBeUndefined();
    expect(root.directories.size).toBe(0);
    expect(root.directoryRequests).toEqual([
      [NAIDAN_PERSISTENCE_CONTROL_FORMAT_CONSTANTS.storage.collectionDirectoryName, false],
    ]);
  });

  it('rejects oversized files before materializing bytes', async () => {
    const { physical, root } = fixture();
    await physical.publishWholeFileDurably({ bytes: Uint8Array.of(1, 2, 3), copy: 0 });
    const file = progressDirectory({ root })?.files.get(NAIDAN_TRANSITION_PROGRESS_FORMAT_CONSTANTS.storage.files[0]);
    await expect(physical.readFileBounded({ copy: 0, maximumByteLength: 2 }))
      .rejects.toThrow('exceeds the requested bounded read limit');
    expect(file?.arrayBufferReads).toBe(0);
  });

  it('removes fixed copies idempotently', async () => {
    const { physical, root } = fixture();
    await physical.publishWholeFileDurably({ bytes: Uint8Array.of(1), copy: 0 });
    await physical.removeFile({ copy: 0 });
    await physical.removeFile({ copy: 0 });
    expect(progressDirectory({ root })?.removed).toEqual([
      NAIDAN_TRANSITION_PROGRESS_FORMAT_CONSTANTS.storage.files[0],
    ]);
  });

  it('uses the shared Persistence Control cross-realm authority lock', async () => {
    const { locks, physical } = fixture();
    await expect(physical.runExclusive({ operation: async () => 'done' })).resolves.toBe('done');
    expect(locks.lockNames).toEqual([TEST_ONLY.persistenceControlAuthorityLockName]);
  });
});
