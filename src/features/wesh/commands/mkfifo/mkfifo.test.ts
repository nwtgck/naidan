import { beforeEach, describe, expect, it } from 'vitest';
import { Wesh } from '@/features/wesh/index';
import { createTextShellSource } from '@/features/wesh/shell/source';
import { MockFileSystemDirectoryHandle } from '@/features/wesh/mocks/InMemoryFileSystem';
import {
  createTestReadHandleFromText,
  createTestWriteCaptureHandle,
} from '@/features/wesh/utils/test-stream';

describe('wesh mkfifo', () => {
  let wesh: Wesh;
  let rootHandle: MockFileSystemDirectoryHandle;

  beforeEach(async () => {
    rootHandle = new MockFileSystemDirectoryHandle({ name: 'root' });
    wesh = new Wesh({ rootHandle: rootHandle as unknown as FileSystemDirectoryHandle });
    await wesh.init();
  });

  async function execute({
    script,
  }: {
    script: string,
  }) {
    const stdout = createTestWriteCaptureHandle();
    const stderr = createTestWriteCaptureHandle();

    const result = await wesh.execute({
      source: createTextShellSource({ text: script }),
      stdin: createTestReadHandleFromText({ text: '' }),
      stdout: stdout.handle,
      stderr: stderr.handle,
    });

    return { result, stdout, stderr };
  }

  it('creates fifos', async () => {
    const { result, stdout, stderr } = await execute({
      script: 'mkfifo pipe',
    });

    const check = await execute({
      script: 'test -p pipe',
    });

    expect(stdout.text).toBe('');
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
    expect(check.result.exitCode).toBe(0);
  });


  it('supports numeric and symbolic permission modes', async () => {
    const numeric = await execute({ script: 'mkfifo -m 600 numeric' });
    const symbolic = await execute({ script: 'mkfifo --mode=u=rw,g=r,o= symbolic' });
    const copied = await execute({ script: 'mkfifo -m u=rw,go=u copied' });

    expect(numeric.result.exitCode).toBe(0);
    expect(symbolic.result.exitCode).toBe(0);
    expect(copied.result.exitCode).toBe(0);
    expect((await wesh.vfs.lstat({ path: '/numeric' })).mode).toBe(0o600);
    expect((await wesh.vfs.lstat({ path: '/symbolic' })).mode).toBe(0o640);
    expect((await wesh.vfs.lstat({ path: '/copied' })).mode).toBe(0o666);
  });

  it('accepts chained and empty symbolic mode operations', async () => {
    const dashMode = await execute({ script: 'mkfifo -m -- dash-mode' });
    const chainedMode = await execute({ script: 'mkfifo --mode=u+r-w chained-mode' });

    expect(dashMode.result.exitCode).toBe(0);
    expect(dashMode.stderr.text).toBe('');
    expect(chainedMode.result.exitCode).toBe(0);
    expect(chainedMode.stderr.text).toBe('');
    expect((await wesh.vfs.lstat({ path: '/dash-mode' })).type).toBe('fifo');
    expect((await wesh.vfs.lstat({ path: '/chained-mode' })).type).toBe('fifo');
  });

  it('rejects invalid modes before creating any operands', async () => {
    const invalid = await execute({ script: 'mkfifo -m 888 first second' });
    const special = await execute({ script: 'mkfifo -m u+s special' });

    expect(invalid.result.exitCode).toBe(1);
    expect(invalid.stderr.text).toBe('mkfifo: invalid mode\n');
    expect(special.result.exitCode).toBe(1);
    expect(special.stderr.text).toBe('mkfifo: mode must specify only file permission bits\n');
    await expect(wesh.vfs.lstat({ path: '/first' })).rejects.toThrow();
    await expect(wesh.vfs.lstat({ path: '/second' })).rejects.toThrow();
    await expect(wesh.vfs.lstat({ path: '/special' })).rejects.toThrow();
  });

  it('honors -- before option-like paths', async () => {
    const { result, stdout, stderr } = await execute({
      script: 'mkfifo -- -pipe',
    });
    const check = await execute({
      script: 'test -p ./-pipe',
    });

    expect(stdout.text).toBe('');
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
    expect(check.result.exitCode).toBe(0);
  });

  it('rejects invalid options', async () => {
    const { result, stdout, stderr } = await execute({
      script: 'mkfifo --definitely-invalid',
    });

    expect(stdout.text).toBe('');
    expect(stderr.text).toContain("mkfifo: unrecognized option '--definitely-invalid'");
    expect(result.exitCode).toBe(1);
  });

  it('rejects a nonexistent fifo path ending in a slash', async () => {
    const { result, stdout, stderr } = await execute({
      script: 'mkfifo pipe/',
    });

    expect(stdout.text).toBe('');
    expect(stderr.text).toBe("mkfifo: cannot create fifo 'pipe/': No such file or directory\n");
    expect(result.exitCode).toBe(1);
    await expect(wesh.vfs.lstat({ path: '/pipe' })).rejects.toThrow();
  });

  it('reports existing paths and continues with later operands', async () => {
    await execute({ script: 'mkfifo existing' });

    const { result, stdout, stderr } = await execute({
      script: 'mkfifo first existing second',
    });
    const first = await execute({ script: 'test -p first' });
    const second = await execute({ script: 'test -p second' });

    expect(stdout.text).toBe('');
    expect(stderr.text).toBe("mkfifo: cannot create fifo 'existing': File exists\n");
    expect(result.exitCode).toBe(1);
    expect(first.result.exitCode).toBe(0);
    expect(second.result.exitCode).toBe(0);
  });

  it('reports missing operands with usage', async () => {
    const { result, stdout, stderr } = await execute({
      script: 'mkfifo',
    });

    expect(stdout.text).toBe('');
    expect(stderr.text).toContain('mkfifo: missing operand');
    expect(stderr.text).toContain('usage: mkfifo [OPTION]... NAME...');
    expect(stderr.text).toContain('try:');
    expect(stderr.text).toContain('--help');
    expect(result.exitCode).toBe(1);
  });

  it('prints help with --help', async () => {
    const { result, stdout, stderr } = await execute({
      script: 'mkfifo --help',
    });

    expect(stderr.text).toBe('');
    expect(stdout.text).toContain('Make FIFOs (named pipes)');
    expect(stdout.text).toContain('usage: mkfifo [OPTION]... NAME...');
    expect(stdout.text).toContain('--help');
    expect(result.exitCode).toBe(0);
  });
  it('stops argv processing when --help is reached before a later invalid option', async () => {
    const helpFirst = await execute({ script: 'mkfifo --help --definitely-invalid-option' });
    const invalidFirst = await execute({ script: 'mkfifo --definitely-invalid-option --help' });

    expect(helpFirst.result.exitCode).toBe(0);
    expect(helpFirst.stdout.text).not.toBe('');
    expect(helpFirst.stderr.text).toBe('');

    expect(invalidFirst.result.exitCode).not.toBe(0);
    expect(invalidFirst.stderr.text).not.toBe('');
  });

});
