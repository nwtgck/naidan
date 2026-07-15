import { describe, expect, it } from 'vitest';
import { MockFileSystemDirectoryHandle } from '@/utils/in-memory-file-system';
import {
  createHizoFS,
  createHizoFSBulkBuilder,
  inspectHizoFS,
} from '@/00-storage/service/hizofs';
import { createNativeOpfsFileSystemSession } from '@/00-storage/service/storage-file-system/native-opfs';
import type {
  StorageDirectoryHandle,
  StorageEntryHandle,
  StorageFileHandle,
} from '@/00-storage/service/storage-file-system/types';
import { readStorageFileText, writeStorageFileText } from '@/00-storage/service/storage-file-system/io';
import {
  copyNaidanPersistenceNamespace,
  verifyNaidanPersistenceNamespaceCopy,
} from './namespace-transfer';

async function writeText({
  root,
  path,
  value,
}: {
  root: ReturnType<typeof createNativeOpfsFileSystemSession>['root'];
  path: readonly string[];
  value: string;
}): Promise<void> {
  let directory = root;
  for (const segment of path.slice(0, -1)) {
    directory = await directory.getDirectoryHandle({ name: segment, create: true });
  }
  await writeStorageFileText({
    fileHandle: await directory.getFileHandle({ name: path.at(-1)!, create: true }),
    value,
  });
}

type ReadMetrics = {
  calls: number;
  maximumLength: number;
};

