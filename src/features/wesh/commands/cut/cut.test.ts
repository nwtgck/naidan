import { beforeEach, describe, expect, it } from 'vitest';
import { Wesh } from '@/features/wesh/index';
import { MockFileSystemDirectoryHandle } from '@/features/wesh/mocks/InMemoryFileSystem';
import {
  createTestReadHandleFromText,
  createTestWriteCaptureHandle,
} from '@/features/wesh/utils/test-stream';

describe('wesh cut', () => {
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


  it('matches GNU byte-oriented character selection for multibyte input', async () => {
    const { result, stdout, stderr } = await execute({
      script: 'cut -c1-2',
      stdinText: 'éx\n',
    });

    expect(Array.from(stdout.buffer)).toEqual([0xc3, 0xa9, 0x0a]);
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
  });

  it('uses NUL-delimited records with -z', async () => {
    const { result, stdout, stderr } = await execute({
      script: "cut -z -d: -f2",
      stdinText: 'a:b\0x:y\0',
    });

    expect(Array.from(stdout.buffer)).toEqual([
      0x62, 0x00,
      0x79, 0x00,
    ]);
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
  });

  it('terminates output records even when the input lacks a final delimiter', async () => {
    const { result, stdout, stderr } = await execute({
      script: 'cut -b1-2',
      stdinText: 'abcd',
    });

    expect(stdout.text).toBe('ab\n');
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
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

  it('validates fatal list and delimiter semantics before a later --help', async () => {
    const invalidDelimiter = await execute({ script: 'cut -d xx -f1 --help' });
    const multipleLists = await execute({ script: 'cut -b1 -f1 --help' });
    const helpFirst = await execute({ script: 'cut --help -d xx -f1' });
    const modeConflict = await execute({ script: 'cut -s -b1 --help' });

    expect(invalidDelimiter.result.exitCode).toBe(1);
    expect(invalidDelimiter.stdout.text).toBe('');
    expect(invalidDelimiter.stderr.text).toContain('the delimiter must be a single character');

    expect(multipleLists.result.exitCode).toBe(1);
    expect(multipleLists.stdout.text).toBe('');
    expect(multipleLists.stderr.text).toContain('only one list may be specified');

    expect(helpFirst.result.exitCode).toBe(0);
    expect(helpFirst.stdout.text).not.toBe('');
    expect(helpFirst.stderr.text).toBe('');

    expect(modeConflict.result.exitCode).toBe(0);
    expect(modeConflict.stdout.text).not.toBe('');
    expect(modeConflict.stderr.text).toBe('');
  });

  it('reports invalid option combinations with usage', async () => {
    const { result, stdout, stderr } = await execute({
      script: 'cut -b1 -f1',
    });

    expect(stdout.text).toBe('');
    expect(stderr.text).toContain('cut: only one list may be specified');
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

  it('uses NUL when an explicitly empty output delimiter joins fields', async () => {
    const { result, stdout, stderr } = await execute({
      script: "cut -d: -f1,3 --output-delimiter=''",
      stdinText: 'a:b:c\n',
    });

    expect(Array.from(stdout.buffer)).toEqual([0x61, 0x00, 0x63, 0x0a]);
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
  });

  it('treats an explicitly empty field delimiter as NUL', async () => {
    await writeFile({
      path: 'nul-delimited-input',
      data: Uint8Array.from([
        0x61, 0x00, 0x62, 0x0a,
        0x63, 0x0a,
      ]),
    });

    const firstField = await execute({
      script: "cut -d '' -f1 nul-delimited-input",
    });
    const secondField = await execute({
      script: "cut -d '' -f2 nul-delimited-input",
    });
    const help = await execute({
      script: "cut -d '' -f1 --help",
    });

    expect(Array.from(firstField.stdout.buffer)).toEqual([0x61, 0x0a, 0x63, 0x0a]);
    expect(firstField.stderr.text).toBe('');
    expect(firstField.result.exitCode).toBe(0);

    expect(Array.from(secondField.stdout.buffer)).toEqual([0x62, 0x0a, 0x63, 0x0a]);
    expect(secondField.stderr.text).toBe('');
    expect(secondField.result.exitCode).toBe(0);

    expect(help.result.exitCode).toBe(0);
    expect(help.stdout.text).not.toBe('');
    expect(help.stderr.text).toBe('');
  });

  it('rejects field delimiters that contain more than one character', async () => {
    const { result, stdout, stderr } = await execute({
      script: "cut -d '::' -f2",
      stdinText: 'a::b\n',
    });

    expect(stdout.text).toBe('');
    expect(stderr.text).toContain('cut: the delimiter must be a single character');
    expect(result.exitCode).toBe(1);
  });

  it.each([
    ['-b 1 -b 2'],
    ['-c 1 -c 2'],
    ['-f 1 -f 2'],
    ['-b 1 -c 2'],
    ['-c 1 -f 2'],
    ['-f 1 -b 2'],
  ])('rejects more than one selection list: %s', async (selectionArguments) => {
    const { result, stdout, stderr } = await execute({
      script: `printf 'abcdef\n' | cut ${selectionArguments}`,
    });

    expect(result.exitCode).toBe(1);
    expect(stdout.text).toBe('');
    expect(stderr.text).toContain('cut: only one list may be specified');
  });

  it('rejects field-only options in byte and character modes', async () => {
    const delimiter = await execute({ script: 'cut -b1 -d:', stdinText: 'a:b\n' });
    const suppress = await execute({ script: 'cut -c1 -s', stdinText: 'abc\n' });

    expect(delimiter.stdout.text).toBe('');
    expect(delimiter.stderr.text).toContain('input delimiter may be specified only when operating on fields');
    expect(delimiter.result.exitCode).toBe(1);
    expect(suppress.stdout.text).toBe('');
    expect(suppress.stderr.text).toContain('only when operating on fields');
    expect(suppress.result.exitCode).toBe(1);
  });


  it('preserves arbitrary bytes in selected fields', async () => {
    await writeFile({
      path: 'input',
      data: Uint8Array.from([0x61, 0x3a, 0xff, 0x3a, 0x62, 0x0a]),
    });

    const execution = await execute({
      script: 'cut -d: -f2 input',
    });

    expect(Array.from(execution.stdout.buffer)).toEqual([0xff, 0x0a]);
    expect(execution.stderr.text).toBe('');
    expect(execution.result.exitCode).toBe(0);
  });

  it('does not synthesize a NUL for an unterminated trailing empty field', async () => {
    await writeFile({
      path: 'input',
      data: Uint8Array.from([0x61, 0x3a]),
    });

    const execution = await execute({
      script: 'cut -z -d: -f2 input',
    });

    expect(Array.from(execution.stdout.buffer)).toEqual([]);
    expect(execution.stderr.text).toBe('');
    expect(execution.result.exitCode).toBe(0);
  });

  it('distinguishes a selected trailing empty field from another empty selection', async () => {
    await writeFile({
      path: 'input',
      data: Uint8Array.from([0x3a]),
    });

    const trailingField = await execute({
      script: 'cut -z -d: -f2 input',
    });
    expect(Array.from(trailingField.stdout.buffer)).toEqual([]);
    expect(trailingField.stderr.text).toBe('');
    expect(trailingField.result.exitCode).toBe(0);

    const firstField = await execute({
      script: 'cut -z -d: -f1,3 input',
    });
    expect(Array.from(firstField.stdout.buffer)).toEqual([0x00]);
    expect(firstField.stderr.text).toBe('');
    expect(firstField.result.exitCode).toBe(0);
  });

  it('omits a synthetic NUL after an output delimiter for a selected trailing field', async () => {
    await writeFile({
      path: 'input',
      data: Uint8Array.from([0x61, 0x09]),
    });

    const execution = await execute({
      script: "cut -z -s -f1-2 --output-delimiter='あ' input",
    });

    expect(Array.from(execution.stdout.buffer)).toEqual([
      0x61,
      0xe3, 0x81, 0x82,
    ]);
    expect(execution.stderr.text).toBe('');
    expect(execution.result.exitCode).toBe(0);
  });

  it('omits a synthetic NUL for an unterminated delimited record suppressed at EOF', async () => {
    await writeFile({
      path: 'input',
      data: Uint8Array.from([0x61, 0x3a]),
    });

    const selected = await execute({
      script: 'cut -z -s -d: -f1 input',
    });
    expect(Array.from(selected.stdout.buffer)).toEqual([0x61]);
    expect(selected.stderr.text).toBe('');
    expect(selected.result.exitCode).toBe(0);

    const complemented = await execute({
      script: 'cut -z -d: -f1-2 --complement input',
    });
    expect(Array.from(complemented.stdout.buffer)).toEqual([]);
    expect(complemented.stderr.text).toBe('');
    expect(complemented.result.exitCode).toBe(0);
  });

  it('retains GNU record termination after a second field delimiter', async () => {
    await writeFile({
      path: 'input',
      data: Uint8Array.from([0x61, 0x3a, 0x62, 0x3a]),
    });

    const missingField = await execute({
      script: 'cut -z -d: -f8-12 input',
    });
    expect(Array.from(missingField.stdout.buffer)).toEqual([0x00]);
    expect(missingField.stderr.text).toBe('');
    expect(missingField.result.exitCode).toBe(0);

    const suppressed = await execute({
      script: "cut -z -s -d: -f1-2 --output-delimiter='--' input",
    });
    expect(Array.from(suppressed.stdout.buffer)).toEqual([
      0x61, 0x2d, 0x2d, 0x62, 0x00,
    ]);
    expect(suppressed.stderr.text).toBe('');
    expect(suppressed.result.exitCode).toBe(0);
  });

  it('preserves arbitrary bytes with complements and NUL records', async () => {
    await writeFile({
      path: 'input',
      data: Uint8Array.from([
        0x61, 0x3a, 0xff, 0x00,
        0x63, 0x3a, 0xfe, 0x00,
      ]),
    });

    const selected = await execute({
      script: 'cut -z -d: -f2 input',
    });
    expect(Array.from(selected.stdout.buffer)).toEqual([
      0xff, 0x00,
      0xfe, 0x00,
    ]);
    expect(selected.stderr.text).toBe('');
    expect(selected.result.exitCode).toBe(0);

    const complemented = await execute({
      script: 'cut -z -d: -f2 --complement input',
    });
    expect(Array.from(complemented.stdout.buffer)).toEqual([
      0x61, 0x00,
      0x63, 0x00,
    ]);
    expect(complemented.stderr.text).toBe('');
    expect(complemented.result.exitCode).toBe(0);
  });

});

describe('wesh cut field byte compatibility', () => {
  let wesh: Wesh;

  beforeEach(async () => {
    const rootHandle = new MockFileSystemDirectoryHandle({ name: 'root' });
    wesh = new Wesh({ rootHandle: rootHandle as unknown as FileSystemDirectoryHandle });
    await wesh.init();
  });

  async function execute({ script, stdinText }: { script: string; stdinText: string }) {
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

  it('rejects multibyte field delimiters', async () => {
    const execution = await execute({
      script: "cut -d '😀' -f2",
      stdinText: 'a😀b😀c\n',
    });

    expect(execution.stdout.text).toBe('');
    expect(execution.stderr.text).toContain('cut: the delimiter must be a single character');
    expect(execution.result.exitCode).toBe(1);
  });

  it('preserves a UTF-8 BOM at every field record boundary', async () => {
    const execution = await execute({
      script: 'cut -d: -f1',
      stdinText: '\uFEFFa:b\nc:d\n\uFEFFe:f\n',
    });

    expect(Array.from(execution.stdout.buffer)).toEqual(Array.from(new TextEncoder().encode('\uFEFFa\nc\n\uFEFFe\n')));
    expect(execution.stderr.text).toBe('');
    expect(execution.result.exitCode).toBe(0);
  });
});
