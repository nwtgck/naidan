import { beforeEach, describe, expect, it } from 'vitest';
import { Wesh } from '@/features/wesh/index';
import { createTextShellSource } from '@/features/wesh/shell/source';
import { MockFileSystemDirectoryHandle } from '@/features/wesh/mocks/InMemoryFileSystem';
import {
  createTestReadHandleFromBytes,
  createTestReadHandleFromText,
  createTestWriteCaptureHandle,
} from '@/features/wesh/utils/test-stream';
import { createReadHandleFromStream } from '@/features/wesh/utils/stream';

describe('wesh wc', () => {
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
    data: string,
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
    stdinBytes,
    stdinChunks,
    stdinText,
  }: {
    script: string,
    stdinBytes?: Uint8Array,
    stdinChunks?: readonly Uint8Array[],
    stdinText?: string,
  }) {
    const stdout = createTestWriteCaptureHandle();
    const stderr = createTestWriteCaptureHandle();

    const stdin = (() => {
      if (stdinChunks !== undefined) {
        return createReadHandleFromStream({
          source: new ReadableStream<Uint8Array>({
            start(controller) {
              for (const chunk of stdinChunks) {
                controller.enqueue(new Uint8Array(chunk));
              }
              controller.close();
            },
          }),
        });
      }
      if (stdinBytes !== undefined) {
        return createTestReadHandleFromBytes({ bytes: stdinBytes });
      }
      return createTestReadHandleFromText({ text: stdinText ?? '' });
    })();

    const result = await wesh.execute({
      source: createTextShellSource({ text: script }),
      stdin,
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

    expect(stdout.text).toBe('      2       3      18\n');
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

    expect(stdout.text).toBe('      1       2       8 -\n');
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

    expect(charsAndBytes.stdout.text).toBe('1 4 emoji.txt\n');
    expect(maxLineLength.stdout.text).toBe('4 long.txt\n');
    expect(charsAndBytes.stderr.text).toBe('');
    expect(maxLineLength.stderr.text).toBe('');
    expect(charsAndBytes.result.exitCode).toBe(0);
    expect(maxLineLength.result.exitCode).toBe(0);
  });

  it('uses locale-aware display width for maximum line length', async () => {
    const input = 'é\n😀\ne\u0301\n漢\n';
    const cLocale = await execute({
      script: 'export LC_ALL=C; wc -L',
      stdinText: input,
    });
    const utf8Locale = await execute({
      script: 'export LC_ALL=C.utf8; wc -L',
      stdinText: input,
    });

    expect(cLocale.stdout.text).toBe('1\n');
    expect(utf8Locale.stdout.text).toBe('2\n');
    expect(cLocale.result.exitCode).toBe(0);
    expect(utf8Locale.result.exitCode).toBe(0);
  });

  it('uses regular file size to align multiple count columns', async () => {
    await writeFile({ path: 'sized.txt', data: `${'x'.repeat(99)}\n` });

    const { result, stdout, stderr } = await execute({
      script: 'LC_ALL=C wc -lw sized.txt',
    });

    expect(stdout.text).toBe('  1   1 sized.txt\n');
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
  });

  it('uses the target regular file size when the operand is a symlink', async () => {
    await writeFile({ path: 'target.txt', data: `${'x'.repeat(99)}\n` });
    await wesh.vfs.symlink({ path: '/link.txt', targetPath: '/target.txt' });

    const { result, stdout, stderr } = await execute({
      script: 'LC_ALL=C wc -lw link.txt',
    });

    expect(stdout.text).toBe('  1   1 link.txt\n');
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
  });

  it('uses total regular file size to align one selected count for multiple files', async () => {
    await writeFile({ path: 'small.txt', data: `${'x'.repeat(99)}\n` });
    await writeFile({ path: 'large.txt', data: `${'y'.repeat(899)}\n` });

    const { result, stdout, stderr } = await execute({
      script: 'LC_ALL=C wc -l small.txt large.txt',
    });

    expect(stdout.text).toBe(`   1 small.txt\n   1 large.txt\n   2 total\n`);
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
  });

  it('treats carriage return and form feed as line-length resets in the C locale', async () => {
    const { result, stdout, stderr } = await execute({
      script: 'LC_ALL=C wc -L',
      stdinBytes: new Uint8Array([
        ...new TextEncoder().encode('123456789012345678'),
        0x0c,
        ...new TextEncoder().encode('1234567890123456789'),
        0x0a,
      ]),
    });

    expect(stdout.text).toBe('19\n');
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
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

    expect(stdout.text).toBe(' 2  3 18 sample.txt\n');
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

    expect(stdout.text).toBe(' 2  3 18 sample.txt\n');
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
 1  1  6 first.txt
 1  2 11 second.txt
 2  3 17 total
`);
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
  });

  it('validates --total values before a later --help', async () => {
    const invalid = await execute({ script: 'wc --total bogus --help' });
    const ambiguous = await execute({ script: 'wc --total a --help' });
    const validAbbreviation = await execute({ script: 'wc --total al --help' });
    const helpFirst = await execute({ script: 'wc --help --total bogus' });

    for (const execution of [invalid, ambiguous]) {
      expect(execution.result.exitCode).toBe(1);
      expect(execution.stdout.text).toBe('');
      expect(execution.stderr.text).toContain("for '--total'");
    }
    for (const execution of [validAbbreviation, helpFirst]) {
      expect(execution.result.exitCode).toBe(0);
      expect(execution.stderr.text).toBe('');
      expect(execution.stdout.text).toContain('usage: wc [OPTION]...');
    }
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
1 1 6 present.txt
1 1 6 total
`);
    expect(stderr.text).toContain('wc: missing.txt:');
    expect(result.exitCode).toBe(1);
  });

  it('prints zero counts for directory operands before continuing', async () => {
    await rootHandle.getDirectoryHandle('dir', { create: true });
    await writeFile({ path: 'present.txt', data: 'alpha\n' });

    const { result, stdout, stderr } = await execute({
      script: 'wc dir present.txt',
      stdinText: undefined,
    });

    expect(stdout.text).toBe(`\
      0       0       0 dir
      1       1       6 present.txt
      1       1       6 total
`);
    expect(stderr.text).toBe('wc: dir: Is a directory\n');
    expect(result.exitCode).toBe(1);
  });
  it('counts bytes as characters in the C locale', async () => {
    const cLocale = await execute({
      script: 'LC_ALL=C wc -m',
      stdinText: 'é\n',
    });
    const utf8Locale = await execute({
      script: 'LC_ALL=C.utf8 wc -m',
      stdinText: 'é\n',
    });

    expect(cLocale.stdout.text).toBe('3\n');
    expect(cLocale.stderr.text).toBe('');
    expect(cLocale.result.exitCode).toBe(0);

    expect(utf8Locale.stdout.text).toBe('2\n');
    expect(utf8Locale.stderr.text).toBe('');
    expect(utf8Locale.result.exitCode).toBe(0);
  });

  it('counts a UTF-8 byte-order mark as a character', async () => {
    const leading = await execute({
      script: 'LC_ALL=C.utf8 wc -m',
      stdinText: '\uFEFFalpha\n',
    });
    const eachRecord = await execute({
      script: 'LC_ALL=C.utf8 wc -m',
      stdinText: `\
\uFEFFalpha
\uFEFFbeta
`,
    });

    expect(leading.stdout.text).toBe('7\n');
    expect(eachRecord.stdout.text).toBe('13\n');
    expect(leading.stderr.text).toBe('');
    expect(eachRecord.stderr.text).toBe('');
    expect(leading.result.exitCode).toBe(0);
    expect(eachRecord.result.exitCode).toBe(0);
  });

  it('uses GNU word separators for C and UTF-8 locales', async () => {
    const cEmSpace = await execute({
      script: 'LC_ALL=C wc -w',
      stdinText: 'left right\n',
    });
    const cEncodedNoBreakByte = await execute({
      script: 'LC_ALL=C wc -w',
      stdinText: 'left᠎right\n',
    });
    const utf8WordJoiner = await execute({
      script: 'LC_ALL=C.utf8 wc -w',
      stdinText: 'left⁠right\n',
    });
    const utf8ByteOrderMark = await execute({
      script: 'LC_ALL=C.utf8 wc -w',
      stdinText: 'left\uFEFFright\n',
    });

    expect(cEmSpace.stdout.text).toBe('1\n');
    expect(cEncodedNoBreakByte.stdout.text).toBe('2\n');
    expect(utf8WordJoiner.stdout.text).toBe('2\n');
    expect(utf8ByteOrderMark.stdout.text).toBe('1\n');
    expect(cEmSpace.stderr.text).toBe('');
    expect(cEncodedNoBreakByte.stderr.text).toBe('');
    expect(utf8WordJoiner.stderr.text).toBe('');
    expect(utf8ByteOrderMark.stderr.text).toBe('');
    expect(cEmSpace.result.exitCode).toBe(0);
    expect(cEncodedNoBreakByte.result.exitCode).toBe(0);
    expect(utf8WordJoiner.result.exitCode).toBe(0);
    expect(utf8ByteOrderMark.result.exitCode).toBe(0);
  });

  it('honors POSIXLY_CORRECT for GNU non-breaking word separators', async () => {
    const noBreakSpace = await execute({
      script: 'POSIXLY_CORRECT=1 LC_ALL=C.utf8 wc -w',
      stdinText: 'left right\n',
    });
    const oghamSpaceMark = await execute({
      script: 'POSIXLY_CORRECT=1 LC_ALL=C.utf8 wc -w',
      stdinText: 'left right\n',
    });
    const emptyPosixlyCorrect = await execute({
      script: 'POSIXLY_CORRECT= LC_ALL=C.utf8 wc -w',
      stdinText: 'left⁠right\n',
    });

    expect(noBreakSpace.stdout.text).toBe('1\n');
    expect(oghamSpaceMark.stdout.text).toBe('2\n');
    expect(emptyPosixlyCorrect.stdout.text).toBe('1\n');
    expect(noBreakSpace.stderr.text).toBe('');
    expect(oghamSpaceMark.stderr.text).toBe('');
    expect(emptyPosixlyCorrect.stderr.text).toBe('');
    expect(noBreakSpace.result.exitCode).toBe(0);
    expect(oghamSpaceMark.result.exitCode).toBe(0);
    expect(emptyPosixlyCorrect.result.exitCode).toBe(0);
  });

  it('uses terminal display width for maximum line length', async () => {
    const { result, stdout, stderr } = await execute({
      script: 'export LC_ALL=C.utf8; wc -L',
      stdinText: 'a\tbc\n漢字\ne\u0301\n',
    });

    expect(stdout.text).toBe('10\n');
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
  });

  it('uses byte-oriented printable width in the C locale', async () => {
    const { result, stdout, stderr } = await execute({
      script: 'export LC_ALL=C; wc -L',
      stdinText: 'A漢字\na\t漢\n',
    });

    expect(stdout.text).toBe('8\n');
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
  });

  it('ignores invalid UTF-8 bytes for character and display-width counts', async () => {
    const onlyInvalid = await execute({
      script: 'export LC_ALL=C.utf8; wc -m -w -L',
      stdinBytes: Uint8Array.of(0xFF),
    });
    const mixed = await execute({
      script: 'export LC_ALL=C.utf8; wc -m -w -L',
      stdinBytes: Uint8Array.of(0x61, 0xE2, 0x28, 0xA1),
    });
    const glibcExtendedSequence = await execute({
      script: 'export LC_ALL=C.utf8; wc -m -w -L',
      stdinBytes: Uint8Array.of(0xF8, 0x88, 0x80, 0x80, 0x80),
    });

    expect(onlyInvalid.stdout.text).toBe('      1       0       0\n');
    expect(mixed.stdout.text).toBe('      1       2       2\n');
    expect(glibcExtendedSequence.stdout.text).toBe('      1       1       0\n');
    expect(onlyInvalid.stderr.text).toBe('');
    expect(mixed.stderr.text).toBe('');
    expect(glibcExtendedSequence.stderr.text).toBe('');
    expect(onlyInvalid.result.exitCode).toBe(0);
    expect(mixed.result.exitCode).toBe(0);
    expect(glibcExtendedSequence.result.exitCode).toBe(0);
  });

  it('resets display columns at carriage-return and form-feed controls', async () => {
    const { result, stdout, stderr } = await execute({
      script: 'export LC_ALL=C.utf8; wc -L',
      stdinBytes: Uint8Array.of(
        0x61, 0x62, 0x0D, 0x63,
        0x0A,
        0x64, 0x65, 0x0C, 0x66,
      ),
    });

    expect(stdout.text).toBe('2\n');
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
  });

  it('preserves UTF-8 validation state across stream chunks', async () => {
    const splitValidSequence = await execute({
      script: 'export LC_ALL=C.utf8; wc -m -w -L',
      stdinChunks: [
        Uint8Array.of(0x61, 0xE2),
        Uint8Array.of(0x82),
        Uint8Array.of(0xAC, 0xFF, 0x0A),
      ],
    });
    const splitIncompleteSequence = await execute({
      script: 'export LC_ALL=C.utf8; wc -m -w -L',
      stdinChunks: [Uint8Array.of(0xE2), Uint8Array.of(0x82)],
    });

    expect(splitValidSequence.stdout.text).toBe('      1       3       2\n');
    expect(splitIncompleteSequence.stdout.text).toBe('      1       0       0\n');
    expect(splitValidSequence.stderr.text).toBe('');
    expect(splitIncompleteSequence.stderr.text).toBe('');
    expect(splitValidSequence.result.exitCode).toBe(0);
    expect(splitIncompleteSequence.result.exitCode).toBe(0);
  });


  it('uses GNU field width when stdin is one of multiple operands', async () => {
    const { result, stdout, stderr } = await execute({
      script: `printf 'alpha\nbeta\ngamma\n' | wc -l - -`,
    });

    expect(stdout.text).toBe(`      3 -
      0 -
      3 total
`);
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
  });

  it('reads NUL-terminated file names from --files0-from and honors the last source', async () => {
    await writeFile({ path: 'a.txt', data: 'a\n' });
    await writeFile({ path: 'b.txt', data: 'b\n' });
    await writeFile({ path: 'first.list', data: 'a.txt\0' });
    await writeFile({ path: 'second.list', data: 'a.txt\0b.txt\0' });

    const { result, stdout, stderr } = await execute({
      script: 'wc -l --files0-from=first.list --files0-from=second.list',
    });

    expect(stdout.text).toBe(`1 a.txt
1 b.txt
2 total
`);
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
  });

  it('reads NUL-terminated file names from stdin without data-column padding', async () => {
    await writeFile({ path: 'a.txt', data: 'a\n' });
    await writeFile({ path: 'b.txt', data: 'bb\n' });

    const { result, stdout, stderr } = await execute({
      script: 'wc --files0-from=-',
      stdinBytes: new TextEncoder().encode('a.txt\0b.txt\0'),
    });

    expect(stdout.text).toBe(`1 1 2 a.txt
1 1 3 b.txt
2 2 5 total
`);
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
  });

  it('reports invalid files0-from records and keeps newline file names on one output line', async () => {
    const newlineName = `\
line
name.txt`;
    await writeFile({ path: newlineName, data: 'value\n' });
    await writeFile({ path: 'names.list', data: `\0${newlineName}\0` });

    const { result, stdout, stderr } = await execute({
      script: 'wc -c --files0-from=names.list',
    });

    expect(stdout.text).toBe(`6 'line'$'\\n''name.txt'
6 total
`);
    expect(stderr.text).toContain('names.list:1: invalid zero-length file name');
    expect(result.exitCode).toBe(1);
  });

  it('supports GNU total output modes and keeps hidden totals in column sizing', async () => {
    await writeFile({ path: 'a.txt', data: 'a b\n' });
    await writeFile({ path: 'b.txt', data: `\
xx
yy
` });

    const auto = await execute({ script: 'wc -c --total=auto a.txt b.txt' });
    const always = await execute({ script: 'wc -c --total=always a.txt' });
    const only = await execute({ script: 'wc -c --total=only a.txt b.txt' });
    const never = await execute({ script: 'wc -c --total=never a.txt b.txt' });

    expect(auto.stdout.text).toBe(` 4 a.txt
 6 b.txt
10 total
`);
    expect(always.stdout.text).toBe(`4 a.txt
4 total
`);
    expect(only.stdout.text).toBe('10\n');
    expect(never.stdout.text).toBe(` 4 a.txt
 6 b.txt
`);
    expect(auto.stderr.text).toBe('');
    expect(always.stderr.text).toBe('');
    expect(only.stderr.text).toBe('');
    expect(never.stderr.text).toBe('');
    expect(auto.result.exitCode).toBe(0);
    expect(always.result.exitCode).toBe(0);
    expect(only.result.exitCode).toBe(0);
    expect(never.result.exitCode).toBe(0);
  });

  it('accepts unique total-mode prefixes and totals an empty files0-from source', async () => {
    await writeFile({ path: 'a.txt', data: 'abcd' });
    await writeFile({ path: 'empty.list', data: '' });

    const prefix = await execute({ script: 'wc -c --total=al a.txt' });
    const emptyList = await execute({ script: 'wc -c --total=always --files0-from=empty.list' });
    const ambiguous = await execute({ script: 'wc -c --total=a a.txt' });

    expect(prefix.stdout.text).toBe(`4 a.txt
4 total
`);
    expect(emptyList.stdout.text).toBe('0 total\n');
    expect(ambiguous.stdout.text).toBe('');
    expect(prefix.stderr.text).toBe('');
    expect(emptyList.stderr.text).toBe('');
    expect(ambiguous.stderr.text).toContain("invalid argument 'a' for '--total'");
    expect(prefix.result.exitCode).toBe(0);
    expect(emptyList.result.exitCode).toBe(0);
    expect(ambiguous.result.exitCode).toBe(1);
  });

});
