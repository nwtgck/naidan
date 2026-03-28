import { beforeEach, describe, expect, it } from 'vitest';
import { Wesh } from '@/services/wesh/index';
import { MockFileSystemDirectoryHandle } from '@/services/wesh/mocks/InMemoryFileSystem';
import {
  createTestReadHandleFromText,
  createTestWriteCaptureHandle,
} from '@/services/wesh/utils/test-stream';

describe('wesh cut', () => {
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
    data: string | Uint8Array;
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

  it('cuts fields from stdin with the default tab delimiter', async () => {
    const { result, stdout, stderr } = await execute({
      script: `\
cut -f1
`,
      stdinText: `\
a\tb\tc
x\ty
`,
    });

    expect(stdout.text).toBe(`\
a
x
`);
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
  });

  it('honors -d and --output-delimiter together with --complement', async () => {
    const { result, stdout, stderr } = await execute({
      script: `\
cut -d, -f1 --complement --output-delimiter='|'
`,
      stdinText: `\
a,b,c
x,y
`,
    });

    expect(stdout.text).toBe(`\
b|c
y
`);
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
  });

  it('supports GNU-style long options for fields and delimiters', async () => {
    const { result, stdout, stderr } = await execute({
      script: "cut --fields=2- --delimiter=, --output-delimiter='|'",
      stdinText: 'a,b,c\n',
    });

    expect(stdout.text).toBe('b|c\n');
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
  });

  it('suppresses lines without delimiters in field mode when -s is set', async () => {
    const { result, stdout, stderr } = await execute({
      script: `\
cut -s -f1 -d,
`,
      stdinText: `\
a,b
single
`,
    });

    expect(stdout.text).toBe('a\n');
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
  });

  it('supports --only-delimited as a long alias for -s', async () => {
    const { result, stdout, stderr } = await execute({
      script: 'cut --only-delimited --fields=1 --delimiter=,',
      stdinText: `\
a,b
single
`,
    });

    expect(stdout.text).toBe('a\n');
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
  });

  it('passes lines without delimiters through unchanged in field mode by default', async () => {
    const { result, stdout, stderr } = await execute({
      script: 'cut -f1 -d,',
      stdinText: `\
a,b
single
`,
    });

    expect(stdout.text).toBe(`\
a
single
`);
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
  });

  it('cuts bytes from files', async () => {
    await writeFile({ path: 'bytes.bin', data: new Uint8Array([0x61, 0x62, 0x63, 0x64, 0x0a]) });

    const { result, stdout, stderr } = await execute({
      script: 'cut -b1-2 bytes.bin',
    });

    expect(stdout.text).toBe('ab\n');
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
  });

  it('supports GNU-style long options for bytes and characters', async () => {
    const bytesResult = await execute({
      script: 'cut --bytes=1-2',
      stdinText: 'abcdef\n',
    });
    const charsResult = await execute({
      script: 'cut --characters=2-4',
      stdinText: 'abcdef\n',
    });

    expect(bytesResult.stdout.text).toBe('ab\n');
    expect(charsResult.stdout.text).toBe('bcd\n');
    expect(bytesResult.stderr.text).toBe('');
    expect(charsResult.stderr.text).toBe('');
    expect(bytesResult.result.exitCode).toBe(0);
    expect(charsResult.result.exitCode).toBe(0);
  });

  it('cuts characters and supports complement selection', async () => {
    await writeFile({ path: 'chars.txt', data: 'abcdef\n' });

    const { result, stdout, stderr } = await execute({
      script: 'cut -c1-2 --complement chars.txt',
    });

    expect(stdout.text).toBe('cdef\n');
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
  });

  it('supports mixed and open-ended lists', async () => {
    await writeFile({ path: 'mixed.txt', data: 'abcdefghi\n' });

    const { result, stdout, stderr } = await execute({
      script: 'cut -c1,3-5,7- mixed.txt',
    });

    expect(stdout.text).toBe('acdeghi\n');
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
  });

  it('supports leading open ranges', async () => {
    const { result, stdout, stderr } = await execute({
      script: 'cut -c-3',
      stdinText: 'abcdef\n',
    });

    expect(stdout.text).toBe('abc\n');
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
  });

  it('preserves stdin and file ordering when - is used', async () => {
    await writeFile({ path: 'file.txt', data: 'f1\tf2\n' });

    const { result, stdout, stderr } = await execute({
      script: 'cut -f1 - file.txt',
      stdinText: 's1\ts2\n',
    });

    expect(stdout.text).toBe(`\
s1
f1
`);
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
  });

  it('stops option parsing after --', async () => {
    await writeFile({ path: '-literal.txt', data: 'abcdef\n' });

    const { result, stdout, stderr } = await execute({
      script: 'cut -c1-3 -- -literal.txt',
    });

    expect(stdout.text).toBe('abc\n');
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
  });

  it('prints help with --help', async () => {
    const { result, stdout, stderr } = await execute({
      script: 'cut --help',
    });

    expect(stdout.text).toContain('Remove sections from each line of files');
    expect(stdout.text).toContain('usage: cut [OPTION]... [FILE]...');
    expect(stdout.text).toContain('options:');
    expect(stdout.text).toContain('--help');
    expect(stdout.text).toContain('--complement');
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
  });

  it('reports invalid option combinations with usage', async () => {
    const { result, stdout, stderr } = await execute({
      script: 'cut -b1 -f1',
    });

    expect(stdout.text).toBe('');
    expect(stderr.text).toContain('cut: must specify exactly one of -b, -c, or -f');
    expect(stderr.text).toContain('usage: cut [OPTION]... [FILE]...');
    expect(stderr.text).toContain('try:');
    expect(stderr.text).toContain('--help');
    expect(result.exitCode).toBe(1);
  });

  it('reports invalid lists with usage', async () => {
    const { result, stdout, stderr } = await execute({
      script: 'cut -f0',
    });

    expect(stdout.text).toBe('');
    expect(stderr.text).toContain("cut: invalid list: '0'");
    expect(stderr.text).toContain('usage: cut [OPTION]... [FILE]...');
    expect(result.exitCode).toBe(1);
  });

  it('continues after file errors and returns a failing exit code', async () => {
    await writeFile({ path: 'present.txt', data: 'abc\n' });

    const { result, stdout, stderr } = await execute({
      script: 'cut -c1-2 missing.txt present.txt',
    });

    expect(stdout.text).toBe('ab\n');
    expect(stderr.text).toContain('cut: missing.txt:');
    expect(result.exitCode).toBe(1);
  });
});
