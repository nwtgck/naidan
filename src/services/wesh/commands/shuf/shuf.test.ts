import { beforeEach, describe, expect, it } from 'vitest';
import { Wesh } from '@/services/wesh/index';
import { MockFileSystemDirectoryHandle } from '@/services/wesh/mocks/InMemoryFileSystem';
import {
  createTestReadHandleFromText,
  createTestWriteCaptureHandle,
} from '@/services/wesh/utils/test-stream';

describe('wesh shuf', () => {
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
    const stdout = createTestWriteCaptureHandle();
    const stderr = createTestWriteCaptureHandle();

    const result = await wesh.execute({
      script,
      stdin: createTestReadHandleFromText({ text: stdinText }),
      stdout: stdout.handle,
      stderr: stderr.handle,
    });

    return { result, stdout, stderr };
  }

  it('prints help and rejects invalid options', async () => {
    const help = await execute({ script: 'shuf --help' });
    const invalid = await execute({ script: 'shuf -x' });
    const extra = await execute({ script: 'shuf - -', stdinText: 'one\ntwo\n' });

    expect(help.stdout.text).toContain('Randomly shuffle lines');
    expect(help.stdout.text).toContain('usage: shuf [OPTION]... [FILE]');
    expect(help.stderr.text).toBe('');
    expect(help.result.exitCode).toBe(0);

    expect(invalid.stdout.text).toBe('');
    expect(invalid.stderr.text).toContain('shuf: invalid option');
    expect(invalid.result.exitCode).toBe(1);

    expect(extra.stdout.text).toBe('');
    expect(extra.stderr.text).toContain("shuf: extra operand '-'");
    expect(extra.result.exitCode).toBe(1);
  });

  it('shuffles file input and honors -n without depending on exact order', async () => {
    await writeFile({
      path: 'input.txt',
      data: 'alpha\nbeta\ngamma\n',
    });

    const { result, stdout, stderr } = await execute({
      script: 'shuf -n 2 input.txt',
    });

    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);

    const lines = stdout.text.trim().split('\n').filter((line) => line.length > 0);
    expect(lines).toHaveLength(2);
    expect(lines.every((line) => ['alpha', 'beta', 'gamma'].includes(line))).toBe(true);
    expect(new Set(lines).size).toBe(lines.length);
  });

  it('shuffles stdin input', async () => {
    const { result, stdout, stderr } = await execute({
      script: 'shuf',
      stdinText: 'red\ngreen\nblue\n',
    });

    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);

    const lines = stdout.text.trim().split('\n').filter((line) => line.length > 0);
    expect(lines).toHaveLength(3);
    expect(lines.every((line) => ['red', 'green', 'blue'].includes(line))).toBe(true);
    expect(new Set(lines).size).toBe(lines.length);
  });

});
