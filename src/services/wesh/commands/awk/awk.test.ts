import { beforeEach, describe, expect, it } from 'vitest';
import { Wesh } from '@/services/wesh/index';
import { MockFileSystemDirectoryHandle } from '@/services/wesh/mocks/InMemoryFileSystem';
import {
  createWeshReadFileHandleFromText,
  createWeshWriteCaptureHandle,
} from '@/services/wesh/utils/test-stream';

describe('wesh awk', () => {
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

  it('reports missing program and file errors', async () => {
    const missingProgram = await execute({ script: 'awk' });
    const missingFile = await execute({ script: `awk '{ print $1 }' missing.txt` });

    expect(missingProgram.stdout.text).toBe('');
    expect(missingProgram.stderr.text).toContain('awk: missing program source');
    expect(missingProgram.stderr.text).toContain('usage: awk [-F FS] [-v VAR=VALUE] [-f PROGRAM_FILE] [--] PROGRAM [FILE]...');
    expect(missingProgram.result.exitCode).toBe(1);

    expect(missingFile.stdout.text).toBe('');
    expect(missingFile.stderr.text).toContain('awk: missing.txt:');
    expect(missingFile.result.exitCode).toBe(1);
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

  it('reports unsupported printf formats explicitly', async () => {
    const badPrintf = await execute({
      script: `\
awk 'BEGIN { printf "%q", 1 }'`,
    });

    expect(badPrintf.stdout.text).toBe('');
    expect(badPrintf.stderr.text).toContain("awk: unsupported printf format '%q'");
    expect(badPrintf.result.exitCode).toBe(2);
  });
});
