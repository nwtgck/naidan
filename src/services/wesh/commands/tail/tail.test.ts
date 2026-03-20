import { beforeEach, describe, expect, it } from 'vitest';
import { Wesh } from '@/services/wesh';
import { MockFileSystemDirectoryHandle } from '@/services/wesh/mocks/InMemoryFileSystem';
import {
  createWeshReadFileHandleFromText,
  createWeshWriteCaptureHandle,
} from '@/services/wesh/utils/test-stream';

describe('tail command', () => {
  let wesh: Wesh;
  let rootHandle: MockFileSystemDirectoryHandle;

  beforeEach(async () => {
    rootHandle = new MockFileSystemDirectoryHandle('root');
    wesh = new Wesh({ rootHandle: rootHandle as unknown as FileSystemDirectoryHandle });
    await wesh.init();
  });

  async function writeFile({
    name,
    data,
  }: {
    name: string;
    data: string;
  }) {
    const handle = await rootHandle.getFileHandle(name, { create: true });
    const writable = await handle.createWritable();
    await writable.write(data);
    await writable.close();
  }

  async function execute({
    script,
    stdinText,
  }: {
    script: string;
    stdinText: string | undefined;
  }) {
    const stdout = createWeshWriteCaptureHandle();
    const stderr = createWeshWriteCaptureHandle();

    const result = await wesh.execute({
      script,
      stdin: createWeshReadFileHandleFromText({ text: stdinText ?? '' }),
      stdout: stdout.handle,
      stderr: stderr.handle,
    });

    return { result, stdout, stderr };
  }

  it('prints headers for multiple files by default', async () => {
    await writeFile({ name: 'a.txt', data: 'a1\na2\na3\n' });
    await writeFile({ name: 'b.txt', data: 'b1\nb2\nb3\n' });

    const { result, stdout, stderr } = await execute({
      script: 'tail -n 1 a.txt b.txt',
      stdinText: undefined,
    });

    expect(stdout.text).toBe(`\
==> a.txt <==
a3

==> b.txt <==
b3
`);
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
  });

  it('suppresses headers with -q', async () => {
    await writeFile({ name: 'a.txt', data: 'a1\na2\n' });
    await writeFile({ name: 'b.txt', data: 'b1\nb2\n' });

    const { result, stdout, stderr } = await execute({
      script: 'tail -q -n 1 a.txt b.txt',
      stdinText: undefined,
    });

    expect(stdout.text).toBe(`\
a2
b2
`);
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
  });

  it('forces headers with -v for a single file', async () => {
    await writeFile({ name: 'a.txt', data: 'a1\na2\n' });

    const { result, stdout, stderr } = await execute({
      script: 'tail -v -n 1 a.txt',
      stdinText: undefined,
    });

    expect(stdout.text).toBe(`\
==> a.txt <==
a2
`);
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
  });

  it('treats - as stdin among files', async () => {
    await writeFile({ name: 'a.txt', data: 'a1\na2\n' });

    const { result, stdout, stderr } = await execute({
      script: 'tail -n 1 - a.txt',
      stdinText: 'stdin1\nstdin2\n',
    });

    expect(stdout.text).toBe(`\
==> standard input <==
stdin2

==> a.txt <==
a2
`);
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
  });

  it('returns non-zero when any file is missing', async () => {
    await writeFile({ name: 'a.txt', data: 'a1\na2\n' });

    const { result, stdout, stderr } = await execute({
      script: 'tail -n 1 a.txt missing.txt',
      stdinText: undefined,
    });

    expect(stdout.text).toContain('==> a.txt <==');
    expect(stderr.text).toContain('tail: missing.txt:');
    expect(result.exitCode).toBe(1);
  });

  it('supports byte counts with -c', async () => {
    await writeFile({ name: 'bytes.txt', data: 'abcdef' });

    const { result, stdout, stderr } = await execute({
      script: 'tail -c 3 bytes.txt',
      stdinText: undefined,
    });

    expect(stdout.text).toBe('def');
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
  });

  it('supports +N byte counts with -c', async () => {
    await writeFile({ name: 'bytes.txt', data: 'abcdef' });

    const { result, stdout, stderr } = await execute({
      script: 'tail -c +3 bytes.txt',
      stdinText: undefined,
    });

    expect(stdout.text).toBe('cdef');
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
  });
});
