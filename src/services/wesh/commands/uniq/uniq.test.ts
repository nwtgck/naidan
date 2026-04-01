import { beforeEach, describe, expect, it } from 'vitest';
import { Wesh } from '@/services/wesh/index';
import { MockFileSystemDirectoryHandle } from '@/services/wesh/mocks/InMemoryFileSystem';
import {
  createTestReadHandleFromText,
  createTestWriteCaptureHandle,
} from '@/services/wesh/utils/test-stream';

describe('wesh uniq', () => {
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

  async function readFileText({
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

  it('deduplicates adjacent lines from stdin by default', async () => {
    const { result, stdout, stderr } = await execute({
      script: 'uniq',
      stdinText: `\
alpha
alpha
beta
`,
    });

    expect(stdout.text).toBe(`\
alpha
beta
`);
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
  });

  it('supports -c to prefix counts', async () => {
    const { result, stdout, stderr } = await execute({
      script: 'uniq -c',
      stdinText: `\
alpha
alpha
beta
`,
    });

    expect(stdout.text).toBe(`\
      2 alpha
      1 beta
`);
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
  });

  it('supports -d to print only duplicate groups', async () => {
    const { result, stdout, stderr } = await execute({
      script: 'uniq -d',
      stdinText: `\
alpha
alpha
beta
beta
beta
gamma
`,
    });

    expect(stdout.text).toBe(`\
alpha
beta
`);
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
  });

  it('supports -u to print only unique groups', async () => {
    const { result, stdout, stderr } = await execute({
      script: 'uniq -u',
      stdinText: `\
alpha
alpha
beta
gamma
gamma
delta
`,
    });

    expect(stdout.text).toBe(`\
beta
delta
`);
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
  });

  it('supports -i, -f, -s, and -w comparisons', async () => {
    const { result, stdout, stderr } = await execute({
      script: 'uniq -i -f 1 -s 7 -w 3',
      stdinText: `\
a prefix ABCDEF
b prefix abczzz
c other something
`,
    });

    expect(stdout.text).toBe(`\
a prefix ABCDEF
c other something
`);
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
  });

  it('supports GNU-style long options for comparisons', async () => {
    const { result, stdout, stderr } = await execute({
      script: 'uniq --ignore-case --skip-fields=1 --skip-chars=7 --check-chars=3',
      stdinText: `\
a prefix ABCDEF
b prefix abczzz
c other something
`,
    });

    expect(stdout.text).toBe(`\
a prefix ABCDEF
c other something
`);
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
  });

  it('supports explicit dash operands for stdin and stdout', async () => {
    const { result, stdout, stderr } = await execute({
      script: 'uniq - -',
      stdinText: `\
alpha
alpha
beta
`,
    });

    expect(stdout.text).toBe(`\
alpha
beta
`);
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
  });

  it('supports input and output files', async () => {
    await writeFile({
      path: 'input.txt',
      data: `\
alpha
alpha
beta
`,
    });

    const { result, stdout, stderr } = await execute({
      script: 'uniq input.txt output.txt',
      stdinText: undefined,
    });

    expect(stdout.text).toBe('');
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
    expect(await readFileText({ path: 'output.txt' })).toBe(`\
alpha
beta
`);
  });

  it('supports root-relative input and output paths from /', async () => {
    await writeFile({
      path: 'input.txt',
      data: `\
alpha
alpha
beta
`,
    });

    const { result, stdout, stderr } = await execute({
      script: 'cd /; uniq input.txt output.txt',
      stdinText: undefined,
    });

    expect(stdout.text).toBe('');
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
    expect(await readFileText({ path: 'output.txt' })).toBe(`\
alpha
beta
`);
  });

  it('supports zero-terminated records with -z', async () => {
    const { result, stdout, stderr } = await execute({
      script: 'uniq -z',
      stdinText: `alpha\0alpha\0beta\0`,
    });

    expect(Array.from(stdout.buffer)).toEqual(Array.from(new TextEncoder().encode('alpha\0beta\0')));
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
  });

  it('supports GNU-style long output selection options', async () => {
    const repeated = await execute({
      script: 'uniq --repeated',
      stdinText: `\
alpha
alpha
beta
`,
    });
    const unique = await execute({
      script: 'uniq --unique',
      stdinText: `\
alpha
alpha
beta
`,
    });
    const count = await execute({
      script: 'uniq --count',
      stdinText: `\
alpha
alpha
beta
`,
    });

    expect(repeated.stdout.text).toBe('alpha\n');
    expect(unique.stdout.text).toBe('beta\n');
    expect(count.stdout.text).toBe(`\
      2 alpha
      1 beta
`);
    expect(repeated.stderr.text).toBe('');
    expect(unique.stderr.text).toBe('');
    expect(count.stderr.text).toBe('');
    expect(repeated.result.exitCode).toBe(0);
    expect(unique.result.exitCode).toBe(0);
    expect(count.result.exitCode).toBe(0);
  });

  it('prints help with --help', async () => {
    const { result, stdout, stderr } = await execute({
      script: 'uniq --help',
      stdinText: undefined,
    });

    expect(stdout.text).toContain('Report or omit repeated lines');
    expect(stdout.text).toContain('usage: uniq [OPTION]... [INPUT [OUTPUT]]');
    expect(stdout.text).toContain('--help');
    expect(stdout.text).toContain('--count');
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
  });

  it('prints usage for extra operands', async () => {
    const { result, stdout, stderr } = await execute({
      script: 'uniq a b c',
      stdinText: undefined,
    });

    expect(stdout.text).toBe('');
    expect(stderr.text).toContain("uniq: extra operand 'c'");
    expect(stderr.text).toContain('usage: uniq [OPTION]... [INPUT [OUTPUT]]');
    expect(result.exitCode).toBe(1);
  });

  it('reports missing input files with a failing exit code', async () => {
    const { result, stdout, stderr } = await execute({
      script: 'uniq missing.txt',
      stdinText: undefined,
    });

    expect(stdout.text).toBe('');
    expect(stderr.text).toContain('uniq: missing.txt:');
    expect(result.exitCode).toBe(1);
  });

  it('reports invalid numeric arguments with usage', async () => {
    const { result, stdout, stderr } = await execute({
      script: 'uniq --skip-fields=nope',
      stdinText: undefined,
    });

    expect(stdout.text).toBe('');
    expect(stderr.text).toContain('uniq: invalid argument to skip-fields: nope');
    expect(stderr.text).toContain('usage: uniq [OPTION]... [INPUT [OUTPUT]]');
    expect(stderr.text).toContain('try:');
    expect(result.exitCode).toBe(1);
  });
});
