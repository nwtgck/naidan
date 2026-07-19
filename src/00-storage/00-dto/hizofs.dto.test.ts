import { describe, expect, it } from 'vitest';
import {
  HizoFSCommitSchemaDto,
  HizoFSDescriptorSchemaDto,
  HizoFSDirectoryInodeSchemaDto,
  HizoFSFileExtentPageSchemaDto,
  HizoFSFileInodeSchemaDto,
  HizoFSInodeIndexPageSchemaDto,
  HizoFSSuperblockSchemaDto,
} from './hizofs.dto';

describe('HizoFS DTO schemas', () => {
  it('parses the HizoFS descriptor format marker', () => {
    expect(HizoFSDescriptorSchemaDto.parse({
      format: 'hizofs',
      formatVersion: 1,
    })).toEqual({
      format: 'hizofs',
      formatVersion: 1,
    });
  });

  it('parses the immutable commit root', () => {
    expect(HizoFSCommitSchemaDto.parse({
      revision: 7,
      publicationId: 'publication-id',
      rootDirectoryNodeId: 'root-node',
      inodeIndexRootObjectId: 'inode-index-root',
    })).toEqual({
      revision: 7,
      publicationId: 'publication-id',
      rootDirectoryNodeId: 'root-node',
      inodeIndexRootObjectId: 'inode-index-root',
    });
  });

  it('parses an inline file inode', () => {
    expect(HizoFSFileInodeSchemaDto.parse({
      nodeId: 'file-node',
      revision: 3,
      createdAt: null,
      modifiedAt: 42,
      size: 12,
      storage: { type: 'inline' },
    }).storage).toEqual({ type: 'inline' });
  });

  it('parses an extent-backed file inode', () => {
    expect(HizoFSFileInodeSchemaDto.parse({
      nodeId: 'file-node',
      revision: 4,
      createdAt: 1,
      modifiedAt: 2,
      size: 1024,
      storage: {
        type: 'extents',
        chunkSize: 256,
        extentIndexRootObjectId: 'extent-root',
      },
    }).storage).toEqual({
      type: 'extents',
      chunkSize: 256,
      extentIndexRootObjectId: 'extent-root',
    });
  });

  it('parses inline directory entries', () => {
    expect(HizoFSDirectoryInodeSchemaDto.parse({
      nodeId: 'directory-node',
      revision: 1,
      createdAt: null,
      modifiedAt: null,
      storage: {
        type: 'inline',
        entries: [{ name: 'a', kind: 'file', nodeId: 'file-node' }],
      },
    }).storage).toEqual({
      type: 'inline',
      entries: [{ name: 'a', kind: 'file', nodeId: 'file-node' }],
    });
  });

  it('parses leaf and branch index pages', () => {
    expect(HizoFSInodeIndexPageSchemaDto.parse({
      type: 'leaf',
      entries: [{ nodeId: 'a', inodeObjectId: 'object-a' }],
    }).type).toBe('leaf');
    expect(HizoFSFileExtentPageSchemaDto.parse({
      type: 'branch',
      children: [{ upperBoundChunkIndex: 12, childPageObjectId: 'page' }],
    }).type).toBe('branch');
  });

  it('rejects an unsupported descriptor version', () => {
    expect(() => HizoFSDescriptorSchemaDto.parse({
      format: 'hizofs',
      formatVersion: 2,
    })).toThrow();
  });

  it('keeps the superblock version out of the DTO and selects by sequence', () => {
    expect(HizoFSSuperblockSchemaDto.parse({
      sequence: 9,
      fileSystemId: 'filesystem-id',
      activeCommitObjectId: 'commit',
    })).toEqual({
      sequence: 9,
      fileSystemId: 'filesystem-id',
      activeCommitObjectId: 'commit',
    });
  });
});
