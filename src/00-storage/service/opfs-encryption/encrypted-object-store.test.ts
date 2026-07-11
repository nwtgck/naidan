import { describe, expect, it } from 'vitest';
import { MockFileSystemDirectoryHandle } from '@/utils/in-memory-file-system';
import {
  createEncryptionMaterial,
  deriveEncryptedStoreRuntimeKeys,
} from './encryption-key-manager';
import { EncryptedObjectStore, TEST_ONLY } from './encrypted-object-store';

async function createObjectStore(): Promise<{
  store: EncryptedObjectStore,
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
    store: new EncryptedObjectStore({ storeDirectory: directory, keys }),
    directory,
  };
}

describe('EncryptedObjectStore', () => {
  it('frames identity payloads with an authenticated codec and logical size', () => {
    const plaintext = Uint8Array.from([1, 2, 3, 4]);
    const frame = TEST_ONLY.encodePayloadFrame({ plaintext });

    expect(new TextDecoder().decode(frame.subarray(0, 8))).toBe('NPAYLD01');
    expect(frame[8]).toBe(0);
    expect(TEST_ONLY.decodePayloadFrame({ frame })).toEqual(plaintext);
  });

  it('uses deterministic opaque addresses while randomizing ciphertext', async () => {
    const { store, directory } = await createObjectStore();
    const locator = { namespace: 'chat_meta', key: 'chat-id' };
    const objectId = await store.getObjectId({ locator });

    await store.write({
      locator,
      plaintext: new TextEncoder().encode('first'),
    });
    const objects = await directory.getDirectoryHandle('objects');
    const shard = await objects.getDirectoryHandle(objectId.slice(0, 2));
    const firstPhysical = new Uint8Array(await (
      await (await shard.getFileHandle(`${objectId}.bin`)).getFile()
    ).arrayBuffer());

    await store.write({
      locator,
      plaintext: new TextEncoder().encode('first'),
    });
    const secondPhysical = new Uint8Array(await (
      await (await shard.getFileHandle(`${objectId}.bin`)).getFile()
    ).arrayBuffer());

    expect(objectId).toHaveLength(43);
    expect(secondPhysical).not.toEqual(firstPhysical);
    expect(new TextDecoder().decode(await store.read({ locator }))).toBe('first');
  });

  it('treats deletion of an absent physical object as successful', async () => {
    const { store } = await createObjectStore();

    await expect(store.delete({
      locator: { namespace: 'chat_meta', key: 'missing' },
    })).resolves.toBeUndefined();
  });

  it('keeps different namespaces at different physical addresses', async () => {
    const { store } = await createObjectStore();
    const [left, right] = await Promise.all([
      store.getObjectId({ locator: { namespace: 'chat_meta', key: 'same' } }),
      store.getObjectId({ locator: { namespace: 'chat_content', key: 'same' } }),
    ]);
    expect(left).not.toBe(right);
  });
});
