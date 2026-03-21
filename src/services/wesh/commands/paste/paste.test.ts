import { beforeEach, describe, expect, it } from 'vitest';
import { Wesh } from '@/services/wesh/index';
import { MockFileSystemDirectoryHandle } from '@/services/wesh/mocks/InMemoryFileSystem';
import {
  createWeshReadFileHandleFromText,
  createWeshWriteCaptureHandle,
} from '@/services/wesh/utils/test-stream';

describe('wesh paste', () => {
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
    stdinText = '',
  }: {
    script: string;
    stdinText?: string;
  }) {
    const stdout = createWeshWriteCaptureHandle();
    const stderr = createWeshWriteCaptureHandle();

    const result = await wesh.execute({
      script,
      stdin: createWeshReadFileHandleFromText({ text: stdinText }),
      stdout: stdout.handle,
      stderr: stderr.handle,
    });

    return { result, stdout, stderr };
  }

  it('prints help and reports invalid delimiter usage', async () => {
    const help = await execute({ script: 'paste --help' });
    const invalid = await execute({ script: 'paste -d' });

    expect(help.stdout.text).toContain('Merge lines of files in parallel or serially');
    expect(help.stdout.text).toContain('usage: paste [OPTION]... [FILE]...');
    expect(help.stderr.text).toBe('');
    expect(help.result.exitCode).toBe(0);

    expect(invalid.stdout.text).toBe('');
    expect(invalid.stderr.text).toContain('paste: -d requires a value for list');
    expect(invalid.stderr.text).toContain('usage: paste [OPTION]... [FILE]...');
    expect(invalid.result.exitCode).toBe(1);
  });

  it('merges files in parallel and serially', async () => {
    await writeFile({
      path: 'left.txt',
      data: 'a\nb\n',
    });
    await writeFile({
      path: 'right.txt',
      data: '1\n2\n3\n',
    });

    const parallel = await execute({ script: 'paste left.txt right.txt' });
    const serial = await execute({ script: "paste -s -d ',;' left.txt right.txt" });

    expect(parallel.stderr.text).toBe('');
    expect(serial.stderr.text).toBe('');
    expect(parallel.result.exitCode).toBe(0);
    expect(serial.result.exitCode).toBe(0);
    expect(parallel.stdout.text).toBe('a\t1\nb\t2\n\t3\n');
    expect(serial.stdout.text).toBe('a,b\n1,2;3\n');
  });

  it('accepts stdin input', async () => {
    const { result, stdout, stderr } = await execute({
      script: "paste -s -d ',;' -",
      stdinText: 'alpha\nbeta\ngamma\n',
    });

    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
    expect(stdout.text).toBe('alpha,beta;gamma\n');
  });

  it('consumes repeated stdin operands sequentially', async () => {
    const { result, stdout, stderr } = await execute({
      script: 'paste - -',
      stdinText: 'a\nb\nc\nd\n',
    });

    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
    expect(stdout.text).toBe('a\tb\nc\td\n');
  });
});
