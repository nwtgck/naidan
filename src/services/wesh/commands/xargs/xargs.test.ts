import { beforeEach, describe, expect, it } from 'vitest';
import { Wesh } from '@/services/wesh/index';
import { MockFileSystemDirectoryHandle } from '@/services/wesh/mocks/InMemoryFileSystem';
import {
  createTestReadHandleFromText,
  createTestWriteCaptureHandle,
} from '@/services/wesh/utils/test-stream';

describe('wesh xargs', () => {
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
    stdinText: string;
  }) {
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
    expect(invalid.result.exitCode).toBe(2);
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

  it('runs the command once on empty input unless -r is used', async () => {
    const { result, stdout, stderr } = await execute({
      script: 'xargs echo prefix',
      stdinText: ' \n\t\n',
    });

    expect(stdout.text).toBe('prefix\n');
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
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
    expect(elapsedMs).toBeLessThan(170);
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

    expect(withEmpty.stdout.text).toBe(`\
prefix alpha
prefix
prefix two words
`);
    expect(withEmpty.stderr.text).toBe('');
    expect(withEmpty.result.exitCode).toBe(0);
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

  it('supports custom delimiters with -d', async () => {
    const { result, stdout, stderr } = await execute({
      script: 'xargs -d , echo',
      stdinText: 'alpha,beta gamma,delta',
    });
    const escaped = await execute({
      script: 'xargs -d \\n echo',
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

    expect(withEmpty.stdout.text).toBe(`\
prefix one
prefix
prefix two
`);
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

    expect(standard.stdout.text).toBe('alpha\n');
    expect(standard.stderr.text).toBe('');
    expect(standard.result.exitCode).toBe(0);

    expect(ignoredWithDelimiter.stdout.text).toBe('alpha STOP beta\n');
    expect(ignoredWithDelimiter.stderr.text).toBe('');
    expect(ignoredWithDelimiter.result.exitCode).toBe(0);
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

  it('accepts attached short option values like -n1 and -s8', async () => {
    const batched = await execute({
      script: 'xargs -n1 echo prefix',
      stdinText: 'a b\n',
    });
    const sized = await execute({
      script: 'xargs -s8 echo',
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

  it('supports -s and -x to limit command size', async () => {
    const softLimit = await execute({
      script: 'xargs -s 8 echo',
      stdinText: 'abc defgh ij\n',
    });
    const hardLimit = await execute({
      script: 'xargs -s 8 -x echo',
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
    expect(hardLimit.stderr.text).toContain('xargs: argument list too long');
    expect(hardLimit.result.exitCode).toBe(1);
  });

  it('counts initial arguments toward --max-chars', async () => {
    const { result, stdout, stderr } = await execute({
      script: 'xargs -s 14 echo prefix',
      stdinText: 'alpha beta\n',
    });

    expect(stdout.text).toBe(`\
prefix alpha
prefix beta
`);
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
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
});
