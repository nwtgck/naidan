import { describe, expect, it } from 'vitest';
import { MockFileSystemDirectoryHandle } from '@/features/wesh/mocks/InMemoryFileSystem';
import { WeshVFS } from '@/features/wesh/vfs';
import { getDiffRenameLimitConfigValue, getDiffRenamesConfigMode, readLocalConfigEntries, setLocalConfigValue } from './config';
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
    expect(getDiffRenameLimitConfigValue({ config: new Map([
      ['diff.renamelimit', { kind: 'explicit', value: '2' }],
    ]) })).toBe(2);
    expect(getDiffRenameLimitConfigValue({ config: new Map([
      ['diff.renamelimit', { kind: 'explicit', value: '010' }],
    ]) })).toBe(8);
    expect(getDiffRenameLimitConfigValue({ config: new Map([
      ['diff.renamelimit', { kind: 'explicit', value: '0x10' }],
    ]) })).toBe(16);
    expect(getDiffRenameLimitConfigValue({ config: new Map([
      ['diff.renamelimit', { kind: 'explicit', value: '2k' }],
    ]) })).toBe(2_048);
    expect(getDiffRenameLimitConfigValue({ config: new Map([
      ['diff.renamelimit', { kind: 'explicit', value: '-1' }],
    ]) })).toBe(-1);
    expect(() => getDiffRenameLimitConfigValue({ config: new Map([
      ['diff.renamelimit', { kind: 'implicit-boolean' }],
    ]) })).toThrow("bad numeric config value '' for 'diff.renamelimit': invalid unit");
    expect(() => getDiffRenameLimitConfigValue({ config: new Map([
      ['diff.renamelimit', { kind: 'explicit', value: '08' }],
    ]) })).toThrow("bad numeric config value '08' for 'diff.renamelimit': invalid unit");
    expect(() => getDiffRenameLimitConfigValue({ config: new Map([
      ['diff.renamelimit', { kind: 'explicit', value: '2g' }],
    ]) })).toThrow("bad numeric config value '2g' for 'diff.renamelimit': out of range");
  });

  it('preserves Git diff.renames boolean and copies modes', () => {
    expect(getDiffRenamesConfigMode({ config: new Map() })).toBe('renames');
    expect(getDiffRenamesConfigMode({ config: new Map([
      ['diff.renames', { kind: 'implicit-boolean' }],
    ]) })).toBe('renames');
    expect(getDiffRenamesConfigMode({ config: new Map([
      ['diff.renames', { kind: 'explicit', value: 'false' }],
    ]) })).toBe('disabled');
    expect(getDiffRenamesConfigMode({ config: new Map([
      ['diff.renames', { kind: 'explicit', value: 'copy' }],
    ]) })).toBe('copies');
    expect(getDiffRenamesConfigMode({ config: new Map([
      ['diff.renames', { kind: 'explicit', value: 'COPIES' }],
    ]) })).toBe('copies');
    expect(() => getDiffRenamesConfigMode({ config: new Map([
      ['diff.renames', { kind: 'explicit', value: 'bogus' }],
    ]) })).toThrow("bad boolean config value 'bogus' for 'diff.renames'");
  });
});
