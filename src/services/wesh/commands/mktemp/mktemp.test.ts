import { beforeEach, describe, expect, it } from 'vitest';
import { Wesh } from '@/services/wesh';
import { MockFileSystemDirectoryHandle } from '@/services/wesh/mocks/InMemoryFileSystem';
import {
  createWeshReadFileHandleFromText,
  createWeshWriteCaptureHandle,
} from '@/services/wesh/utils/test-stream';

describe('wesh mktemp', () => {
  let wesh: Wesh;
  let rootHandle: MockFileSystemDirectoryHandle;

  beforeEach(async () => {
    rootHandle = new MockFileSystemDirectoryHandle('root');
    wesh = new Wesh({ rootHandle: rootHandle as unknown as FileSystemDirectoryHandle });
    await wesh.init();
    await wesh.vfs.mkdir({ path: '/tmp', recursive: true });
  });

  async function execute({
    script,
  }: {
    script: string;
  }) {
    const stdout = createWeshWriteCaptureHandle();
    const stderr = createWeshWriteCaptureHandle();
    const result = await wesh.execute({
      script,
      stdin: createWeshReadFileHandleFromText({ text: '' }),
      stdout: stdout.handle,
      stderr: stderr.handle,
    });

    return { result, stdout, stderr };
  }

  it('creates a temporary file in /tmp by default', async () => {
    const { result, stdout, stderr } = await execute({
      script: 'mktemp',
    });

    const path = stdout.text.trim();
    expect(path).toMatch(/^\/tmp\/tmp\.[A-Za-z0-9]{10}$/);
    await expect(wesh.vfs.stat({ path })).resolves.toMatchObject({ type: 'file' });
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
  });

  it('creates directories with -d', async () => {
    const { result, stdout, stderr } = await execute({
      script: 'mktemp -d dir.XXXXXX',
    });

    const path = stdout.text.trim();
    expect(path).toMatch(/^\/dir\.[A-Za-z0-9]{6}$/);
    await expect(wesh.vfs.stat({ path })).resolves.toMatchObject({ type: 'directory' });
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
  });

  it('supports creating relative to an explicit temp directory', async () => {
    await wesh.vfs.mkdir({ path: '/workspace', recursive: true });

    const { result, stdout, stderr } = await execute({
      script: 'mktemp -p /workspace file.XXXXXX',
    });

    const path = stdout.text.trim();
    expect(path).toMatch(/^\/workspace\/file\.[A-Za-z0-9]{6}$/);
    await expect(wesh.vfs.stat({ path })).resolves.toMatchObject({ type: 'file' });
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
  });

  it('supports dry-run mode', async () => {
    const { result, stdout, stderr } = await execute({
      script: 'mktemp -u temp.XXXXXX',
    });

    const path = stdout.text.trim();
    expect(path).toMatch(/^\/temp\.[A-Za-z0-9]{6}$/);
    await expect(wesh.vfs.stat({ path })).rejects.toThrow();
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
  });

  it('prints help with --help', async () => {
    const { result, stdout, stderr } = await execute({
      script: 'mktemp --help',
    });

    expect(stdout.text).toContain('usage: mktemp [OPTION]... [TEMPLATE]');
    expect(stdout.text).toContain('--tmpdir');
    expect(stdout.text).toContain('--dry-run');
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
  });

  it('reports invalid templates', async () => {
    const { result, stdout, stderr } = await execute({
      script: 'mktemp plain-name',
    });

    expect(stdout.text).toBe('');
    expect(stderr.text).toContain("template must contain at least 3 consecutive 'X' characters");
    expect(result.exitCode).toBe(1);
  });
});
