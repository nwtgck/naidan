import { describe, expect, it, vi } from 'vitest';
import { MockFileSystemDirectoryHandle } from '@/features/wesh/mocks/InMemoryFileSystem';
import type { WeshPreparedRename } from '@/features/wesh/types';
import { WeshVFS } from '@/features/wesh/vfs';
import { getDiffRenameLimitConfigValue, getDiffRenamesConfigMode, readLocalConfigEntries, setLocalConfigValue, withRenamedLocalConfigSection } from './config';
import { pathExists, readFileText, writeFileText } from './files';
import type { GitRepository } from './repository';

describe('wesh git config serialization safety', () => {
  function createFiles(): WeshVFS {
    const rootHandle = new MockFileSystemDirectoryHandle({ name: 'root' });
    return new WeshVFS({ rootHandle: rootHandle as unknown as FileSystemDirectoryHandle });
  }

  function repository(): GitRepository {
    return { worktreePath: '/repo', gitDirPath: '/repo/.git', commonDirPath: '/repo/.git' };
  }

  it('renames every matching header while preserving the other config text', async () => {
    const files = createFiles();
    await files.mkdir({ path: '/repo/.git', recursive: true });
    const path = '/repo/.git/config';
    const text = [
      '# config\r\n',
      '[core]\r\n',
      '\tcommand = prefix\\\r\n',
      '[branch "old"]\r\n',
      '# comment ending in a backslash\\\r\n',
      '  [Branch   "old"]  # first\r\n',
      '\tremote = origin\r\n',
      '[branch "new"]\n',
      '\tpushRemote = upstream # retained comment\\\n',
      '[branch "old"] ; second\r\n',
      '\tmerge = refs/heads/main',
    ].join('');
    await writeFileText({ files, path, text });
    const publish = vi.fn(async ({ rename }: { rename: WeshPreparedRename | undefined }) => {
      expect(await pathExists({ files, path: `${path}.lock` })).toBe(true);
      expect(await readFileText({ files, path })).toBe(text);
      if (rename === undefined) {
        throw new Error('Expected a prepared config replacement');
      }
      await files.publishEntries({ changes: [rename] });
    });

    await expect(withRenamedLocalConfigSection({
      files,
      repository: repository(),
      section: 'branch',
      oldSubsection: 'old',
      newSubsection: 'new',
      publish,
    })).resolves.toBe(true);

    expect(publish).toHaveBeenCalledTimes(1);
    expect(await readFileText({ files, path })).toBe(text
      .replace('[Branch   "old"]', '[Branch   "new"]')
      .replace('[branch "old"] ; second', '[branch "new"] ; second'));
  });

  it('publishes a no-op once with the config lock still held', async () => {
    const files = createFiles();
    await files.mkdir({ path: '/repo/.git', recursive: true });
    const path = '/repo/.git/config';
    const publish = vi.fn(async ({ rename }: { rename: WeshPreparedRename | undefined }) => {
      expect(rename).toBeUndefined();
      expect(await pathExists({ files, path: `${path}.lock` })).toBe(true);
      expect(await pathExists({ files, path })).toBe(false);
    });

    await expect(withRenamedLocalConfigSection({
      files,
      repository: repository(),
      section: 'branch',
      oldSubsection: 'old',
      newSubsection: 'new',
      publish,
    })).resolves.toBe(false);
    expect(publish).toHaveBeenCalledTimes(1);
    expect(await pathExists({ files, path: `${path}.lock` })).toBe(false);
    expect(await pathExists({ files, path })).toBe(false);
  });

  it.each(['rename', 'set'])('reads the latest config after acquiring the %s operation lock', async first => {
    const files = createFiles();
    await files.mkdir({ path: '/repo/.git', recursive: true });
    const path = '/repo/.git/config';
    await writeFileText({ files, path, text: '[branch "old"]\n\tremote = origin\n' });
    const acquiring = Promise.withResolvers<void>();
    const resume = Promise.withResolvers<void>();
    using _resume = {
      [Symbol.dispose]() {
        resume.resolve();
      },
    };
    const createTemporaryFile = files.createTemporaryFile.bind(files);
    using _lock = vi.spyOn(files, 'createTemporaryFile').mockImplementationOnce(async args => {
      expect(args.path).toBe(`${path}.lock`);
      acquiring.resolve();
      await resume.promise;
      return createTemporaryFile(args);
    });

    const rename = () => withRenamedLocalConfigSection({
      files,
      repository: repository(),
      section: 'branch',
      oldSubsection: 'old',
      newSubsection: 'new',
      publish: async ({ rename: change }) => {
        if (change !== undefined) {
          await files.publishEntries({ changes: [change] });
        }
      },
    });
    const set = () => setLocalConfigValue({ files, repository: repository(), key: 'user.name', value: 'Tester', valuePattern: undefined });
    const pending = first === 'rename' ? rename() : set();
    await acquiring.promise;
    await (first === 'rename' ? set() : rename());
    resume.resolve();
    await pending;

    expect(await readLocalConfigEntries({ files, repository: repository() })).toEqual([
      { key: 'branch.new.remote', value: { kind: 'explicit', value: 'origin' } },
      { key: 'user.name', value: { kind: 'explicit', value: 'Tester' } },
    ]);
  });

  it.each([`\
one
two`, 'one\rtwo'])('round-trips Git-supported control characters in config value %j', async value => {
    const files = createFiles();
    await files.mkdir({ path: '/repo/.git', recursive: true });

    await expect(setLocalConfigValue({
      files,
      repository: repository(),
      key: 'remote.origin.url',
      value,
      valuePattern: undefined,
    })).resolves.toBe('set');
    expect(await readLocalConfigEntries({ files, repository: repository() })).toEqual([{
      key: 'remote.origin.url',
      value: { kind: 'explicit', value },
    }]);
  });

  it('rejects NUL before writing a config value', async () => {
    const files = createFiles();
    await files.mkdir({ path: '/repo/.git', recursive: true });

    await expect(setLocalConfigValue({
      files,
      repository: repository(),
      key: 'remote.origin.url',
      value: 'one\0two',
      valuePattern: undefined,
    })).rejects.toThrow("config value for 'remote.origin.url' contains NUL");
    expect(await readLocalConfigEntries({ files, repository: repository() })).toEqual([]);
  });

  it('parses diff.renameLimit with Git integer syntax', () => {
    expect(getDiffRenameLimitConfigValue({ config: new Map() })).toBeUndefined();
    expect(getDiffRenameLimitConfigValue({
      config: new Map([
        ['diff.renamelimit', { kind: 'explicit', value: '2' }],
      ]),
    })).toBe(2);
    expect(getDiffRenameLimitConfigValue({
      config: new Map([
        ['diff.renamelimit', { kind: 'explicit', value: '010' }],
      ]),
    })).toBe(8);
    expect(getDiffRenameLimitConfigValue({
      config: new Map([
        ['diff.renamelimit', { kind: 'explicit', value: '0x10' }],
      ]),
    })).toBe(16);
    expect(getDiffRenameLimitConfigValue({
      config: new Map([
        ['diff.renamelimit', { kind: 'explicit', value: '2k' }],
      ]),
    })).toBe(2_048);
    expect(getDiffRenameLimitConfigValue({
      config: new Map([
        ['diff.renamelimit', { kind: 'explicit', value: '-1' }],
      ]),
    })).toBe(-1);
    expect(() => getDiffRenameLimitConfigValue({
      config: new Map([
        ['diff.renamelimit', { kind: 'implicit-boolean' }],
      ]),
    })).toThrow("bad numeric config value '' for 'diff.renamelimit': invalid unit");
    expect(() => getDiffRenameLimitConfigValue({
      config: new Map([
        ['diff.renamelimit', { kind: 'explicit', value: '08' }],
      ]),
    })).toThrow("bad numeric config value '08' for 'diff.renamelimit': invalid unit");
    expect(() => getDiffRenameLimitConfigValue({
      config: new Map([
        ['diff.renamelimit', { kind: 'explicit', value: '2g' }],
      ]),
    })).toThrow("bad numeric config value '2g' for 'diff.renamelimit': out of range");
  });

  it('preserves Git diff.renames boolean and copies modes', () => {
    expect(getDiffRenamesConfigMode({ config: new Map() })).toBe('renames');
    expect(getDiffRenamesConfigMode({
      config: new Map([
        ['diff.renames', { kind: 'implicit-boolean' }],
      ]),
    })).toBe('renames');
    expect(getDiffRenamesConfigMode({
      config: new Map([
        ['diff.renames', { kind: 'explicit', value: 'false' }],
      ]),
    })).toBe('disabled');
    expect(getDiffRenamesConfigMode({
      config: new Map([
        ['diff.renames', { kind: 'explicit', value: 'copy' }],
      ]),
    })).toBe('copies');
    expect(getDiffRenamesConfigMode({
      config: new Map([
        ['diff.renames', { kind: 'explicit', value: 'COPIES' }],
      ]),
    })).toBe('copies');
    expect(() => getDiffRenamesConfigMode({
      config: new Map([
        ['diff.renames', { kind: 'explicit', value: 'bogus' }],
      ]),
    })).toThrow("bad boolean config value 'bogus' for 'diff.renames'");
  });
});
