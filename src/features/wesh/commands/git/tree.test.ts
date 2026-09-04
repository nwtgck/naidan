import { describe, expect, it } from 'vitest';
import { MockFileSystemDirectoryHandle } from '@/features/wesh/mocks/InMemoryFileSystem';
import { WeshVFS } from '@/features/wesh/vfs';
import { concatBytes, hexToBytes } from './bytes';
import { writeObject } from './objects';
import type { GitRepository } from './repository';
import { readTreePath, readTreeRecursively } from './tree';

const encoder = new TextEncoder();

describe('wesh git tree pathname safety', () => {
  function createFiles(): WeshVFS {
    const rootHandle = new MockFileSystemDirectoryHandle({ name: 'root' });
    return new WeshVFS({ rootHandle: rootHandle as unknown as FileSystemDirectoryHandle });
  }

  async function createRepository({ files }: { files: WeshVFS }): Promise<GitRepository> {
    const repository = { worktreePath: '/repo', gitDirPath: '/repo/.git', commonDirPath: '/repo/.git' };
    await files.mkdir({ path: '/repo/.git/objects', recursive: true });
    return repository;
  }

  async function writeSingleEntryTree({ files, repository, name }: {
    files: WeshVFS,
    repository: GitRepository,
    name: string,
  }): Promise<string> {
    const blobObjectId = await writeObject({
      files,
      repository,
      type: 'blob',
      body: encoder.encode('payload\n'),
    });
    return writeObject({
      files,
      repository,
      type: 'tree',
      body: concatBytes({
        chunks: [encoder.encode(`100644 ${name}\0`), hexToBytes({ hex: blobObjectId })],
      }),
    });
  }

  it('safe-fails non-UTF-8 tree pathname bytes explicitly', async () => {
    const files = createFiles();
    const repository = await createRepository({ files });
    const blobObjectId = await writeObject({
      files,
      repository,
      type: 'blob',
      body: encoder.encode('payload\n'),
    });
    const treeObjectId = await writeObject({
      files,
      repository,
      type: 'tree',
      body: concatBytes({
        chunks: [encoder.encode('100644 '), Uint8Array.of(0xff, 0), hexToBytes({ hex: blobObjectId })],
      }),
    });

    await expect(readTreeRecursively({ files, repository, treeObjectId })).rejects.toThrow(
      'non-UTF-8 tree pathname is not supported yet',
    );
  });

  it('resolves one path without reading an unrelated corrupt sibling subtree', async () => {
    const files = createFiles();
    const repository = await createRepository({ files });
    const corruptTreeObjectId = await writeObject({
      files,
      repository,
      type: 'tree',
      body: encoder.encode('corrupt'),
    });
    const targetObjectId = await writeObject({
      files,
      repository,
      type: 'blob',
      body: encoder.encode('target\n'),
    });
    const treeObjectId = await writeObject({
      files,
      repository,
      type: 'tree',
      body: concatBytes({
        chunks: [
          encoder.encode('40000 broken\0'),
          hexToBytes({ hex: corruptTreeObjectId }),
          encoder.encode('100644 target.txt\0'),
          hexToBytes({ hex: targetObjectId }),
        ],
      }),
    });

    await expect(readTreeRecursively({ files, repository, treeObjectId })).rejects.toThrow(
      `corrupt tree ${corruptTreeObjectId}: missing mode separator`,
    );
    await expect(readTreePath({ files, repository, treeObjectId, path: 'target.txt' })).resolves.toEqual({
      path: 'target.txt',
      objectId: targetObjectId,
      mode: 0o100644,
    });
  });

  it.each(['..', '.git', 'a/b'])('rejects malformed tree entry name %j', async name => {
    const files = createFiles();
    const repository = await createRepository({ files });
    const treeObjectId = await writeSingleEntryTree({ files, repository, name });

    await expect(readTreeRecursively({ files, repository, treeObjectId })).rejects.toThrow('invalid tree entry name');
  });
});
