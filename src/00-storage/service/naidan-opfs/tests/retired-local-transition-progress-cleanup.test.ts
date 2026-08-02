import { describe, expect, it, vi } from 'vitest';
import { NAIDAN_PERSISTENCE_CONTROL_FORMAT_CONSTANTS } from '@/00-storage/service/naidan-persistence-control/00-format';
import type { NaidanPersistenceControlExclusiveGate } from '@/00-storage/service/naidan-opfs/persistence-control-exclusive-gate';
import {
  cleanupRetiredLocalTransitionProgress,
  TEST_ONLY,
} from '@/00-storage/service/naidan-opfs/retired-local-transition-progress-cleanup';

function notFound({ message }: { message: string }): Error {
  const error = new Error(message);
  error.name = 'NotFoundError';
  return error;
}

class MemoryFileHandle {
  readonly kind = 'file' as const;
  readonly name: string;
  readonly bytes: Uint8Array;
  reads = 0;

  constructor({ bytes, name }: { bytes: Uint8Array; name: string }) {
    this.bytes = bytes.slice();
    this.name = name;
  }

  async getFile(): Promise<File> {
    this.reads += 1;
    const bytes = this.bytes.slice();
    return {
      arrayBuffer: async () => bytes.buffer.slice(
        bytes.byteOffset,
        bytes.byteOffset + bytes.byteLength,
      ) as ArrayBuffer,
      name: this.name,
      size: bytes.byteLength,
    } as File;
  }
}

class MemoryDirectoryHandle {
  readonly kind = 'directory' as const;
  readonly name: string;
  readonly directories = new Map<string, MemoryDirectoryHandle>();
  readonly files = new Map<string, MemoryFileHandle>();
  readonly directoryRequests: Array<readonly [string, boolean]> = [];
  readonly removed: string[] = [];
  failRemovalFor: string | undefined;

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

  async removeEntry(name: string): Promise<void> {
    if (name === this.failRemovalFor) throw new Error('cleanup write failed');
    if (!this.files.delete(name)) throw notFound({ message: `missing file: ${name}` });
    this.removed.push(name);
  }
}

function fixture() {
  const root = new MemoryDirectoryHandle({ name: 'naidan-storage' });
  const collection = new MemoryDirectoryHandle({ name: 'control' });
  const progress = new MemoryDirectoryHandle({ name: TEST_ONLY.directoryName });
  root.directories.set(
    NAIDAN_PERSISTENCE_CONTROL_FORMAT_CONSTANTS.storage.collectionDirectoryName,
    collection,
  );
  collection.directories.set(TEST_ONLY.directoryName, progress);
  const runExclusive = vi.fn(async <T>({ operation }: {
    operation: () => Promise<T>;
  }): Promise<T> => await operation());
  const exclusiveGate = { runExclusive } as NaidanPersistenceControlExclusiveGate;
  return { collection, exclusiveGate, progress, root, runExclusive };
}

function seed({ bytes, name, progress }: {
  bytes: Uint8Array;
  name: string;
  progress: MemoryDirectoryHandle;
}): MemoryFileHandle {
  const file = new MemoryFileHandle({ bytes, name });
  progress.files.set(name, file);
  return file;
}

describe('retired local transition progress cleanup', () => {
  it('removes only the two known fixed files without decoding their bytes', async () => {
    const { exclusiveGate, progress, root, runExclusive } = fixture();
    const first = seed({ bytes: Uint8Array.of(0xff, 0x00), name: TEST_ONLY.fileNames[0], progress });
    const second = seed({ bytes: new TextEncoder().encode('wrong-key and stale operation'), name: TEST_ONLY.fileNames[1], progress });
    const unknown = seed({ bytes: Uint8Array.of(7), name: 'future-state.json', progress });

    await cleanupRetiredLocalTransitionProgress({
      exclusiveGate,
      storageRoot: root as unknown as FileSystemDirectoryHandle,
    });

    expect(runExclusive).toHaveBeenCalledOnce();
    expect(progress.removed).toEqual(TEST_ONLY.fileNames);
    expect(progress.files.has(unknown.name)).toBe(true);
    expect(first.reads).toBe(0);
    expect(second.reads).toBe(0);
    expect(unknown.reads).toBe(0);
  });

  it('does not create a missing collection while cleaning', async () => {
    const root = new MemoryDirectoryHandle({ name: 'naidan-storage' });
    const runExclusive = vi.fn(async <T>({ operation }: {
      operation: () => Promise<T>;
    }): Promise<T> => await operation());

    await cleanupRetiredLocalTransitionProgress({
      exclusiveGate: { runExclusive } as unknown as NaidanPersistenceControlExclusiveGate,
      storageRoot: root as unknown as FileSystemDirectoryHandle,
    });

    expect(root.directories.size).toBe(0);
    expect(root.directoryRequests).toEqual([[
      NAIDAN_PERSISTENCE_CONTROL_FORMAT_CONSTANTS.storage.collectionDirectoryName,
      false,
    ]]);
  });

  it('keeps stable startup nonblocking when removal or locking fails', async () => {
    const removalFailure = fixture();
    seed({ bytes: Uint8Array.of(1), name: TEST_ONLY.fileNames[0], progress: removalFailure.progress });
    removalFailure.progress.failRemovalFor = TEST_ONLY.fileNames[0];
    await expect(cleanupRetiredLocalTransitionProgress({
      exclusiveGate: removalFailure.exclusiveGate,
      storageRoot: removalFailure.root as unknown as FileSystemDirectoryHandle,
    })).resolves.toBeUndefined();
    expect(removalFailure.progress.files.has(TEST_ONLY.fileNames[0])).toBe(true);

    const lockFailure = new Error('authority lock failed');
    await expect(cleanupRetiredLocalTransitionProgress({
      exclusiveGate: {
        runExclusive: async () => await Promise.reject(lockFailure),
      },
      storageRoot: removalFailure.root as unknown as FileSystemDirectoryHandle,
    })).resolves.toBeUndefined();
  });
});
