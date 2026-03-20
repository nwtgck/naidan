import { beforeEach, describe, expect, it } from 'vitest';
import { Wesh } from '@/services/wesh/index';
import { MockFileSystemDirectoryHandle } from '@/services/wesh/mocks/InMemoryFileSystem';
import {
  createWeshReadFileHandleFromText,
  createWeshWriteCaptureHandle,
} from '@/services/wesh/utils/test-stream';

describe('wesh readlink', () => {
  let wesh: Wesh;
  let rootHandle: MockFileSystemDirectoryHandle;

  beforeEach(async () => {
    rootHandle = new MockFileSystemDirectoryHandle('root');
    wesh = new Wesh({ rootHandle: rootHandle as unknown as FileSystemDirectoryHandle });
    await wesh.init();
  });

  async function writeFile({
    path,
    data,
  }: {
    path: string;
    data: string;
  }) {
    const segments = path.split('/').filter(Boolean);
    const fileName = segments.pop();
    if (fileName === undefined) {
      throw new Error('path must include a file name');
    }

    let dir = rootHandle;
    for (const segment of segments) {
      dir = await dir.getDirectoryHandle(segment, { create: true });
    }

    const handle = await dir.getFileHandle(fileName, { create: true });
    const writable = await handle.createWritable();
    await writable.write(data);
    await writable.close();
  }

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

  it('reports missing and extra operands with usage', async () => {
    const missing = await execute({ script: 'readlink' });
    const extra = await execute({ script: 'readlink one two' });

    expect(missing.stdout.text).toBe('');
    expect(missing.stderr.text).toContain('readlink: missing operand');
    expect(missing.stderr.text).toContain('usage: readlink');
    expect(missing.result.exitCode).toBe(1);

    expect(extra.stdout.text).toBe('');
    expect(extra.stderr.text).toContain("readlink: extra operand 'two'");
    expect(extra.stderr.text).toContain('usage: readlink');
    expect(extra.result.exitCode).toBe(1);
  });

  it('supports -n for no trailing newline', async () => {
    await wesh.vfs.symlink({
      path: '/alias.txt',
      targetPath: '/target.txt',
    });

    const { result, stdout, stderr } = await execute({
      script: 'readlink -n alias.txt',
    });

    expect(stdout.text).toBe('/target.txt');
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
  });

  it('supports --no-newline as a long option alias', async () => {
    await wesh.vfs.symlink({
      path: '/alias.txt',
      targetPath: '/target.txt',
    });

    const { result, stdout, stderr } = await execute({
      script: 'readlink --no-newline alias.txt',
    });

    expect(stdout.text).toBe('/target.txt');
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
  });

  it('supports -f to print the canonical absolute path', async () => {
    await writeFile({ path: 'target.txt', data: 'target\n' });
    await wesh.vfs.mkdir({ path: '/dir', recursive: true });
    await wesh.vfs.symlink({
      path: '/alias.txt',
      targetPath: '/dir/../target.txt',
    });

    const { result, stdout, stderr } = await execute({
      script: 'readlink -f alias.txt',
    });

    expect(stdout.text).toBe('/target.txt\n');
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
  });

  it('reports missing targets when canonicalizing existing paths', async () => {
    const { result, stdout, stderr } = await execute({
      script: 'readlink -e missing.txt',
    });

    expect(stdout.text).toBe('');
    expect(stderr.text).toContain('readlink: missing.txt:');
    expect(result.exitCode).toBe(1);
  });

  it('supports -e for existing canonical paths', async () => {
    await writeFile({ path: 'target.txt', data: 'target\n' });
    await wesh.vfs.symlink({
      path: '/alias.txt',
      targetPath: '/target.txt',
    });

    const { result, stdout, stderr } = await execute({
      script: 'readlink -e alias.txt',
    });

    expect(stdout.text).toBe('/target.txt\n');
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
  });

  it('allows a missing final path component with -f', async () => {
    await wesh.vfs.mkdir({ path: '/dir', recursive: true });

    const { result, stdout, stderr } = await execute({
      script: 'readlink -f dir/missing.txt',
    });

    expect(stdout.text).toBe('/dir/missing.txt\n');
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
  });

  it('supports long canonicalize aliases', async () => {
    await writeFile({ path: 'target.txt', data: 'target\n' });
    await wesh.vfs.symlink({
      path: '/alias.txt',
      targetPath: '/target.txt',
    });

    const canonicalize = await execute({
      script: 'readlink --canonicalize alias.txt',
    });
    const existing = await execute({
      script: 'readlink --canonicalize-existing alias.txt',
    });

    expect(canonicalize.stdout.text).toBe('/target.txt\n');
    expect(canonicalize.stderr.text).toBe('');
    expect(canonicalize.result.exitCode).toBe(0);
    expect(existing.stdout.text).toBe('/target.txt\n');
    expect(existing.stderr.text).toBe('');
    expect(existing.result.exitCode).toBe(0);
  });
});
