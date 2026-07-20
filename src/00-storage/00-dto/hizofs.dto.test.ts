import { describe, expect, it } from 'vitest';
import {
  HizoFSCommitSchemaDto,
  HizoFSDescriptorSchemaDto,
  HizoFSDirectoryInodeSchemaDto,
  HizoFSFileExtentPageSchemaDto,
  HizoFSFileInodeSchemaDto,
  HizoFSInodeIndexPageSchemaDto,
  HizoFSSubvolumeDescriptorSchemaDto,
  HizoFSSubvolumeMountIndexPageSchemaDto,
  HizoFSSuperblockSchemaDto,
} from './hizofs.dto';

describe('HizoFS DTO schemas', () => {
  it('parses the HizoFS descriptor format marker', () => {
    expect(HizoFSDescriptorSchemaDto.parse({
      format: 'hizofs',
      formatVersion: 1,
      instanceId: 'instance-id',
    })).toEqual({
      format: 'hizofs',
      formatVersion: 1,
      instanceId: 'instance-id',
    });
  });

  it('strips unknown persisted fields without weakening required fields', () => {
    expect(HizoFSDescriptorSchemaDto.parse({
      format: 'hizofs',
      formatVersion: 1,
      instanceId: 'instance-id',
      addedByNewerNaidan: 'ignored',
    })).toEqual({
      format: 'hizofs',
      formatVersion: 1,
      instanceId: 'instance-id',
    });
    expect(HizoFSSubvolumeDescriptorSchemaDto.parse({
      subvolumeId: 'writable-subvolume',
      access: 'read_write',
      addedByNewerNaidan: true,
    })).toEqual({
      subvolumeId: 'writable-subvolume',
      access: 'read_write',
    });
    expect(HizoFSDescriptorSchemaDto.safeParse({
      format: 'hizofs',
      formatVersion: 1,
    }).success).toBe(false);
  });

  it('parses the immutable commit root', () => {
    expect(HizoFSCommitSchemaDto.parse({
      revision: 7,
      publicationId: 'publication-id',
      subvolumeId: 'subvolume-id',
      rootDirectoryNodeId: 'root-node',
      inodeIndexRootObjectId: 'inode-index-root',
      subvolumeMountIndexRootObjectId: 'mount-index-root',
    })).toEqual({
      revision: 7,
      publicationId: 'publication-id',
      subvolumeId: 'subvolume-id',
      rootDirectoryNodeId: 'root-node',
      inodeIndexRootObjectId: 'inode-index-root',
      subvolumeMountIndexRootObjectId: 'mount-index-root',
    });
  });

  it('parses subvolume access and mount records with one access authority', () => {
    expect(HizoFSSubvolumeDescriptorSchemaDto.parse({
      subvolumeId: 'read-subvolume',
      access: 'read',
      fixedCommitObjectId: 'commit-object',
    })).toEqual({
      subvolumeId: 'read-subvolume',
      access: 'read',
      fixedCommitObjectId: 'commit-object',
    });
    expect(HizoFSSubvolumeDescriptorSchemaDto.parse({
      subvolumeId: 'writable-subvolume',
      access: 'read_write',
    })).toEqual({
      subvolumeId: 'writable-subvolume',
      access: 'read_write',
    });
    expect(HizoFSSubvolumeMountIndexPageSchemaDto.parse({
      type: 'leaf',
      mounts: [{
        mountId: 'mount-id',
        subvolumeDescriptorObjectId: 'descriptor-object',
        parentDirectoryNodeId: 'parent-directory-node',
        entryName: 'mounted-name',
      }],
    })).toEqual({
      type: 'leaf',
      mounts: [{
        mountId: 'mount-id',
        subvolumeDescriptorObjectId: 'descriptor-object',
        parentDirectoryNodeId: 'parent-directory-node',
        entryName: 'mounted-name',
      }],
    });
    expect(HizoFSSubvolumeDescriptorSchemaDto.safeParse({
      subvolumeId: 'legacy-subvolume',
      access: 'read_only',
      fixedCommitObjectId: 'commit-object',
    }).success).toBe(false);
    expect(HizoFSSubvolumeMountIndexPageSchemaDto.parse({
      type: 'leaf',
      mounts: [{
        mountId: 'mount-id',
        subvolumeDescriptorObjectId: 'descriptor-object',
        parentDirectoryNodeId: 'parent-directory-node',
        entryName: 'mounted-name',
        access: 'read',
      }],
    })).toEqual({
      type: 'leaf',
      mounts: [{
        mountId: 'mount-id',
        subvolumeDescriptorObjectId: 'descriptor-object',
        parentDirectoryNodeId: 'parent-directory-node',
        entryName: 'mounted-name',
      }],
    });
    expect(HizoFSSubvolumeMountIndexPageSchemaDto.safeParse({
      type: 'leaf',
      mounts: [{
        mountId: 'mount-id',
        subvolumeDescriptorObjectId: 'descriptor-object',
      }],
    }).success).toBe(false);
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
      instanceId: 'instance-id',
    })).toThrow();
  });

  it('keeps the superblock version out of the DTO and selects by sequence', () => {
    expect(HizoFSSuperblockSchemaDto.parse({
      sequence: 9,
      fileSystemId: 'filesystem-id',
      subvolumeDescriptorObjectId: 'descriptor',
      activeCommitObjectId: 'commit',
    })).toEqual({
      sequence: 9,
      fileSystemId: 'filesystem-id',
      subvolumeDescriptorObjectId: 'descriptor',
      activeCommitObjectId: 'commit',
    });
  });
});
