import { describe, expect, it } from 'vitest';
import { MockFileSystemDirectoryHandle } from '@/utils/in-memory-file-system';
import { NativeOpfsEncryptedOpfsBackingStore } from '@/00-storage/service/encrypted-opfs/backing-store/native-opfs-backing-store';
import { importEncryptedOpfsRootKey } from '@/00-storage/service/encrypted-opfs/crypto/object-crypto';
import {
  EncryptedOpfsCorruptionError,
  EncryptedOpfsUnsupportedFormatError,
} from '@/00-storage/service/encrypted-opfs/errors';
import { EncryptedOpfsObjectStore } from './object-store';
import { EncryptedOpfsSuperblockStore } from './superblock-store';

async function setup() {
  const backingStore = new NativeOpfsEncryptedOpfsBackingStore({
    root: new MockFileSystemDirectoryHandle({ name: 'backing' }),
  });
  const objectStore = new EncryptedOpfsObjectStore({
    backingStore,
    rootKey: await importEncryptedOpfsRootKey({
      rawRootKey: new Uint8Array(32).fill(1),
    }),
    fileSystemId: 'filesystem-id',
  });
  return {
    backingStore,
    objectStore,
    superblockStore: new EncryptedOpfsSuperblockStore({
      objectStore,
      fileSystemId: 'filesystem-id',
    }),
  };
}

describe('EncryptedOpfs A/B superblock store', () => {
  it('selects the valid slot with the greatest sequence', async () => {
    const { superblockStore } = await setup();
    await superblockStore.write({
      value: {
        sequence: 0,
        fileSystemId: 'filesystem-id',
        activeCommitObjectId: 'commit-0',
      },
    });
    await superblockStore.write({
      value: {
        sequence: 1,
        fileSystemId: 'filesystem-id',
        activeCommitObjectId: 'commit-1',
      },
    });
    expect(await superblockStore.read()).toEqual({
      sequence: 1,
      fileSystemId: 'filesystem-id',
      activeCommitObjectId: 'commit-1',
    });
  });

  it('uses the other slot when one physical slot is corrupt', async () => {
    const { backingStore, superblockStore } = await setup();
    await superblockStore.write({
      value: {
        sequence: 0,
        fileSystemId: 'filesystem-id',
        activeCommitObjectId: 'commit-0',
      },
    });
    await backingStore.write({
      path: ['superblock-1.eopfs'],
      bytes: new Uint8Array([1, 2, 3]),
    });
    expect(await superblockStore.read()).toMatchObject({ sequence: 0 });
  });

  it('fails when no valid slot remains', async () => {
    const { backingStore, superblockStore } = await setup();
    await backingStore.write({
      path: ['superblock-0.eopfs'],
      bytes: new Uint8Array([1]),
    });
    await expect(superblockStore.read()).rejects.toBeInstanceOf(
      EncryptedOpfsCorruptionError,
    );
  });

  it('does not downgrade past an authenticated unsupported superblock record', async () => {
    const { objectStore, superblockStore } = await setup();
    await superblockStore.write({
      value: {
        sequence: 0,
        fileSystemId: 'filesystem-id',
        activeCommitObjectId: 'commit-0',
      },
    });
    await objectStore.writeSuperblock({
      slot: 1,
      record: {
        kind: 'superblock',
        recordVersion: 2,
        metadata: {
          sequence: 1,
          fileSystemId: 'filesystem-id',
          activeCommitObjectId: 'commit-1',
        },
        binaryPayload: new Uint8Array(),
      },
    });
    await expect(superblockStore.read()).rejects.toBeInstanceOf(
      EncryptedOpfsUnsupportedFormatError,
    );
  });

  it('rejects equal sequence values as an ambiguous authority state', async () => {
    const { objectStore, superblockStore } = await setup();
    for (const slot of [0, 1] as const) {
      await objectStore.writeSuperblock({
        slot,
        record: {
          kind: 'superblock',
          recordVersion: 1,
          metadata: {
            sequence: 4,
            fileSystemId: 'filesystem-id',
            activeCommitObjectId: `commit-${String(slot)}`,
          },
          binaryPayload: new Uint8Array(),
        },
      });
    }
    await expect(superblockStore.read()).rejects.toThrow('same sequence');
  });

  it('rejects a superblock belonging to another descriptor', async () => {
    const { objectStore } = await setup();
    await objectStore.writeSuperblock({
      slot: 0,
      record: {
        kind: 'superblock',
        recordVersion: 1,
        metadata: {
          sequence: 0,
          fileSystemId: 'other-filesystem',
          activeCommitObjectId: 'commit',
        },
        binaryPayload: new Uint8Array(),
      },
    });
    const superblockStore = new EncryptedOpfsSuperblockStore({
      objectStore,
      fileSystemId: 'filesystem-id',
    });
    await expect(superblockStore.read()).rejects.toThrow(
      'does not match its descriptor',
    );
  });
});
