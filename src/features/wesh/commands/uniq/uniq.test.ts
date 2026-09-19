import { beforeEach, describe, expect, it } from 'vitest';
import { Wesh } from '@/features/wesh/index';
import { createTextShellSource } from '@/features/wesh/shell/source';
import { MockFileSystemDirectoryHandle } from '@/features/wesh/mocks/InMemoryFileSystem';
import {
  createTestReadHandleFromText,
  createTestWriteCaptureHandle,
} from '@/features/wesh/utils/test-stream';

describe('wesh uniq', () => {
  let wesh: Wesh;
  let rootHandle: MockFileSystemDirectoryHandle;

  beforeEach(async () => {
    rootHandle = new MockFileSystemDirectoryHandle({ name: 'root' });
    wesh = new Wesh({ rootHandle: rootHandle as unknown as FileSystemDirectoryHandle });
    await wesh.init();
  });

  async function writeFile({
    path,
    data,
  }: {
    path: string,
    data: string | Uint8Array,
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
    path: string,
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
    script: string,
    stdinText?: string,
  }) {
    const stdout = createTestWriteCaptureHandle();
    const stderr = createTestWriteCaptureHandle();

    const result = await wesh.execute({
      source: createTextShellSource({ text: script }),
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

  it('preserves UTF-8 byte-order marks in input records', async () => {
    const { result, stdout, stderr } = await execute({
      script: 'uniq',
      stdinText: `\
\uFEFFalpha
\uFEFFbeta
`,
    });

    expect(Array.from(stdout.buffer)).toEqual(
      Array.from(new TextEncoder().encode(`\
\uFEFFalpha
\uFEFFbeta
`)),
    );
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

  it('terminates an unterminated final input record in its output', async () => {
    const { result, stdout, stderr } = await execute({
      script: 'uniq',
      stdinText: `\
alpha
alpha
beta`,
    });

    expect(stdout.text).toBe(`\
alpha
beta
`);
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
  });

  it('adds a NUL terminator to an unterminated final record with -z', async () => {
    const { result, stdout, stderr } = await execute({
      script: 'uniq -z',
      stdinText: `alpha\0alpha\0beta`,
    });

    expect(Array.from(stdout.buffer)).toEqual(Array.from(new TextEncoder().encode('alpha\0beta\0')));
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
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

  it('treats embedded newlines as field blanks for NUL-terminated records', async () => {
    const input = 'a\nx\0b\ny\0b\ny\0';
    const all = await execute({
      script: 'uniq -z -f 1',
      stdinText: input,
    });
    const duplicates = await execute({
      script: 'uniq -z -d -f 1',
      stdinText: input,
    });

    expect(Array.from(all.stdout.buffer)).toEqual(
      Array.from(new TextEncoder().encode('a\nx\0b\ny\0')),
    );
    expect(all.stderr.text).toBe('');
    expect(all.result.exitCode).toBe(0);
    expect(Array.from(duplicates.stdout.buffer)).toEqual(
      Array.from(new TextEncoder().encode('b\ny\0')),
    );
    expect(duplicates.stderr.text).toBe('');
    expect(duplicates.result.exitCode).toBe(0);
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

  it('emits no groups when both duplicate-only and unique-only modes are requested', async () => {
    const { result, stdout, stderr } = await execute({
      script: 'uniq -d -u',
      stdinText: `\
a
a
b
c
c
`,
    });

    expect(stdout.text).toBe('');
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
  });

  it('counts skipped and checked characters by Unicode code point', async () => {
    const { result, stdout, stderr } = await execute({
      script: 'uniq -s1',
      stdinText: `\
😀alpha
😁alpha
`,
    });

    expect(stdout.text).toBe('😀alpha\n');
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
  });

  it('supports -D and --all-repeated group separators without buffering whole groups', async () => {
    const input = `\
a
a
b
c
c
c
d
`;
    const allRepeated = await execute({
      script: 'uniq -D',
      stdinText: input,
    });
    expect(allRepeated.stdout.text).toBe(`\
a
a
c
c
c
`);
    expect(allRepeated.stderr.text).toBe('');
    expect(allRepeated.result.exitCode).toBe(0);

    const prepend = await execute({
      script: 'uniq --all-repeated=prepend',
      stdinText: input,
    });
    expect(prepend.stdout.text).toBe(`\

a
a

c
c
c
`);
    expect(prepend.stderr.text).toBe('');
    expect(prepend.result.exitCode).toBe(0);
  });

  it('preserves GNU category composition when -u is combined with -D', async () => {
    const { result, stdout, stderr } = await execute({
      script: 'uniq -uD',
      stdinText: `\
a
a
b
c
c
c
d
`,
    });

    expect(stdout.text).toBe(`\
a
c
c
`);
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
  });

  it('supports --group methods while keeping comparison options active', async () => {
    const { result, stdout, stderr } = await execute({
      script: 'uniq -i --group=both',
      stdinText: `\
A
a
b
`,
    });

    expect(stdout.text).toBe(`\

A
a

b

`);
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
  });

  it('rejects repeat counts with -D and selection modes with --group', async () => {
    const allRepeatedCount = await execute({
      script: 'uniq -cD',
      stdinText: `\
a
a
`,
    });
    expect(allRepeatedCount.stdout.text).toBe('');
    expect(allRepeatedCount.stderr.text).toContain('printing all duplicated lines and repeat counts is meaningless');
    expect(allRepeatedCount.result.exitCode).toBe(1);

    const groupedSelection = await execute({
      script: 'uniq --group -u',
      stdinText: `\
a
a
`,
    });
    expect(groupedSelection.stdout.text).toBe('');
    expect(groupedSelection.stderr.text).toContain('--group is mutually exclusive with -c/-d/-D/-u');
    expect(groupedSelection.result.exitCode).toBe(1);
  });

});

describe('wesh uniq ASCII case compatibility', () => {
  async function executeWithFile({
    script,
    data,
  }: {
    script: string,
    data: Uint8Array,
  }) {
    const rootHandle = new MockFileSystemDirectoryHandle({ name: 'root' });
    const fileHandle = await rootHandle.getFileHandle('input.bin', { create: true });
    const writable = await fileHandle.createWritable();
    await writable.write(data);
    await writable.close();

    const wesh = new Wesh({ rootHandle: rootHandle as unknown as FileSystemDirectoryHandle });
    await wesh.init();
    const stdout = createTestWriteCaptureHandle();
    const stderr = createTestWriteCaptureHandle();
    const result = await wesh.execute({
      source: createTextShellSource({ text: script }),
      stdin: createTestReadHandleFromText({ text: '' }),
      stdout: stdout.handle,
      stderr: stderr.handle,
    });
    return { result, stdout, stderr };
  }

  it('does not fold non-ASCII letters with -i', async () => {
    const rootHandle = new MockFileSystemDirectoryHandle({ name: 'root' });
    const wesh = new Wesh({ rootHandle: rootHandle as unknown as FileSystemDirectoryHandle });
    await wesh.init();
    const stdout = createTestWriteCaptureHandle();
    const stderr = createTestWriteCaptureHandle();
    const result = await wesh.execute({
      source: createTextShellSource({ text: 'uniq -ic' }),
      stdin: createTestReadHandleFromText({ text: `\
É
é
E
e
` }),
      stdout: stdout.handle,
      stderr: stderr.handle,
    });

    expect(stdout.text).toBe(`\
      1 É
      1 é
      2 E
`);
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
  });

  it('counts check characters as bytes in the C locale and code points in UTF-8 locales', async () => {
    const data = Uint8Array.from([
      0xc3, 0x89, 0x78, 0x0a,
      0xc3, 0xa9, 0x79, 0x0a,
    ]);

    const cLocale = await executeWithFile({
      script: 'LC_ALL=C uniq -iw1 input.bin',
      data,
    });
    expect(Array.from(cLocale.stdout.buffer)).toEqual([
      0xc3, 0x89, 0x78, 0x0a,
    ]);
    expect(cLocale.stderr.text).toBe('');
    expect(cLocale.result.exitCode).toBe(0);

    const utf8Locale = await executeWithFile({
      script: 'LC_ALL=C.utf8 uniq -iw1 input.bin',
      data,
    });
    expect(Array.from(utf8Locale.stdout.buffer)).toEqual(Array.from(data));
    expect(utf8Locale.stderr.text).toBe('');
    expect(utf8Locale.result.exitCode).toBe(0);
  });

  it('preserves invalid UTF-8 bytes while applying comparison limits', async () => {
    const data = Uint8Array.from([
      0xff, 0x61, 0x0a,
      0xff, 0x62, 0x0a,
    ]);

    const { result, stdout, stderr } = await executeWithFile({
      script: 'LC_ALL=C.utf8 uniq -iw1 input.bin',
      data,
    });

    expect(Array.from(stdout.buffer)).toEqual([0xff, 0x61, 0x0a]);
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
  });


  it('accepts only leading C-locale whitespace in numeric options', async () => {
    const data = new TextEncoder().encode(`\
alpha
atom
`);
    for (const whitespace of [' ', '\t', '\n', '\v', '\f', '\r']) {
      const execution = await executeWithFile({
        script: `uniq -w '${whitespace}1' input.bin`,
        data,
      });
      expect(execution.stdout.text).toBe('alpha\n');
      expect(execution.stderr.text).toBe('');
      expect(execution.result.exitCode).toBe(0);
    }

    for (const operand of ['1 ', '\u00a01', '\u20031', '\ufeff1']) {
      const execution = await executeWithFile({
        script: `uniq -w '${operand}' input.bin`,
        data,
      });
      expect(execution.stdout.text).toBe('');
      expect(execution.stderr.text).toContain('invalid argument to check-chars');
      expect(execution.result.exitCode).toBe(1);
    }
  });


  it('stops field skipping at the end of each record for enormous counts', async () => {
    const { result, stdout, stderr } = await executeWithFile({
      script: 'uniq --skip-fields=999999999999999999999999 input.bin',
      data: new TextEncoder().encode(`\
alpha
atom
`),
    });

    expect(stdout.text).toBe('alpha\n');
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
  });

  it('accepts explicit positive signs and saturates impractically large limits', async () => {
    const data = new TextEncoder().encode(`\
alpha
atom
`);
    for (const operand of ['+1', '999999999999999999999999']) {
      const execution = await executeWithFile({
        script: `uniq -w '${operand}' input.bin`,
        data,
      });
      expect(execution.stderr.text).toBe('');
      expect(execution.result.exitCode).toBe(0);
    }
  });

});
