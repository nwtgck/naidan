import { describe, expect, it, vi } from 'vitest';
import { MockFileSystemDirectoryHandle } from '@/utils/in-memory-file-system';
import {
  createEncryptionMaterial,
  deriveEncryptedStoreRuntimeKeys,
} from './encryption-key-manager';
import {
  decodeEncryptedObjectPhysicalHeader,
  EncryptedObjectStore,
  TEST_ONLY,
} from './encrypted-object-store';

async function createObjectStores(): Promise<{
  durableStore: EncryptedObjectStore,
  temporaryStore: EncryptedObjectStore,
  directory: MockFileSystemDirectoryHandle,
}> {
  const material = await createEncryptionMaterial({
    passphrase: 'test passphrase',
    pbkdf2Iterations: 10,
  });
  const keys = await deriveEncryptedStoreRuntimeKeys({
    storeRootKey: material.storeRootKey,
    encryptedStoreId: 'test-store',
  });
  const directory = new MockFileSystemDirectoryHandle({ name: 'test-store' });
  return {
    durableStore: new EncryptedObjectStore({
      storeDirectory: directory,
      keys,
      area: 'durable',
    }),
    temporaryStore: new EncryptedObjectStore({
      storeDirectory: directory,
      keys,
      area: 'temporary',
    }),
    directory,
  };
}

describe('EncryptedObjectStore', () => {
  it('frames identity payloads with an authenticated version and decoded size', () => {
    const plaintext = Uint8Array.from([1, 2, 3, 4]);
    const frame = TEST_ONLY.encodePayloadFrame({ plaintext });

    expect(frame[0]).toBe(1);
    expect(frame[1]).toBe(0);
    expect(new DataView(frame.buffer).getBigUint64(2, false)).toBe(4n);
    expect(TEST_ONLY.decodePayloadFrame({ frame })).toEqual(plaintext);
  });

  it('uses an explicit physical magic, version, header length, and random nonce', () => {
    const first = TEST_ONLY.encodePhysicalHeader({ nonce: new Uint8Array(12).fill(1) });
    const second = TEST_ONLY.encodePhysicalHeader({ nonce: new Uint8Array(12).fill(2) });

    expect(Array.from(first.subarray(0, 8))).toEqual([
      0x4e, 0x41, 0x49, 0x4f, 0x42, 0x4a, 0x00, 0x00,
    ]);
    expect(new DataView(first.buffer).getUint16(8, false)).toBe(1);
    expect(new DataView(first.buffer).getUint16(10, false)).toBe(24);
    expect(first).not.toEqual(second);
  });

  it('uses deterministic opaque addresses while randomizing ciphertext', async () => {
    const { durableStore, directory } = await createObjectStores();
    const locator = { namespace: 'chat_meta', key: 'chat-id' };
    const address = await durableStore.getObjectAddress({ locator });

    await durableStore.write({
      locator,
      plaintext: new TextEncoder().encode('first'),
    });
    const objects = await directory.getDirectoryHandle('objects');
    const shard = await objects.getDirectoryHandle(address.shardId);
    const firstPhysical = new Uint8Array(await (
      await (await shard.getFileHandle(`${address.objectId}.enc`)).getFile()
    ).arrayBuffer());

    await durableStore.write({
      locator,
      plaintext: new TextEncoder().encode('first'),
    });
    const secondPhysical = new Uint8Array(await (
      await (await shard.getFileHandle(`${address.objectId}.enc`)).getFile()
    ).arrayBuffer());

    const header = decodeEncryptedObjectPhysicalHeader({ physical: secondPhysical });
    expect(address.objectId).toHaveLength(43);
    expect(address.path).toBe(`objects/${address.shardId}/${address.objectId}.enc`);
    expect(header).toMatchObject({
      formatVersion: 1,
      headerByteLength: 24,
      ciphertextByteLength: secondPhysical.byteLength - 24,
    });
    expect(header.nonce).toHaveLength(12);
    expect(secondPhysical).not.toEqual(firstPhysical);
    expect(new TextDecoder().decode(await durableStore.read({ locator }))).toBe('first');
  });

  it('accepts an exact durable object replacement when close reports an error', async () => {
    const { durableStore, directory } = await createObjectStores();
    const locator = { namespace: 'chat_meta', key: 'close-error' };
    const address = await durableStore.getObjectAddress({ locator });
    const objects = await directory.getDirectoryHandle('objects', { create: true });
    const shard = await objects.getDirectoryHandle(address.shardId, { create: true });
    const handle = await shard.getFileHandle(`${address.objectId}.enc`, { create: true });
    const createWritable = handle.createWritable.bind(handle);
    vi.spyOn(handle, 'createWritable').mockImplementation(async options => {
      const writable = await createWritable(options);
      const close = writable.close.bind(writable);
      vi.spyOn(writable, 'close').mockImplementation(async () => {
        await close();
        throw new Error('simulated close error after durable replacement');
      });
      return writable;
    });

    await expect(durableStore.write({
      locator,
      plaintext: new TextEncoder().encode('durably committed'),
    })).resolves.toBeUndefined();
    expect(new TextDecoder().decode(await durableStore.read({ locator }))).toBe(
      'durably committed',
    );
  });

  it('binds ciphertext to its durable or temporary physical area', async () => {
    const { durableStore, temporaryStore } = await createObjectStores();
    const locator = { namespace: 'file_chunk', key: 'chunk-id' };
    await durableStore.write({
      locator,
      plaintext: new TextEncoder().encode('durable payload'),
    });
    const durableAddress = await durableStore.getObjectAddress({ locator });
    const temporaryAddress = await temporaryStore.getObjectAddress({ locator });
    const physical = await durableStore.readPhysical({ address: durableAddress });
    if (physical === undefined) {
      throw new Error('Expected a physical encrypted object');
    }

    await expect(temporaryStore.decryptPhysical({
      address: temporaryAddress,
      physical,
    })).rejects.toThrow();
  });

  it('accepts a confirmed deletion when removeEntry reports an error', async () => {
    const { durableStore, directory } = await createObjectStores();
    const locator = { namespace: 'chat_meta', key: 'delete-close-error' };
    await durableStore.write({
      locator,
      plaintext: new TextEncoder().encode('delete me'),
    });
    const address = await durableStore.getObjectAddress({ locator });
    const objects = await directory.getDirectoryHandle('objects');
    const shard = await objects.getDirectoryHandle(address.shardId);
    const removeEntry = shard.removeEntry.bind(shard);
    vi.spyOn(shard, 'removeEntry').mockImplementation(async (name, options) => {
      await removeEntry(name, options);
      throw new Error('simulated remove error after durable deletion');
    });

    await expect(durableStore.delete({ locator })).resolves.toBeUndefined();
    await expect(durableStore.read({ locator })).resolves.toBeUndefined();
  });

  it('treats deletion of an absent physical object as successful', async () => {
    const { durableStore } = await createObjectStores();

    await expect(durableStore.delete({
      locator: { namespace: 'chat_meta', key: 'missing' },
    })).resolves.toBeUndefined();
  });

  it('keeps different namespaces at different physical addresses', async () => {
    const { durableStore } = await createObjectStores();
    const [left, right] = await Promise.all([
      durableStore.getObjectId({ locator: { namespace: 'chat_meta', key: 'same' } }),
      durableStore.getObjectId({ locator: { namespace: 'chat_content', key: 'same' } }),
    ]);
    expect(left).not.toBe(right);
  });
});
