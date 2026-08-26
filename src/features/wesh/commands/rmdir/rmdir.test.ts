import { beforeEach, describe, expect, it } from 'vitest';
import { Wesh } from '@/features/wesh/index';
import { MockFileSystemDirectoryHandle } from '@/features/wesh/mocks/InMemoryFileSystem';
import {
  createTestReadHandleFromText,
  createTestWriteCaptureHandle,
} from '@/features/wesh/utils/test-stream';

describe('wesh rmdir', () => {
  let wesh: Wesh;
  let rootHandle: MockFileSystemDirectoryHandle;

  beforeEach(async () => {
    rootHandle = new MockFileSystemDirectoryHandle({ name: 'root' });
    wesh = new Wesh({ rootHandle: rootHandle as unknown as FileSystemDirectoryHandle });
    await wesh.init();
  });

  async function createDir({
    path,
  }: {
    path: string,
  }) {
    const segments = path.split('/').filter(Boolean);
    let dir = rootHandle;
    for (const segment of segments) {
      dir = await dir.getDirectoryHandle(segment, { create: true });
    }
    return dir;
  }

  async function execute({
    script,
  }: {
    script: string,
  }) {
    const stdout = createTestWriteCaptureHandle();
    const stderr = createTestWriteCaptureHandle();

    const result = await wesh.execute({
      script,
      stdin: createTestReadHandleFromText({ text: '' }),
      stdout: stdout.handle,
      stderr: stderr.handle,
    });

    return { result, stdout, stderr };
  }

  it('removes empty directories', async () => {
    await createDir({ path: 'empty' });

    const { result, stdout, stderr } = await execute({
      script: 'rmdir empty',
    });

    const check = await execute({
      script: 'test -e empty',
    });

    expect(stdout.text).toBe('');
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
    expect(check.result.exitCode).toBe(1);
  });

  it('reports missing operands with usage', async () => {
    const { result, stdout, stderr } = await execute({
      script: 'rmdir',
    });

    expect(stdout.text).toBe('');
    expect(stderr.text).toContain('rmdir: missing operand');
    expect(stderr.text).toContain('usage: rmdir directory...');
    expect(stderr.text).toContain('try:');
    expect(stderr.text).toContain('--help');
    expect(result.exitCode).toBe(1);
  });

  it('reports non-empty directories and returns non-zero', async () => {
    const dir = await createDir({ path: 'full' });
    const handle = await dir.getFileHandle('file.txt', { create: true });
    const writable = await handle.createWritable();
    await writable.write('alpha\n');
    await writable.close();

    const { result, stdout, stderr } = await execute({
      script: 'rmdir full',
    });

    expect(stdout.text).toBe('');
    expect(stderr.text).toContain("rmdir: failed to remove 'full':");
    expect(result.exitCode).toBe(1);
  });

  it('prints help with --help', async () => {
    const { result, stdout, stderr } = await execute({
      script: 'rmdir --help',
    });

    expect(stderr.text).toBe('');
    expect(stdout.text).toContain('Remove empty directories');
    expect(stdout.text).toContain('usage: rmdir directory...');
    expect(stdout.text).toContain('--help');
    expect(result.exitCode).toBe(0);
  });

  it('supports -p to remove empty parent directories', async () => {
    await createDir({ path: 'one/two' });

    const removed = await execute({ script: 'rmdir -p one/two' });

    expect(removed.result.exitCode).toBe(0);
    expect(removed.stderr.text).toBe('');
    await expect(wesh.vfs.lstat({ path: '/one' })).rejects.toThrow();
  });

  it('normalizes repeated separators while walking lexical parents', async () => {
    await createDir({ path: 'one/two' });

    const removed = await execute({ script: 'rmdir -p one///two////' });

    expect(removed.result.exitCode).toBe(0);
    expect(removed.stderr.text).toBe('');
    await expect(wesh.vfs.lstat({ path: '/one' })).rejects.toThrow();
  });

  it('rejects dot parents before they can remove the referenced directory', async () => {
    await createDir({ path: 'one/two' });

    const removed = await execute({ script: 'rmdir -p one/./two' });

    expect(removed.result.exitCode).toBe(1);
    expect(removed.stderr.text).toContain('Invalid argument');
    expect((await wesh.vfs.lstat({ path: '/one' })).type).toBe('directory');
    await expect(wesh.vfs.lstat({ path: '/one/two' })).rejects.toThrow();
  });

  it('stops relative parent removal before the current working directory', async () => {
    await createDir({ path: 'base/one/two' });
    const base = await createDir({ path: 'base' });
    await base.getFileHandle('keep.txt', { create: true });

    const removed = await execute({
      script: `\
cd base && rmdir -p one/two && printf 'ok
'`,
    });

    expect(removed.result.exitCode).toBe(0);
    expect(removed.stdout.text).toBe('ok\n');
    expect(removed.stderr.text).toBe('');
    expect((await wesh.vfs.lstat({ path: '/base' })).type).toBe('directory');
    await expect(wesh.vfs.lstat({ path: '/base/one' })).rejects.toThrow();
  });

  it('rejects dot operands without removing an empty current directory', async () => {
    await createDir({ path: 'empty' });

    const removed = await execute({ script: 'cd empty && rmdir .' });

    expect(removed.result.exitCode).toBe(1);
    expect(removed.stderr.text).toContain('Invalid argument');
    expect((await wesh.vfs.lstat({ path: '/empty' })).type).toBe('directory');
  });

  it('treats dot-dot as a non-empty directory failure', async () => {
    await createDir({ path: 'parent/child' });

    const rejected = await execute({ script: 'cd /parent/child && rmdir ..' });
    expect(rejected.result.exitCode).toBe(1);
    expect(rejected.stderr.text).toContain('Directory not empty');

    const ignored = await execute({
      script: `\
cd /parent/child && rmdir --ignore-fail-on-non-empty .. && printf 'ok\n'`,
    });
    expect(ignored.result.exitCode).toBe(0);
    expect(ignored.stdout.text).toBe('ok\n');
    expect(ignored.stderr.text).toBe('');
    expect((await wesh.vfs.lstat({ path: '/parent' })).type).toBe('directory');
  });

  it('rejects an empty operand without removing an empty current directory', async () => {
    await createDir({ path: 'empty' });

    const removed = await execute({ script: "cd empty && rmdir ''" });

    expect(removed.result.exitCode).toBe(1);
    expect(removed.stderr.text).toContain('No such file or directory');
    expect((await wesh.vfs.lstat({ path: '/empty' })).type).toBe('directory');
  });

  it('reports every attempted removal in verbose parent mode', async () => {
    await createDir({ path: 'one/two' });

    const removed = await execute({ script: 'rmdir -pv one/two' });

    expect(removed.result.exitCode).toBe(0);
    expect(removed.stdout.text).toBe(`rmdir: removing directory, 'one/two'
rmdir: removing directory, 'one'
`);
    expect(removed.stderr.text).toBe('');
  });

  it('reports ignored non-empty directories in verbose mode', async () => {
    const dir = await createDir({ path: 'full' });
    await dir.getFileHandle('file.txt', { create: true });

    const ignored = await execute({
      script: 'rmdir --ignore-fail-on-non-empty --verbose full',
    });

    expect(ignored.result.exitCode).toBe(0);
    expect(ignored.stdout.text).toBe(`rmdir: removing directory, 'full'
`);
    expect(ignored.stderr.text).toBe('');
    expect((await wesh.vfs.lstat({ path: '/full' })).type).toBe('directory');
  });

  it('reports the parent operand that actually failed under -p', async () => {
    await createDir({ path: 'one/two' });
    const parent = await createDir({ path: 'one' });
    await parent.getFileHandle('keep.txt', { create: true });

    const failed = await execute({ script: 'rmdir -p one/two' });

    expect(failed.result.exitCode).toBe(1);
    expect(failed.stdout.text).toBe('');
    expect(failed.stderr.text).toContain("rmdir: failed to remove 'one':");
    expect(failed.stderr.text).not.toContain("failed to remove 'one/two'");
    await expect(wesh.vfs.lstat({ path: '/one/two' })).rejects.toThrow();
    expect((await wesh.vfs.lstat({ path: '/one' })).type).toBe('directory');
  });

  it('supports --ignore-fail-on-non-empty', async () => {
    const dir = await createDir({ path: 'full' });
    await dir.getFileHandle('file.txt', { create: true });

    const ignored = await execute({ script: 'rmdir --ignore-fail-on-non-empty full' });

    expect(ignored.result.exitCode).toBe(0);
    expect(ignored.stderr.text).toBe('');
    expect((await wesh.vfs.lstat({ path: '/full' })).type).toBe('directory');
  });

  it('prints verbose attempts before rejecting empty operands', async () => {
    const execution = await execute({ script: "rmdir -v -- ''" });

    expect(execution.result.exitCode).toBe(1);
    expect(execution.stdout.text).toBe("rmdir: removing directory, ''\n");
    expect(execution.stderr.text).toContain("failed to remove ''");
  });

});
