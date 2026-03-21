import { beforeEach, describe, expect, it } from 'vitest';
import { Wesh } from '@/services/wesh';
import { MockFileSystemDirectoryHandle } from '@/services/wesh/mocks/InMemoryFileSystem';
import {
  createWeshReadFileHandleFromText,
  createWeshWriteCaptureHandle,
} from '@/services/wesh/utils/test-stream';

describe('head command', () => {
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
      script: 'head -n 1 a.txt b.txt',
      stdinText: undefined,
    });

    expect(stdout.text).toBe(`\
==> a.txt <==
a1

==> b.txt <==
b1
`);
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
  });

  it('suppresses headers with -q', async () => {
    await writeFile({ name: 'a.txt', data: 'a1\na2\n' });
    await writeFile({ name: 'b.txt', data: 'b1\nb2\n' });

    const { result, stdout, stderr } = await execute({
      script: 'head -q -n 1 a.txt b.txt',
      stdinText: undefined,
    });

    expect(stdout.text).toBe(`\
a1
b1
`);
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
  });

  it('supports long option aliases for header and line selection', async () => {
    await writeFile({ name: 'a.txt', data: 'a1\na2\n' });
    await writeFile({ name: 'b.txt', data: 'b1\nb2\n' });

    const { result, stdout, stderr } = await execute({
      script: 'head --silent --lines=1 a.txt b.txt',
      stdinText: undefined,
    });

    expect(stdout.text).toBe(`\
a1
b1
`);
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
  });

  it('forces headers with -v for a single file', async () => {
    await writeFile({ name: 'a.txt', data: 'a1\na2\n' });

    const { result, stdout, stderr } = await execute({
      script: 'head -v -n 1 a.txt',
      stdinText: undefined,
    });

    expect(stdout.text).toBe(`\
==> a.txt <==
a1
`);
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
  });

  it('treats - as stdin among files', async () => {
    await writeFile({ name: 'a.txt', data: 'a1\na2\n' });

    const { result, stdout, stderr } = await execute({
      script: 'head -n 1 - a.txt',
      stdinText: 'stdin1\nstdin2\n',
    });

    expect(stdout.text).toBe(`\
==> standard input <==
stdin1

==> a.txt <==
a1
`);
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
  });

  it('returns non-zero when any file is missing', async () => {
    await writeFile({ name: 'a.txt', data: 'a1\na2\n' });

    const { result, stdout, stderr } = await execute({
      script: 'head -n 1 a.txt missing.txt',
      stdinText: undefined,
    });

    expect(stdout.text).toContain('==> a.txt <==');
    expect(stderr.text).toContain('head: missing.txt:');
    expect(result.exitCode).toBe(1);
  });

  it('rejects invalid line counts with usage', async () => {
    const { result, stdout, stderr } = await execute({
      script: 'head --lines=1x',
      stdinText: undefined,
    });

    expect(stdout.text).toBe('');
    expect(stderr.text).toContain("head: invalid number of lines: '1x'");
    expect(stderr.text).toContain('usage: head');
    expect(result.exitCode).toBe(1);
  });
});
