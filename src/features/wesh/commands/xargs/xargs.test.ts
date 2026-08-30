import { beforeEach, describe, expect, it } from 'vitest';
import { Wesh } from '@/features/wesh/index';
import { createTextShellSource } from '@/features/wesh/shell/source';
import { MockFileSystemDirectoryHandle } from '@/features/wesh/mocks/InMemoryFileSystem';
import { TEST_ONLY } from '@/features/wesh/commands/xargs';
import {
  createTestReadHandleFromBytes,
  createTestReadHandleFromText,
  createTestWriteCaptureHandle,
} from '@/features/wesh/utils/test-stream';

describe('wesh xargs', () => {
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
    stdinText,
    stdinBytes,
  }: {
    script: string,
    stdinText?: string,
    stdinBytes?: Uint8Array,
  }) {
    const stdout = createTestWriteCaptureHandle();
    const stderr = createTestWriteCaptureHandle();

    const result = await wesh.execute({
      source: createTextShellSource({ text: script }),
      stdin: stdinBytes === undefined
        ? createTestReadHandleFromText({ text: stdinText ?? '' })
        : createTestReadHandleFromBytes({ bytes: stdinBytes }),
      stdout: stdout.handle,
      stderr: stderr.handle,
    });

    return { result, stdout, stderr };
  }

  it('prints help and rejects invalid options', async () => {
    const help = await execute({
      script: 'xargs --help',
      stdinText: '',
    });
    const invalid = await execute({
      script: 'xargs --bogus',
      stdinText: '',
    });

    expect(help.stdout.text).toContain('Build and run command lines from standard input');
    expect(help.stdout.text).toContain('usage: xargs [-0rtx] [-a FILE] [-d DELIM] [-E EOFSTR] [-n MAX] [-L MAX] [-s MAX] [-I REPLSTR] [COMMAND [INITIAL-ARGS]...]');
    expect(help.result.exitCode).toBe(0);

    expect(invalid.stdout.text).toBe('');
    expect(invalid.stderr.text).toContain("xargs: unrecognized option '--bogus'");
    expect(invalid.result.exitCode).toBe(1);
  });

  it('stops parsing xargs options at the child command', async () => {
    const { result, stdout, stderr } = await execute({
      script: 'xargs false -n',
      stdinText: 'argument\n',
    });

    expect(stdout.text).toBe('');
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(123);
  });

  it('maps a missing child command to exit code 127', async () => {
    const { result, stdout, stderr } = await execute({
      script: 'xargs definitely-missing-command',
      stdinText: 'argument\n',
    });

    expect(stdout.text).toBe('');
    expect(stderr.text).toContain('xargs: definitely-missing-command: No such file or directory');
    expect(result.exitCode).toBe(127);
  });

  it('maps a child exit code 126 to the generic child failure code', () => {
    expect(TEST_ONLY.normalizeXargsExitCode({ exitCode: 126 })).toBe(123);
  });

  it('discards an unquoted trailing backslash at end of input', async () => {
    const { result, stdout, stderr } = await execute({
      script: "xargs printf '<%s>\\n'",
      stdinText: 'alpha\\',
    });

    expect(stdout.text).toBe('<alpha>\n');
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
  });

  it('supports --show-limits', async () => {
    const { result, stdout, stderr } = await execute({
      script: 'xargs --show-limits',
      stdinText: '',
    });

    expect(stdout.text).toContain('POSIX upper limit on argument length');
    expect(stdout.text).toContain('Maximum parallelism');
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
  });

  it('supports --version', async () => {
    const { result, stdout, stderr } = await execute({
      script: 'xargs --version',
      stdinText: '',
    });

    expect(stdout.text).toContain('xargs (wesh)');
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
  });

  it('uses the first help or version early exit in argv order', async () => {
    const versionThenInvalid = await execute({
      script: 'xargs --version --definitely-invalid-option',
      stdinText: '',
    });
    const versionThenHelp = await execute({
      script: 'xargs --version --help',
      stdinText: '',
    });

    expect(versionThenInvalid.stdout.text).toContain('xargs (wesh)');
    expect(versionThenInvalid.stderr.text).toBe('');
    expect(versionThenInvalid.result.exitCode).toBe(0);
    expect(versionThenHelp.stdout.text).toContain('xargs (wesh)');
    expect(versionThenHelp.stderr.text).toBe('');
    expect(versionThenHelp.result.exitCode).toBe(0);
  });

  it('runs the command once on empty input unless -r is used', async () => {
    const standard = await execute({
      script: 'xargs echo prefix',
      stdinText: ' \n\t\n',
    });
    const maxLines = await execute({
      script: 'xargs -L1 echo prefix',
      stdinText: '',
    });
    const maxLinesNoRun = await execute({
      script: 'xargs -r -L1 echo prefix',
      stdinText: '',
    });
    const replace = await execute({
      script: 'xargs -I{} echo pre-{}-post',
      stdinText: '',
    });

    expect(standard.stdout.text).toBe('prefix\n');
    expect(standard.stderr.text).toBe('');
    expect(standard.result.exitCode).toBe(0);
    expect(maxLines.stdout.text).toBe('prefix\n');
    expect(maxLines.stderr.text).toBe('');
    expect(maxLines.result.exitCode).toBe(0);
    expect(maxLinesNoRun.stdout.text).toBe('');
    expect(maxLinesNoRun.stderr.text).toBe('');
    expect(maxLinesNoRun.result.exitCode).toBe(0);
    expect(replace.stdout.text).toBe('');
    expect(replace.stderr.text).toBe('');
    expect(replace.result.exitCode).toBe(0);
  });

  it('matches GNU empty replacement-marker boundaries', async () => {
    const withInitialArgument = await execute({
      script: "xargs -I '' echo X",
      stdinText: 'a\n',
    });
    const commandOnly = await execute({
      script: "xargs -I '' true",
      stdinText: 'a\n',
    });
    const emptyInput = await execute({
      script: "xargs -I '' echo X",
      stdinText: '',
    });

    expect(withInitialArgument.stdout.text).toBe('');
    expect(withInitialArgument.stderr.text).toContain('xargs: command too long');
    expect(withInitialArgument.result.exitCode).toBe(1);

    expect(commandOnly.stdout.text).toBe('');
    expect(commandOnly.stderr.text).toBe('');
    expect(commandOnly.result.exitCode).toBe(0);

    expect(emptyInput.stdout.text).toBe('');
    expect(emptyInput.stderr.text).toBe('');
    expect(emptyInput.result.exitCode).toBe(0);
  });

  it('supports max-procs batching with -P', async () => {
    const sequential = await execute({
      script: 'xargs -P 1 echo prefix',
      stdinText: 'alpha beta\n',
    });
    const unlimited = await execute({
      script: 'xargs -P 0 echo prefix',
      stdinText: 'alpha beta\n',
    });
    const startedAt = Date.now();
    const parallelSleep = await execute({
      script: 'xargs -n 1 -P 2 sleep',
      stdinText: `\
0.05
0.05
0.05
0.05
`,
    });
    const elapsedMs = Date.now() - startedAt;

    expect(sequential.stdout.text).toBe('prefix alpha beta\n');
    expect(sequential.stderr.text).toBe('');
    expect(sequential.result.exitCode).toBe(0);

    expect(unlimited.stdout.text).toBe('prefix alpha beta\n');
    expect(unlimited.stderr.text).toBe('');
    expect(unlimited.result.exitCode).toBe(0);

    expect(parallelSleep.stdout.text).toBe('');
    expect(parallelSleep.stderr.text).toBe('');
    expect(parallelSleep.result.exitCode).toBe(0);
    // Keep this assertion loose enough for sharded CI-like runs where
    // worker startup and timer scheduling can add noticeable overhead.
    expect(elapsedMs).toBeLessThan(400);
  });

  it('rejects explicit parallelism above the advertised safety limit', async () => {
    const { result, stdout, stderr } = await execute({
      script: 'xargs -n 1 -P 33 echo',
      stdinText: `\
alpha
beta
`,
    });

    expect(stdout.text).toBe('');
    expect(stderr.text).toContain("max-procs value '33' exceeds safety limit 32");
    expect(result.exitCode).toBe(1);
  });

  it('normalizes child failures under parallel execution', async () => {
    const { result, stdout, stderr } = await execute({
      script: 'xargs -L 1 -P 2 eval',
      stdinText: `\
test ok = ok
test ok = ng
`,
    });

    expect(stdout.text).toBe('');
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(123);
  });

  it('rejects unsupported tty-dependent options', async () => {
    const interactive = await execute({
      script: 'xargs -p echo',
      stdinText: 'alpha\n',
    });
    const openTty = await execute({
      script: 'xargs -o echo',
      stdinText: 'alpha\n',
    });

    expect(interactive.stdout.text).toBe('');
    expect(interactive.stderr.text).toContain('interactive prompting with --interactive/-p is not supported in wesh yet');
    expect(interactive.result.exitCode).toBe(1);

    expect(openTty.stdout.text).toBe('');
    expect(openTty.stderr.text).toContain('reopening stdin as /dev/tty with --open-tty/-o is not supported in wesh yet');
    expect(openTty.result.exitCode).toBe(1);
  });

  it('splits standard input using xargs-style quoting and escaping', async () => {
    const { result, stdout, stderr } = await execute({
      script: 'xargs echo',
      stdinText: 'alpha "two words" three\\ four\n',
    });

    expect(stdout.text).toBe('alpha two words three four\n');
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
  });

  it('preserves malformed UTF-8 input across all item modes', async () => {
    const cases = [
      { script: "xargs -n1 printf '<%s>\\n'", bytes: Uint8Array.of(0xff, 0x0a) },
      { script: "xargs -0 -n1 printf '<%s>\\n'", bytes: Uint8Array.of(0xff, 0x00) },
      { script: "xargs -d'|' -n1 printf '<%s>\\n'", bytes: Uint8Array.of(0xff, 0x7c) },
      { script: "xargs -I{} printf '<%s>\\n' '{}'", bytes: Uint8Array.of(0xff, 0x0a) },
      { script: "xargs -L1 printf '<%s>\\n'", bytes: Uint8Array.of(0xff, 0x0a) },
    ] as const;

    for (const testCase of cases) {
      const execution = await execute({
        script: testCase.script,
        stdinBytes: testCase.bytes,
      });
      expect(execution.result.exitCode).toBe(0);
      expect([...execution.stdout.buffer]).toEqual([0x3c, 0xff, 0x3e, 0x0a]);
      expect(execution.stderr.text).toBe('');
    }
  });

  it('preserves malformed bytes across printf string-like conversions', async () => {
    const cases = [
      { script: `xargs -0 printf '<%b>\n'`, expected: [0x3c, 0xff, 0x3e, 0x0a] },
      { script: `xargs -0 printf '<%c>\n'`, expected: [0x3c, 0xff, 0x3e, 0x0a] },
    ] as const;

    for (const testCase of cases) {
      const execution = await execute({
        script: testCase.script,
        stdinBytes: Uint8Array.of(0xff, 0x00),
      });
      expect(execution.result.exitCode).toBe(0);
      expect([...execution.stdout.buffer]).toEqual(testCase.expected);
      expect(execution.stderr.text).toBe('');
    }
  });

  it('supports null-delimited input', async () => {
    const { result, stdout, stderr } = await execute({
      script: 'xargs -0 echo',
      stdinText: 'alpha beta\0two words\0',
    });
    const withEmpty = await execute({
      script: 'xargs -0 -n1 echo prefix',
      stdinText: 'alpha\0\0two words\0',
    });

    expect(stdout.text).toBe('alpha beta two words\n');
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);

    expect(withEmpty.stdout.text).toBe(['prefix alpha', 'prefix ', 'prefix two words', ''].join('\n'));
    expect(withEmpty.stderr.text).toBe('');
    expect(withEmpty.result.exitCode).toBe(0);
  });

  it('uses the last of null and custom delimiter modes', async () => {
    const delimiterLast = await execute({
      script: "xargs -0 -d, -n1 printf '<%s>\\n'",
      stdinText: 'alpha,beta\0',
    });
    const nullLast = await execute({
      script: "xargs -d, -0 -n1 printf '<%s>\\n'",
      stdinText: 'alpha,beta\0',
    });

    expect(delimiterLast.stdout.text).toBe(`\
<alpha>
<beta>
`);
    expect(delimiterLast.stderr.text).toBe('');
    expect(delimiterLast.result.exitCode).toBe(0);
    expect(nullLast.stdout.text).toBe('<alpha,beta>\n');
    expect(nullLast.stderr.text).toBe('');
    expect(nullLast.result.exitCode).toBe(0);
  });

  it('discards NUL suffixes outside null-delimited mode', async () => {
    const standard = await execute({
      script: "xargs -n1 printf '<%s>\\n'",
      stdinText: 'a\0b c',
    });
    const lines = await execute({
      script: "xargs -L1 printf '<%s>\\n'",
      stdinText: 'a\0b c\nd\n',
    });
    const replace = await execute({
      script: "xargs -I{} printf '<%s>\\n' 'pre{}post'",
      stdinText: 'a\0b c\nd\n',
    });
    const delimiter = await execute({
      script: "xargs -d, -n1 printf '<%s>\\n'",
      stdinText: 'a\0b,c',
    });

    expect(standard.stdout.text).toBe(`\
<a>
<c>
`);
    expect(lines.stdout.text).toBe(`\
<a>
<c>
<d>
`);
    expect(replace.stdout.text).toBe(`\
<prea>
<predpost>
`);
    expect(delimiter.stdout.text).toBe(`\
<a>
<c>
`);
    expect(standard.stderr.text).toContain('a NUL character occurred in the input');
    expect(lines.stderr.text).toContain('a NUL character occurred in the input');
    expect(replace.stderr.text).toContain('a NUL character occurred in the input');
    expect(delimiter.stderr.text).toBe('');
    expect(standard.result.exitCode).toBe(0);
    expect(lines.result.exitCode).toBe(0);
    expect(replace.result.exitCode).toBe(0);
    expect(delimiter.result.exitCode).toBe(0);
  });

  it('does not create an empty delimited item for an empty stream', async () => {
    const nullDelimited = await execute({
      script: "xargs -0 printf '<%s>\\n' fixed",
      stdinText: '',
    });
    const customDelimited = await execute({
      script: "xargs -d, printf '<%s>\\n' fixed",
      stdinText: '',
    });

    expect(nullDelimited.stdout.text).toBe('<fixed>\n');
    expect(customDelimited.stdout.text).toBe('<fixed>\n');
    expect(nullDelimited.stderr.text).toBe('');
    expect(customDelimited.stderr.text).toBe('');
    expect(nullDelimited.result.exitCode).toBe(0);
    expect(customDelimited.result.exitCode).toBe(0);
  });

  it('preserves backslash-newline continuations in replace and max-lines modes', async () => {
    const replace = await execute({
      script: "xargs -I{} printf '<%s>\\n' '{}'",
      stdinText: 'alpha\\\nbeta\ngamma\n',
    });
    const lines = await execute({
      script: "xargs -L1 printf '<%s>\\n'",
      stdinText: 'alpha\\\nbeta\ngamma\n',
    });

    expect(replace.stdout.text).toBe(`\
<alpha
beta>
<gamma>
`);
    expect(replace.stderr.text).toBe('');
    expect(replace.result.exitCode).toBe(0);
    expect(lines.stdout.text).toBe(`\
<alpha
beta>
<gamma>
`);
    expect(lines.stderr.text).toBe('');
    expect(lines.result.exitCode).toBe(0);
  });

  it('supports reading input from -a files', async () => {
    await writeFile({
      path: 'items.txt',
      data: `\
alpha
beta gamma
`,
    });

    const { result, stdout, stderr } = await execute({
      script: 'xargs -a items.txt echo',
      stdinText: 'ignored stdin',
    });

    expect(stdout.text).toBe('alpha beta gamma\n');
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
  });

  it('preserves child stdin when -a is used', async () => {
    await writeFile({
      path: 'items.txt',
      data: '',
    });

    const preservedStdin = await execute({
      script: 'xargs -a items.txt cat',
      stdinText: 'child stdin survives\n',
    });

    expect(preservedStdin.stdout.text).toBe('child stdin survives\n');
    expect(preservedStdin.stderr.text).toBe('');
    expect(preservedStdin.result.exitCode).toBe(0);
  });

  it('treats -a - as standard input and isolates child stdin', async () => {
    const result = await execute({
      script: 'xargs -a - -I{} cat',
      stdinText: 'alpha beta\n',
    });

    expect(result.stdout.text).toBe('');
    expect(result.stderr.text).toBe('');
    expect(result.result.exitCode).toBe(0);
  });

  it('supports custom delimiters with -d', async () => {
    const { result, stdout, stderr } = await execute({
      script: 'xargs -d , echo',
      stdinText: 'alpha,beta gamma,delta',
    });
    const escaped = await execute({
      script: "xargs -d '\\n' echo",
      stdinText: `\
alpha
beta gamma
`,
    });
    const hexEscaped = await execute({
      script: `xargs -d '\\x2c' echo`,
      stdinText: 'one,two',
    });
    const withEmpty = await execute({
      script: 'xargs -d , -n1 echo prefix',
      stdinText: 'one,,two,',
    });

    expect(stdout.text).toBe('alpha beta gamma delta\n');
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);

    expect(escaped.stdout.text).toBe('alpha beta gamma\n');
    expect(escaped.stderr.text).toBe('');
    expect(escaped.result.exitCode).toBe(0);

    expect(hexEscaped.stdout.text).toBe('one two\n');
    expect(hexEscaped.stderr.text).toBe('');
    expect(hexEscaped.result.exitCode).toBe(0);

    expect(withEmpty.stdout.text).toBe(['prefix one', 'prefix ', 'prefix two', ''].join('\n'));
    expect(withEmpty.stderr.text).toBe('');
    expect(withEmpty.result.exitCode).toBe(0);
  });

  it('supports logical end-of-file markers with -E', async () => {
    const standard = await execute({
      script: 'xargs -E STOP echo',
      stdinText: `\
alpha
STOP
beta
`,
    });
    const ignoredWithDelimiter = await execute({
      script: 'xargs -d , -E STOP echo',
      stdinText: 'alpha,STOP,beta',
    });
    const unterminatedMarker = await execute({
      script: 'xargs -E STOP -n1 echo',
      stdinText: 'alpha STOP',
    });
    const standaloneUnterminatedMarker = await execute({
      script: 'xargs -E STOP -n1 echo prefix',
      stdinText: 'STOP',
    });

    expect(standard.stdout.text).toBe('alpha\n');
    expect(standard.stderr.text).toBe('');
    expect(standard.result.exitCode).toBe(0);

    expect(ignoredWithDelimiter.stdout.text).toBe('alpha STOP beta\n');
    expect(ignoredWithDelimiter.stderr.text).toBe('');
    expect(ignoredWithDelimiter.result.exitCode).toBe(0);
    expect(unterminatedMarker.stdout.text).toBe(`\
alpha
STOP
`);
    expect(unterminatedMarker.stderr.text).toBe('');
    expect(unterminatedMarker.result.exitCode).toBe(0);
    expect(standaloneUnterminatedMarker.stdout.text).toBe('prefix\n');
    expect(standaloneUnterminatedMarker.stderr.text).toBe('');
    expect(standaloneUnterminatedMarker.result.exitCode).toBe(0);
  });

  it('supports deprecated -e, -i, and -l spellings', async () => {
    const eof = await execute({
      script: 'xargs -eSTOP echo',
      stdinText: `\
alpha
STOP
beta
`,
    });
    const replace = await execute({
      script: 'xargs -i echo X:{}:Y',
      stdinText: `\
foo
bar
`,
    });
    const lines = await execute({
      script: 'xargs -l2 echo prefix',
      stdinText: `\
a
b
c
`,
    });

    expect(eof.stdout.text).toBe('alpha\n');
    expect(eof.stderr.text).toBe('');
    expect(eof.result.exitCode).toBe(0);

    expect(replace.stdout.text).toBe(`\
X:foo:Y
X:bar:Y
`);
    expect(replace.stderr.text).toBe('');
    expect(replace.result.exitCode).toBe(0);

    expect(lines.stdout.text).toBe(`\
prefix a b
prefix c
`);
    expect(lines.stderr.text).toBe('');
    expect(lines.result.exitCode).toBe(0);
  });

  it('supports deprecated optional short options after bundled flags', async () => {
    const replace = await execute({
      script: 'xargs -ri echo X:{}:Y',
      stdinText: `\
foo
bar
`,
    });
    const lines = await execute({
      script: 'xargs -rl2 echo prefix',
      stdinText: `\
a
b
c
`,
    });
    const eof = await execute({
      script: 'xargs -reSTOP echo',
      stdinText: `\
alpha
STOP
beta
`,
    });

    expect(replace.stdout.text).toBe(`\
X:foo:Y
X:bar:Y
`);
    expect(replace.stderr.text).toBe('');
    expect(replace.result.exitCode).toBe(0);

    expect(lines.stdout.text).toBe(`\
prefix a b
prefix c
`);
    expect(lines.stderr.text).toBe('');
    expect(lines.result.exitCode).toBe(0);

    expect(eof.stdout.text).toBe('alpha\n');
    expect(eof.stderr.text).toBe('');
    expect(eof.result.exitCode).toBe(0);
  });

  it('does not split deprecated optional short options out of option values', async () => {
    const directReplacementSuffix = await execute({
      script: 'xargs -it echo X:t:Y',
      stdinText: 'foo\n',
    });
    const requiredAttachedValue = await execute({
      script: 'xargs -ni echo',
      stdinText: 'foo\n',
    });

    expect(directReplacementSuffix.stdout.text).toBe('X:foo:Y\n');
    expect(directReplacementSuffix.stderr.text).toBe('');
    expect(directReplacementSuffix.result.exitCode).toBe(0);

    expect(requiredAttachedValue.stdout.text).toBe('');
    expect(requiredAttachedValue.stderr.text).toContain("invalid max-args value 'i'");
    expect(requiredAttachedValue.result.exitCode).toBe(1);
  });

  it('preserves explicit input delimiters in replace and max-lines modes', async () => {
    const nulReplace = await execute({
      script: "xargs -0 -I{} printf '<%s>\\n' '{}'",
      stdinText: 'a b\nc\0d e\nf\0',
    });
    const nulMaxLines = await execute({
      script: "xargs -0 -L1 printf '<%s>\\n'",
      stdinText: 'a b\nc\0d e\nf\0',
    });
    const delimiterReplace = await execute({
      script: "xargs -d, -I{} printf '<%s>\\n' '{}'",
      stdinText: 'alpha beta,gamma delta,',
    });
    const delimiterMaxLines = await execute({
      script: "xargs -d, -L1 printf '<%s>\\n'",
      stdinText: 'alpha beta,gamma delta,',
    });

    for (const execution of [nulReplace, nulMaxLines]) {
      expect(execution.stdout.text).toBe(`\
<a b
c>
<d e
f>
`);
      expect(execution.stderr.text).toBe('');
      expect(execution.result.exitCode).toBe(0);
    }
    for (const execution of [delimiterReplace, delimiterMaxLines]) {
      expect(execution.stdout.text).toBe(`\
<alpha beta>
<gamma delta>
`);
      expect(execution.stderr.text).toBe('');
      expect(execution.result.exitCode).toBe(0);
    }
  });

  it('supports --replace and --eof without explicit values', async () => {
    const replace = await execute({
      script: 'xargs --replace echo X:{}:Y',
      stdinText: `\
foo
bar
`,
    });
    const eof = await execute({
      script: 'xargs --eof echo',
      stdinText: `\
alpha
STOP
beta
`,
    });

    expect(replace.stdout.text).toBe(`\
X:foo:Y
X:bar:Y
`);
    expect(replace.stderr.text).toBe('');
    expect(replace.result.exitCode).toBe(0);

    expect(eof.stdout.text).toBe('alpha STOP beta\n');
    expect(eof.stderr.text).toBe('');
    expect(eof.result.exitCode).toBe(0);
  });

  it('batches arguments with -n', async () => {
    const { result, stdout, stderr } = await execute({
      script: 'xargs -n 2 echo prefix',
      stdinText: 'a b c d e\n',
    });

    expect(stdout.text).toBe(`\
prefix a b
prefix c d
prefix e
`);
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
  });

  it('accepts attached short option values like -n1 and -s11', async () => {
    const batched = await execute({
      script: 'xargs -n1 echo prefix',
      stdinText: 'a b\n',
    });
    const sized = await execute({
      script: 'xargs -s11 echo',
      stdinText: 'abc defgh ij\n',
    });

    expect(batched.stdout.text).toBe(`\
prefix a
prefix b
`);
    expect(batched.stderr.text).toBe('');
    expect(batched.result.exitCode).toBe(0);

    expect(sized.stdout.text).toBe(`\
abc
defgh
ij
`);
    expect(sized.stderr.text).toBe('');
    expect(sized.result.exitCode).toBe(0);
  });

  it('batches input lines with -L', async () => {
    const { result, stdout, stderr } = await execute({
      script: 'xargs -L 2 echo prefix',
      stdinText: `\
a b
c

d e
`,
    });
    const continued = await execute({
      script: 'xargs -L 1 echo prefix',
      stdinText: `\
one   
two
three
`,
    });

    expect(stdout.text).toBe(`\
prefix a b c
prefix d e
`);
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);

    expect(continued.stdout.text).toBe(`\
prefix one two
prefix three
`);
    expect(continued.stderr.text).toBe('');
    expect(continued.result.exitCode).toBe(0);
  });

  it('preserves Unicode-only logical lines with -L', async () => {
    const { result, stdout, stderr } = await execute({
      script: "xargs -L1 printf '<%s>\\n'",
      stdinText: '\u2003\n\u00A0\n \u2060 \n\uFEFF\n',
    });

    expect(stdout.text).toBe(`\
<\u2003>
<\u00A0>
<\u2060>
<\uFEFF>
`);
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
  });

  it('skips ASCII control-whitespace-only logical lines with -L', async () => {
    const { result, stdout, stderr } = await execute({
      script: "xargs -L1 printf '<%s>\\n'",
      stdinText: '\v\n\f\n\r\nalpha\n',
    });

    expect(stdout.text).toBe('<alpha>\n');
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
  });

  it('supports insert mode with -I using one line per execution', async () => {
    const { result, stdout, stderr } = await execute({
      script: 'xargs -I {} echo X:{}:Y',
      stdinText: `\
  foo bar
baz
`,
    });

    expect(stdout.text).toBe(`\
X:foo bar:Y
X:baz:Y
`);
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
  });

  it('uses the last of -n, -L, and -I and warns about conflicts', async () => {
    const replaceWins = await execute({
      script: 'xargs -n 2 -I {} echo item:{}',
      stdinText: `\
foo
bar
`,
    });
    const maxLinesWins = await execute({
      script: 'xargs -I {} -L 2 echo prefix',
      stdinText: `\
a
b
c
`,
    });
    const ignoredN1 = await execute({
      script: 'xargs -I {} -n 1 echo item:{}',
      stdinText: `\
left
right
`,
    });

    expect(replaceWins.stdout.text).toBe(`\
item:foo
item:bar
`);
    expect(replaceWins.stderr.text).toContain('mutually exclusive');
    expect(replaceWins.result.exitCode).toBe(0);

    expect(maxLinesWins.stdout.text).toBe(`\
prefix a b
prefix c
`);
    expect(maxLinesWins.stderr.text).toContain('mutually exclusive');
    expect(maxLinesWins.result.exitCode).toBe(0);

    expect(ignoredN1.stdout.text).toBe(`\
item:left
item:right
`);
    expect(ignoredN1.stderr.text).toBe('');
    expect(ignoredN1.result.exitCode).toBe(0);
  });

  it('supports -r to skip execution when there is no input', async () => {
    const { result, stdout, stderr } = await execute({
      script: 'xargs -r echo prefix',
      stdinText: ' \n\t\n',
    });

    expect(stdout.text).toBe('');
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
  });

  it('supports --verbose as an alias for -t', async () => {
    const { result, stdout, stderr } = await execute({
      script: 'xargs --verbose echo prefix',
      stdinText: 'alpha beta\n',
    });

    expect(stdout.text).toBe('prefix alpha beta\n');
    expect(stderr.text).toContain('echo prefix alpha beta');
    expect(result.exitCode).toBe(0);
  });

  it('renders trace arguments with locale-aware shell quoting', async () => {
    const bytes = Uint8Array.of(
      0xff, 0x00,
      0x61, 0x0d, 0x62, 0x00,
      0xc3, 0xa9, 0x00,
    );
    const ascii = await execute({
      script: "LC_ALL=C xargs -0 -t -n1 printf '<%s>\\n'",
      stdinBytes: bytes,
    });
    const unicode = await execute({
      script: "LC_ALL=C.UTF-8 xargs -0 -t -n1 printf '<%s>\\n'",
      stdinBytes: bytes,
    });

    expect(ascii.stderr.text).toBe(`\
printf '<%s>\\n' ''$'\\377'
printf '<%s>\\n' 'a'$'\\r''b'
printf '<%s>\\n' ''$'\\303\\251'
`);
    expect(unicode.stderr.text).toBe(`\
printf '<%s>\\n' ''$'\\377'
printf '<%s>\\n' 'a'$'\\r''b'
printf '<%s>\\n' é
`);
    expect(ascii.result.exitCode).toBe(0);
    expect(unicode.result.exitCode).toBe(0);
  });

  it('supports -s and -x to limit command size', async () => {
    const softLimit = await execute({
      script: 'xargs -s 11 echo',
      stdinText: 'abc defgh ij\n',
    });
    const hardLimit = await execute({
      script: 'xargs -s 9 -x echo',
      stdinText: 'abc defghijkl\n',
    });

    expect(softLimit.stdout.text).toBe(`\
abc
defgh
ij
`);
    expect(softLimit.stderr.text).toBe('');
    expect(softLimit.result.exitCode).toBe(0);

    expect(hardLimit.stdout.text).toBe('');
    expect(hardLimit.stderr.text).toContain('xargs: argument line too long');
    expect(hardLimit.result.exitCode).toBe(1);
  });

  it('applies command-size failure semantics to -x, -L, and -I', async () => {
    const hardBatch = await execute({
      script: "xargs -s 21 -n3 -x printf '<%s>\\n'",
      stdinText: 'a bbbbbbbbbbbbbbbb\n',
    });
    const lines = await execute({
      script: "xargs -s 30 -L1 printf '<%s>\\n'",
      stdinText: `\
a b
cccccccccccccccccccc
`,
    });
    const replace = await execute({
      script: "xargs -s 30 -I{} printf '<%s>\\n' 'pre{}post'",
      stdinText: `\
a
cccccccccccccccccccc
`,
    });

    expect(hardBatch.stdout.text).toBe('');
    expect(hardBatch.stderr.text).toContain('argument line too long');
    expect(hardBatch.result.exitCode).toBe(1);
    expect(lines.stdout.text).toBe(`\
<a>
<b>
`);
    expect(lines.stderr.text).toContain('argument list too long');
    expect(lines.result.exitCode).toBe(1);
    expect(replace.stdout.text).toBe('<preapost>\n');
    expect(replace.stderr.text).toContain('argument list too long');
    expect(replace.result.exitCode).toBe(1);
  });

  it('counts initial arguments toward --max-chars', async () => {
    const { result, stdout, stderr } = await execute({
      script: 'xargs -s 18 echo prefix',
      stdinText: 'alpha beta\n',
    });

    expect(stdout.text).toBe(`\
prefix alpha
prefix beta
`);
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
  });

  it('handles more input items than the JavaScript argument limit', async () => {
    const execution = await execute({
      script: 'xargs -s 8 -n1 -x true',
      stdinText: 'x '.repeat(150_000),
    });

    expect(execution.stdout.text).toBe('');
    expect(execution.stderr.text).toBe('');
    expect(execution.result.exitCode).toBe(0);
  });

  it('reports malformed quoted input', async () => {
    const { result, stdout, stderr } = await execute({
      script: 'xargs echo',
      stdinText: '"unterminated\n',
    });

    expect(stdout.text).toBe('');
    expect(stderr.text).toContain('xargs: unmatched quote in input');
    expect(result.exitCode).toBe(1);
  });

  it('accepts only leading C-locale whitespace in numeric options', async () => {
    for (const whitespace of [' ', '\t', '\n', '\v', '\f', '\r']) {
      const execution = await execute({
        script: `xargs -n '${whitespace}1' echo`,
        stdinText: 'alpha beta\n',
      });
      expect(execution.stdout.text).toBe(`\
alpha
beta
`);
      expect(execution.stderr.text).toBe('');
      expect(execution.result.exitCode).toBe(0);
    }

    for (const operand of ['1 ', '\u00a01', '\u20031', '\ufeff1']) {
      const execution = await execute({
        script: `xargs -n '${operand}' echo`,
        stdinText: 'alpha\n',
      });
      expect(execution.stdout.text).toBe('');
      expect(execution.stderr.text).toContain('invalid max-args value');
      expect(execution.result.exitCode).toBe(1);
    }
  });

  it('rejects unsafe integer limits instead of rounding them', async () => {
    for (const option of ['-n', '-L', '-s', '-P']) {
      const execution = await execute({
        script: `xargs ${option} 9007199254740993 echo`,
        stdinText: 'alpha\n',
      });
      expect(execution.stdout.text).toBe('');
      expect(execution.stderr.text).toContain('invalid');
      expect(execution.result.exitCode).toBe(1);
    }
  });


  it('accepts explicit positive signs in numeric options and obsolete -l', async () => {
    const maxArgs = await execute({
      script: 'xargs -n +1 echo',
      stdinText: 'alpha beta\n',
    });
    const obsoleteMaxLines = await execute({
      script: 'xargs -l+1 echo',
      stdinText: 'alpha beta\n',
    });

    expect(maxArgs.stdout.text).toBe(`\
alpha
beta
`);
    expect(maxArgs.stderr.text).toBe('');
    expect(maxArgs.result.exitCode).toBe(0);
    expect(obsoleteMaxLines.stdout.text).toBe('alpha beta\n');
    expect(obsoleteMaxLines.stderr.text).toBe('');
    expect(obsoleteMaxLines.result.exitCode).toBe(0);
  });

});
