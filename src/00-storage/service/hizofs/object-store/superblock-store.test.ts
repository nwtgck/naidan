import { describe, expect, it, vi } from 'vitest';
import { encodeBase64Url } from '@/00-storage/service/hizofs/base64-url';
import { MockFileSystemDirectoryHandle } from '@/utils/in-memory-file-system';
import { NativeOpfsHizoFSBackingStore } from '@/00-storage/service/hizofs/backing-store/native-opfs-backing-store';
import { importHizoFSRootKey } from '@/00-storage/service/hizofs/crypto/object-crypto';
import {
  HizoFSCorruptionError,
  HizoFSUnsupportedFormatError,
} from '@/00-storage/service/hizofs/errors';
import { HizoFSObjectStore } from './object-store';
import { HizoFSSuperblockStore } from './superblock-store';

const FILE_SYSTEM_ID = encodeBase64Url({ bytes: new Uint8Array(16).fill(0x11) });
const OTHER_FILE_SYSTEM_ID = encodeBase64Url({ bytes: new Uint8Array(16).fill(0x22) });
const CHILD_SUBVOLUME_ID = encodeBase64Url({ bytes: new Uint8Array(16).fill(0x44) });

function objectId(byte: number): string {
  const bytes = new Uint8Array(32);
  bytes.fill(byte, 0, 16);
  new DataView(bytes.buffer).setBigUint64(16, 64n, false);
  new DataView(bytes.buffer).setUint32(24, 80, false);
  bytes[28] = 1;
  return encodeBase64Url({ bytes });
}

const SUBVOLUME_DESCRIPTOR_OBJECT_ID = objectId(0x33);

async function setup() {
  const root = new MockFileSystemDirectoryHandle({ name: 'backing' });
  const backingStore = new NativeOpfsHizoFSBackingStore({
    root,
    fileHandleCacheEntryLimit: 64,
    fileSnapshotCacheEntryLimit: 64,
    diagnostics: undefined,
  });
  const objectStore = new HizoFSObjectStore({
    backingStore,
    rootKey: await importHizoFSRootKey({
      rawRootKey: new Uint8Array(32).fill(1),
    }),
    fileSystemId: FILE_SYSTEM_ID,
    metadataCacheByteLimit: 1024,
    metadataCacheEntryLimit: 64,
    fileChunkCacheByteLimit: 1024,
    fileChunkCacheEntryLimit: 64,
    fileChunkCacheAdmission: 'read',
  });
  return {
    root,
    backingStore,
    objectStore,
    superblockStore: new HizoFSSuperblockStore({
      objectStore,
      fileSystemId: FILE_SYSTEM_ID,
      headScope: { type: 'root' },
    }),
  };
}