function instrumentFileReads({
  file,
  metrics,
}: {
  file: StorageFileHandle;
  metrics: ReadMetrics;
}): StorageFileHandle {
  return new Proxy(file, {
    get(target, property) {
      if (property === 'openReadable') {
        return async ({ mimeType }: { mimeType: string }) => {
          const readable = await target.openReadable({ mimeType });
          return {
            size: readable.size,
            mimeType: readable.mimeType,
            backing: readable.backing,
            async read(options: Parameters<typeof readable.read>[0]) {
              metrics.calls += 1;
              metrics.maximumLength = Math.max(
                metrics.maximumLength,
                options.length,
              );
              return await readable.read(options);
            },
            stream(options: Parameters<typeof readable.stream>[0]) {
              return readable.stream(options);
            },
            async close() {
              await readable.close();
            },
          };
        };
      }
      const value = Reflect.get(target, property, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

function instrumentDirectoryReads({
  directory,
  metrics,
}: {
  directory: StorageDirectoryHandle;
  metrics: ReadMetrics;
}): StorageDirectoryHandle {
  const instrumentEntry = ({ entry }: {
    entry: StorageEntryHandle;
  }): StorageEntryHandle => {
    switch (entry.kind) {
    case 'directory':
      return instrumentDirectoryReads({ directory: entry, metrics });
    case 'file':
      return instrumentFileReads({ file: entry, metrics });
    case 'symlink':
      return entry;
    default: {
      const _ex: never = entry;
      throw new Error(`Unhandled instrumented entry: ${String(_ex)}`);
    }
    }
  };

  return new Proxy(directory, {
    get(target, property) {
      switch (property) {
      case 'entries':
        return async function*() {
          for await (const [name, entry] of target.entries()) {
            yield [name, instrumentEntry({ entry })] as const;
          }
        };
      case 'getDirectoryHandle':
        return async (options: { name: string; create: boolean }) =>
          instrumentDirectoryReads({
            directory: await target.getDirectoryHandle(options),
            metrics,
          });
      case 'getFileHandle':
        return async (options: { name: string; create: boolean }) =>
          instrumentFileReads({
            file: await target.getFileHandle(options),
            metrics,
          });
      case 'getEntryHandle':
        return async (options: { name: string }) => instrumentEntry({
          entry: await target.getEntryHandle(options),
        });
      default: {
        const value = Reflect.get(target, property, target);
        return typeof value === 'function' ? value.bind(target) : value;
      }
      }
    },
  });
}

describe('Naidan persistence namespace transfer', () => {
  it('copies unknown durable entries byte-for-byte while excluding control state and resetting tmp', async () => {
    const native = createNativeOpfsFileSystemSession({
      root: new MockFileSystemDirectoryHandle({ name: 'native' }),
    });
    await writeText({ root: native.root, path: ['naidan-storage', 'settings.json'], value: 'settings' });
    await writeText({ root: native.root, path: ['naidan-storage', 'future', 'unknown.bin'], value: 'future' });
    await writeText({ root: native.root, path: ['naidan-storage', 'encryption-state', 'state-0.json'], value: 'control' });
    await writeText({ root: native.root, path: ['naidan-debug-wesh', 'home', 'value'], value: 'debug' });
    await writeText({ root: native.root, path: ['naidan-tmp', 'discard'], value: 'tmp' });

    const encrypted = await createHizoFS({
      backingDirectory: new MockFileSystemDirectoryHandle({ name: 'backing' }),
      fileSystemRootKey: new Uint8Array(32).fill(8),
    });
    await copyNaidanPersistenceNamespace({
      targetBuilder: undefined,
      sourceRoot: native.root,
      targetRoot: encrypted.root,
      signal: undefined,
    });
    await verifyNaidanPersistenceNamespaceCopy({
      signal: undefined,
      sourceRoot: native.root,
      targetRoot: encrypted.root,
    });

    const storage = await encrypted.root.getDirectoryHandle({ name: 'naidan-storage', create: false });
    expect(await readStorageFileText({
      fileHandle: await storage.getFileHandle({ name: 'settings.json', create: false }),
    })).toBe('settings');
    await expect(storage.getDirectoryHandle({
      name: 'encryption-state',
      create: false,
    })).rejects.toMatchObject({ name: 'NotFoundError' });

    const temporary = await encrypted.root.getDirectoryHandle({ name: 'naidan-tmp', create: false });
    const temporaryNames: string[] = [];
    for await (const [name] of temporary.entries()) temporaryNames.push(name);
    expect(temporaryNames).toEqual([]);
  });

  it('verifies large files with bounded read requests instead of materializing whole files', async () => {
    const native = createNativeOpfsFileSystemSession({
      root: new MockFileSystemDirectoryHandle({ name: 'native' }),
    });
    const storage = await native.root.getDirectoryHandle({
      name: 'naidan-storage',
      create: true,
    });
    const sourceFile = await storage.getFileHandle({
      name: 'large.bin',
      create: true,
    });
    const bytes = new Uint8Array((256 * 1024 * 3) + 17);
    for (let index = 0; index < bytes.byteLength; index += 1) {
      bytes[index] = index % 251;
    }
    const writable = await sourceFile.createWritable({ keepExistingData: false });
    await writable.write({ position: 0, data: bytes });
    await writable.close();

    const encrypted = await createHizoFS({
      backingDirectory: new MockFileSystemDirectoryHandle({ name: 'backing' }),
      fileSystemRootKey: new Uint8Array(32).fill(8),
    });
    await copyNaidanPersistenceNamespace({
      sourceRoot: native.root,
      targetRoot: encrypted.root,
      targetBuilder: await createHizoFSBulkBuilder({ fileSystemSession: encrypted }),
      signal: undefined,
    });

    const metrics: ReadMetrics = { calls: 0, maximumLength: 0 };
    await verifyNaidanPersistenceNamespaceCopy({
      sourceRoot: instrumentDirectoryReads({ directory: native.root, metrics }),
      targetRoot: instrumentDirectoryReads({ directory: encrypted.root, metrics }),
      signal: undefined,
    });

    expect(metrics.calls).toBeGreaterThan(2);
    expect(metrics.maximumLength).toBeLessThanOrEqual(256 * 1024);
    await encrypted.close();
    await native.close();
  });

  it('publishes one HizoFS commit for a namespace with one hundred files', async () => {
    const native = createNativeOpfsFileSystemSession({
      root: new MockFileSystemDirectoryHandle({ name: 'native' }),
    });
    for (let index = 0; index < 100; index += 1) {
      await writeText({
        root: native.root,
        path: ['naidan-storage', 'chat-metas', `${String(index)}.json`],
        value: `{"index":${String(index)}}`,
      });
    }

    const backingDirectory = new MockFileSystemDirectoryHandle({ name: 'backing' });
    const fileSystemRootKey = new Uint8Array(32).fill(8);
    const encrypted = await createHizoFS({
      backingDirectory,
      fileSystemRootKey,
    });
    const before = await inspectHizoFS({
      backingDirectory,
      fileSystemRootKey,
    });
    expect(before.superblock.sequence).toBe(1);

    const targetBuilder = await createHizoFSBulkBuilder({
      fileSystemSession: encrypted,
    });
    expect(targetBuilder).toBeDefined();
    await copyNaidanPersistenceNamespace({
      sourceRoot: native.root,
      targetRoot: encrypted.root,
      targetBuilder,
      signal: undefined,
    });

    const after = await inspectHizoFS({
      backingDirectory,
      fileSystemRootKey,
    });
    expect(after.superblock.sequence).toBe(2);
    await verifyNaidanPersistenceNamespaceCopy({
      sourceRoot: native.root,
      targetRoot: encrypted.root,
      signal: undefined,
    });
  });


  it('preserves HizoFS file timestamps during HizoFS-to-HizoFS transfer', async () => {
    const source = await createHizoFS({
      backingDirectory: new MockFileSystemDirectoryHandle({ name: 'source-backing' }),
      fileSystemRootKey: new Uint8Array(32).fill(3),
    });
    const sourceStorage = await source.root.getDirectoryHandle({
      name: 'naidan-storage',
      create: true,
    });
    const sourceFile = await sourceStorage.getFileHandle({
      name: 'settings.json',
      create: true,
    });
    await writeStorageFileText({ fileHandle: sourceFile, value: 'timestamped' });
    const sourceStat = await sourceFile.stat();
    const sourceRootStat = await source.root.stat();

    const target = await createHizoFS({
      backingDirectory: new MockFileSystemDirectoryHandle({ name: 'target-backing' }),
      fileSystemRootKey: new Uint8Array(32).fill(4),
    });
    await copyNaidanPersistenceNamespace({
      sourceRoot: source.root,
      targetRoot: target.root,
      targetBuilder: await createHizoFSBulkBuilder({ fileSystemSession: target }),
      signal: undefined,
    });
    const targetFile = await (await target.root.getDirectoryHandle({
      name: 'naidan-storage',
      create: false,
    })).getFileHandle({ name: 'settings.json', create: false });

    expect(await targetFile.stat()).toMatchObject({
      createdAt: sourceStat.createdAt,
      modifiedAt: sourceStat.modifiedAt,
    });
    expect(await target.root.stat()).toMatchObject({
      createdAt: sourceRootStat.createdAt,
      modifiedAt: sourceRootStat.modifiedAt,
    });
    await source.close();
    await target.close();
  });

});
