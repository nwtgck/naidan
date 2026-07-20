import { describe, expect, it } from 'vitest';
import { MockFileSystemDirectoryHandle } from '@/utils/in-memory-file-system';
import { writeStorageFileText } from '@/00-storage/service/storage-file-system/io';
import { createHizoFS } from './api';
import { createHizoFSInspectionReader } from './inspection';
import { NativeOpfsHizoFSBackingStore } from './backing-store/native-opfs-backing-store';
import { deriveHizoFSFileSystemId, importHizoFSRootKey } from './crypto/object-crypto';
import { HizoFSGarbageCollectionCheckpointStore, TEST_ONLY as CHECKPOINT_TEST_ONLY } from './garbage-collection-checkpoint';

const ROOT_KEY = new Uint8Array(32).fill(23);

describe('HizoFS inspection reader', () => {
  it('exposes authenticated persisted state without exposing the root key', async () => {
    const backing = new MockFileSystemDirectoryHandle({ name: 'backing' });
    const session = await createHizoFS({
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
      formatVersion: 'invalid',
      unknownPersistedField: 'must remain visible',
    }));
    await descriptorWritable.close();

    const reader = await createHizoFSInspectionReader({
      backingDirectory: backing,
      fileSystemRootKey: ROOT_KEY,
    });
    const overview = await reader.readOverview();
    expect(overview.fileSystemId).toBe(overview.activeSuperblock.fileSystemId);
    expect(overview.activeMode).toBe('current');
    expect(overview.persistedDescriptorDto).toMatchObject({
      unknownPersistedField: 'must remain visible',
    });
    expect(overview.descriptorValidationError).toContain('formatVersion');
    expect(overview.activeCommitPersistedDto).toEqual(overview.activeCommit);
    expect(overview.activeCommit.revision).toBe(2);
    expect(overview.superblockSlots).toContainEqual(expect.objectContaining({
      status: 'valid',
      selected: true,
    }));
    expect(overview.maintenance.relocationMap).toMatchObject({
      status: 'valid',
      sequence: 0,
      mappingCount: 0,
    });
    expect(overview.maintenance.garbageCollectionCheckpoint).toEqual({ status: 'absent' });
    expect(overview.maintenance.recoveryAssessment.automaticRepairPerformed).toBe(false);
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
      new Uint8Array([0x48, 0x5a, 0x52, 0x45, 0x43, 0x30, 0x30, 0x31]),
    );
    expect(inspected?.binary.persistedObject.headerFields).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'magic', offset: 0, byteLength: 8 }),
      expect.objectContaining({ name: 'nonce', offset: 56, byteLength: 12 }),
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

  it('reports a non-canonical descriptor instance identity without using it for coordination', async () => {
    const backing = new MockFileSystemDirectoryHandle({ name: 'backing' });
    const session = await createHizoFS({
      backingDirectory: backing,
      fileSystemRootKey: ROOT_KEY,
    });
    await session.close();

    const descriptorFile = await backing.getFileHandle('descriptor.json');
    const descriptor = JSON.parse(
      await (await descriptorFile.getFile()).text(),
    ) as Record<string, unknown>;
    const writable = await descriptorFile.createWritable({
      keepExistingData: false,
    });
    await writable.write(JSON.stringify({
      ...descriptor,
      instanceId: '../shared-maintenance-lock',
    }));
    await writable.close();

    const reader = await createHizoFSInspectionReader({
      backingDirectory: backing,
      fileSystemRootKey: ROOT_KEY,
    });
    try {
      const overview = await reader.readOverview();
      expect(overview.persistedDescriptorDto).toMatchObject({
        instanceId: '../shared-maintenance-lock',
      });
      expect(overview.descriptorValidationError).toContain(
        'instanceId must be canonical Base64URL',
      );
      expect(overview.descriptor.instanceId)
        .not.toBe('../shared-maintenance-lock');
    } finally {
      await reader.dispose();
    }
  });

  it('reports fallback read-only mode when the newest superblock is invalid', async () => {
    const backing = new MockFileSystemDirectoryHandle({ name: 'backing' });
    const session = await createHizoFS({
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

    const beforeCorruptionReader = await createHizoFSInspectionReader({
      backingDirectory: backing,
      fileSystemRootKey: ROOT_KEY,
    });
    const beforeCorruption = await beforeCorruptionReader.readOverview();
    const activeSlot = beforeCorruption.superblockSlots.find(
      slot => slot.status === 'valid' && slot.selected,
    );
    if (activeSlot === undefined || activeSlot.status !== 'valid') {
      throw new Error('Active superblock fixture was missing');
    }
    await beforeCorruptionReader.dispose();

    const invalidSlot = await backing.getFileHandle(`head-${String(activeSlot.slot)}.hfs`);
    const writable = await invalidSlot.createWritable({ keepExistingData: false });
    await writable.write(new Uint8Array([1, 2, 3]));
    await writable.close();

    const reader = await createHizoFSInspectionReader({
      backingDirectory: backing,
      fileSystemRootKey: ROOT_KEY,
    });
    const overview = await reader.readOverview();
    expect(overview.activeMode).toBe('fallback');
    expect(overview.maintenance.recoveryAssessment.status).toBe('degraded');
    expect(overview.maintenance.recoveryAssessment.reasons).toEqual(expect.arrayContaining([
      expect.stringContaining('fallback'),
      expect.stringContaining('superblock slot'),
    ]));
    expect(overview.superblockSlots).toContainEqual(expect.objectContaining({
      slot: activeSlot.slot,
      status: 'invalid',
      selected: false,
      physicalBytes: expect.objectContaining({
        offset: 0,
        regionByteLength: 3,
        bytes: new Uint8Array([1, 2, 3]),
      }),
    }));
    expect(overview.superblockSlots).toContainEqual(expect.objectContaining({
      status: 'valid',
      selected: true,
    }));
    await reader.dispose();
    await session.close();
  });

  it('reports unusable authenticated GC checkpoint slots without attempting automatic repair', async () => {
    const backing = new MockFileSystemDirectoryHandle({ name: 'backing' });
    const session = await createHizoFS({
      backingDirectory: backing,
      fileSystemRootKey: ROOT_KEY,
    });
    await writeStorageFileText({
      fileHandle: await session.root.getFileHandle({ name: 'value.txt', create: true }),
      value: 'value',
    });
    await session.close();

    const beforeReader = await createHizoFSInspectionReader({
      backingDirectory: backing,
      fileSystemRootKey: ROOT_KEY,
    });
    const beforeOverview = await beforeReader.readOverview();
    await beforeReader.dispose();

    const backingStore = new NativeOpfsHizoFSBackingStore({
      root: backing,
      fileHandleCacheEntryLimit: 8,
      fileSnapshotCacheEntryLimit: 8,
      diagnostics: undefined,
    });
    const rootKey = await importHizoFSRootKey({ rawRootKey: ROOT_KEY });
    const fileSystemId = await deriveHizoFSFileSystemId({ rootKey });
    const checkpointStore = new HizoFSGarbageCollectionCheckpointStore({
      backingStore,
      rootKey,
      fileSystemId,
    });
    await checkpointStore.write({
      checkpoint: {
        sequence: 1,
        activeCommitObjectId: beforeOverview.activeCommitObjectId,
        phase: 'sweep',
        completedCompactionCandidateCount: 0,
        completedSweepCandidateCount: 0,
        relocatedObjectCount: 0,
        reclaimedCompactionObjectCount: 0,
        removedSweepObjectCount: 0,
        lastCompletedCandidateObjectId: null,
      },
    });
    for (const slot of [0, 1] as const) {
      await backingStore.write({
        path: CHECKPOINT_TEST_ONLY.pathForSlot({ slot }),
        bytes: new Uint8Array([1, 2, 3]),
      });
    }

    const reader = await createHizoFSInspectionReader({
      backingDirectory: backing,
      fileSystemRootKey: ROOT_KEY,
    });
    const overview = await reader.readOverview();
    expect(overview.maintenance.garbageCollectionCheckpoint).toMatchObject({ status: 'invalid' });
    expect(overview.maintenance.recoveryAssessment).toMatchObject({
      status: 'manual_review_required',
      automaticRepairPerformed: false,
    });
    expect(overview.maintenance.recoveryAssessment.reasons).toContain(
      'no authenticated garbage-collection checkpoint slot is usable',
    );
    await reader.dispose();
  });

  it('paginates physical objects with an opaque shard cursor without duplicates', async () => {
    const backing = new MockFileSystemDirectoryHandle({ name: 'backing' });
    const session = await createHizoFS({
      backingDirectory: backing,
      fileSystemRootKey: ROOT_KEY,
    });
    for (const name of ['a.txt', 'b.txt', 'c.txt']) {
      await writeStorageFileText({
        fileHandle: await session.root.getFileHandle({ name, create: true }),
        value: name.repeat(20),
      });
    }

    const reader = await createHizoFSInspectionReader({
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
        expect(page.nextCursor).toMatch(/^[A-Za-z0-9_-]{43}$/u);
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
