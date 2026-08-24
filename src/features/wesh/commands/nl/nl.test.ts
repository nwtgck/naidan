import { beforeEach, describe, expect, it } from 'vitest';
import { Wesh } from '@/features/wesh/index';
import { MockFileSystemDirectoryHandle } from '@/features/wesh/mocks/InMemoryFileSystem';
import {
  createTestReadHandleFromBytes,
  createTestReadHandleFromText,
  createTestWriteCaptureHandle,
} from '@/features/wesh/utils/test-stream';

describe('wesh nl', () => {
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
    stdinText,
    stdinBytes,
  }: {
    script: string,
    stdinText?: string,
    stdinBytes?: Uint8Array,
  }) {
    const stdout = createTestWriteCaptureHandle();
    const stderr = createTestWriteCaptureHandle();

    const stdin = stdinBytes === undefined
      ? createTestReadHandleFromText({ text: stdinText ?? '' })
      : createTestReadHandleFromBytes({ bytes: stdinBytes });

    const result = await wesh.execute({
      script,
      stdin,
      stdout: stdout.handle,
      stderr: stderr.handle,
    });

    return { result, stdout, stderr };
  }

  function expandVisibleSpaces({
    text,
  }: {
    text: string,
  }): string {
    return text.replaceAll('·', ' ');
  }

  it('numbers nonempty stdin lines by default', async () => {
    const { result, stdout, stderr } = await execute({
      script: 'nl',
      stdinText: `\
alpha

beta
`,
    });

    expect(stdout.text).toBe(expandVisibleSpaces({
      text: `\
     1\talpha
·······
     2\tbeta
`,
    }));
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
  });

  it('adds a final newline for an unterminated final input line', async () => {
    const { result, stdout, stderr } = await execute({
      script: 'nl',
      stdinText: 'alpha',
    });

    expect(stdout.text).toBe(`\
     1\talpha
`);
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
  });

  it('reads files, stdin operands, and multiple files in order', async () => {
    await writeFile({
      path: 'first.txt',
      data: `\
first
`,
    });
    await writeFile({
      path: 'second.txt',
      data: `\
second
`,
    });

    const { result, stdout, stderr } = await execute({
      script: 'nl first.txt - second.txt',
      stdinText: `\
stdin
`,
    });

    expect(stdout.text).toBe(`\
     1\tfirst
     2\tstdin
     3\tsecond
`);
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
  });

  it('continues after missing file errors and returns a failing exit code', async () => {
    await writeFile({
      path: 'present.txt',
      data: `\
present
`,
    });

    const { result, stdout, stderr } = await execute({
      script: 'nl missing.txt present.txt',
    });

    expect(stdout.text).toBe(`\
     1\tpresent
`);
    expect(stderr.text).toContain('nl: missing.txt:');
    expect(result.exitCode).toBe(1);
  });

  it('supports body numbering styles', async () => {
    const input = `\
alpha

beta
`;

    const all = await execute({ script: 'nl -ba', stdinText: input });
    const none = await execute({ script: 'nl -bn', stdinText: input });
    const pattern = await execute({ script: "nl -bp'^b'", stdinText: input });

    expect(all.stdout.text).toBe(`\
     1\talpha
     2\t
     3\tbeta
`);
    expect(none.stdout.text).toBe(expandVisibleSpaces({
      text: `\
       alpha
·······
       beta
`,
    }));
    expect(pattern.stdout.text).toBe(expandVisibleSpaces({
      text: `\
       alpha
·······
     1\tbeta
`,
    }));
    expect(all.stderr.text).toBe('');
    expect(none.stderr.text).toBe('');
    expect(pattern.stderr.text).toBe('');
    expect(all.result.exitCode).toBe(0);
    expect(none.result.exitCode).toBe(0);
    expect(pattern.result.exitCode).toBe(0);
  });

  it('treats carriage return as ordinary data in pattern numbering', async () => {
    const result = await execute({
      script: 'nl -bp.',
      stdinBytes: Uint8Array.from([0x0d, 0x0a]),
    });

    expect(result.stdout.buffer).toEqual(
      Uint8Array.from([0x20, 0x20, 0x20, 0x20, 0x20, 0x31, 0x09, 0x0d, 0x0a]),
    );
    expect(result.stderr.text).toBe('');
    expect(result.result.exitCode).toBe(0);
  });

  it('does not treat malformed UTF-8 bytes as characters in a UTF-8 locale', async () => {
    const anchored = await execute({
      script: String.raw`LC_ALL=C.utf8 nl -bp'^..$'`,
      stdinBytes: Uint8Array.from([0x41, 0xff, 0x0a]),
    });
    const dot = await execute({
      script: String.raw`LC_ALL=C.utf8 nl -bp.`,
      stdinBytes: Uint8Array.from([0x80]),
    });
    const byteLocale = await execute({
      script: String.raw`LC_ALL=C nl -bp'^..$'`,
      stdinBytes: Uint8Array.from([0x41, 0xff, 0x0a]),
    });

    expect(anchored.stdout.buffer).toEqual(
      Uint8Array.from([0x20, 0x20, 0x20, 0x20, 0x20, 0x20, 0x20, 0x41, 0xff, 0x0a]),
    );
    expect(dot.stdout.buffer).toEqual(
      Uint8Array.from([0x20, 0x20, 0x20, 0x20, 0x20, 0x20, 0x20, 0x80, 0x0a]),
    );
    expect(byteLocale.stdout.buffer).toEqual(
      Uint8Array.from([0x20, 0x20, 0x20, 0x20, 0x20, 0x31, 0x09, 0x41, 0xff, 0x0a]),
    );
    for (const result of [anchored, dot, byteLocale]) {
      expect(result.stderr.text).toBe('');
      expect(result.result.exitCode).toBe(0);
    }
  });

  it('keeps UTF-8 byte-order marks visible to pattern numbering', async () => {
    const ascii = await execute({
      script: "nl -bp'^alpha'",
      stdinText: `\
\uFEFFalpha
beta
`,
    });
    const literalBom = await execute({
      script: "nl -bp'^\uFEFFalpha'",
      stdinText: `\
\uFEFFalpha
beta
`,
    });

    expect(ascii.stdout.text).toBe(expandVisibleSpaces({
      text: `\
       \uFEFFalpha
       beta
`,
    }));
    expect(literalBom.stdout.text).toBe(expandVisibleSpaces({
      text: `\
     1\t\uFEFFalpha
       beta
`,
    }));
    for (const outcome of [ascii, literalBom]) {
      expect(outcome.stderr.text).toBe('');
      expect(outcome.result.exitCode).toBe(0);
    }
  });

  it('supports number formatting, width, separator, start, and increment options', async () => {
    const input = `\
a
b
c
`;

    const left = await execute({ script: "nl -nln -w3 -s '|' -v -3 -i 2", stdinText: input });
    const zero = await execute({ script: 'nl -nrz -w4 -v -3 -i 2', stdinText: input });

    expect(left.stdout.text).toBe(`\
-3 |a
-1 |b
1  |c
`);
    expect(zero.stdout.text).toBe(`\
-003\ta
-001\tb
0001\tc
`);
    expect(left.stderr.text).toBe('');
    expect(zero.stderr.text).toBe('');
    expect(left.result.exitCode).toBe(0);
    expect(zero.result.exitCode).toBe(0);
  });


  it('accepts leading C-locale whitespace in numeric options', async () => {
    const { result, stdout, stderr } = await execute({
      script: "nl -ba -w ' 2' -v '\t3' -i '\v2'",
      stdinText: `\
a
b
`,
    });

    expect(stdout.text).toBe(`\
 3\ta
 5\tb
`);
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
  });

  it('groups blank lines with join-blank-lines', async () => {
    const { result, stdout, stderr } = await execute({
      script: 'nl -ba -l2',
      stdinText: `\
alpha


beta
`,
    });

    expect(stdout.text).toBe(expandVisibleSpaces({
      text: `\
     1\talpha
·······
     2\t
     3\tbeta
`,
    }));
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
  });

  it('handles logical page delimiters and no-renumber', async () => {
    const input = `\
\\:\\:\\:
header
\\:\\:
body
\\:
footer
`;

    const renumber = await execute({ script: 'nl -ha -ba -fa', stdinText: input });
    const noRenumber = await execute({ script: 'nl -ha -ba -fa -p', stdinText: input });

    expect(renumber.stdout.text).toBe(`\

     1\theader

     1\tbody

     1\tfooter
`);
    expect(noRenumber.stdout.text).toBe(`\

     1\theader

     2\tbody

     3\tfooter
`);
    expect(renumber.stderr.text).toBe('');
    expect(noRenumber.stderr.text).toBe('');
    expect(renumber.result.exitCode).toBe(0);
    expect(noRenumber.result.exitCode).toBe(0);
  });

  it('supports custom, one-character, long, and empty section delimiters', async () => {
    const oneChar = await execute({
      script: 'nl -d x -ha -ba -fa',
      stdinText: `\
x:x:x:
header
x:x:
body
x:
footer
`,
    });
    const long = await execute({
      script: 'nl -d abc -ha -ba -fa',
      stdinText: `\
abcabcabc
header
abcabc
body
abc
footer
`,
    });
    const empty = await execute({
      script: "nl -d '' -ba",
      stdinText: `\
\\:\\:\\:
body
`,
    });

    expect(oneChar.stdout.text).toBe(`\

     1\theader

     1\tbody

     1\tfooter
`);
    expect(long.stdout.text).toBe(`\

     1\theader

     1\tbody

     1\tfooter
`);
    expect(empty.stdout.text).toBe(`\
     1\t\\:\\:\\:
     2\tbody
`);
    expect(oneChar.stderr.text).toBe('');
    expect(long.stderr.text).toBe('');
    expect(empty.stderr.text).toBe('');
    expect(oneChar.result.exitCode).toBe(0);
    expect(long.result.exitCode).toBe(0);
    expect(empty.result.exitCode).toBe(0);
  });

  it('preserves binary line content while adding line prefixes and terminators', async () => {
    const input = new Uint8Array([
      0x41,
      0x00,
      0x42,
      0x0a,
      0x43,
      0x0d,
      0x0a,
    ]);

    const { result, stdout, stderr } = await execute({
      script: 'nl -ba',
      stdinBytes: input,
    });

    expect(Array.from(stdout.buffer)).toEqual([
      0x20, 0x20, 0x20, 0x20, 0x20, 0x31, 0x09, 0x41, 0x00, 0x42, 0x0a,
      0x20, 0x20, 0x20, 0x20, 0x20, 0x32, 0x09, 0x43, 0x0d, 0x0a,
    ]);
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
  });

  it('prints help and reports invalid usage', async () => {
    const help = await execute({ script: 'nl --help' });
    const invalidOption = await execute({ script: 'nl -z' });
    const invalidStyle = await execute({ script: 'nl -bx' });
    const invalidWidth = await execute({ script: 'nl -w0' });
    const excessiveWidth = await execute({ script: 'nl -w1000001' });
    const invalidRegex = await execute({ script: "nl -bp'['" });

    expect(help.stdout.text).toContain('Number lines of files');
    expect(help.stdout.text).toContain('usage: nl [OPTION]... [FILE]...');
    expect(help.stdout.text).toContain('--body-numbering');
    expect(help.stderr.text).toBe('');
    expect(help.result.exitCode).toBe(0);

    expect(invalidOption.stdout.text).toBe('');
    expect(invalidOption.stderr.text).toContain("nl: invalid option -- 'z'");
    expect(invalidOption.stderr.text).toContain('usage: nl [OPTION]... [FILE]...');
    expect(invalidOption.result.exitCode).toBe(1);

    expect(invalidStyle.stdout.text).toBe('');
    expect(invalidStyle.stderr.text).toContain("nl: invalid body numbering style: 'x'");
    expect(invalidStyle.result.exitCode).toBe(1);

    expect(invalidWidth.stdout.text).toBe('');
    expect(invalidWidth.stderr.text).toContain("nl: invalid line number field width: '0'");
    expect(invalidWidth.result.exitCode).toBe(1);

    expect(excessiveWidth.stdout.text).toBe('');
    expect(excessiveWidth.stderr.text).toContain('nl: line number field width exceeds safety limit 1000000');
    expect(excessiveWidth.result.exitCode).toBe(1);

    expect(invalidRegex.stdout.text).toBe('');
    expect(invalidRegex.stderr.text).toContain('nl: invalid regular expression');
    expect(invalidRegex.result.exitCode).toBe(1);
  });

  it('matches GNU nl help ordering around unknown and invalid options', async () => {
    const helpThenUnknown = await execute({ script: 'nl --help --bogus' });
    const unknownThenHelp = await execute({ script: 'nl --bogus --help' });
    const invalidWidthThenHelp = await execute({ script: 'nl -w nope --help' });
    const helpThenInvalidWidth = await execute({ script: 'nl --help -w nope' });
    const doubleDash = await execute({ script: 'nl -- --help --bogus' });

    expect(helpThenUnknown.stdout.text).toContain('Number lines of files');
    expect(helpThenUnknown.stderr.text).toBe('');
    expect(helpThenUnknown.result.exitCode).toBe(0);

    expect(unknownThenHelp.stdout.text).toContain('Number lines of files');
    expect(unknownThenHelp.stderr.text).toContain("nl: unrecognized option '--bogus'");
    expect(unknownThenHelp.stderr.text).not.toContain('usage: nl [OPTION]... [FILE]...');
    expect(unknownThenHelp.result.exitCode).toBe(0);

    expect(invalidWidthThenHelp.stdout.text).toBe('');
    expect(invalidWidthThenHelp.stderr.text).toContain("nl: invalid line number field width: 'nope'");
    expect(invalidWidthThenHelp.result.exitCode).toBe(1);

    expect(helpThenInvalidWidth.stdout.text).toContain('Number lines of files');
    expect(helpThenInvalidWidth.stderr.text).toBe('');
    expect(helpThenInvalidWidth.result.exitCode).toBe(0);

    expect(doubleDash.stdout.text).toBe('');
    expect(doubleDash.stderr.text).toContain('nl: --help:');
    expect(doubleDash.stderr.text).toContain('nl: --bogus:');
    expect(doubleDash.result.exitCode).toBe(1);

    const semanticThenUnknown = await execute({ script: 'nl -b bad --bogus --help' });
    const unknownThenSemantic = await execute({ script: 'nl --bogus -b bad --help' });
    expect(semanticThenUnknown.stderr.text.indexOf('invalid body numbering style'))
      .toBeLessThan(semanticThenUnknown.stderr.text.indexOf("unrecognized option '--bogus'"));
    expect(unknownThenSemantic.stderr.text.indexOf("unrecognized option '--bogus'"))
      .toBeLessThan(unknownThenSemantic.stderr.text.indexOf('invalid body numbering style'));
    expect(semanticThenUnknown.result.exitCode).toBe(0);
    expect(unknownThenSemantic.result.exitCode).toBe(0);
  });

  it('preserves GNU semantic diagnostics that precede a later --help', async () => {
    const invalidFormat = await execute({ script: 'nl -n bad --help' });
    const invalidBody = await execute({ script: 'nl -b bad --help' });
    const invalidFooter = await execute({ script: 'nl -f bad --help' });
    const invalidHeader = await execute({ script: 'nl -h bad --help' });
    const invalidRegex = await execute({ script: "nl -b 'p[' --help" });
    const helpFirst = await execute({ script: 'nl --help -b bad' });

    for (const execution of [invalidFormat, invalidBody, invalidFooter, invalidHeader]) {
      expect(execution.result.exitCode).toBe(0);
      expect(execution.stdout.text).toContain('Number lines of files');
      expect(execution.stderr.text).not.toBe('');
    }

    expect(invalidRegex.result.exitCode).toBe(1);
    expect(invalidRegex.stdout.text).toBe('');
    expect(invalidRegex.stderr.text).toContain('invalid regular expression');

    expect(helpFirst.result.exitCode).toBe(0);
    expect(helpFirst.stdout.text).toContain('Number lines of files');
    expect(helpFirst.stderr.text).toBe('');
  });

  it('is available through the standard command registry paths', async () => {
    const binPath = await execute({
      script: '/bin/nl',
      stdinText: `\
alpha
`,
    });
    const commandLookup = await execute({ script: 'command -v nl' });
    const helpLookup = await execute({ script: 'help nl' });

    expect(binPath.stdout.text).toBe(`\
     1\talpha
`);
    expect(binPath.stderr.text).toBe('');
    expect(binPath.result.exitCode).toBe(0);

    expect(commandLookup.stdout.text).toContain('nl');
    expect(commandLookup.stderr.text).toBe('');
    expect(commandLookup.result.exitCode).toBe(0);

    expect(helpLookup.stdout.text).toContain('Number lines of files');
    expect(helpLookup.stdout.text).toContain('usage: nl [OPTION]... [FILE]...');
    expect(helpLookup.stderr.text).toBe('');
    expect(helpLookup.result.exitCode).toBe(0);
  });

  it('uses GNU basic regular expressions for pattern numbering styles', async () => {
    const input = `\
123
abc
abab
${' '}
`;
    const digits = await execute({
      script: String.raw`nl -bp'[[:digit:]]\+'`,
      stdinText: input,
    });
    const backreference = await execute({
      script: String.raw`nl -bp'^\(ab\)\1$'`,
      stdinText: input,
    });

    expect(digits.stdout.text).toBe(expandVisibleSpaces({
      text: `\
     1\t123
       abc
       abab
·······${' '}
`,
    }));
    expect(backreference.stdout.text).toBe(expandVisibleSpaces({
      text: `\
       123
       abc
     1\tabab
·······${' '}
`,
    }));
    for (const outcome of [digits, backreference]) {
      expect(outcome.stderr.text).toBe('');
      expect(outcome.result.exitCode).toBe(0);
    }
  });

  it('uses BRE anchor context and leading closing brackets in pattern styles', async () => {
    const input = `\
a^b
a$b
a
]
b
`;
    const caret = await execute({ script: String.raw`nl -bp'a^b'`, stdinText: input });
    const dollar = await execute({ script: String.raw`nl -bp'a$b'`, stdinText: input });
    const bracket = await execute({ script: String.raw`nl -bp'[]a]'`, stdinText: input });

    expect(caret.stdout.text).toContain('     1\ta^b\n');
    expect(caret.stdout.text).not.toContain('     1\ta$b\n');
    expect(dollar.stdout.text).toContain('     1\ta$b\n');
    expect(dollar.stdout.text).not.toContain('     1\ta^b\n');
    expect(bracket.stdout.text).toContain('     1\ta^b\n');
    expect(bracket.stdout.text).toContain('     2\ta$b\n');
    expect(bracket.stdout.text).toContain('     3\ta\n');
    expect(bracket.stdout.text).toContain('     4\t]\n');
    for (const outcome of [caret, dollar, bracket]) {
      expect(outcome.stderr.text).toBe('');
      expect(outcome.result.exitCode).toBe(0);
    }
  });

  it('uses locale-sensitive POSIX character classes in numbering styles', async () => {
    const cLocale = await execute({
      script: "LC_ALL=C nl -bp'[[:alpha:]]'",
      stdinText: `\
é
1
`,
    });
    const utf8Locale = await execute({
      script: "LC_ALL=C.utf8 nl -bp'[[:alpha:]]'",
      stdinText: `\
é
1
`,
    });

    expect(cLocale.stdout.text).toBe(expandVisibleSpaces({
      text: `\
       é
       1
`,
    }));
    expect(cLocale.stderr.text).toBe('');
    expect(cLocale.result.exitCode).toBe(0);
    expect(utf8Locale.stdout.text).toBe(expandVisibleSpaces({
      text: `\
     1\té
       1
`,
    }));
    expect(utf8Locale.stderr.text).toBe('');
    expect(utf8Locale.result.exitCode).toBe(0);
  });

  it('keeps blank-line grouping state across logical page delimiters and unnumbered sections', async () => {
    const { result, stdout, stderr } = await execute({
      script: 'nl -ba -l2 -w1 -s"|"',
      stdinText: ['', '\\:', 'text', '\\:\\:', '', ''].join('\n'),
    });

    expect(stdout.text).toBe(['  ', '', '  text', '', '1|', ''].join('\n'));
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
  });


});
