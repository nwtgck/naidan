import { beforeEach, describe, expect, it } from 'vitest';
import { Wesh } from '@/services/wesh/index';
import { MockFileSystemDirectoryHandle } from '@/services/wesh/mocks/InMemoryFileSystem';
import {
  createTestReadHandleFromText,
  createTestWriteCaptureHandle,
} from '@/services/wesh/utils/test-stream';

describe('wesh fold', () => {
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

  async function execute({
    script,
    stdinText,
  }: {
    script: string;
    stdinText?: string;
  }) {
    const stdout = createTestWriteCaptureHandle();
    const stderr = createTestWriteCaptureHandle();

    const result = await wesh.execute({
      script,
      stdin: createTestReadHandleFromText({ text: stdinText ?? '' }),
      stdout: stdout.handle,
      stderr: stderr.handle,
    });

    return { result, stdout, stderr };
  }

  it('folds stdin to the requested width', async () => {
    const { result, stdout, stderr } = await execute({
      script: 'fold -w 3',
      stdinText: 'abcdef\n',
    });

    expect(stdout.text).toBe(`\
abc
def
`);
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
  });

  it('supports long width option and preserves missing trailing newlines', async () => {
    const { result, stdout, stderr } = await execute({
      script: 'fold --width=3',
      stdinText: 'abcdef',
    });

    expect(stdout.text).toBe(`\
abc
def`);
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
  });

  it('breaks at spaces when -s is set', async () => {
    const { result, stdout, stderr } = await execute({
      script: 'fold -s -w 5',
      stdinText: 'abc def ghi\n',
    });

    expect(stdout.text).toBe(`\
abc 
def 
ghi
`);
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
  });

  it('reads stdin and files in operand order when - is used', async () => {
    await writeFile({ path: 'sample.txt', data: 'qrstuv\n' });

    const { result, stdout, stderr } = await execute({
      script: 'fold -w 4 - sample.txt',
      stdinText: 'abcdef\n',
    });

    expect(stdout.text).toBe(`\
abcd
ef
qrst
uv
`);
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
  });

  it('continues after missing file errors and returns a failing exit code', async () => {
    await writeFile({ path: 'present.txt', data: 'abcd\n' });

    const { result, stdout, stderr } = await execute({
      script: 'fold -w 2 missing.txt present.txt',
    });

    expect(stdout.text).toBe(`\
ab
cd
`);
    expect(stderr.text).toContain('fold: missing.txt:');
    expect(result.exitCode).toBe(1);
  });

  it('prints usage errors for invalid widths', async () => {
    const { result, stdout, stderr } = await execute({
      script: 'fold --width=0',
    });

    expect(stdout.text).toBe('');
    expect(stderr.text).toContain("fold: invalid width: '0'");
    expect(stderr.text).toContain('usage: fold [OPTION]... [FILE]...');
    expect(result.exitCode).toBe(1);
  });

  it('prints help with --help', async () => {
    const { result, stdout, stderr } = await execute({
      script: 'fold --help',
    });

    expect(stdout.text).toContain('Wrap input lines to fit in specified width');
    expect(stdout.text).toContain('usage: fold [OPTION]... [FILE]...');
    expect(stdout.text).toContain('--width');
    expect(stdout.text).toContain('--spaces');
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
  });
});
