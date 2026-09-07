import { describe, expect, it } from 'vitest';
import { MockFileSystemDirectoryHandle } from '@/features/wesh/mocks/InMemoryFileSystem';
import { WeshVFS } from '@/features/wesh/vfs';
import { findMergeBases } from './graph';
import { writeObject } from './objects';
import type { GitRepository } from './repository';

const encoder = new TextEncoder();
const treeObjectId = '0000000000000000000000000000000000000000';

function createFiles(): WeshVFS {
  const rootHandle = new MockFileSystemDirectoryHandle({ name: 'root' });
  return new WeshVFS({ rootHandle: rootHandle as unknown as FileSystemDirectoryHandle });
}

async function createRepository({ files }: { files: WeshVFS }): Promise<GitRepository> {
  const repository = { worktreePath: '/repo', gitDirPath: '/repo/.git', commonDirPath: '/repo/.git' };
  await files.mkdir({ path: '/repo/.git/objects', recursive: true });
  return repository;
}

async function writeCommit({ files, repository, parentObjectIds, subject }: {
  files: WeshVFS,
  repository: GitRepository,
  parentObjectIds: readonly string[],
  subject: string,
}): Promise<string> {
  const body = `\
tree ${treeObjectId}
${parentObjectIds.map(objectId => `parent ${objectId}\n`).join('')}author Tester <tester@example.com> 981173106 +0000
committer Tester <tester@example.com> 981173106 +0000

${subject}
`;
  return writeObject({ files, repository, type: 'commit', body: encoder.encode(body) });
}

describe('wesh git commit graph', () => {
  it('returns the descendant when one commit is an ancestor of the other', async () => {
    const files = createFiles();
    const repository = await createRepository({ files });
    const root = await writeCommit({ files, repository, parentObjectIds: [], subject: 'root' });
    const child = await writeCommit({ files, repository, parentObjectIds: [root], subject: 'child' });

    expect(await findMergeBases({
      files,
      repository,
      cache: undefined,
      leftObjectId: root,
      rightObjectId: child,
    })).toEqual([root]);
  });

  it('keeps multiple incomparable best merge bases', async () => {
    const files = createFiles();
    const repository = await createRepository({ files });
    const root = await writeCommit({ files, repository, parentObjectIds: [], subject: 'root' });
    const leftBase = await writeCommit({ files, repository, parentObjectIds: [root], subject: 'left-base' });
    const rightBase = await writeCommit({ files, repository, parentObjectIds: [root], subject: 'right-base' });
    const left = await writeCommit({
      files,
      repository,
      parentObjectIds: [leftBase, rightBase],
      subject: 'left',
    });
    const right = await writeCommit({
      files,
      repository,
      parentObjectIds: [rightBase, leftBase],
      subject: 'right',
    });

    expect(await findMergeBases({
      files,
      repository,
      cache: undefined,
      leftObjectId: left,
      rightObjectId: right,
    })).toEqual([leftBase, rightBase].sort());
  });
});
