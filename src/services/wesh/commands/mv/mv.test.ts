import { beforeEach, describe, expect, it } from 'vitest';
import { Wesh } from '@/services/wesh/index';
import { MockFileSystemDirectoryHandle } from '@/services/wesh/mocks/InMemoryFileSystem';
import {
  createTestReadHandleFromText,
  createTestWriteCaptureHandle,
} from '@/services/wesh/utils/test-stream';

describe('wesh mv', () => {
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
    if (fileName === undefined) throw new Error('path must include a file name');

    let dir = rootHandle;
    for (const segment of segments) {
      dir = await dir.getDirectoryHandle(segment, { create: true });
    }

    const handle = await dir.getFileHandle(fileName, { create: true });
    const writable = await handle.createWritable();
    await writable.write(data);
    await writable.close();
  }

  async function mkdir({
    path,
  }: {
    path: string;
  }) {
    const segments = path.split('/').filter(Boolean);
    let dir = rootHandle;
    for (const segment of segments) {
      dir = await dir.getDirectoryHandle(segment, { create: true });
    }
  }

  async function execute({
    script,
  }: {
    script: string;
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

  it('moves files', async () => {
    await writeFile({ path: 'source.txt', data: 'alpha\n' });

    const { result, stdout, stderr } = await execute({
      script: 'mv source.txt target.txt',
    });

    const moved = await execute({
      script: 'test -e target.txt',
    });
    const original = await execute({
      script: 'test -e source.txt',
    });

    expect(stdout.text).toBe('');
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
    expect(moved.result.exitCode).toBe(0);
    expect(original.result.exitCode).toBe(1);
  });

  it('supports moving multiple sources into a target directory with -t', async () => {
    await writeFile({ path: 'first.txt', data: 'first\n' });
    await writeFile({ path: 'second.txt', data: 'second\n' });
    await mkdir({ path: 'dest' });

    const { result, stdout, stderr } = await execute({
      script: `\
mv -t dest first.txt second.txt
cat dest/first.txt
cat dest/second.txt`,
    });

    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
    expect(stdout.text).toBe('first\nsecond\n');
  });

  it('supports --target-directory as a long option alias', async () => {
    await writeFile({ path: 'first.txt', data: 'first\n' });
    await writeFile({ path: 'second.txt', data: 'second\n' });
    await mkdir({ path: 'dest' });

    const { result, stdout, stderr } = await execute({
      script: `\
mv --target-directory=dest first.txt second.txt
cat dest/first.txt
cat dest/second.txt`,
    });

    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
    expect(stdout.text).toBe('first\nsecond\n');
  });

  it('supports -T to forbid treating the destination as a directory', async () => {
    await writeFile({ path: 'source.txt', data: 'alpha\n' });
    await mkdir({ path: 'dest' });

    const { result, stdout, stderr } = await execute({
      script: 'mv -T source.txt dest',
    });

    expect(stdout.text).toBe('');
    expect(stderr.text).toContain("cannot overwrite directory 'dest' with non-directory");
    expect(result.exitCode).toBe(1);
  });

  it('supports --no-target-directory as a long option alias', async () => {
    await writeFile({ path: 'source.txt', data: 'alpha\n' });
    await mkdir({ path: 'dest' });

    const { result, stdout, stderr } = await execute({
      script: 'mv --no-target-directory source.txt dest',
    });

    expect(stdout.text).toBe('');
    expect(stderr.text).toContain("cannot overwrite directory 'dest' with non-directory");
    expect(result.exitCode).toBe(1);
  });

  it('supports -n to avoid overwriting an existing destination', async () => {
    await writeFile({ path: 'source.txt', data: 'source\n' });
    await writeFile({ path: 'dest.txt', data: 'dest\n' });

    const { result, stdout, stderr } = await execute({
      script: `\
mv -n source.txt dest.txt
cat dest.txt
test -e source.txt
echo $?`,
    });

    expect(stdout.text).toBe('dest\n0\n');
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
  });

  it('supports --no-clobber as a long option alias', async () => {
    await writeFile({ path: 'source.txt', data: 'source\n' });
    await writeFile({ path: 'dest.txt', data: 'dest\n' });

    const { result, stdout, stderr } = await execute({
      script: `\
mv --no-clobber source.txt dest.txt
cat dest.txt
test -e source.txt
echo $?`,
    });

    expect(stdout.text).toBe('dest\n0\n');
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
  });

  it('reports missing operands with usage', async () => {
    const { result, stdout, stderr } = await execute({
      script: 'mv source.txt',
    });

    expect(stdout.text).toBe('');
    expect(stderr.text).toContain('mv: missing file operand');
    expect(stderr.text).toContain('usage: mv source destination');
    expect(stderr.text).toContain('try:');
    expect(stderr.text).toContain('--help');
    expect(result.exitCode).toBe(1);
  });

  it('reports non-directory targets for multiple sources', async () => {
    await writeFile({ path: 'first.txt', data: 'first\n' });
    await writeFile({ path: 'second.txt', data: 'second\n' });
    await writeFile({ path: 'dest.txt', data: 'dest\n' });

    const { result, stdout, stderr } = await execute({
      script: 'mv first.txt second.txt dest.txt',
    });

    expect(stdout.text).toBe('');
    expect(stderr.text).toContain("target 'dest.txt' is not a directory");
    expect(result.exitCode).toBe(1);
  });

  it('continues after a missing source when moving multiple files into a directory', async () => {
    await writeFile({ path: 'present.txt', data: 'present\n' });
    await mkdir({ path: 'dest' });

    const { result, stdout, stderr } = await execute({
      script: `\
mv -t dest missing.txt present.txt
echo $?
cat dest/present.txt`,
    });

    expect(stdout.text).toBe('1\npresent\n');
    expect(stderr.text).toContain('mv: missing.txt:');
    expect(result.exitCode).toBe(0);
  });

  it('supports root-relative source and destination paths from /', async () => {
    await writeFile({ path: 'root-source.txt', data: 'alpha\n' });

    const { result, stdout, stderr } = await execute({
      script: `\
cd /
mv root-source.txt root-dest.txt
cat /root-dest.txt`,
    });

    expect(stdout.text).toBe('alpha\n');
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
  });

  it('prints help with --help', async () => {
    const { result, stdout, stderr } = await execute({
      script: 'mv --help',
    });

    expect(stderr.text).toBe('');
    expect(stdout.text).toContain('Move or rename files');
    expect(stdout.text).toContain('usage: mv source destination');
    expect(stdout.text).toContain('--help');
    expect(result.exitCode).toBe(0);
  });
});
