import { beforeEach, describe, expect, it } from 'vitest';
import { Wesh } from '@/services/wesh/index';
import { MockFileSystemDirectoryHandle } from '@/services/wesh/mocks/InMemoryFileSystem';
import {
  createTestReadHandleFromText,
  createTestWriteCaptureHandle,
} from '@/services/wesh/utils/test-stream';

describe('wesh wc', () => {
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

  it('counts stdin with the default columns and no filename', async () => {
    const { result, stdout, stderr } = await execute({
      script: 'wc',
      stdinText: `\
alpha beta
second
`,
    });

    expect(stdout.text).toBe('       2       3      18\n');
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
  });

  it('prints explicit stdin markers and totals when multiple inputs are present', async () => {
    await writeFile({ path: 'first.txt', data: 'alpha\n' });
    await writeFile({ path: 'second.txt', data: 'beta gamma\n' });

    const { result, stdout, stderr } = await execute({
      script: 'wc -l - first.txt second.txt',
      stdinText: 'one two\n',
    });

    expect(stdout.text).toBe(`\
       1 -
       1 first.txt
       1 second.txt
       3 total
`);
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
  });

  it('prints a filename for an explicit stdin operand', async () => {
    const { result, stdout, stderr } = await execute({
      script: 'wc -',
      stdinText: 'one two\n',
    });

    expect(stdout.text).toBe('       1       2       8 -\n');
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
  });

  it('supports bytes, chars, and max line length selections', async () => {
    await writeFile({ path: 'emoji.txt', data: '😀' });
    await writeFile({ path: 'long.txt', data: `\
ab
abcd
` });

    const charsAndBytes = await execute({
      script: 'wc -cm emoji.txt',
      stdinText: undefined,
    });
    const maxLineLength = await execute({
      script: 'wc -L long.txt',
      stdinText: undefined,
    });

    expect(charsAndBytes.stdout.text).toBe('       1       4 emoji.txt\n');
    expect(maxLineLength.stdout.text).toBe('       4 long.txt\n');
    expect(charsAndBytes.stderr.text).toBe('');
    expect(maxLineLength.stderr.text).toBe('');
    expect(charsAndBytes.result.exitCode).toBe(0);
    expect(maxLineLength.result.exitCode).toBe(0);
  });

  it('supports GNU-style long counting options', async () => {
    await writeFile({ path: 'sample.txt', data: `\
alpha beta
second
` });

    const { result, stdout, stderr } = await execute({
      script: 'wc --lines --words --bytes sample.txt',
      stdinText: undefined,
    });

    expect(stdout.text).toBe('       2       3      18 sample.txt\n');
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
  });

  it('reads root-relative files correctly from /', async () => {
    await writeFile({ path: 'sample.txt', data: `\
alpha beta
second
` });

    const { result, stdout, stderr } = await execute({
      script: 'cd /; wc sample.txt',
      stdinText: undefined,
    });

    expect(stdout.text).toBe('       2       3      18 sample.txt\n');
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
  });

  it('prints totals for multiple files', async () => {
    await writeFile({ path: 'first.txt', data: 'alpha\n' });
    await writeFile({ path: 'second.txt', data: 'beta gamma\n' });

    const { result, stdout, stderr } = await execute({
      script: 'wc first.txt second.txt',
      stdinText: undefined,
    });

    expect(stdout.text).toBe(`\
       1       1       6 first.txt
       1       2      11 second.txt
       2       3      17 total
`);
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
  });

  it('prints usage help for invalid options', async () => {
    const { result, stdout, stderr } = await execute({
      script: 'wc -z',
      stdinText: undefined,
    });

    expect(stdout.text).toBe('');
    expect(stderr.text).toContain("wc: invalid option -- 'z'");
    expect(stderr.text).toContain('usage: wc [OPTION]... [FILE]...');
    expect(stderr.text).toContain('try:');
    expect(stderr.text).toContain('--help');
    expect(result.exitCode).toBe(1);
  });

  it('prints help with --help', async () => {
    const { result, stdout, stderr } = await execute({
      script: 'wc --help',
      stdinText: undefined,
    });

    expect(stdout.text).toContain('Print newline, word, byte, character, and line length counts');
    expect(stdout.text).toContain('usage: wc [OPTION]... [FILE]...');
    expect(stdout.text).toContain('options:');
    expect(stdout.text).toContain('--max-line-length');
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
  });

  it('continues after missing file errors and returns a failing exit code', async () => {
    await writeFile({ path: 'present.txt', data: 'alpha\n' });

    const { result, stdout, stderr } = await execute({
      script: 'wc missing.txt present.txt',
      stdinText: undefined,
    });

    expect(stdout.text).toBe(`\
       1       1       6 present.txt
       1       1       6 total
`);
    expect(stderr.text).toContain('wc: missing.txt:');
    expect(result.exitCode).toBe(1);
  });
});
