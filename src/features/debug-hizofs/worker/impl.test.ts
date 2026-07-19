import { describe, expect, it } from 'vitest';
import { MockFileSystemDirectoryHandle } from '@/utils/in-memory-file-system';
import { writeStorageFileText } from '@/00-storage/service/storage-file-system/io';
import { createHizoFS } from '@/00-storage/service/hizofs/api';
import { createHizoFSInspectionReader } from '@/00-storage/service/hizofs/inspection';
import { createHizoFSInspectionWorker, TEST_ONLY } from './impl';
import {
  hizoFSInspectedObjectViewSchema,
  hizoFSResolvedNodeSchema,
} from './types';

const ROOT_KEY = new Uint8Array(32).fill(29);

describe('HizoFS inspection worker', () => {
  it('builds namespace and reachability views from persisted DTO records', async () => {
    const backing = new MockFileSystemDirectoryHandle({ name: 'backing' });
    const session = await createHizoFS({
      backingDirectory: backing,
      fileSystemRootKey: ROOT_KEY,
    });
    const directory = await session.root.getDirectoryHandle({ name: 'docs', create: true });
    await writeStorageFileText({
      fileHandle: await directory.getFileHandle({ name: 'readme.txt', create: true }),
      value: 'hello',
    });
    await directory.createSymlink({ name: 'latest', target: 'readme.txt' });
    for (let index = 0; index < 31; index += 1) {
      await writeStorageFileText({
        fileHandle: await directory.getFileHandle({
          name: `entry-${String(index).padStart(2, '0')}.txt`,
          create: true,
        }),
        value: String(index),
      });
    }

    const reader = await createHizoFSInspectionReader({
      backingDirectory: backing,
      fileSystemRootKey: ROOT_KEY,
    });
    const worker = createHizoFSInspectionWorker();
    await worker.configure(reader);

    const namespace = await worker.readNamespace({ maximumEntryCount: 100 });
    expect(namespace.truncated).toBe(false);
    expect(namespace.issues).toEqual([]);
    expect(namespace.entries).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: '/', kind: 'directory' }),
      expect.objectContaining({ path: '/docs', kind: 'directory' }),
      expect.objectContaining({ path: '/docs/readme.txt', kind: 'file', size: 5 }),
      expect.objectContaining({ path: '/docs/latest', kind: 'symlink' }),
    ]));

    const scan = await worker.runIntegrityScan();
    expect(scan.issues).toEqual([]);
    expect(scan.activeReachableObjectCount).toBeGreaterThan(0);
    expect(scan.reachableObjectCount).toBeGreaterThanOrEqual(scan.activeReachableObjectCount);
    expect(scan.physicalObjectCount).toBeGreaterThanOrEqual(scan.reachableObjectCount);
    expect(scan.recordKindCounts.commit).toBeGreaterThanOrEqual(1);

    const overview = await worker.readOverview();
    const commit = await worker.inspectObject({
      objectId: overview.activeCommitObjectId,
      binaryPreviewByteLength: 16,
    });
    expect(hizoFSInspectedObjectViewSchema.parse(commit)).toEqual(commit);
    expect(commit).toMatchObject({
      validation: { status: 'valid' },
      references: [{ relation: 'inode index root' }],
      rootDirectoryEntryPoint: {
        commitObjectId: overview.activeCommitObjectId,
        rootDirectoryNodeId: overview.activeCommit.rootDirectoryNodeId,
      },
    });

    const root = await worker.readNode({
      commitObjectId: overview.activeCommitObjectId,
      nodeId: overview.activeCommit.rootDirectoryNodeId,
      logicalPath: '/',
      maximumDirectoryEntryCount: 100,
    });
    expect(hizoFSResolvedNodeSchema.parse(root)).toEqual(root);
    expect(root).toMatchObject({
      logicalPath: '/',
      inodeKind: 'directory',
      nodeId: overview.activeCommit.rootDirectoryNodeId,
      commitObjectId: overview.activeCommitObjectId,
      directory: {
        storageType: 'inline',
        truncated: false,
        issues: [],
      },
    });
    expect(root.inodeIndexLookup.length).toBeGreaterThan(0);
    const docsEntry = root.directory?.entries.find(({ entry }) => entry.name === 'docs');
    expect(docsEntry).toBeDefined();
    if (docsEntry === undefined) throw new Error('Root directory did not contain docs');
    if (docsEntry.entry.kind === 'subvolume') {
      throw new Error('docs unexpectedly resolved to a subvolume');
    }

    const docs = await worker.readNode({
      commitObjectId: root.commitObjectId,
      nodeId: docsEntry.entry.nodeId,
      logicalPath: '/docs',
      maximumDirectoryEntryCount: 100,
    });
    expect(docs).toMatchObject({
      logicalPath: '/docs',
      inodeKind: 'directory',
      directory: {
        storageType: 'indexed',
        truncated: false,
        issues: [],
      },
    });
    expect(docs.directory?.directoryIndexRootObjectId).toBeDefined();
    expect(docs.directory?.entries).toEqual(expect.arrayContaining([
      expect.objectContaining({
        entry: expect.objectContaining({ name: 'readme.txt', kind: 'file' }),
      }),
      expect.objectContaining({
        entry: expect.objectContaining({ name: 'latest', kind: 'symlink' }),
      }),
    ]));

    const readmeEntry = docs.directory?.entries.find(({ entry }) => entry.name === 'readme.txt');
    if (readmeEntry === undefined) throw new Error('docs directory did not contain readme.txt');
    if (readmeEntry.entry.kind === 'subvolume') {
      throw new Error('readme.txt unexpectedly resolved to a subvolume');
    }
    expect(readmeEntry.source).toMatchObject({ type: 'indexed' });
    const limitedDocs = await worker.readNode({
      commitObjectId: root.commitObjectId,
      nodeId: docsEntry.entry.nodeId,
      logicalPath: '/docs',
      maximumDirectoryEntryCount: 5,
    });
    expect(limitedDocs.directory).toMatchObject({
      storageType: 'indexed',
      truncated: true,
    });
    expect(limitedDocs.directory?.entries).toHaveLength(5);
    const resolvedPath = await worker.readPath({
      commitObjectId: root.commitObjectId,
      logicalPath: '/docs/readme.txt',
      maximumDirectoryEntryCount: 5,
    });
    expect(resolvedPath.map(node => node.logicalPath)).toEqual([
      '/',
      '/docs',
      '/docs/readme.txt',
    ]);
    expect(resolvedPath[1]?.directory).toMatchObject({
      storageType: 'indexed',
      truncated: true,
    });
    expect(resolvedPath[1]?.directory?.entries).toEqual(expect.arrayContaining([
      expect.objectContaining({
        entry: expect.objectContaining({ name: 'readme.txt', kind: 'file' }),
        source: expect.objectContaining({ type: 'indexed' }),
      }),
    ]));
    const readme = await worker.readNode({
      commitObjectId: root.commitObjectId,
      nodeId: readmeEntry.entry.nodeId,
      logicalPath: '/docs/readme.txt',
      maximumDirectoryEntryCount: 100,
    });
    expect(readme).toMatchObject({
      logicalPath: '/docs/readme.txt',
      inodeKind: 'file',
      binaryPayloadByteLength: 5,
      directory: undefined,
    });
    const readmeObject = await reader.inspectObject({
      objectId: readme.inodeObjectId,
      binaryPreviewByteLength: 16,
    });
    expect(readmeObject).toBeDefined();
    expect(Array.from(
      readmeObject?.binary.decryptedRecord.binaryPayload.bytes ?? new Uint8Array(),
    )).toEqual(Array.from(new TextEncoder().encode('hello')));
    expect(readmeObject?.binary.decryptedRecord.binaryPayload).toMatchObject({
      regionByteLength: 5,
      truncatedAfter: false,
    });

    await reader.dispose();
    await session.close();
  });

  it('keeps the exact record metadata for Raw DTO display while using parsed data for references', () => {
    const metadata = {
      revision: 7,
      publicationId: 'publication-7',
      subvolumeId: 'AAAAAAAAAAAAAAAAAAAAAA',
      rootDirectoryNodeId: 'root-node',
      inodeIndexRootObjectId: 'inode-index-root',
      subvolumeMountIndexRootObjectId: 'subvolume-mount-index-root',
      unknownPersistedField: 'must remain visible',
    };
    const result = TEST_ONLY.parsePersistedDto({
      object: {
        objectId: 'commit-object',
        physicalPath: ['objects', '00', 'commit-object.enc'],
        physicalByteLength: 64,
        binary: {
          persistedObject: {
            bytes: {
              offset: 0,
              regionByteLength: 64,
              bytes: new Uint8Array([0x48, 0x49, 0x5a, 0x4f, 0x46, 0x53, 0x00, 0x00]),
              truncatedAfter: true,
            },
            headerFields: [],
            ciphertextOffset: 32,
            ciphertextByteLength: 32,
          },
          decryptedRecord: {
            bytes: {
              offset: 0,
              regionByteLength: 16,
              bytes: new Uint8Array(16),
              truncatedAfter: false,
            },
            headerFields: [],
            metadataJson: {
              bytes: {
                offset: 16,
                regionByteLength: 0,
                bytes: new Uint8Array(),
                truncatedAfter: false,
              },
              utf8Text: JSON.stringify(metadata),
            },
            binaryPayload: {
              offset: 16,
              regionByteLength: 0,
              bytes: new Uint8Array(),
              truncatedAfter: false,
            },
          },
        },
        record: {
          kind: 'commit',
          recordVersion: 1,
          metadata,
          binaryPayloadByteLength: 0,
        },
      },
    });

    expect(result.validation).toEqual({
      status: 'valid',
      persistedDto: metadata,
    });
    expect(result.references).toEqual([{
      relation: 'inode index root',
      objectId: 'inode-index-root',
    }]);
  });

  it('protects objects referenced only by the valid fallback superblock generation', async () => {
    const backing = new MockFileSystemDirectoryHandle({ name: 'backing' });
    const session = await createHizoFS({
      backingDirectory: backing,
      fileSystemRootKey: ROOT_KEY,
    });
    await writeStorageFileText({
      fileHandle: await session.root.getFileHandle({ name: 'old.txt', create: true }),
      value: 'old',
    });
    const newFile = await session.root.getFileHandle({ name: 'new.txt', create: true });
    const readerBefore = await createHizoFSInspectionReader({
      backingDirectory: backing,
      fileSystemRootKey: ROOT_KEY,
    });
    const previousOverview = await readerBefore.readOverview();
    await readerBefore.dispose();

    await writeStorageFileText({
      fileHandle: newFile,
      value: 'new',
    });

    const reader = await createHizoFSInspectionReader({
      backingDirectory: backing,
      fileSystemRootKey: ROOT_KEY,
    });
    const worker = createHizoFSInspectionWorker();
    await worker.configure(reader);
    const scan = await worker.runIntegrityScan();

    expect(scan.fallbackReachableObjectCount).toBeGreaterThan(0);
    expect(scan.fallbackOnlyObjectIds).toContain(previousOverview.activeCommitObjectId);
    expect(scan.orphanObjectIds).not.toContain(previousOverview.activeCommitObjectId);

    await reader.dispose();
    await session.close();
  });

});
