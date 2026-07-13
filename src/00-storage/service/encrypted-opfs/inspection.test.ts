import { describe, expect, it } from 'vitest';
import { MockFileSystemDirectoryHandle } from '@/utils/in-memory-file-system';
import { writeStorageFileText } from '@/00-storage/service/storage-file-system/io';
import { createEncryptedOpfs } from './api';
import { createEncryptedOpfsInspectionReader } from './inspection';

const ROOT_KEY = new Uint8Array(32).fill(23);

describe('EncryptedOpfs inspection reader', () => {
  it('exposes authenticated persisted state without exposing the root key', async () => {
    const backing = new MockFileSystemDirectoryHandle({ name: 'backing' });
    const session = await createEncryptedOpfs({
      backingDirectory: backing,
      fileSystemRootKey: ROOT_KEY,
    });
    await writeStorageFileText({
      fileHandle: await session.root.getFileHandle({ name: 'settings.json', create: true }),
      value: '{"ok":true}',
    });

    const reader = await createEncryptedOpfsInspectionReader({
      backingDirectory: backing,
      fileSystemRootKey: ROOT_KEY,
    });
    const overview = await reader.readOverview();
    expect(overview.descriptor.fileSystemId).toBe(overview.activeSuperblock.fileSystemId);
    expect(overview.activeCommit.revision).toBe(2);
    expect(overview.superblockSlots).toContainEqual(expect.objectContaining({
      status: 'valid',
      selected: true,
    }));

    const page = await reader.listPhysicalObjects({ cursor: undefined, limit: 100 });
    expect(page.entries.length).toBeGreaterThan(0);
    const inspected = await reader.inspectObject({
      objectId: overview.activeCommitObjectId,
      binaryPayloadPreviewByteLength: 32,
    });
    expect(inspected).toMatchObject({
      objectId: overview.activeCommitObjectId,
      record: {
        kind: 'commit',
        recordVersion: 1,
        binaryPayloadByteLength: 0,
      },
    });
    expect(inspected?.envelope.nonceBytes).toHaveLength(12);

    await reader.dispose();
    await expect(reader.readOverview()).rejects.toThrow('inspection reader is closed');
    await session.close();
  });

  it('reports an invalid fallback superblock without hiding the active slot', async () => {
    const backing = new MockFileSystemDirectoryHandle({ name: 'backing' });
    const session = await createEncryptedOpfs({
      backingDirectory: backing,
      fileSystemRootKey: ROOT_KEY,
    });
    await writeStorageFileText({
      fileHandle: await session.root.getFileHandle({ name: 'a.txt', create: true }),
      value: 'a',
    });
    await writeStorageFileText({
      fileHandle: await session.root.getFileHandle({ name: 'b.txt', create: true }),
      value: 'b',
    });
    const invalidSlot = await backing.getFileHandle('superblock-0.eopfs');
    const writable = await invalidSlot.createWritable({ keepExistingData: false });
    await writable.write(new Uint8Array([1, 2, 3]));
    await writable.close();

    const reader = await createEncryptedOpfsInspectionReader({
      backingDirectory: backing,
      fileSystemRootKey: ROOT_KEY,
    });
    const overview = await reader.readOverview();
    expect(overview.superblockSlots).toContainEqual(expect.objectContaining({
      slot: 0,
      status: 'invalid',
      selected: false,
    }));
    expect(overview.superblockSlots).toContainEqual(expect.objectContaining({
      slot: 1,
      status: 'valid',
      selected: true,
    }));
    await reader.dispose();
    await session.close();
  });
});
