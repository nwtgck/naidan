import { describe, expect, it } from 'vitest';
import { MockFileSystemDirectoryHandle } from '@/utils/in-memory-file-system';
import { NativeOpfsHizoFSBackingStore } from '@/00-storage/service/hizofs/backing-store/native-opfs-backing-store';
import { importHizoFSRootKey } from '@/00-storage/service/hizofs/crypto/object-crypto';
import {
  HizoFSCorruptionError,
  HizoFSUnsupportedFormatError,
} from '@/00-storage/service/hizofs/errors';
import { HizoFSObjectStore } from './object-store';
import { HizoFSSuperblockStore } from './superblock-store';

async function setup() {
  const backingStore = new NativeOpfsHizoFSBackingStore({
    root: new MockFileSystemDirectoryHandle({ name: 'backing' }),
  });
  const objectStore = new HizoFSObjectStore({
    backingStore,
    rootKey: await importHizoFSRootKey({
      rawRootKey: new Uint8Array(32).fill(1),
    }),
    fileSystemId: 'filesystem-id',
  });
  return {
    backingStore,
    objectStore,
    superblockStore: new HizoFSSuperblockStore({
      objectStore,
      fileSystemId: 'filesystem-id',
    }),
  };
}

describe('HizoFS A/B superblock store', () => {
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
      path: ['superblock-1.enc'],
      bytes: new Uint8Array([1, 2, 3]),
    });
    expect(await superblockStore.read()).toMatchObject({ sequence: 0 });
  });

  it('uses the older slot when newer authenticated metadata is structurally corrupt', async () => {
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
        recordVersion: 1,
        metadata: {
          sequence: 1,
          fileSystemId: 'filesystem-id',
          activeCommitObjectId: 42,
        },
        binaryPayload: new Uint8Array(),
      },
    });

    await expect(superblockStore.read()).resolves.toMatchObject({ sequence: 0 });
  });

  it('fails when no valid slot remains', async () => {
    const { backingStore, superblockStore } = await setup();
    await backingStore.write({
      path: ['superblock-0.enc'],
      bytes: new Uint8Array([1]),
    });
    await expect(superblockStore.read()).rejects.toBeInstanceOf(
      HizoFSCorruptionError,
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
      HizoFSUnsupportedFormatError,
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

  it('rejects a superblock belonging to another root-key-derived identity', async () => {
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
    const superblockStore = new HizoFSSuperblockStore({
      objectStore,
      fileSystemId: 'filesystem-id',
    });
    await expect(superblockStore.read()).rejects.toThrow(
      'does not match the root-key-derived file system ID',
    );
  });
});
