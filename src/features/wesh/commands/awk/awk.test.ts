import { beforeEach, describe, expect, it } from 'vitest';
import { Wesh } from '@/features/wesh/index';
import { MockFileSystemDirectoryHandle } from '@/features/wesh/mocks/InMemoryFileSystem';
import {
  createTestReadHandleFromText,
  createTestWriteCaptureHandle,
} from '@/features/wesh/utils/test-stream';

describe('wesh awk', () => {
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

  async function readFile({
    path,
  }: {
    path: string,
  }): Promise<string> {
    const segments = path.split('/').filter(Boolean);
    const fileName = segments.pop();
    if (fileName === undefined) throw new Error('path must include a file name');

    let dir = rootHandle;
    for (const segment of segments) {
      dir = await dir.getDirectoryHandle(segment);
    }

    const handle = await dir.getFileHandle(fileName);
    return await (await handle.getFile()).text();
  }

  async function readFileBytes({ path }: { path: string }): Promise<Uint8Array> {
    const segments = path.split('/').filter(Boolean);
    const fileName = segments.pop();
    if (fileName === undefined) throw new Error('path must include a file name');

    let dir = rootHandle;
    for (const segment of segments) {
      dir = await dir.getDirectoryHandle(segment);
    }

    const handle = await dir.getFileHandle(fileName);
    return new Uint8Array(await (await handle.getFile()).arrayBuffer());
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

  it('preserves arbitrary input bytes through records, fields, substitutions, and output', async () => {
    await writeFile({
      path: 'invalid',
      data: Uint8Array.from([0x61, 0xff, 0x62, 0x0a]),
    });
    await writeFile({
      path: 'invalid-only',
      data: Uint8Array.from([0xff, 0xfe, 0x0a]),
    });
    await writeFile({
      path: 'crlf',
      data: Uint8Array.from([0x61, 0x0d, 0x0a, 0x62, 0x0a]),
    });
    await writeFile({
      path: 'colon',
      data: Uint8Array.from([0x61, 0xff, 0x3a, 0x62, 0x0a]),
    });
    await writeFile({
      path: 'two-records',
      data: Uint8Array.from([0x61, 0xff, 0x0a, 0x62, 0xfe, 0x0a]),
    });
    await writeFile({
      path: 'separated',
      data: Uint8Array.from([0x61, 0xff, 0x3a, 0x62, 0xfe, 0x3a, 0x3a, 0x63]),
    });

    const printed = await execute({ script: String.raw`awk '{ print }' invalid` });
    const substituted = await execute({
      script: String.raw`awk '{ sub(/a/,"A"); print }' invalid`,
    });
    const dotCarriageReturn = await execute({
      script: String.raw`awk '{ gsub(/./,"X"); print }' crlf`,
    });
    const field = await execute({
      script: String.raw`awk 'BEGIN { FS=":" } { print $1 }' colon`,
    });
    const formatted = await execute({
      script: String.raw`awk '{ printf "%s", $0 }' invalid`,
    });
    const redirected = await execute({
      script: String.raw`awk '{ print > "out" }' invalid`,
    });
    const substring = await execute({
      script: String.raw`awk '{ print substr($0,2,1) }' invalid`,
    });
    const dotInvalid = await execute({
      script: String.raw`awk '{ gsub(/./,"X"); print }' invalid-only`,
    });
    const getlineFile = await execute({
      script: String.raw`awk 'BEGIN { getline value < "invalid"; print value }'`,
    });
    const getlinePipe = await execute({
      script: String.raw`awk 'BEGIN { "cat invalid" | getline value; print value; close("cat invalid") }'`,
    });
    const printPipe = await execute({
      script: String.raw`awk '{ print | "cat" } END { close("cat") }' two-records`,
    });
    const singleByteSeparator = await execute({
      script: String.raw`awk 'BEGIN { RS=":" } { print "<" $0 ">" }' separated`,
    });
    const multiByteSeparator = await execute({
      script: String.raw`awk 'BEGIN { RS="::" } { print "<" $0 ">" }' separated`,
    });
    const regexSeparator = await execute({
      script: String.raw`awk 'BEGIN { RS="[:,]+" } { print "<" $0 ">" }' separated`,
    });
    const dataDerivedSeparator = await execute({
      script: String.raw`awk '{ ORS=substr($0,2,1); print "x" }' two-records`,
    });
    const appended = await execute({
      script: String.raw`awk '{ print >> "append" }' two-records`,
    });

    expect(printed.stdout.buffer).toEqual(Uint8Array.from([0x61, 0xff, 0x62, 0x0a]));
    expect(substituted.stdout.buffer).toEqual(Uint8Array.from([0x41, 0xff, 0x62, 0x0a]));
    expect(dotCarriageReturn.stdout.buffer).toEqual(
      Uint8Array.from([0x58, 0x58, 0x0a, 0x58, 0x0a]),
    );
    expect(field.stdout.buffer).toEqual(Uint8Array.from([0x61, 0xff, 0x0a]));
    expect(formatted.stdout.buffer).toEqual(Uint8Array.from([0x61, 0xff, 0x62]));
    expect(redirected.stdout.buffer).toEqual(new Uint8Array());
    expect(await readFileBytes({ path: 'out' })).toEqual(
      Uint8Array.from([0x61, 0xff, 0x62, 0x0a]),
    );
    expect(substring.stdout.buffer).toEqual(Uint8Array.from([0xff, 0x0a]));
    expect(dotInvalid.stdout.buffer).toEqual(Uint8Array.from([0x58, 0x58, 0x0a]));
    expect(getlineFile.stdout.buffer).toEqual(Uint8Array.from([0x61, 0xff, 0x62, 0x0a]));
    expect(getlinePipe.stdout.buffer).toEqual(Uint8Array.from([0x61, 0xff, 0x62, 0x0a]));
    expect(printPipe.stdout.buffer).toEqual(
      Uint8Array.from([0x61, 0xff, 0x0a, 0x62, 0xfe, 0x0a]),
    );
    expect(singleByteSeparator.stdout.buffer).toEqual(
      Uint8Array.from([
        0x3c, 0x61, 0xff, 0x3e, 0x0a,
        0x3c, 0x62, 0xfe, 0x3e, 0x0a,
        0x3c, 0x3e, 0x0a,
        0x3c, 0x63, 0x3e, 0x0a,
      ]),
    );
    expect(multiByteSeparator.stdout.buffer).toEqual(
      Uint8Array.from([
        0x3c, 0x61, 0xff, 0x3a, 0x62, 0xfe, 0x3e, 0x0a,
        0x3c, 0x63, 0x3e, 0x0a,
      ]),
    );
    expect(regexSeparator.stdout.buffer).toEqual(
      Uint8Array.from([
        0x3c, 0x61, 0xff, 0x3e, 0x0a,
        0x3c, 0x62, 0xfe, 0x3e, 0x0a,
        0x3c, 0x63, 0x3e, 0x0a,
      ]),
    );
    expect(dataDerivedSeparator.stdout.buffer).toEqual(
      Uint8Array.from([0x78, 0xff, 0x78, 0xfe]),
    );
    expect(appended.stdout.buffer).toEqual(new Uint8Array());
    expect(await readFileBytes({ path: 'append' })).toEqual(
      Uint8Array.from([0x61, 0xff, 0x0a, 0x62, 0xfe, 0x0a]),
    );

    for (const execution of [
      printed,
      substituted,
      dotCarriageReturn,
      field,
      formatted,
      redirected,
      substring,
      dotInvalid,
      getlineFile,
      getlinePipe,
      printPipe,
      singleByteSeparator,
      multiByteSeparator,
      regexSeparator,
      dataDerivedSeparator,
      appended,
    ]) {
      expect(execution.stderr.text).toBe('');
      expect(execution.result.exitCode).toBe(0);
    }
  });

  it('prints help and rejects invalid options', async () => {
    const help = await execute({ script: 'awk --help' });
    const invalid = await execute({ script: 'awk --bogus' });

    expect(help.stdout.text).toContain('Pattern scanning and processing language');
    expect(help.stdout.text).toContain('usage: awk [-F FS] [-v VAR=VALUE] [-f PROGRAM_FILE] [--] PROGRAM [FILE]...');
    expect(help.stdout.text).toContain('--help');
    expect(help.stderr.text).toBe('');
    expect(help.result.exitCode).toBe(0);

    expect(invalid.stdout.text).toBe('');
    expect(invalid.stderr.text).toContain("awk: unrecognized option '--bogus'");
    expect(invalid.stderr.text).toContain('usage: awk [-F FS] [-v VAR=VALUE] [-f PROGRAM_FILE] [--] PROGRAM [FILE]...');
    expect(invalid.result.exitCode).toBe(2);
  });

  it('supports inline programs with BEGIN, END, fields, and variables', async () => {
    await writeFile({
      path: 'people.txt',
      data: `\
alice:10
bob:20
`,
    });

    const { result, stdout, stderr } = await execute({
      script: `\
awk -F: -v prefix=ID 'BEGIN { print prefix } { print $1, $2 } END { print NR }' people.txt`,
    });

    expect(stdout.text).toBe(`\
ID
alice 10
bob 20
2
`);
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
  });

  it('supports attached values for -v and -f', async () => {
    await writeFile({
      path: 'program.awk',
      data: 'BEGIN { print prefix }\n',
    });

    const attachedVariable = await execute({
      script: 'awk -vprefix=ID \'BEGIN { print prefix }\'',
    });
    const attachedProgramFile = await execute({
      script: 'awk -fprogram.awk',
    });

    expect(attachedVariable.stdout.text).toBe('ID\n');
    expect(attachedVariable.stderr.text).toBe('');
    expect(attachedVariable.result.exitCode).toBe(0);

    expect(attachedProgramFile.stdout.text).toBe('\n');
    expect(attachedProgramFile.stderr.text).toBe('');
    expect(attachedProgramFile.result.exitCode).toBe(0);
  });

  it('supports regex patterns and -f program files', async () => {
    await writeFile({
      path: 'program.awk',
      data: `\
/foo/ { print $1 }
END { print NR }`,
    });
    await writeFile({
      path: 'input.txt',
      data: `\
foo one
bar two
foo three
`,
    });

    const { result, stdout, stderr } = await execute({
      script: 'awk -f program.awk input.txt',
    });

    expect(stdout.text).toBe(`\
foo
foo
3
`);
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
  });

  it('preserves malformed UTF-8 literals in program files', async () => {
    await writeFile({
      path: 'invalid-program.awk',
      data: Uint8Array.of(
        0x7b, 0x67, 0x73, 0x75, 0x62, 0x28, 0x2f, 0xff, 0x2f, 0x2c,
        0x22, 0x58, 0x22, 0x29, 0x3b, 0x70, 0x72, 0x69, 0x6e, 0x74, 0x7d,
        0x0a,
      ),
    });
    await writeFile({ path: 'invalid-input', data: Uint8Array.of(0xff, 0x0a) });

    for (const locale of ['C', 'C.utf8'] as const) {
      const execution = await execute({
        script: `LC_ALL=${locale} awk -f invalid-program.awk invalid-input`,
      });
      expect(execution.result.exitCode).toBe(0);
      expect([...execution.stdout.buffer]).toEqual([0x58, 0x0a]);
      expect(execution.stderr.text).toBe('');
    }
  });

  it('does not hide a UTF-8 byte-order mark in program files', async () => {
    await writeFile({
      path: 'bom-program.awk',
      data: '\uFEFFBEGIN { print 1 }\n',
    });

    const { result, stdout, stderr } = await execute({
      script: 'awk -f bom-program.awk',
    });

    expect(stdout.text).toBe('');
    expect(stderr.text).toContain("unexpected character '\uFEFF'");
    expect(result.exitCode).toBe(2);
  });

  it('reads a program from stdin with -f -', async () => {
    await writeFile({
      path: 'input.txt',
      data: `\
alpha
beta
`,
    });

    const execution = await execute({
      script: 'awk -f - input.txt',
      stdinText: '{ print toupper($0) }\n',
    });

    expect(execution.stdout.text).toBe(`\
ALPHA
BETA
`);
    expect(execution.stderr.text).toBe('');
    expect(execution.result.exitCode).toBe(0);
  });

  it('reads an stdin program larger than one internal read chunk', async () => {
    await writeFile({ path: 'input.txt', data: `\
alpha
beta
` });
    const execution = await execute({
      script: 'awk -f - input.txt',
      stdinText: `${'# padding\n'.repeat(8192)}{ print toupper($0) }\n`,
    });

    expect(execution.stdout.text).toBe(`\
ALPHA
BETA
`);
    expect(execution.stderr.text).toBe('');
    expect(execution.result.exitCode).toBe(0);
  });

  it('decodes common escapes in command-line assignments', async () => {
    const variable = await execute({
      script: String.raw`awk -v 'x=a\tb' 'BEGIN { print length(x); print x }'`,
    });
    const operand = await execute({
      script: String.raw`awk 'END { print length(x); print x }' 'x=a\nb'`,
    });

    expect(variable.stdout.text).toBe('3\na\tb\n');
    expect(variable.stderr.text).toBe('');
    expect(variable.result.exitCode).toBe(0);

    expect(operand.stdout.text).toBe(`\
3
a
b
`);
    expect(operand.stderr.text).toBe('');
    expect(operand.result.exitCode).toBe(0);
  });

  it('decodes Linux-compatible command-line assignment escapes', async () => {
    const controlCharacters = await execute({
      script: String.raw`awk -v 'x=a\ab\bc\fd\ve' 'BEGIN { printf "%s", x }'`,
    });
    const numericEscapes = await execute({
      script: String.raw`awk -v 'x=\101\x42' 'BEGIN { print x }'`,
    });
    const wrappedOctalEscape = await execute({
      script: String.raw`awk -v 'x=\400' 'BEGIN { printf "%s", x }'`,
    });
    const unknownEscape = await execute({
      script: String.raw`awk -v 'x=a\qb' 'BEGIN { print x }'`,
    });
    const fieldSeparator = await execute({
      script: String.raw`awk -F '\t' '{ print NF ":" $1 ":" $2 }'`,
      stdinText: 'a\tb\n',
    });

    expect(controlCharacters.stdout.text).toBe('a\u0007b\bc\fd\ve');
    expect(controlCharacters.stderr.text).toBe('');
    expect(controlCharacters.result.exitCode).toBe(0);

    expect(numericEscapes.stdout.text).toBe('AB\n');
    expect(numericEscapes.stderr.text).toBe('');
    expect(numericEscapes.result.exitCode).toBe(0);

    expect(wrappedOctalEscape.stdout.text).toBe('\0');
    expect(wrappedOctalEscape.stderr.text).toBe('');
    expect(wrappedOctalEscape.result.exitCode).toBe(0);

    expect(unknownEscape.stdout.text).toBe('a\\qb\n');
    expect(unknownEscape.stderr.text).toBe('');
    expect(unknownEscape.result.exitCode).toBe(0);

    expect(fieldSeparator.stdout.text).toBe('2:a:b\n');
    expect(fieldSeparator.stderr.text).toBe('');
    expect(fieldSeparator.result.exitCode).toBe(0);
  });

  it('reads stdin when no files are provided', async () => {
    const { result, stdout, stderr } = await execute({
      script: `\
awk '{ print $1 }'`,
      stdinText: `\
alpha beta
gamma delta
`,
    });

    expect(stdout.text).toBe(`\
alpha
gamma
`);
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
  });

  it('uses AWK field and numeric whitespace instead of JavaScript whitespace', async () => {
    const separators = [
      { value: ' ', separates: true },
      { value: '\t', separates: true },
      { value: '\v', separates: false },
      { value: '\f', separates: false },
      { value: '\r', separates: false },
      { value: '\u00A0', separates: false },
      { value: '\u2003', separates: false },
      { value: '\u0085', separates: false },
      { value: '\u2028', separates: false },
      { value: '\uFEFF', separates: false },
    ];

    for (const separator of separators) {
      const fields = await execute({
        script: `awk '{printf "%d|%s|%s\\n", NF, $1, $2}'`,
        stdinText: `a${separator.value}b\n`,
      });
      expect(fields.stdout.text).toBe(
        separator.separates
          ? '2|a|b\n'
          : `1|a${separator.value}b|\n`,
      );
      expect(fields.stderr.text).toBe('');
      expect(fields.result.exitCode).toBe(0);

      const numeric = await execute({
        script: `awk -F, '{printf "%d|%g\\n", ($1 == 1), ($1 + 0)}'`,
        stdinText: `${separator.value}1,x\n`,
      });
      expect(numeric.stdout.text).toBe(separator.separates ? '1|1\n' : '0|0\n');
      expect(numeric.stderr.text).toBe('');
      expect(numeric.result.exitCode).toBe(0);
    }

    const paragraph = await execute({
      script: `awk 'BEGIN { RS = "" } { printf "%d|%s|%s\\n", NF, $1, $2 }'`,
      stdinText: `\
a
b

`,
    });
    expect(paragraph.stdout.text).toBe('2|a|b\n');
    expect(paragraph.stderr.text).toBe('');
    expect(paragraph.result.exitCode).toBe(0);
  });

  it('reports missing program and file errors', async () => {
    const missingProgram = await execute({ script: 'awk' });
    const missingFile = await execute({ script: `awk '{ print $1 }' missing.txt` });

    expect(missingProgram.stdout.text).toBe('');
    expect(missingProgram.stderr.text).toContain('awk: missing program source');
    expect(missingProgram.stderr.text).toContain('usage: awk [-F FS] [-v VAR=VALUE] [-f PROGRAM_FILE] [--] PROGRAM [FILE]...');
    expect(missingProgram.result.exitCode).toBe(1);

    expect(missingFile.stdout.text).toBe('');
    expect(missingFile.stderr.text).toContain('awk: missing.txt:');
    expect(missingFile.result.exitCode).toBe(2);
  });

  it('supports if/else with logical operators and string concatenation', async () => {
    await writeFile({
      path: 'scores.txt',
      data: `\
alice 10
bob 20
carol 30
`,
    });

    const { result, stdout, stderr } = await execute({
      script: `\
awk '{ if ($2 >= 20 && !($1 == "carol")) print "ok:" $1; else print "skip:" $1 }' scores.txt`,
    });

    expect(stdout.text).toBe(`\
skip:alice
ok:bob
skip:carol
`);
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
  });

  it('supports next to skip remaining actions for a record', async () => {
    await writeFile({
      path: 'events.txt',
      data: `\
keep one
skip two
keep three
`,
    });

    const { result, stdout, stderr } = await execute({
      script: `\
awk '/skip/ { next } { print $1 }' events.txt`,
    });

    expect(stdout.text).toBe(`\
keep
keep
`);
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
  });

  it('supports built-in functions length, index, substr, tolower, and toupper', async () => {
    await writeFile({
      path: 'words.txt',
      data: `\
alpha
beta
`,
    });

    const { result, stdout, stderr } = await execute({
      script: `\
awk '{ print length($1), index($1, "a"), substr($1, 2, 2), tolower($1), toupper($1) }' words.txt`,
    });

    expect(stdout.text).toBe(`\
5 1 lp alpha ALPHA
4 4 et beta BETA
`);
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
  });

  it('limits tolower and toupper to ASCII letters', async () => {
    const { result, stdout, stderr } = await execute({
      script: `awk 'BEGIN { print tolower("ÉAΒBİ"); print toupper("éaβbß") }'`,
    });

    expect(stdout.text).toBe(`\
ÉaΒbİ
éAβBß
`);
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
  });

  it('supports associative-array style indexed assignment and lookup', async () => {
    await writeFile({
      path: 'items.txt',
      data: `\
apple
banana
apple
`,
    });

    const { result, stdout, stderr } = await execute({
      script: `\
awk '{ counts[$1] = counts[$1] + 1 } END { print counts["apple"], counts["banana"] }' items.txt`,
    });

    expect(stdout.text).toBe('2 1\n');
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
  });

  it('supports postfix increment on indexed variables', async () => {
    await writeFile({
      path: 'items-plus.txt',
      data: `\
apple
banana
apple
`,
    });

    const { result, stdout, stderr } = await execute({
      script: `\
awk '{ counts[$1]++ } END { print counts["apple"], counts["banana"] }' items-plus.txt`,
    });

    expect(stdout.text).toBe('2 1\n');
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
  });

  it('supports match and still reports unsupported builtin functions explicitly', async () => {
    const supported = await execute({
      script: `\
awk 'BEGIN { print match("abc", "b"), RSTART, RLENGTH; print match("abc", "z"), RSTART, RLENGTH }'`,
    });
    const { result, stdout, stderr } = await execute({
      script: `\
awk 'BEGIN { print gensub("abc", "b") }'`,
    });

    expect(supported.stdout.text).toBe(`\
2 2 1
0 0 -1
`);
    expect(supported.stderr.text).toBe('');
    expect(supported.result.exitCode).toBe(0);

    expect(stdout.text).toBe('');
    expect(stderr.text).toContain("awk: unsupported builtin function 'gensub'");
    expect(result.exitCode).toBe(2);
  });

  it('supports sub and gsub against records, variables, and fields', async () => {
    await writeFile({
      path: 'replace.txt',
      data: `\
alpha beta alpha
`,
    });

    const { result, stdout, stderr } = await execute({
      script: `\
awk '{
  text = $0
  print sub("alpha", "A", text), text
  print gsub("alpha", "A", $0), $0
  print sub("beta", "B", $2), $0
}' replace.txt`,
    });

    expect(stdout.text).toBe(`\
1 A beta alpha
2 A beta A
1 A B A
`);
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
  });

  it('matches GNU awk global substitutions around empty matches', async () => {
    const { result, stdout, stderr } = await execute({
      script: `\
awk 'BEGIN {
  value = "ab"
  print gsub(/x*/, "Y", value), value
  value = "xx"
  print gsub(/x*/, "Y", value), value
  value = "aab"
  print gsub(/a*/, "Y", value), value
}'`,
    });

    expect(stdout.text).toBe(`\
3 YaYbY
1 Y
2 YbY
`);
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
  });

  it('rejects empty alternatives in awk regular expressions', async () => {
    const scripts = [
      ...['(a|)', '(|a)', 'a||b', '()'].map((pattern) => `awk '/${pattern}/ { print }'`),
      `awk 'BEGIN { regex="(a|)" } $0 ~ regex { print }'`,
      `awk -F '(a|)' '{ print NF }'`,
      `awk 'BEGIN { RS="(a|)" } { print }'`,
      `awk 'BEGIN { regex="(a|)"; print split("a", values, regex) }'`,
    ];
    for (const script of scripts) {
      const { result, stdout, stderr } = await execute({
        script,
        stdinText: 'a\n',
      });

      expect(stdout.text).toBe('');
      expect(stderr.text).toContain('regular expression compile failed');
      expect(result.exitCode).toBe(2);
    }
  });

  it('accepts an extended regular expression literal as the split separator', async () => {
    const { result, stdout, stderr } = await execute({
      script: `\
awk 'BEGIN { count = split("a,b::c", parts, /[,:]+/); print count, parts[1], parts[2], parts[3] }'`,
    });

    expect(stdout.text).toBe('3 a b c\n');
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
  });

  it('supports split into arrays and the in operator', async () => {
    const { result, stdout, stderr } = await execute({
      script: `\
awk 'BEGIN { n = split("red blue", parts, " "); print n, parts[1], ("2" in parts), ("3" in parts) }'`,
    });

    expect(stdout.text).toBe('2 red 1 0\n');
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
  });

  it('reports invalid split and in usage explicitly', async () => {
    const badSplit = await execute({
      script: `\
awk 'BEGIN { print split("a b", value[1], " ") }'`,
    });
    const badIn = await execute({
      script: `\
awk 'BEGIN { arr["1"] = 1; print ("1" in arr["1"]) }'`,
    });

    expect(badSplit.stdout.text).toBe('');
    expect(badSplit.stderr.text).toContain('awk: split requires an array variable as its second argument');
    expect(badSplit.result.exitCode).toBe(2);

    expect(badIn.stdout.text).toBe('');
    expect(badIn.stderr.text).toContain("awk: right operand of 'in' must be an array variable");
    expect(badIn.result.exitCode).toBe(2);
  });

  it('supports while loops', async () => {
    const { result, stdout, stderr } = await execute({
      script: `\
awk 'BEGIN { i = 0; while (i < 3) { print i; i++ } }'`,
    });

    expect(stdout.text).toBe(`\
0
1
2
`);
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
  });

  it('supports delete for array entries and whole arrays', async () => {
    const { result, stdout, stderr } = await execute({
      script: `\
awk 'BEGIN { arr["a"] = 1; arr["b"] = 2; delete arr["a"]; print ("a" in arr), ("b" in arr); delete arr; print ("b" in arr) }'`,
    });

    expect(stdout.text).toBe(`\
0 1
0
`);
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
  });

  it('can reuse and measure an array after deleting the whole array', async () => {
    const { result, stdout, stderr } = await execute({
      script: `\
awk 'BEGIN { arr[1] = 1; delete arr; arr[2] = 2; print length(arr), (1 in arr), arr[2] }'`,
    });

    expect(stdout.text).toBe('1 0 2\n');
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
  });

  it('deletes an aliased function array in place and reports scalar misuse', async () => {
    const aliased = await execute({
      script: `\
awk 'function reset(values) { delete values; values[2] = 2; return length(values) } BEGIN { values[1] = 1; print reset(values), (1 in values), values[2] }'`,
    });
    const scalarMisuse = await execute({
      script: `awk 'BEGIN { values[1] = 1; print values }'`,
    });

    expect(aliased.stdout.text).toBe('1 0 2\n');
    expect(aliased.stderr.text).toBe('');
    expect(aliased.result.exitCode).toBe(0);
    expect(scalarMisuse.stdout.text).toBe('');
    expect(scalarMisuse.stderr.text).toContain('illegal reference to array values');
    expect(scalarMisuse.result.exitCode).not.toBe(0);

    const scalarAsArray = await execute({
      script: `awk 'BEGIN { value = 1; print value[1] }'`,
    });
    expect(scalarAsArray.stdout.text).toBe('');
    expect(scalarAsArray.stderr.text).toContain("'value' is not an array");
    expect(scalarAsArray.result.exitCode).not.toBe(0);
  });

  it('supports C-style for loops', async () => {
    const { result, stdout, stderr } = await execute({
      script: `\
awk 'BEGIN { for (i = 0; i < 3; i++) printf "%d,", i }'`,
    });

    expect(stdout.text).toBe('0,1,2,');
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
  });

  it('supports printf without automatically appending a newline', async () => {
    const { result, stdout, stderr } = await execute({
      script: `\
awk 'BEGIN { printf "%s:%d:%f:%%", "id", 7, 1.5 }'`,
    });

    expect(stdout.text).toBe('id:7:1.500000:%');
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
  });

  it('supports for-in loops over arrays', async () => {
    const { result, stdout, stderr } = await execute({
      script: `\
awk 'BEGIN { arr["b"] = 2; arr["a"] = 1; for (key in arr) print key, arr[key] }'`,
    });

    expect(stdout.text).toBe(`\
b 2
a 1
`);
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
  });

  it('reports non-array for-in and in operands explicitly', async () => {
    const badForIn = await execute({
      script: `\
awk 'BEGIN { value = 1; for (key in value) print key }'`,
    });
    const badIn = await execute({
      script: `\
awk 'BEGIN { value = 1; print ("x" in value) }'`,
    });

    expect(badForIn.stdout.text).toBe('');
    expect(badForIn.stderr.text).toContain("awk: 'value' is not an array");
    expect(badForIn.result.exitCode).toBe(2);

    expect(badIn.stdout.text).toBe('');
    expect(badIn.stderr.text).toContain("awk: 'value' is not an array");
    expect(badIn.result.exitCode).toBe(2);
  });

  it('supports break and continue inside loops', async () => {
    const { result, stdout, stderr } = await execute({
      script: `\
awk 'BEGIN { for (i = 0; i < 6; i++) { if (i == 2) continue; if (i == 4) break; print i } }'`,
    });

    expect(stdout.text).toBe(`\
0
1
3
`);
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
  });

  it('reports break and continue outside loops explicitly', async () => {
    const badBreak = await execute({
      script: `\
awk 'BEGIN { break }'`,
    });
    const badContinue = await execute({
      script: `\
awk 'BEGIN { continue }'`,
    });

    expect(badBreak.stdout.text).toBe('');
    expect(badBreak.stderr.text).toContain("awk: 'break' is not allowed outside loops");
    expect(badBreak.result.exitCode).toBe(2);

    expect(badContinue.stdout.text).toBe('');
    expect(badContinue.stderr.text).toContain("awk: 'continue' is not allowed outside loops");
    expect(badContinue.result.exitCode).toBe(2);
  });

  it('supports dynamic fields and field/NF assignment', async () => {
    await writeFile({
      path: 'records.txt',
      data: `\
alpha 10 red
beta 20 blue
`,
    });

    const { result, stdout, stderr } = await execute({
      script: `awk '{ print $NF, $(NF - 1); $1 = toupper($1); NF = 2; print $0 }' records.txt`,
    });

    expect(stdout.text).toBe(`\
red 10
ALPHA 10
blue 20
BETA 20
`);
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
  });

  it('allows record and field assignment before the first input record', async () => {
    const record = await execute({
      script: `awk 'BEGIN { $0 = "old value"; print NF, $1, $0 }'`,
    });
    const field = await execute({
      script: `awk 'BEGIN { $2 = "tail"; print NF, "[" $1 "]", $2, "[" $0 "]" }'`,
    });
    const builtins = await execute({
      script: `awk 'BEGIN { NR = 7; FNR = 3; FILENAME = "manual"; NF = 2; print NR, FNR, FILENAME, NF, "[" $0 "]" }'`,
    });

    expect(record.stdout.text).toBe('2 old old value\n');
    expect(record.stderr.text).toBe('');
    expect(record.result.exitCode).toBe(0);
    expect(field.stdout.text).toBe('2 [] tail [ tail]\n');
    expect(field.stderr.text).toBe('');
    expect(field.result.exitCode).toBe(0);
    expect(builtins.stdout.text).toBe('7 3 manual 2 [ ]\n');
    expect(builtins.stderr.text).toBe('');
    expect(builtins.result.exitCode).toBe(0);
  });

  it('supports common arithmetic, compound assignment, short circuiting, and conditionals', async () => {
    const { result, stdout, stderr } = await execute({
      script: `awk 'BEGIN { x = 7; x /= 2; y = 0; print x, 7 % 2, 2 ^ 3, -7, (0 && y++), (1 || y++), y, (x > 3 ? "yes" : "no") }'`,
    });

    expect(stdout.text).toBe('3.5 1 8 -7 0 1 0 yes\n');
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
  });

  it('supports int, sqrt, sprintf, and common printf width and precision formats', async () => {
    const { result, stdout, stderr } = await execute({
      script: `awk 'BEGIN { print int(3.9), int(-3.9), sqrt(9), sprintf("%s:%04d", "id", 7); printf "[%5s][%.2f][%.3s][%g]\\n", "x", 1.234, "abcdef", 1.25 }'`,
    });

    expect(stdout.text).toBe(`\
3 -3 3 id:0007
[    x][1.23][abc][1.25]
`);
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
  });

  it('supports integer precision and exponential printf formats', async () => {
    const { result, stdout, stderr } = await execute({
      script: `awk 'BEGIN { printf "[%5.3d][%08.3d][%.2e][%.2E][%.1f][%.1e]\n", 7, 7, 12.5, 12.5, 1.25, 12.5 }'`,
    });

    expect(stdout.text).toBe('[  007][     007][1.25e+01][1.25E+01][1.2][1.2e+01]\n');
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
  });

  it('supports the standard awk mathematical builtins', async () => {
    const { result, stdout, stderr } = await execute({
      script: `awk 'BEGIN { printf "%.6f %.6f %.6f %.6f %.6f\\n", exp(1), log(exp(1)), sin(0), cos(0), atan2(1, 1) }'`,
    });

    expect(stdout.text).toBe('2.718282 1.000000 0.000000 1.000000 0.785398\n');
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
  });

  it('supports mawk-compatible POSIX character classes', async () => {
    const { result, stdout, stderr } = await execute({
      script: `awk 'BEGIN { print ("a7" ~ /^[[:alpha:][:digit:]]+$/), ("a b" ~ /[[:space:]]/), ("café" ~ /^[[:alpha:]]+$/) }'`,
    });

    expect(stdout.text).toBe('1 1 0\n');
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
  });

  it('retains the final record and fields while executing END rules', async () => {
    const execution = await execute({
      script: `printf 'alpha,beta,gamma' | awk -v RS=, 'END { print NR, $0, $1 }'`,
    });

    expect(execution.stdout.text).toBe('3 gamma gamma\n');
    expect(execution.stderr.text).toBe('');
    expect(execution.result.exitCode).toBe(0);
  });

  it('supports record separators, numeric conversion formats, and standard arrays', async () => {
    await writeFile({ path: 'one.txt', data: 'alpha\n' });

    const recordSeparator = await execute({
      script: `printf 'alpha,beta,gamma' | awk -v RS=, '{ print NR, $0 }'`,
    });
    const formats = await execute({
      script: `awk 'BEGIN { OFMT = "%.2f"; CONVFMT = "%.2f"; print 1.234, (1.234 "") }'`,
    });
    const arrays = await execute({
      script: `awk 'BEGIN { print ARGC, ARGV[0], ARGV[1], ("PATH" in ENVIRON) }' one.txt`,
    });

    expect(recordSeparator.stdout.text).toBe(`\
1 alpha
2 beta
3 gamma
`);
    expect(recordSeparator.stderr.text).toBe('');
    expect(recordSeparator.result.exitCode).toBe(0);
    expect(formats.stdout.text).toBe('1.23 1.23\n');
    expect(formats.stderr.text).toBe('');
    expect(formats.result.exitCode).toBe(0);
    expect(arrays.stdout.text).toBe('2 awk one.txt 1\n');
    expect(arrays.stderr.text).toBe('');
    expect(arrays.result.exitCode).toBe(0);
  });

  it('preserves UTF-8 byte-order marks with non-default record separators', async () => {
    const character = await execute({
      script: `printf '\uFEFFalpha:beta:' | awk -v RS=: '{ print "<" $0 ">" }'`,
    });
    const paragraph = await execute({
      script: `printf '\uFEFFalpha\n\nbeta\n' | awk 'BEGIN { RS="" } { print "<" $0 ">" }'`,
    });

    expect(character.stdout.text).toBe(`\
<\uFEFFalpha>
<beta>
`);
    expect(character.stderr.text).toBe('');
    expect(character.result.exitCode).toBe(0);
    expect(paragraph.stdout.text).toBe(`\
<\uFEFFalpha>
<beta>
`);
    expect(paragraph.stderr.text).toBe('');
    expect(paragraph.result.exitCode).toBe(0);
  });

  it('supports nextfile and the standard random-number builtins', async () => {
    await writeFile({ path: 'one.txt', data: `\
a
b
` });
    await writeFile({ path: 'two.txt', data: `\
c
d
` });

    const nextFile = await execute({
      script: `awk '{ print FILENAME, $1; nextfile }' one.txt two.txt`,
    });
    const random = await execute({
      script: `awk 'BEGIN { previous = srand(1); value = rand(); print previous, (value >= 0 && value < 1) }'`,
    });

    expect(nextFile.stdout.text).toBe(`\
one.txt a
two.txt c
`);
    expect(nextFile.stderr.text).toBe('');
    expect(nextFile.result.exitCode).toBe(0);
    expect(random.stdout.text).toBe('1 1\n');
    expect(random.stderr.text).toBe('');
    expect(random.result.exitCode).toBe(0);
  });

  it('supports FILENAME, post-program assignments, and exit while still running END', async () => {
    await writeFile({ path: 'one.txt', data: `\
a 1
b 2
` });

    const { result, stdout, stderr } = await execute({
      script: `awk '{ print prefix FILENAME, FNR, $1; if (FNR == 2) exit 3 } END { print "end" }' prefix=X one.txt`,
    });

    expect(stdout.text).toBe(`\
Xone.txt 1 a
Xone.txt 2 b
end
`);
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(3);
  });

  it('treats input open failures as fatal and does not run END', async () => {
    const { result, stdout, stderr } = await execute({
      script: `awk 'END { print NR }' missing.txt`,
    });

    expect(stdout.text).toBe('');
    expect(stderr.text).toContain('missing.txt');
    expect(result.exitCode).toBe(2);
  });

  it('honors ARGV deletion and replacement performed during BEGIN', async () => {
    await writeFile({ path: 'one.txt', data: 'one\n' });
    await writeFile({ path: 'two.txt', data: 'two\n' });

    const deleted = await execute({
      script: `awk 'BEGIN { delete ARGV[1] } { print $0 }' one.txt`,
    });
    const replaced = await execute({
      script: `awk 'BEGIN { ARGV[1] = "two.txt" } { print FILENAME, $0 }' one.txt`,
    });

    expect(deleted.stdout.text).toBe('');
    expect(deleted.stderr.text).toBe('');
    expect(deleted.result.exitCode).toBe(0);
    expect(replaced.stdout.text).toBe('two.txt two\n');
    expect(replaced.stderr.text).toBe('');
    expect(replaced.result.exitCode).toBe(0);
  });

  it('supports inclusive range patterns', async () => {
    const range = await execute({
      script: `printf 'skip\nstart\ninside\nend\nskip\nstart\nend\n' | awk '/start/,/end/ { print $0 }'`,
    });

    expect(range.stdout.text).toBe(`start
inside
end
start
end
`);
    expect(range.stderr.text).toBe('');
    expect(range.result.exitCode).toBe(0);
  });

  it('supports do-while loops and their loop controls', async () => {
    const loop = await execute({
      script: `awk 'BEGIN { value = 0; do { value++; if (value == 2) continue; print value } while (value < 3) }'`,
    });

    expect(loop.stdout.text).toBe(`1
3
`);
    expect(loop.stderr.text).toBe('');
    expect(loop.result.exitCode).toBe(0);
  });

  it('supports multidimensional array subscripts through SUBSEP', async () => {
    const arrays = await execute({
      script: `awk 'BEGIN { values[1, 2] = 7; values["x" SUBSEP "y"] = 9; print values[1, 2], ((1, 2) in values), values["x", "y"], SUBSEP == sprintf("%c", 28) }'`,
    });

    expect(arrays.stdout.text).toBe('7 1 9 1\n');
    expect(arrays.stderr.text).toBe('');
    expect(arrays.result.exitCode).toBe(0);
  });

  it('evaluates regex constants against the current record in expressions', async () => {
    const regexExpressions = await execute({
      script: `printf 'alpha\nbeta\n' | awk '{ print (/beta/), (!/beta/); if (/beta/) print "matched", NR }'`,
    });

    expect(regexExpressions.stdout.text).toBe(`0 1
1 0
matched 2
`);
    expect(regexExpressions.stderr.text).toBe('');
    expect(regexExpressions.result.exitCode).toBe(0);
  });

  it('supports assignment expressions in output and conditions', async () => {
    const assignments = await execute({
      script: `awk 'BEGIN { print (value = 3), value; if (condition = 2) print condition; print (nested = other = 4), other }'`,
    });

    expect(assignments.stdout.text).toBe(`3 3
2
4 4
`);
    expect(assignments.stderr.text).toBe('');
    expect(assignments.result.exitCode).toBe(0);
  });

  it('supports common printf sign, alternate-form, alignment, and zero-padding flags', async () => {
    const formatted = await execute({
      script: `awk 'BEGIN { printf "[%-5s][%+d][% d][%#x][%05d]\n", "x", 3, 3, 15, -7 }'`,
    });

    expect(formatted.stdout.text).toBe('[x    ][+3][ 3][0xf][-0007]\n');
    expect(formatted.stderr.text).toBe('');
    expect(formatted.result.exitCode).toBe(0);
  });

  it('supports print and printf redirection, append mode, and close return values', async () => {
    await writeFile({ path: 'append.txt', data: 'before\n' });

    const redirected = await execute({
      script: `awk 'BEGIN { print "alpha" > "out.txt"; printf "%s\n", "beta" > "out.txt"; print close("out.txt"); print "replacement" > "out.txt"; print close("missing.txt"); print "after" >> "append.txt" }'`,
    });

    expect(redirected.stdout.text).toBe(`0
-1
`);
    expect(redirected.stderr.text).toBe('');
    expect(redirected.result.exitCode).toBe(0);
    expect(await readFile({ path: 'out.txt' })).toBe('replacement\n');
    expect(await readFile({ path: 'append.txt' })).toBe(`before
after
`);
  });

  it('keeps parenthesized comparisons on stdout instead of treating them as redirections', async () => {
    const comparison = await execute({
      script: `awk 'BEGIN { print (2 > 1), (1 > 2) }'`,
    });

    expect(comparison.stdout.text).toBe('1 0\n');
    expect(comparison.stderr.text).toBe('');
    expect(comparison.result.exitCode).toBe(0);
  });

  it('evaluates chained comparison operators from left to right', async () => {
    const comparison = await execute({
      script: `awk 'BEGIN { a=1; b=2; c=3; print (a < b == c), (a == b < c), (3 > 2 >= 1) }'`,
    });

    expect(comparison.stdout.text).toBe('0 1 1\n');
    expect(comparison.stderr.text).toBe('');
    expect(comparison.result.exitCode).toBe(0);
  });

  it('preserves the sign of NaN from invalid negative-base exponentiation', async () => {
    const result = await execute({
      script: `awk 'BEGIN { print ((-2) ^ (1 / 3)) }'`,
    });

    expect(result.stdout.text).toBe('-nan\n');
    expect(result.stderr.text).toBe('');
    expect(result.result.exitCode).toBe(0);
  });

  it('accepts leading-dot and exponential numeric literals', async () => {
    const result = await execute({
      script: `awk 'BEGIN { print .5, 1., 1e2, 2.5E-1 }'`,
    });

    expect(result.stdout.text).toBe('0.5 1 100 0.25\n');
    expect(result.stderr.text).toBe('');
    expect(result.result.exitCode).toBe(0);
  });

  it('supports user-defined functions with local parameters, recursion, arrays, and output', async () => {
    const basic = await execute({
      script: `awk 'function twice(value) { return value * 2 } BEGIN { print twice(3) }'`,
    });
    const recursive = await execute({
      script: `awk 'function factorial(value) { if (value <= 1) return 1; return value * factorial(value - 1) } BEGIN { print factorial(5) }'`,
    });
    const localsAndArrays = await execute({
      script: `awk 'function summarize(values, key, total) { for (key in values) total += values[key]; print "inside", total; return total } BEGIN { total = 10; values[1] = 2; values[2] = 3; print summarize(values), total, (key == "") }'`,
    });

    expect(basic.stdout.text).toBe('6\n');
    expect(basic.stderr.text).toBe('');
    expect(basic.result.exitCode).toBe(0);
    expect(recursive.stdout.text).toBe('120\n');
    expect(recursive.stderr.text).toBe('');
    expect(recursive.result.exitCode).toBe(0);
    expect(localsAndArrays.stdout.text).toBe(`inside 5
5 10 1
`);
    expect(localsAndArrays.stderr.text).toBe('');
    expect(localsAndArrays.result.exitCode).toBe(0);
  });

  it('rejects next and nextfile inside user-defined functions before processing input', async () => {
    const next = await execute({
      script: `printf 'keep\nskip\n' | awk 'function skip() { next } { print $1; skip() }'`,
    });
    const nextfile = await execute({
      script: `awk 'function skipfile() { nextfile } BEGIN { print "before" }'`,
    });

    expect(next.stdout.text).toBe('');
    expect(next.stderr.text).toContain('improper use of next');
    expect(next.result.exitCode).toBe(2);
    expect(nextfile.stdout.text).toBe('');
    expect(nextfile.stderr.text).toContain('improper use of nextfile');
    expect(nextfile.result.exitCode).toBe(2);
  });

  it('allows exit from a user-defined function and still executes END rules', async () => {
    const exited = await execute({
      script: `awk 'function stop(code) { exit code } BEGIN { print "before"; stop(7); print "after" } END { print "end" }'`,
    });

    expect(exited.stdout.text).toBe(`before
end
`);
    expect(exited.stderr.text).toBe('');
    expect(exited.result.exitCode).toBe(7);
  });

  it('executes Wesh shell commands through system and returns their exit status', async () => {
    const system = await execute({
      script: `awk 'BEGIN { print system("printf child"); print system("false") }'`,
    });

    expect(system.stdout.text).toBe(`\
child0
1
`);
    expect(system.stderr.text).toBe('');
    expect(system.result.exitCode).toBe(0);
  });

  it('returns shell-compatible status 127 when system cannot resolve a command', async () => {
    const missing = await execute({
      script: `awk 'BEGIN { print system("wesh-command-that-does-not-exist") }'`,
    });

    expect(missing.stdout.text).toBe('127\n');
    expect(missing.stderr.text).toContain('Command not found: wesh-command-that-does-not-exist');
    expect(missing.result.exitCode).toBe(0);
  });

  it('supports command pipelines as getline sources', async () => {
    const pipeline = await execute({
      script: `awk 'BEGIN { "printf alpha" | getline value; print value; close("printf alpha") }'`,
    });

    expect(pipeline.stdout.text).toBe('alpha\n');
    expect(pipeline.stderr.text).toBe('');
    expect(pipeline.result.exitCode).toBe(0);
  });

  it('returns command exit status when closing getline pipelines', async () => {
    const failed = await execute({
      script: `awk 'BEGIN { command = "false"; print (command | getline value), value; print close(command) }'`,
    });
    const outputThenFailed = await execute({
      script: `awk 'BEGIN { command = "printf alpha; false"; print (command | getline value), value; print close(command) }'`,
    });
    const missing = await execute({
      script: `awk 'BEGIN { command = "wesh-command-that-does-not-exist"; print (command | getline value), value; print close(command) }'`,
    });

    expect(failed.stdout.text).toBe(`\
0 ${''}
1
`);
    expect(failed.stderr.text).toBe('');
    expect(failed.result.exitCode).toBe(0);
    expect(outputThenFailed.stdout.text).toBe(`\
1 alpha
1
`);
    expect(outputThenFailed.stderr.text).toBe('');
    expect(outputThenFailed.result.exitCode).toBe(0);
    expect(missing.stdout.text).toBe(`\
0 ${''}
127
`);
    expect(missing.stderr.text).toContain('Command not found: wesh-command-that-does-not-exist');
    expect(missing.result.exitCode).toBe(0);
  });

  it('supports print output pipelines and flushes them through close', async () => {
    const pipeline = await execute({
      script: `awk 'BEGIN { print "alpha" | "cat"; close("cat") }'`,
    });

    expect(pipeline.stdout.text).toBe('alpha\n');
    expect(pipeline.stderr.text).toBe('');
    expect(pipeline.result.exitCode).toBe(0);
  });

  it('supports getline from standard input with target variables and end-of-input status', async () => {
    const getline = await execute({
      script: `awk 'BEGIN { first = getline value; second = getline other; third = getline missing; print first, value, second, other, third, missing }'`,
      stdinText: `\
alpha
beta
`,
    });

    expect(getline.stdout.text).toBe('1 alpha 1 beta 0 \n');
    expect(getline.stderr.text).toBe('');
    expect(getline.result.exitCode).toBe(0);
  });

  it('supports getline from named files without changing NR or FNR', async () => {
    await writeFile({
      path: 'getline.txt',
      data: `\
alpha
beta
`,
    });

    const getline = await execute({
      script: `awk 'BEGIN { first = getline value < "getline.txt"; second = getline other < "getline.txt"; third = getline missing < "getline.txt"; print first, value, second, other, third, NR, FNR }'`,
    });

    expect(getline.stdout.text).toBe(`\
1 alpha 1 beta 0 0 0
`);
    expect(getline.stderr.text).toBe('');
    expect(getline.result.exitCode).toBe(0);
  });

  it('accepts assignments in both branches of conditional expressions', async () => {
    const conditional = await execute({
      script: `awk 'BEGIN { x = 1; print (1 ? x++ : x += 10), x; print (0 ? x += 10 : x++), x }'`,
    });

    expect(conditional.stdout.text).toBe(`\
1 2
2 3
`);
    expect(conditional.stderr.text).toBe('');
    expect(conditional.result.exitCode).toBe(0);
  });

  it('reports unsupported printf formats explicitly', async () => {
    const badPrintf = await execute({
      script: `\
awk 'BEGIN { printf "%q", 1 }'`,
    });

    expect(badPrintf.stdout.text).toBe('');
    expect(badPrintf.stderr.text).toContain("awk: unsupported printf format '%q'");
    expect(badPrintf.result.exitCode).toBe(2);
  });

  it('supports a leading closing bracket in regular expression bracket expressions', async () => {
    const { result, stdout, stderr } = await execute({
      script: String.raw`awk '$0 ~ /[]a]/ { print NR ":" $0 }'`,
      stdinText: `\
a
]
b
`,
    });

    expect(stdout.text).toBe(`\
1:a
2:]
`);
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
  });

  it('uses POSIX leftmost-longest matching for match and substitutions', async () => {
    const matched = await execute({
      script: String.raw`awk 'BEGIN { print match("aa", /a|aa/), RSTART, RLENGTH }'`,
    });
    const substituted = await execute({
      script: String.raw`awk 'BEGIN { value = "aa"; print sub(/a|aa/, "X", value), value }'`,
    });

    expect(matched.stdout.text).toBe('1 1 2\n');
    expect(substituted.stdout.text).toBe('1 X\n');
    for (const outcome of [matched, substituted]) {
      expect(outcome.stderr.text).toBe('');
      expect(outcome.result.exitCode).toBe(0);
    }
  });

  it('uses POSIX leftmost-longest matching for FS, split, and RS separators', async () => {
    const fields = await execute({
      script: String.raw`printf 'xaaY\n' | awk -F'a|aa' '{ print NF, "[" $1 "]", "[" $2 "]" }'`,
    });
    const split = await execute({
      script: String.raw`awk 'BEGIN { count = split("xaaY", values, /a|aa/); print count, "[" values[1] "]", "[" values[2] "]" }'`,
    });
    const records = await execute({
      script: String.raw`printf 'xaaY' | awk 'BEGIN { RS="a|aa" } { print NR, "[" $0 "]" }'`,
    });
    const emptyFieldSeparator = await execute({
      script: String.raw`printf 'abc\n' | awk -v FS= '{ print NF, $1, $2, $3 }'`,
    });

    expect(fields.stdout.text).toBe('2 [x] [Y]\n');
    expect(split.stdout.text).toBe('2 [x] [Y]\n');
    expect(records.stdout.text).toBe(`\
1 [x]
2 [Y]
`);
    expect(emptyFieldSeparator.stdout.text).toBe('3 a b c\n');
    for (const outcome of [fields, split, records, emptyFieldSeparator]) {
      expect(outcome.stderr.text).toBe('');
      expect(outcome.result.exitCode).toBe(0);
    }
  });

  it('rejects printf materialization beyond the command safety limits', async () => {
    const width = await execute({
      script: String.raw`awk 'BEGIN { printf "%1000001s", "x" }'`,
    });
    expect(width.stdout.text).toBe('');
    expect(width.stderr.text).toContain('awk: printf width 1000001 exceeds safety limit 1000000');
    expect(width.result.exitCode).toBe(2);

    const precision = await execute({
      script: String.raw`awk 'BEGIN { printf "%.101f", 1 }'`,
    });
    expect(precision.stdout.text).toBe('');
    expect(precision.stderr.text).toContain('awk: printf precision 101 exceeds safety limit 100');
    expect(precision.result.exitCode).toBe(2);
  });

  it('limits only newly materialized AWK fields', async () => {
    const nf = await execute({
      script: String.raw`awk 'BEGIN { NF = 100001 }'`,
    });
    expect(nf.stdout.text).toBe('');
    expect(nf.stderr.text).toContain('awk: field count 100001 exceeds safety limit 100000');
    expect(nf.result.exitCode).toBe(2);

    const field = await execute({
      script: String.raw`awk 'BEGIN { $100001 = "x" }'`,
    });
    expect(field.stdout.text).toBe('');
    expect(field.stderr.text).toContain('awk: field index 100001 exceeds safety limit 100000');
    expect(field.result.exitCode).toBe(2);

    const shrink = await execute({
      script: String.raw`printf 'a b c\n' | awk '{ NF = 1; print $0 }'`,
    });
    expect(shrink.stdout.text).toBe('a\n');
    expect(shrink.stderr.text).toBe('');
    expect(shrink.result.exitCode).toBe(0);
  });

  it('supports dynamic printf width and precision arguments', async () => {
    const { result, stdout, stderr } = await execute({
      script: String.raw`awk 'BEGIN { printf "[%*s][%.*f]\n", -5, "x", 2, 1.234 }'`,
    });

    expect(stdout.text).toBe('[x    ][1.23]\n');
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
  });

  it('preserves negative zero with general printf conversion', async () => {
    const { result, stdout, stderr } = await execute({
      script: String.raw`awk 'BEGIN { printf "%.0f|%g\n", -0.1, -0.0 }'`,
    });

    expect(stdout.text).toBe('-0|-0\n');
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
  });

  it('preserves escaped ampersands in substitution replacement strings', async () => {
    const { result, stdout, stderr } = await execute({
      script: String.raw`awk 'BEGIN { value = "abc"; sub(/b/, "\\&", value); print value }'`,
    });

    expect(stdout.text).toBe('a&c\n');
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
  });

  it('uses the leading numeric prefix when coercing ordinary strings to numbers', async () => {
    const { result, stdout, stderr } = await execute({
      script: String.raw`awk 'BEGIN { print (" 12x" + 0), ("-.5tail" + 0), ("none" + 0) }'`,
    });

    expect(stdout.text).toBe('12 -0.5 0\n');
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
  });

  it('distinguishes whitespace-separated concatenation from known function calls', async () => {
    const { result, stdout, stderr } = await execute({
      script: String.raw`awk 'function increment(value) { return value + 1 } BEGIN { x = 1; y = 2; print x (y + 3), length ("abc"), increment (2) }'`,
    });

    expect(stdout.text).toBe('15 3 3\n');
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
  });

  it('rejects a spaced call before the user function declaration', async () => {
    const { result, stdout, stderr } = await execute({
      script: String.raw`awk 'BEGIN { print plus (2) } function plus(value) { return value + 1 }'`,
    });

    expect(stdout.text).toBe('');
    expect(stderr.text).toContain('awk: illegal reference to variable plus');
    expect(result.exitCode).toBe(2);
  });

  it('flushes standard and named output through fflush', async () => {
    const standard = await execute({
      script: String.raw`awk 'BEGIN { print "before"; print fflush(); print "after" }'`,
    });
    const named = await execute({
      script: String.raw`awk 'BEGIN { print "x" > "out.txt"; print fflush("out.txt"); print "y" >> "out.txt"; close("out.txt") }'`,
    });
    const command = await execute({
      script: String.raw`awk 'BEGIN { print "x" | "cat"; print fflush("cat"); print "y" | "cat"; close("cat") }'`,
    });

    const repeatedCommand = await execute({
      script: String.raw`awk 'BEGIN { print "pre"; print "x" | "cat"; print fflush("cat"); print "mid"; print "y" | "cat"; print fflush("cat"); print "post"; close("cat") }'`,
    });
    const distinctCommands = await execute({
      script: String.raw`awk 'BEGIN { print "pre"; print "x" | "cat"; print "y" | "sed s/y/Y/"; print fflush("cat"); print "mid"; print fflush("sed s/y/Y/"); print "post"; close("cat"); close("sed s/y/Y/") }'`,
    });
    const reverseFlushOrder = await execute({
      script: String.raw`awk 'BEGIN { print "pre"; print "a" | "cat"; print "b" | "sed s/b/B/"; print fflush("sed s/b/B/"); print "mid"; print fflush("cat"); print "post"; close("cat"); close("sed s/b/B/") }'`,
    });
    const failingCommand = await execute({
      script: String.raw`awk 'BEGIN { print "x" | "false"; print fflush("false"); print close("false") }'`,
    });
    const missingCommand = await execute({
      script: String.raw`awk 'BEGIN { print "x" | "command-that-does-not-exist"; print fflush("command-that-does-not-exist"); print close("command-that-does-not-exist") }'`,
    });

    expect(standard.stdout.text).toBe(`\
before
0
after
`);
    expect(standard.stderr.text).toBe('');
    expect(standard.result.exitCode).toBe(0);
    expect(named.stdout.text).toBe('0\n');
    expect(named.stderr.text).toBe('');
    expect(named.result.exitCode).toBe(0);
    expect(await readFile({ path: 'out.txt' })).toBe(`\
x
y
`);
    expect(command.stdout.text).toBe(`\
x
y
0
`);
    expect(command.stderr.text).toBe('');
    expect(command.result.exitCode).toBe(0);
    expect(repeatedCommand.stdout.text).toBe(`\
pre
x
y
0
mid
0
post
`);
    expect(repeatedCommand.stderr.text).toBe('');
    expect(repeatedCommand.result.exitCode).toBe(0);
    expect(distinctCommands.stdout.text).toBe(`\
pre
x
Y
0
mid
0
post
`);
    expect(distinctCommands.stderr.text).toBe('');
    expect(distinctCommands.result.exitCode).toBe(0);
    expect(reverseFlushOrder.stdout.text).toBe(`\
pre
a
B
0
mid
0
post
`);
    expect(reverseFlushOrder.stderr.text).toBe('');
    expect(reverseFlushOrder.result.exitCode).toBe(0);
    expect(failingCommand.stdout.text).toBe(`\
0
1
`);
    expect(failingCommand.stderr.text).toBe('');
    expect(failingCommand.result.exitCode).toBe(0);
    expect(missingCommand.stdout.text).toBe(`\
0
127
`);
    expect(missingCommand.stderr.text).toContain('Command not found: command-that-does-not-exist');
    expect(missingCommand.result.exitCode).toBe(0);
  });

  it('rejects high-confidence unsafe backtracking on long records', async () => {
    const unsafe = await execute({
      script: String.raw`awk '{ print $0 ~ /(a+)+$/ }'`,
      stdinText: `${'a'.repeat(100)}X\n`,
    });
    const safe = await execute({
      script: String.raw`awk '{ print $0 ~ /(a+)$/ }'`,
      stdinText: `${'a'.repeat(100)}\n`,
    });

    expect(unsafe.result.exitCode).not.toBe(0);
    expect(unsafe.stderr.text).toContain('safe backtracking limit');
    expect(safe.result.exitCode).toBe(0);
    expect(safe.stdout.text).toBe('1\n');
  });

  it('treats escaped alphanumeric characters literally inside POSIX bracket expressions', async () => {
    const result = await execute({
      script: String.raw`awk '$0 ~ /[\w]+/'`,
      stdinText: `\
w
5
word
`,
    });

    expect(result.result.exitCode).toBe(0);
    expect(result.stdout.text).toBe(`\
w
word
`);
    expect(result.stderr.text).toBe('');
  });

  it('decodes AWK regexp-literal escapes before POSIX matching', async () => {
    const result = await execute({
      script: String.raw`awk '$0 ~ /[\b]/ || $0 ~ /\x41/ || $0 ~ /\w/'`,
      stdinText: `\b\nA\nw\nb\n`,
    });

    expect(result.result.exitCode).toBe(0);
    expect(result.stdout.text).toBe(`\b\nA\nw\n`);
    expect(result.stderr.text).toBe('');
  });

  it('decodes AWK source string escapes while preserving unknown escapes', async () => {
    const result = await execute({
      script: String.raw`awk 'BEGIN { printf "%d:%d:%d:%d:%s:%s:%s\n", length("\b"), length("\f"), length("\v"), length("\a"), "\x41", "\101", "\w" }'`,
      stdinText: '',
    });

    expect(result.result.exitCode).toBe(0);
    expect(result.stdout.text).toBe('1:1:1:1:A:A:\\w\n');
    expect(result.stderr.text).toBe('');
  });

  it('decodes known escapes again when compiling dynamic AWK regular expressions', async () => {
    const result = await execute({
      script: String.raw`awk 'BEGIN { alert="\\a"; hex="\\x41+"; octal="\\101+" } $0 ~ alert || $0 ~ hex || $0 ~ octal'`,
      stdinText: `\u0007\nAAA\nx41\n101\n`,
    });

    expect(result.result.exitCode).toBe(0);
    expect(result.stdout.text).toBe(`\u0007\nAAA\n`);
    expect(result.stderr.text).toBe('');
  });

  it('treats unknown escapes literally in dynamic AWK regular expressions', async () => {
    const commandLine = await execute({
      script: String.raw`awk -v r='\w+' '$0 ~ r'`,
      stdinText: `\
w
www
5
word
`,
    });
    const sourceString = await execute({
      script: String.raw`awk 'BEGIN { r="\\d+" } $0 ~ r'`,
      stdinText: `\
ddd
5
word
`,
    });

    expect(commandLine.result.exitCode).toBe(0);
    expect(commandLine.stdout.text).toBe(`\
w
www
word
`);
    expect(sourceString.result.exitCode).toBe(0);
    expect(sourceString.stdout.text).toBe(`\
ddd
word
`);
    expect(commandLine.stderr.text).toBe('');
    expect(sourceString.stderr.text).toBe('');
  });

  it('handles deep unary expressions without using the host call stack', async () => {
    const depth = 10_000;
    const result = await execute({
      script: `awk 'BEGIN { print ${'!'.repeat(depth)}1 }'`,
    });

    expect(result.result.exitCode).toBe(0);
    expect(result.stdout.text).toBe('1\n');
    expect(result.stderr.text).toBe('');
  });

  it('bounds structural expression nesting with a stable diagnostic', async () => {
    const acceptedDepth = 128;
    const accepted = await execute({
      script: `awk 'BEGIN { print ${'('.repeat(acceptedDepth)}1${')'.repeat(acceptedDepth)} }'`,
    });
    const rejected = await execute({
      script: `awk 'BEGIN { print ${'('.repeat(acceptedDepth + 1)}1${')'.repeat(acceptedDepth + 1)} }'`,
    });

    expect(accepted.result.exitCode).toBe(0);
    expect(accepted.stdout.text).toBe('1\n');
    expect(accepted.stderr.text).toBe('');
    expect(rejected.result.exitCode).toBe(2);
    expect(rejected.stdout.text).toBe('');
    expect(rejected.stderr.text).toBe('awk: expression nesting exceeds limit 128\n');
  });

  it('bounds nested calls, array indices, and dynamic fields with the structural limit', async () => {
    const acceptedDepth = 128;
    const nestedCall = ({ depth }: { depth: number }): string => (
      `${'identity('.repeat(depth)}1${')'.repeat(depth)}`
    );
    const nestedIndex = ({ depth }: { depth: number }): string => (
      `${'values['.repeat(depth)}0${']'.repeat(depth)}`
    );
    const nestedField = ({ depth }: { depth: number }): string => (
      `${'$'.repeat(depth)}fieldIndex`
    );
    const cases = [
      {
        acceptedScript: `awk 'function identity(value) { return value } BEGIN { print ${nestedCall({ depth: acceptedDepth })} }'`,
        acceptedStdout: '1\n',
        rejectedScript: `awk 'function identity(value) { return value } BEGIN { print ${nestedCall({ depth: acceptedDepth + 1 })} }'`,
      },
      {
        acceptedScript: `awk 'BEGIN { ${nestedIndex({ depth: acceptedDepth })}=1; print 1 }'`,
        acceptedStdout: '1\n',
        rejectedScript: `awk 'BEGIN { ${nestedIndex({ depth: acceptedDepth + 1 })}=1; print 1 }'`,
      },
      {
        acceptedScript: `awk 'BEGIN { fieldIndex=0; print ${nestedField({ depth: acceptedDepth })} }'`,
        acceptedStdout: '\n',
        rejectedScript: `awk 'BEGIN { fieldIndex=0; print ${nestedField({ depth: acceptedDepth + 1 })} }'`,
      },
    ];

    for (const current of cases) {
      const accepted = await execute({ script: current.acceptedScript });
      const rejected = await execute({ script: current.rejectedScript });

      expect(accepted.result.exitCode).toBe(0);
      expect(accepted.stdout.text).toBe(current.acceptedStdout);
      expect(accepted.stderr.text).toBe('');
      expect(rejected.result.exitCode).toBe(2);
      expect(rejected.stdout.text).toBe('');
      expect(rejected.stderr.text).toBe('awk: expression nesting exceeds limit 128\n');
    }
  });

  it('bounds nested statement bodies with a stable diagnostic', async () => {
    const acceptedDepth = 128;
    const accepted = await execute({
      script: `awk 'BEGIN { ${'if (1) '.repeat(acceptedDepth)}print 1 }'`,
    });
    const rejected = await execute({
      script: `awk 'BEGIN { ${'if (1) '.repeat(acceptedDepth + 1)}print 1 }'`,
    });

    expect(accepted.result.exitCode).toBe(0);
    expect(accepted.stdout.text).toBe('1\n');
    expect(accepted.stderr.text).toBe('');
    expect(rejected.result.exitCode).toBe(2);
    expect(rejected.stdout.text).toBe('');
    expect(rejected.stderr.text).toBe('awk: statement nesting exceeds limit 128\n');
  });

  it('evaluates deep left-associated binary chains without using the host call stack', async () => {
    const depth = 20_000;
    const addition = await execute({
      script: `awk 'BEGIN { print ${Array.from({ length: depth }, () => '1').join(' + ')} }'`,
    });
    const shortCircuit = await execute({
      script: `awk 'BEGIN { x=0; print ${Array.from({ length: depth }, () => '0').join(' && ')} && ++x; print x }'`,
    });

    expect(addition.result.exitCode).toBe(0);
    expect(addition.stdout.text).toBe(`${depth}\n`);
    expect(addition.stderr.text).toBe('');
    expect(shortCircuit.result.exitCode).toBe(0);
    expect(shortCircuit.stdout.text).toBe(`\
0
0
`);
    expect(shortCircuit.stderr.text).toBe('');
  });

  it('bounds right-associative expression nesting with a stable diagnostic', async () => {
    const acceptedDepth = 128;
    const expressions = [
      Array.from({ length: acceptedDepth + 1 }, () => '1').join(' ^ '),
      `${'0 ? 0 : '.repeat(acceptedDepth)}1`,
      `${Array.from({ length: acceptedDepth }, (_, index) => `v${index}=`).join('')}1`,
    ];
    for (const expression of expressions) {
      const accepted = await execute({ script: `awk 'BEGIN { print ${expression} }'` });
      expect(accepted.result.exitCode).toBe(0);
      expect(accepted.stdout.text).toBe('1\n');
      expect(accepted.stderr.text).toBe('');
    }

    const rejected = await execute({
      script: `awk 'BEGIN { print ${Array.from({ length: acceptedDepth + 2 }, () => '1').join(' ^ ')} }'`,
    });
    expect(rejected.result.exitCode).toBe(2);
    expect(rejected.stdout.text).toBe('');
    expect(rejected.stderr.text).toBe(
      'awk: right-associative expression nesting exceeds limit 128\n',
    );
  });

  it('rejects duplicate function parameter names', async () => {
    const result = await execute({
      script: `awk 'function duplicate(first, second, first) { return first } BEGIN { print 1 }'`,
    });

    expect(result.result.exitCode).toBe(2);
    expect(result.stdout.text).toBe('');
    expect(result.stderr.text).toBe("awk: duplicate function parameter 'first'\n");
  });

  it('preserves prefix updates nested inside unary expressions', async () => {
    const result = await execute({
      script: `awk 'BEGIN { x=1; print -++x, x; print !++x, x; print +--x, x }'`,
    });

    expect(result.result.exitCode).toBe(0);
    expect(result.stdout.text).toBe(`\
-2 2
0 3
2 2
`);
    expect(result.stderr.text).toBe('');
  });

  it('stops option parsing after the inline program operand', async () => {
    await writeFile({
      path: 'input.txt',
      data: 'left:right\n',
    });

    const execution = await execute({
      script: `awk '{ print $1 }' input.txt -F:`,
    });

    expect(execution.stdout.text).toBe('left:right\n');
    expect(execution.stderr.text).toContain("awk: -F:");
    expect(execution.result.exitCode).toBe(2);
  });

  it('does not open input operands for functions-only or BEGIN-only programs', async () => {
    const beginOnly = await execute({
      script: `awk 'BEGIN { print "begin" }' definitely-missing-input`,
    });
    const functionsOnly = await execute({
      script: `awk 'function identity(value) { return value }' definitely-missing-input`,
    });
    const beginAndEnd = await execute({
      script: `awk 'BEGIN { print "begin" } END { print NR }' definitely-missing-input`,
    });

    expect(beginOnly.stdout.text).toBe('begin\n');
    expect(beginOnly.stderr.text).toBe('');
    expect(beginOnly.result.exitCode).toBe(0);

    expect(functionsOnly.stdout.text).toBe('');
    expect(functionsOnly.stderr.text).toBe('');
    expect(functionsOnly.result.exitCode).toBe(0);

    expect(beginAndEnd.stdout.text).toBe('begin\n');
    expect(beginAndEnd.stderr.text).toContain('definitely-missing-input');
    expect(beginAndEnd.result.exitCode).toBe(2);
  });

  it('stops option parsing after the first input operand with a program file', async () => {
    await writeFile({
      path: 'program.awk',
      data: '{ print x ":" $0 }\n',
    });
    await writeFile({
      path: 'input.txt',
      data: 'alpha\n',
    });

    const execution = await execute({
      script: 'awk -f program.awk input.txt -v x=1',
    });

    expect(execution.stdout.text).toBe(':alpha\n');
    expect(execution.stderr.text).toContain("awk: -v:");
    expect(execution.result.exitCode).toBe(2);
  });

});
