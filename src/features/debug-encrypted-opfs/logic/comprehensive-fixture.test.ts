import { describe, expect, it } from 'vitest';
import { MockFileSystemDirectoryHandle } from '@/utils/in-memory-file-system';
import {
  createEncryptedOpfs,
  createEncryptedOpfsInspectionReader,
} from '@/00-storage/service/encrypted-opfs';
import type { EncryptedOpfsRecordKind } from '@/00-storage/service/encrypted-opfs/format/record';
import { readStorageFileText } from '@/00-storage/service/storage-file-system/io';
import {
  ENCRYPTED_OPFS_COMPREHENSIVE_FIXTURE_ROOT_PATH,
  generateEncryptedOpfsComprehensiveFixture,
} from './comprehensive-fixture';


const EXPECTED_OBJECT_RECORD_KINDS = {
  commit: true,
  inode_index_page: true,
  file_inode: true,
  directory_inode: true,
  symlink_inode: true,
  directory_index_page: true,
  file_extent_page: true,
  file_chunk: true,
} as const satisfies Record<Exclude<EncryptedOpfsRecordKind, 'superblock'>, true>;

describe('EncryptedOpfs comprehensive fixture', () => {
  it('generates every persisted record family and crosses each default index boundary', async () => {
    const backingDirectory = new MockFileSystemDirectoryHandle({ name: 'encrypted-backing' });
    const rootKey = new Uint8Array(32).fill(0x62);
    const session = await createEncryptedOpfs({ backingDirectory, fileSystemRootKey: rootKey });
    const progressPhases: string[] = [];

    const result = await generateEncryptedOpfsComprehensiveFixture({
      root: session.root,
      onProgress: ({ progress }) => progressPhases.push(progress.phase),
    });

    expect(result.rootPath).toBe(ENCRYPTED_OPFS_COMPREHENSIVE_FIXTURE_ROOT_PATH);
    expect(progressPhases).toEqual([
      'preparing',
      'directories',
      'files',
      'indexes',
      'symlinks',
      'mutations',
      'manifest',
      'complete',
    ]);

    const fixtureRoot = await session.root.getDirectoryHandle({
      name: '__encrypted_opfs_fixture__',
      create: false,
    });
    const manifestText = await readStorageFileText({
      fileHandle: await fixtureRoot.getFileHandle({ name: 'manifest.json', create: false }),
    });
    expect(manifestText).toContain('EncryptedOpfs persisted data-structure coverage');
    expect(manifestText).toContain('extent-index-branch');
    expect(await (await fixtureRoot.getDirectoryHandle({ name: 'links', create: false }))
      .getEntryHandle({ name: 'dangling' })).toMatchObject({ kind: 'symlink' });

    const reader = await createEncryptedOpfsInspectionReader({
      backingDirectory,
      fileSystemRootKey: rootKey,
    });
    try {
      const overview = await reader.readOverview();
      expect(overview.activeCommit.revision).toBeGreaterThan(100);
      expect(overview.superblockSlots.filter(slot => slot.status === 'valid')).toHaveLength(2);

      const structureTags = new Set<string>();
      let cursor: string | undefined;
      do {
        const page = await reader.listPhysicalObjects({ cursor, limit: 1000 });
        for (const entry of page.entries) {
          const object = await reader.inspectObject({
            objectId: entry.objectId,
            binaryPreviewByteLength: 0,
          });
          if (object === undefined) continue;
          structureTags.add(object.record.kind);
          const metadata = toRecord({ value: object.record.metadata });
          const type = metadata?.type;
          const storage = toRecord({ value: metadata?.storage });
          if (typeof type === 'string') {
            structureTags.add(`${object.record.kind}:${type}`);
          }
          if (typeof storage?.type === 'string') {
            structureTags.add(`${object.record.kind}:${storage.type}`);
          }
        }
        cursor = page.nextCursor;
      } while (cursor !== undefined);

      for (const recordKind of Object.keys(EXPECTED_OBJECT_RECORD_KINDS)) {
        expect(structureTags).toContain(recordKind);
      }
      const expectedStructureTags = [
        'inode_index_page:leaf',
        'inode_index_page:branch',
        'directory_inode:inline',
        'directory_inode:indexed',
        'file_inode:inline',
        'file_inode:extents',
        'symlink_inode',
        'directory_index_page:leaf',
        'directory_index_page:branch',
        'file_extent_page:leaf',
        'file_extent_page:branch',
        'file_chunk',
      ];
      for (const structureTag of expectedStructureTags) {
        expect(structureTags).toContain(structureTag);
      }
    } finally {
      await reader.dispose();
      await session.close();
    }
  }, 60_000);

  it('refuses to merge a second fixture into the same root', async () => {
    const backingDirectory = new MockFileSystemDirectoryHandle({ name: 'encrypted-backing' });
    const session = await createEncryptedOpfs({
      backingDirectory,
      fileSystemRootKey: new Uint8Array(32).fill(0x73),
    });
    try {
      await generateEncryptedOpfsComprehensiveFixture({
        root: session.root,
        onProgress: () => undefined,
      });
      await expect(generateEncryptedOpfsComprehensiveFixture({
        root: session.root,
        onProgress: () => undefined,
      })).rejects.toThrow(`${ENCRYPTED_OPFS_COMPREHENSIVE_FIXTURE_ROOT_PATH} already exists`);
    } finally {
      await session.close();
    }
  }, 60_000);
});

function toRecord({ value }: { value: unknown }): Readonly<Record<string, unknown>> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Readonly<Record<string, unknown>>
    : undefined;
}