describe('HizoFS A/B superblock store', () => {
  it('selects the valid slot with the greatest sequence', async () => {
    const { superblockStore } = await setup();
    await superblockStore.write({
      value: {
        sequence: 0,
        fileSystemId: FILE_SYSTEM_ID,
        subvolumeDescriptorObjectId: SUBVOLUME_DESCRIPTOR_OBJECT_ID,
        activeCommitObjectId: 'commit-0',
      },
    });
    await superblockStore.write({
      value: {
        sequence: 1,
        fileSystemId: FILE_SYSTEM_ID,
        subvolumeDescriptorObjectId: SUBVOLUME_DESCRIPTOR_OBJECT_ID,
        activeCommitObjectId: 'commit-1',
      },
    });
    expect(await superblockStore.read()).toEqual({
      sequence: 1,
      fileSystemId: FILE_SYSTEM_ID,
      subvolumeDescriptorObjectId: SUBVOLUME_DESCRIPTOR_OBJECT_ID,
      activeCommitObjectId: 'commit-1',
    });
  });

  it('isolates root and child-subvolume head paths and authentication scopes', async () => {
    const { backingStore, objectStore, superblockStore } = await setup();
    const childStore = new HizoFSSuperblockStore({
      objectStore,
      fileSystemId: FILE_SYSTEM_ID,
      headScope: { type: 'subvolume', subvolumeId: CHILD_SUBVOLUME_ID },
    });
    await superblockStore.write({
      value: {
        sequence: 0,
        fileSystemId: FILE_SYSTEM_ID,
        subvolumeDescriptorObjectId: SUBVOLUME_DESCRIPTOR_OBJECT_ID,
        activeCommitObjectId: 'root-commit',
      },
    });
    await childStore.write({
      value: {
        sequence: 0,
        fileSystemId: FILE_SYSTEM_ID,
        subvolumeDescriptorObjectId: SUBVOLUME_DESCRIPTOR_OBJECT_ID,
        activeCommitObjectId: 'child-commit',
      },
    });

    await expect(superblockStore.read()).resolves.toMatchObject({
      activeCommitObjectId: 'root-commit',
    });
    await expect(childStore.read()).resolves.toMatchObject({
      activeCommitObjectId: 'child-commit',
    });

    const childPath = [
      'subvolume-heads',
      CHILD_SUBVOLUME_ID.slice(0, 2),
      `${CHILD_SUBVOLUME_ID}-0.hfs`,
    ];
    const childBytes = await backingStore.read({ path: childPath });
    if (childBytes === undefined) throw new Error('Child head is missing');
    await backingStore.write({ path: ['head-0.hfs'], bytes: childBytes });
    await backingStore.remove({ path: childPath, recursive: false });

    await expect(superblockStore.read()).rejects.toBeInstanceOf(
      HizoFSCorruptionError,
    );
  });

  it('uses the other slot when one physical slot is corrupt', async () => {
    const { backingStore, superblockStore } = await setup();
    await superblockStore.write({
      value: {
        sequence: 0,
        fileSystemId: FILE_SYSTEM_ID,
        subvolumeDescriptorObjectId: SUBVOLUME_DESCRIPTOR_OBJECT_ID,
        activeCommitObjectId: 'commit-0',
      },
    });
    await backingStore.write({
      path: ['head-1.hfs'],
      bytes: new Uint8Array([1, 2, 3]),
    });
    expect(await superblockStore.read()).toMatchObject({ sequence: 0 });
  });

  it('fails when no valid slot remains', async () => {
    const { backingStore, superblockStore } = await setup();
    await backingStore.write({
      path: ['head-0.hfs'],
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
        fileSystemId: FILE_SYSTEM_ID,
        subvolumeDescriptorObjectId: SUBVOLUME_DESCRIPTOR_OBJECT_ID,
        activeCommitObjectId: 'commit-0',
      },
    });
    await objectStore.writeSuperblock({
      scope: { type: 'root' },
      slot: 1,
      record: {
        kind: 'superblock',
        recordVersion: 2,
        metadata: {
          sequence: 1,
          fileSystemId: FILE_SYSTEM_ID,
          subvolumeDescriptorObjectId: SUBVOLUME_DESCRIPTOR_OBJECT_ID,
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
        scope: { type: 'root' },
        slot,
        record: {
          kind: 'superblock',
          recordVersion: 1,
          metadata: {
            sequence: 4,
            fileSystemId: FILE_SYSTEM_ID,
            subvolumeDescriptorObjectId: SUBVOLUME_DESCRIPTOR_OBJECT_ID,
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
      scope: { type: 'root' },
      slot: 0,
      record: {
        kind: 'superblock',
        recordVersion: 1,
        metadata: {
          sequence: 0,
          fileSystemId: OTHER_FILE_SYSTEM_ID,
          subvolumeDescriptorObjectId: SUBVOLUME_DESCRIPTOR_OBJECT_ID,
          activeCommitObjectId: 'commit',
        },
        binaryPayload: new Uint8Array(),
      },
    });
    const superblockStore = new HizoFSSuperblockStore({
      objectStore,
      fileSystemId: FILE_SYSTEM_ID,
      headScope: { type: 'root' },
    });
    await expect(superblockStore.read()).rejects.toThrow(
      'does not match the root-key-derived file system ID',
    );
  });

  it('accepts an ambiguous head flush failure only after independent complete read-back', async () => {
    const { root, objectStore } = await setup();
    const handle = await root.getFileHandle('head-0.hfs', { create: true });
    const createWritable = handle.createWritable.bind(handle);
    vi.spyOn(handle, 'createWritable').mockImplementation(async (options) => {
      const writable = await createWritable(options);
      const close = writable.close.bind(writable);
      vi.spyOn(writable, 'close').mockImplementation(async () => {
        await close();
        throw new Error('ambiguous head close failure');
      });
      return writable;
    });

    await expect(objectStore.writeSuperblock({
      scope: { type: 'root' },
      slot: 0,
      record: {
        kind: 'superblock',
        recordVersion: 1,
        metadata: {
          sequence: 0,
          fileSystemId: FILE_SYSTEM_ID,
          subvolumeDescriptorObjectId: SUBVOLUME_DESCRIPTOR_OBJECT_ID,
          activeCommitObjectId: 'commit-0',
        },
        binaryPayload: new Uint8Array(),
      },
    })).resolves.toBeUndefined();
    await expect(objectStore.readSuperblock({
      scope: { type: 'root' },
      slot: 0,
    })).resolves.toMatchObject({ metadata: { sequence: 0 } });
  });

  it('preserves a head flush error when independent read-back cannot prove completion', async () => {
    const { root, objectStore } = await setup();
    const handle = await root.getFileHandle('head-0.hfs', { create: true });
    const createWritable = handle.createWritable.bind(handle);
    vi.spyOn(handle, 'createWritable').mockImplementation(async (options) => {
      const writable = await createWritable(options);
      vi.spyOn(writable, 'write').mockImplementation(async () => undefined);
      vi.spyOn(writable, 'close').mockRejectedValue(new Error('definite head close failure'));
      return writable;
    });

    await expect(objectStore.writeSuperblock({
      scope: { type: 'root' },
      slot: 0,
      record: {
        kind: 'superblock',
        recordVersion: 1,
        metadata: {
          sequence: 0,
          fileSystemId: FILE_SYSTEM_ID,
          subvolumeDescriptorObjectId: SUBVOLUME_DESCRIPTOR_OBJECT_ID,
          activeCommitObjectId: 'commit-0',
        },
        binaryPayload: new Uint8Array(),
      },
    })).rejects.toThrow('definite head close failure');
  });

});
