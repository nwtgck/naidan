import { describe, expect, it, vi } from 'vitest';
import type { OpfsEncryptedStoreHeaderDto } from '@/00-storage/00-dto/opfs-encryption.dto';
import { MockFileSystemDirectoryHandle } from '@/utils/in-memory-file-system';
import { encodeBase64Url } from './base64-url';
import { EncryptedStoreHeaderStore, TEST_ONLY } from './encrypted-store-header-store';

function createHeader({
  encryptedStoreId,
  fileSystemId = encodeBase64Url({ bytes: new Uint8Array(16).fill(7) }),
}: {
  encryptedStoreId: string;
  fileSystemId?: string;
}): OpfsEncryptedStoreHeaderDto {
  return {
    formatVersion: 1,
    encryptedStoreId,
    fileSystemId,
    wrappedFileSystemRootKey: {
      nonce: encodeBase64Url({ bytes: new Uint8Array(12).fill(1) }),
      ciphertext: encodeBase64Url({ bytes: new Uint8Array(48).fill(2) }),
    },
  };
}

describe('EncryptedStoreHeaderStore', () => {
  it('writes two immutable header copies beside a separate HizoFS data directory', async () => {
    const storageRoot = new MockFileSystemDirectoryHandle({ name: 'naidan-storage' });
    const store = new EncryptedStoreHeaderStore({ storageRoot });
    const header = createHeader({ encryptedStoreId: 'store-id' });

    await store.write({ header });
    await store.write({ header });

    await expect(store.read({ encryptedStoreId: 'store-id' })).resolves.toEqual(header);
    const storeDirectory = await store.getStoreDirectory({
      encryptedStoreId: 'store-id',
      create: false,
    });
    for (const name of TEST_ONLY.HEADER_FILE_NAMES) {
      await expect(storeDirectory.getFileHandle(name)).resolves.toBeDefined();
    }
    await expect(store.getHizoFSBackingDirectory({
      encryptedStoreId: 'store-id',
      create: true,
    })).resolves.toMatchObject({ name: TEST_ONLY.HIZOFS_BACKING_DIRECTORY_NAME });
  });

  it('reads the intact header when the other copy is corrupt', async () => {
    const storageRoot = new MockFileSystemDirectoryHandle({ name: 'naidan-storage' });
    const store = new EncryptedStoreHeaderStore({ storageRoot });
    const header = createHeader({ encryptedStoreId: 'store-id' });
    await store.write({ header });
    const storeDirectory = await store.getStoreDirectory({
      encryptedStoreId: 'store-id',
      create: false,
    });
    const corruptHandle = await storeDirectory.getFileHandle(
      TEST_ONLY.HEADER_FILE_NAMES[1],
    );
    const writable = await corruptHandle.createWritable();
    await writable.write('{not valid json');
    await writable.close();

    await expect(store.read({ encryptedStoreId: 'store-id' })).resolves.toEqual(header);
  });

  it('reports each persisted header copy without hiding an invalid sibling', async () => {
    const storageRoot = new MockFileSystemDirectoryHandle({ name: 'naidan-storage' });
    const store = new EncryptedStoreHeaderStore({ storageRoot });
    const header = createHeader({ encryptedStoreId: 'store-id' });
    await store.write({ header });
    const storeDirectory = await store.getStoreDirectory({
      encryptedStoreId: 'store-id',
      create: false,
    });
    const invalidHandle = await storeDirectory.getFileHandle(
      TEST_ONLY.HEADER_FILE_NAMES[1],
    );
    const writable = await invalidHandle.createWritable();
    await writable.write(JSON.stringify({ ...header, fileSystemId: 'not-base64url' }));
    await writable.close();

    await expect(store.inspectCopies({ encryptedStoreId: 'store-id' })).resolves.toEqual([
      expect.objectContaining({
        slot: 0,
        fileName: 'header-0.json',
        status: 'valid',
        header,
      }),
      expect.objectContaining({
        slot: 1,
        fileName: 'header-1.json',
        status: 'invalid',
        persistedDto: expect.objectContaining({ fileSystemId: 'not-base64url' }),
        errorMessage: 'Encrypted store header failed semantic validation',
      }),
    ]);
  });

  it('reads the intact header when the other copy is semantically invalid', async () => {
    const storageRoot = new MockFileSystemDirectoryHandle({ name: 'naidan-storage' });
    const store = new EncryptedStoreHeaderStore({ storageRoot });
    const header = createHeader({ encryptedStoreId: 'store-id' });
    await store.write({ header });
    const storeDirectory = await store.getStoreDirectory({
      encryptedStoreId: 'store-id',
      create: false,
    });
    const invalidHeader = {
      ...header,
      fileSystemId: 'not-base64url',
    };
    const invalidHandle = await storeDirectory.getFileHandle(
      TEST_ONLY.HEADER_FILE_NAMES[1],
    );
    const writable = await invalidHandle.createWritable();
    await writable.write(JSON.stringify(invalidHeader));
    await writable.close();

    await expect(store.read({ encryptedStoreId: 'store-id' })).resolves.toEqual(header);
  });

  it('validates every intact copy before repairing a damaged header', async () => {
    const storageRoot = new MockFileSystemDirectoryHandle({ name: 'naidan-storage' });
    const store = new EncryptedStoreHeaderStore({ storageRoot });
    const original = createHeader({ encryptedStoreId: 'store-id' });
    await store.write({ header: original });
    const storeDirectory = await store.getStoreDirectory({
      encryptedStoreId: 'store-id',
      create: false,
    });
    const damagedName = TEST_ONLY.HEADER_FILE_NAMES[0];
    const damagedHandle = await storeDirectory.getFileHandle(damagedName);
    const damagedWritable = await damagedHandle.createWritable();
    await damagedWritable.write('{damaged');
    await damagedWritable.close();

    const replacement = createHeader({
      encryptedStoreId: 'store-id',
      fileSystemId: encodeBase64Url({ bytes: new Uint8Array(16).fill(8) }),
    });
    await expect(store.write({ header: replacement })).rejects.toThrow('immutable');
    await expect((await damagedHandle.getFile()).text()).resolves.toBe('{damaged');
    await expect(store.read({ encryptedStoreId: 'store-id' })).resolves.toEqual(original);
  });

  it('does not hide an unsupported header format behind the other copy', async () => {
    const storageRoot = new MockFileSystemDirectoryHandle({ name: 'naidan-storage' });
    const store = new EncryptedStoreHeaderStore({ storageRoot });
    const header = createHeader({ encryptedStoreId: 'store-id' });
    await store.write({ header });
    const storeDirectory = await store.getStoreDirectory({
      encryptedStoreId: 'store-id',
      create: false,
    });
    const unsupportedHandle = await storeDirectory.getFileHandle(
      TEST_ONLY.HEADER_FILE_NAMES[1],
    );
    const writable = await unsupportedHandle.createWritable();
    await writable.write(JSON.stringify({ ...header, formatVersion: 2 }));
    await writable.close();

    await expect(store.read({ encryptedStoreId: 'store-id' })).rejects.toThrow(
      'format is unsupported: 2',
    );
  });

  it('fails closed when two valid header copies disagree', async () => {
    const storageRoot = new MockFileSystemDirectoryHandle({ name: 'naidan-storage' });
    const store = new EncryptedStoreHeaderStore({ storageRoot });
    const header = createHeader({ encryptedStoreId: 'store-id' });
    await store.write({ header });
    const storeDirectory = await store.getStoreDirectory({
      encryptedStoreId: 'store-id',
      create: false,
    });
    const conflictingHeader = createHeader({
      encryptedStoreId: 'store-id',
      fileSystemId: encodeBase64Url({ bytes: new Uint8Array(16).fill(8) }),
    });
    const conflictingHandle = await storeDirectory.getFileHandle(
      TEST_ONLY.HEADER_FILE_NAMES[1],
    );
    const writable = await conflictingHandle.createWritable();
    await writable.write(JSON.stringify(conflictingHeader));
    await writable.close();

    await expect(store.read({ encryptedStoreId: 'store-id' })).rejects.toThrow(
      'copies disagree',
    );
  });

  it('treats property order as irrelevant when writing the same immutable header', async () => {
    const storageRoot = new MockFileSystemDirectoryHandle({ name: 'naidan-storage' });
    const store = new EncryptedStoreHeaderStore({ storageRoot });
    const header = createHeader({ encryptedStoreId: 'store-id' });
    await store.write({ header });

    const reorderedHeader: OpfsEncryptedStoreHeaderDto = {
      wrappedFileSystemRootKey: {
        ciphertext: header.wrappedFileSystemRootKey.ciphertext,
        nonce: header.wrappedFileSystemRootKey.nonce,
      },
      fileSystemId: header.fileSystemId,
      encryptedStoreId: header.encryptedStoreId,
      formatVersion: header.formatVersion,
    };

    await expect(store.write({ header: reorderedHeader })).resolves.toBeUndefined();
  });

  it('rejects replacing an existing header with different contents', async () => {
    const storageRoot = new MockFileSystemDirectoryHandle({ name: 'naidan-storage' });
    const store = new EncryptedStoreHeaderStore({ storageRoot });
    await store.write({ header: createHeader({ encryptedStoreId: 'store-id' }) });

    await expect(store.write({
      header: createHeader({
        encryptedStoreId: 'store-id',
        fileSystemId: encodeBase64Url({ bytes: new Uint8Array(16).fill(8) }),
      }),
    })).rejects.toThrow('immutable');
  });

  it('accepts a durable encrypted-store removal when removeEntry reports an error', async () => {
    const storageRoot = new MockFileSystemDirectoryHandle({ name: 'naidan-storage' });
    const store = new EncryptedStoreHeaderStore({ storageRoot });
    await store.write({ header: createHeader({ encryptedStoreId: 'store-id' }) });
    const storesDirectory = await storageRoot.getDirectoryHandle('encrypted-stores');
    const removeEntry = storesDirectory.removeEntry.bind(storesDirectory);
    vi.spyOn(storesDirectory, 'removeEntry').mockImplementation(async (name, options) => {
      await removeEntry(name, options);
      throw new Error('simulated remove error after durable deletion');
    });

    await expect(store.removeStore({ encryptedStoreId: 'store-id' })).resolves.toBeUndefined();
    await expect(store.read({ encryptedStoreId: 'store-id' })).resolves.toBeUndefined();
  });

  it('removes only the requested encrypted store', async () => {
    const storageRoot = new MockFileSystemDirectoryHandle({ name: 'naidan-storage' });
    const store = new EncryptedStoreHeaderStore({ storageRoot });
    await store.write({ header: createHeader({ encryptedStoreId: 'store-a' }) });
    await store.write({ header: createHeader({ encryptedStoreId: 'store-b' }) });

    await store.removeStore({ encryptedStoreId: 'store-a' });

    await expect(store.read({ encryptedStoreId: 'store-b' })).resolves.toMatchObject({
      encryptedStoreId: 'store-b',
    });
    await expect(store.read({ encryptedStoreId: 'store-a' })).resolves.toBeUndefined();
  });
});
