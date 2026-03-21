import { beforeEach, describe, expect, it } from 'vitest';
import { Wesh } from '@/services/wesh';
import { MockFileSystemDirectoryHandle } from '@/services/wesh/mocks/InMemoryFileSystem';
import { createWeshReadFileHandleFromText, createWeshWriteCaptureHandle } from '@/services/wesh/utils/test-stream';

describe('tee command', () => {
  let wesh: Wesh;
  let rootHandle: MockFileSystemDirectoryHandle;

  beforeEach(async () => {
    rootHandle = new MockFileSystemDirectoryHandle('root');
    wesh = new Wesh({ rootHandle: rootHandle as unknown as FileSystemDirectoryHandle });
    await wesh.init();
  });

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

  async function readTextFile({
    path,
  }: {
    path: string;
  }): Promise<string> {
    const segments = path.split('/').filter(Boolean);
    const fileName = segments.pop();
    if (fileName === undefined) {
      throw new Error('path must include a file name');
    }

    let dir = rootHandle;
    for (const segment of segments) {
      dir = await dir.getDirectoryHandle(segment, { create: true });
    }

    const handle = await dir.getFileHandle(fileName, { create: false });
    const file = await handle.getFile();
    return await file.text();
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

  it('prints help output', async () => {
    const { result, stdout, stderr } = await execute({ script: 'tee --help' });

    expect(stdout.text).toContain('Read from standard input and write to standard output and files');
    expect(stdout.text).toContain('usage: tee [OPTION]... [FILE]...');
    expect(stdout.text).toContain('-a');
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
  });

  it('copies stdin to stdout and files, then appends with -a', async () => {
    const first = await execute({
      script: `\
printf '%s' hello | tee output.txt`,
    });
    const second = await execute({
      script: `\
printf '%s' world | tee -a output.txt`,
    });

    expect(first.stdout.text).toBe('hello');
    expect(first.stderr.text).toBe('');
    expect(first.result.exitCode).toBe(0);

    expect(second.stdout.text).toBe('world');
    expect(second.stderr.text).toBe('');
    expect(second.result.exitCode).toBe(0);
    expect(await readTextFile({ path: 'output.txt' })).toBe('helloworld');
  });

  it('continues writing to other outputs when one file fails', async () => {
    await mkdir({ path: 'blocked' });

    const { result, stdout, stderr } = await execute({
      script: `\
printf '%s' alpha | tee good.txt blocked`,
    });

    expect(stdout.text).toBe('alpha');
    expect(stderr.text).toContain('tee: blocked:');
    expect(result.exitCode).toBe(1);
    expect(await readTextFile({ path: 'good.txt' })).toBe('alpha');
  });
});
