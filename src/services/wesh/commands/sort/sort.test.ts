import { beforeEach, describe, expect, it } from 'vitest';
import { Wesh } from '@/services/wesh/index';
import { MockFileSystemDirectoryHandle } from '@/services/wesh/mocks/InMemoryFileSystem';
import {
  createWeshReadFileHandleFromText,
  createWeshWriteCaptureHandle,
} from '@/services/wesh/utils/test-stream';

describe('wesh sort', () => {
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

  async function readFile({
    path,
  }: {
    path: string;
  }) {
    const segments = path.split('/').filter(Boolean);
    const fileName = segments.pop();
    if (fileName === undefined) throw new Error('path must include a file name');

    let dir = rootHandle;
    for (const segment of segments) {
      dir = await dir.getDirectoryHandle(segment);
    }

    const handle = await dir.getFileHandle(fileName);
    const file = await handle.getFile();
    return await file.text();
  }

  async function execute({
    script,
    stdinText,
  }: {
    script: string;
    stdinText?: string;
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

  it('sorts stdin lexically by default', async () => {
    const { result, stdout, stderr } = await execute({
      script: `\
sort`,
      stdinText: 'beta\nalpha\n',
    });

    expect(stdout.text).toBe('alpha\nbeta\n');
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
  });

  it('combines stdin, - operand, and files in argument order', async () => {
    await writeFile({ path: 'file.txt', data: 'beta\n' });

    const { result, stdout, stderr } = await execute({
      script: `\
sort file.txt -`,
      stdinText: 'gamma\nalpha\n',
    });

    expect(stdout.text).toBe('alpha\nbeta\ngamma\n');
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
  });

  it('supports numeric sort with -n and last-resort line ordering', async () => {
    const { result, stdout, stderr } = await execute({
      script: `\
sort -n`,
      stdinText: 'b2\na2\n',
    });

    expect(stdout.text).toBe('a2\nb2\n');
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
  });

  it('supports GNU-style long sort options', async () => {
    const { result, stdout, stderr } = await execute({
      script: 'sort --numeric-sort --reverse',
      stdinText: '2\n10\n1\n',
    });

    expect(stdout.text).toBe('10\n2\n1\n');
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
  });

  it('preserves input order among equal keys with -s', async () => {
    const { result, stdout, stderr } = await execute({
      script: `\
sort -sn`,
      stdinText: 'b2\na2\n',
    });

    expect(stdout.text).toBe('b2\na2\n');
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
  });

  it('deduplicates lines with -u', async () => {
    const { result, stdout, stderr } = await execute({
      script: `\
sort -n -u`,
      stdinText: '02\n2\n1\n',
    });

    expect(stdout.text).toBe('1\n02\n');
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
  });

  it('supports reverse sorting with -r', async () => {
    const { result, stdout, stderr } = await execute({
      script: `\
sort -r`,
      stdinText: 'beta\nalpha\ngamma\n',
    });

    expect(stdout.text).toBe('gamma\nbeta\nalpha\n');
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
  });

  it('sorts by key definition and field separator with -b, -t, and -k', async () => {
    const { result, stdout, stderr } = await execute({
      script: `\
sort -b -t: -k2,2`,
      stdinText: 'row: b\nrow:a\n',
    });

    expect(stdout.text).toBe('row:a\nrow: b\n');
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
  });

  it('supports GNU-style long key and field-separator options', async () => {
    const { result, stdout, stderr } = await execute({
      script: 'sort --ignore-leading-blanks --field-separator=: --key=2,2',
      stdinText: 'row: b\nrow:a\n',
    });

    expect(stdout.text).toBe('row:a\nrow: b\n');
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
  });

  it('supports dictionary order with -d', async () => {
    const { result, stdout, stderr } = await execute({
      script: `\
sort -d`,
      stdinText: 'a!b\na1b\n',
    });

    expect(stdout.text).toBe('a1b\na!b\n');
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
  });

  it('supports ignore nonprinting with -i', async () => {
    const { result, stdout, stderr } = await execute({
      script: `\
sort -i`,
      stdinText: `a\x01b\na1b\n`,
    });

    expect(stdout.text).toBe(`a1b\na\x01b\n`);
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
  });

  it('supports general numeric sort with -g', async () => {
    const { result, stdout, stderr } = await execute({
      script: `\
sort -g`,
      stdinText: '2e2\n9\n10\n',
    });

    expect(stdout.text).toBe('9\n10\n2e2\n');
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
  });

  it('supports human numeric sort with -h', async () => {
    const { result, stdout, stderr } = await execute({
      script: `\
sort -h`,
      stdinText: '2K\n500\n1K\n',
    });

    expect(stdout.text).toBe('500\n1K\n2K\n');
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
  });

  it('supports month sort with -M', async () => {
    const { result, stdout, stderr } = await execute({
      script: `\
sort -M`,
      stdinText: 'Dec\nFeb\nJan\n',
    });

    expect(stdout.text).toBe('Jan\nFeb\nDec\n');
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
  });

  it('supports version sort with -V', async () => {
    const { result, stdout, stderr } = await execute({
      script: `\
sort -V`,
      stdinText: 'v1.10\nv1.2\nv1.9\n',
    });

    expect(stdout.text).toBe('v1.2\nv1.9\nv1.10\n');
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
  });

  it('supports merge mode with already sorted files', async () => {
    await writeFile({ path: 'left.txt', data: 'a\nc\n' });
    await writeFile({ path: 'right.txt', data: 'b\nd\n' });

    const { result, stdout, stderr } = await execute({
      script: `\
sort -m left.txt right.txt`,
      stdinText: undefined,
    });

    expect(stdout.text).toBe('a\nb\nc\nd\n');
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
  });

  it('supports merge mode together with key selection', async () => {
    await writeFile({ path: 'left.txt', data: 'a2\nb1\n' });
    await writeFile({ path: 'right.txt', data: 'a3\nb0\n' });

    const { result, stdout, stderr } = await execute({
      script: 'sort -m -k1,1 left.txt right.txt',
      stdinText: undefined,
    });

    expect(stdout.text).toBe('a2\na3\nb0\nb1\n');
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
  });

  it('writes output to a file with -o', async () => {
    await writeFile({ path: 'input.txt', data: 'beta\nalpha\n' });

    const { result, stdout, stderr } = await execute({
      script: `\
sort -o output.txt input.txt`,
      stdinText: undefined,
    });

    expect(stdout.text).toBe('');
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
    expect(await readFile({ path: 'output.txt' })).toBe('alpha\nbeta\n');
  });

  it('supports the long --output form', async () => {
    await writeFile({ path: 'input.txt', data: 'beta\nalpha\n' });

    const { result, stdout, stderr } = await execute({
      script: 'sort --output=output.txt input.txt',
      stdinText: undefined,
    });

    expect(stdout.text).toBe('');
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
    expect(await readFile({ path: 'output.txt' })).toBe('alpha\nbeta\n');
  });

  it('supports zero-terminated input and output with -z', async () => {
    const { result, stdout, stderr } = await execute({
      script: `\
sort -z`,
      stdinText: 'b\0a\0',
    });

    expect(stdout.text).toBe('a\0b\0');
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
  });

  it('reports unsorted input with -c and exits 1', async () => {
    const { result, stdout, stderr } = await execute({
      script: `\
sort -c`,
      stdinText: 'beta\nalpha\n',
    });

    expect(stdout.text).toBe('');
    expect(stderr.text).toContain('sort: disorder at line 2: alpha');
    expect(result.exitCode).toBe(1);
  });

  it('checks silently with -C', async () => {
    const { result, stdout, stderr } = await execute({
      script: `\
sort -C`,
      stdinText: 'beta\nalpha\n',
    });

    expect(stdout.text).toBe('');
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(1);
  });

  it('supports the long --check form', async () => {
    const { result, stdout, stderr } = await execute({
      script: `\
sort --check`,
      stdinText: 'beta\nalpha\n',
    });

    expect(stdout.text).toBe('');
    expect(stderr.text).toContain('sort: disorder at line 2: alpha');
    expect(result.exitCode).toBe(1);
  });

  it('supports the quiet long check form', async () => {
    const { result, stdout, stderr } = await execute({
      script: `\
sort --check=quiet`,
      stdinText: 'beta\nalpha\n',
    });

    expect(stdout.text).toBe('');
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(1);
  });

  it('reports invalid options with usage and help hints', async () => {
    const { result, stdout, stderr } = await execute({
      script: `\
sort --no-such-option`,
      stdinText: undefined,
    });

    expect(stdout.text).toBe('');
    expect(stderr.text).toContain("sort: unrecognized option '--no-such-option'");
    expect(stderr.text).toContain('usage: sort [OPTION]... [FILE]...');
    expect(stderr.text).toContain('try:');
    expect(stderr.text).toContain('--help');
    expect(result.exitCode).toBe(2);
  });

  it('reports missing key operands with usage', async () => {
    const { result, stdout, stderr } = await execute({
      script: `\
sort -k`,
      stdinText: undefined,
    });

    expect(stdout.text).toBe('');
    expect(stderr.text).toContain('sort: -k requires a value for KEYDEF');
    expect(stderr.text).toContain('usage: sort [OPTION]... [FILE]...');
    expect(stderr.text).toContain('try:');
    expect(result.exitCode).toBe(2);
  });

  it('prints structured help with --help', async () => {
    const { result, stdout, stderr } = await execute({
      script: `\
sort --help`,
      stdinText: undefined,
    });

    expect(stderr.text).toBe('');
    expect(stdout.text).toContain('Sort lines of text files');
    expect(stdout.text).toContain('usage: sort [OPTION]... [FILE]...');
    expect(stdout.text).toContain('-k KEYDEF, --key=KEYDEF');
    expect(stdout.text).toContain('-n, --numeric-sort');
    expect(result.exitCode).toBe(0);
  });
});
