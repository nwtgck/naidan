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

    const descriptorFile = await backing.getFileHandle('descriptor.json');
    const persistedDescriptor = JSON.parse(await (await descriptorFile.getFile()).text()) as Record<string, unknown>;
    const descriptorWritable = await descriptorFile.createWritable({ keepExistingData: false });
    await descriptorWritable.write(JSON.stringify({
      ...persistedDescriptor,
      unknownPersistedField: 'must remain visible',
    }));
    await descriptorWritable.close();

    const reader = await createEncryptedOpfsInspectionReader({
      backingDirectory: backing,
      fileSystemRootKey: ROOT_KEY,
    });
    const overview = await reader.readOverview();
    expect(overview.descriptor.fileSystemId).toBe(overview.activeSuperblock.fileSystemId);
    expect(overview.persistedDescriptorDto).toMatchObject({
      unknownPersistedField: 'must remain visible',
    });
    expect(overview.activeCommitPersistedDto).toEqual(overview.activeCommit);
    expect(overview.activeCommit.revision).toBe(2);
    expect(overview.superblockSlots).toContainEqual(expect.objectContaining({
      status: 'valid',
      selected: true,
    }));
    const selectedSuperblockSlot = overview.superblockSlots.find(slot => slot.status === 'valid' && slot.selected);
    if (selectedSuperblockSlot === undefined || selectedSuperblockSlot.status !== 'valid') {
      throw new Error('Selected superblock fixture was missing');
    }
    expect(selectedSuperblockSlot.binary.decryptedRecord.metadataJson.utf8Text).toBeUndefined();
    const detailedSuperblockSlot = await reader.inspectSuperblockSlot({
      slot: selectedSuperblockSlot.slot,
      binaryPreviewByteLength: 64 * 1024,
    });
    expect(detailedSuperblockSlot.status).toBe('valid');
    if (detailedSuperblockSlot.status !== 'valid') throw new Error('Detailed superblock was not valid');
    expect(detailedSuperblockSlot.binary.decryptedRecord.metadataJson.utf8Text).toBe(
      JSON.stringify(detailedSuperblockSlot.persistedDto),
    );

    const page = await reader.listPhysicalObjects({ cursor: undefined, limit: 100 });
    expect(page.entries.length).toBeGreaterThan(0);
    const inspected = await reader.inspectObject({
      objectId: overview.activeCommitObjectId,
      binaryPreviewByteLength: 32,
    });
    expect(inspected).toMatchObject({
      objectId: overview.activeCommitObjectId,
      record: {
        kind: 'commit',
        recordVersion: 1,
        binaryPayloadByteLength: 0,
      },
    });
    expect(inspected?.binary.persistedObject.bytes.bytes.slice(0, 8)).toEqual(
      new Uint8Array([0x45, 0x4e, 0x43, 0x4f, 0x50, 0x46, 0x53, 0x00]),
    );
    expect(inspected?.binary.persistedObject.headerFields).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'magic', offset: 0, byteLength: 8 }),
      expect.objectContaining({ name: 'nonce', offset: 12, byteLength: 12 }),
    ]));
    expect(inspected?.binary.decryptedRecord.bytes.bytes.slice(0, 2)).toEqual(
      new Uint8Array([1, 0]),
    );
    expect(inspected?.binary.decryptedRecord.metadataJson.utf8Text).toBeUndefined();
    const inspectedWithBinaryDetails = await reader.inspectObject({
      objectId: overview.activeCommitObjectId,
      binaryPreviewByteLength: 64 * 1024,
    });
    expect(inspectedWithBinaryDetails?.binary.decryptedRecord.metadataJson.utf8Text).toBe(
      JSON.stringify(inspectedWithBinaryDetails?.record.metadata),
    );
    expect(inspected?.binary.decryptedRecord.binaryPayload.bytes).toBeInstanceOf(Uint8Array);
    expect(inspected?.binary.decryptedRecord.binaryPayload.regionByteLength).toBe(0);

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
      physicalBytes: expect.objectContaining({
        offset: 0,
        regionByteLength: 3,
        bytes: new Uint8Array([1, 2, 3]),
      }),
    }));
    expect(overview.superblockSlots).toContainEqual(expect.objectContaining({
      slot: 1,
      status: 'valid',
      selected: true,
    }));
    await reader.dispose();
    await session.close();
  });

  it('paginates physical objects with an opaque shard cursor without duplicates', async () => {
    const backing = new MockFileSystemDirectoryHandle({ name: 'backing' });
    const session = await createEncryptedOpfs({
      backingDirectory: backing,
      fileSystemRootKey: ROOT_KEY,
    });
    for (const name of ['a.txt', 'b.txt', 'c.txt']) {
      await writeStorageFileText({
        fileHandle: await session.root.getFileHandle({ name, create: true }),
        value: name.repeat(20),
      });
    }

    const reader = await createEncryptedOpfsInspectionReader({
      backingDirectory: backing,
      fileSystemRootKey: ROOT_KEY,
    });
    const completePage = await reader.listPhysicalObjects({ cursor: undefined, limit: 1000 });
    expect(completePage.nextCursor).toBeUndefined();

    const objectIds: string[] = [];
    let cursor: string | undefined;
    do {
      const page = await reader.listPhysicalObjects({ cursor, limit: 2 });
      objectIds.push(...page.entries.map(entry => entry.objectId));
      if (page.nextCursor !== undefined) {
        expect(page.nextCursor).toMatch(/^[0-9a-f]{2}\//u);
      }
      cursor = page.nextCursor;
    } while (cursor !== undefined);

    expect(objectIds.length).toBeGreaterThan(2);
    expect(new Set(objectIds).size).toBe(objectIds.length);
    expect([...objectIds].sort()).toEqual(
      completePage.entries.map(entry => entry.objectId).sort(),
    );
    await reader.dispose();
    await session.close();
  });

});
