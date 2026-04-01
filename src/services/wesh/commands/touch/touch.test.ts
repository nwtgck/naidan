import { beforeEach, describe, expect, it } from 'vitest';
import { Wesh } from '@/services/wesh/index';
import { MockFileSystemDirectoryHandle } from '@/services/wesh/mocks/InMemoryFileSystem';
import {
  createTestReadHandleFromText,
  createTestWriteCaptureHandle,
} from '@/services/wesh/utils/test-stream';

describe('wesh touch', () => {
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

  it('prints help and reports missing operands with usage', async () => {
    const help = await execute({
      script: 'touch --help',
    });
    const missing = await execute({
      script: 'touch',
    });

    expect(help.stdout.text).toContain('Update file timestamps or create empty files');
    expect(help.stdout.text).toContain('usage: touch [-c] [-r FILE] path...');
    expect(help.stdout.text).toContain('--help');
    expect(help.stderr.text).toBe('');
    expect(help.result.exitCode).toBe(0);

    expect(missing.stdout.text).toBe('');
    expect(missing.stderr.text).toContain('touch: missing file operand');
    expect(missing.stderr.text).toContain('usage: touch');
    expect(missing.result.exitCode).toBe(1);
  });

  it('creates missing files by default', async () => {
    const { result, stdout, stderr } = await execute({
      script: `\
touch created.txt
test -e created.txt
echo $?`,
    });

    expect(stdout.text).toBe('0\n');
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
  });

  it('supports -c to avoid creating missing files', async () => {
    const { result, stdout, stderr } = await execute({
      script: `\
touch -c missing.txt
test -e missing.txt
echo $?`,
    });

    expect(stdout.text).toBe('1\n');
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
  });

  it('updates mtime for existing files without changing contents', async () => {
    await writeFile({ path: 'file.txt', data: 'payload' });
    const before = await wesh.vfs.stat({ path: '/file.txt' });
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 5);
    });

    const { result, stdout, stderr } = await execute({
      script: `\
touch file.txt
cat file.txt`,
    });
    const after = await wesh.vfs.stat({ path: '/file.txt' });

    expect(stdout.text).toBe('payload');
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
    expect(after.mtime).toBeGreaterThan(before.mtime);
  });

  it('returns non-zero when a target path cannot be touched', async () => {
    const { result, stdout, stderr } = await execute({
      script: `\
touch missing/file.txt
echo $?`,
    });

    expect(stdout.text).toBe('1\n');
    expect(stderr.text).toContain("touch: cannot touch 'missing/file.txt':");
    expect(result.exitCode).toBe(0);
  });

  it('accepts -r and --reference when the reference file exists', async () => {
    await writeFile({ path: 'reference.txt', data: 'ref' });

    const shortResult = await execute({
      script: `\
touch -r reference.txt short.txt
test -e short.txt
echo $?`,
    });
    const longResult = await execute({
      script: `\
touch --reference=reference.txt long.txt
test -e long.txt
echo $?`,
    });

    expect(shortResult.stdout.text).toBe('0\n');
    expect(shortResult.stderr.text).toBe('');
    expect(longResult.stdout.text).toBe('0\n');
    expect(longResult.stderr.text).toBe('');
  });

  it('fails when the reference file does not exist', async () => {
    const { result, stdout, stderr } = await execute({
      script: `\
touch -r missing.txt target.txt
echo $?`,
    });

    expect(stdout.text).toBe('1\n');
    expect(stderr.text).toContain("touch: failed to get attributes of 'missing.txt':");
    expect(result.exitCode).toBe(0);
  });
});
