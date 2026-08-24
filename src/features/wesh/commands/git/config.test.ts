import { describe, expect, it } from 'vitest';
import { MockFileSystemDirectoryHandle } from '@/features/wesh/mocks/InMemoryFileSystem';
import { WeshVFS } from '@/features/wesh/vfs';
import { readLocalConfigEntries, setLocalConfigValue } from './config';
import type { GitRepository } from './repository';

describe('wesh git config serialization safety', () => {
  function createFiles(): WeshVFS {
    const rootHandle = new MockFileSystemDirectoryHandle({ name: 'root' });
    return new WeshVFS({ rootHandle: rootHandle as unknown as FileSystemDirectoryHandle });
  }

  function repository(): GitRepository {
    return { worktreePath: '/repo', gitDirPath: '/repo/.git', commonDirPath: '/repo/.git' };
  }

  it.each([`\
one
two`, 'one\rtwo', 'one\0two'])('rejects control characters before writing config value %j', async value => {
    const files = createFiles();
    await files.mkdir({ path: '/repo/.git', recursive: true });

    await expect(setLocalConfigValue({
      files,
      repository: repository(),
      key: 'remote.origin.url',
      value,
    })).rejects.toThrow("config value for 'remote.origin.url' contains an unsupported control character");
    expect(await readLocalConfigEntries({ files, repository: repository() })).toEqual([]);
  });
});
