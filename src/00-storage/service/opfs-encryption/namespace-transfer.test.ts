import { describe, expect, it } from 'vitest';
import { MockFileSystemDirectoryHandle } from '@/utils/in-memory-file-system';
import { createEncryptedOpfs } from '@/00-storage/service/encrypted-opfs';
import { createNativeOpfsFileSystemSession } from '@/00-storage/service/storage-file-system/native-opfs';
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

    const encrypted = await createEncryptedOpfs({
      backingDirectory: new MockFileSystemDirectoryHandle({ name: 'backing' }),
      fileSystemRootKey: new Uint8Array(32).fill(8),
    });
    await copyNaidanPersistenceNamespace({
      sourceRoot: native.root,
      targetRoot: encrypted.root,
      signal: undefined,
    });
    await verifyNaidanPersistenceNamespaceCopy({
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
});
