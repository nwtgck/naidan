import { beforeEach, describe, expect, it } from 'vitest';
import { Wesh } from './index';
import { parseCommandLine, parseNextShellUnit } from './parser';
import { createTextShellSource } from './shell/source';
import { MockFileSystemDirectoryHandle } from './mocks/InMemoryFileSystem';
import {
  createTestReadHandleFromText,
  createTestWriteCaptureHandle,
} from './utils/test-stream';

describe('Wesh Bash-compatible here-documents', () => {
  let wesh: Wesh;

  beforeEach(async () => {
    const rootHandle = new MockFileSystemDirectoryHandle({ name: 'root' });
    wesh = new Wesh({
      rootHandle: rootHandle as unknown as FileSystemDirectoryHandle,
      initialEnv: { FOO: 'value' },
    });
    await wesh.init();
  });

  async function execute({ script }: { script: string }) {
    const stdout = createTestWriteCaptureHandle();
    const stderr = createTestWriteCaptureHandle();
    const result = await wesh.execute({
      source: createTextShellSource({ text: script }),
      stdin: createTestReadHandleFromText({ text: '' }),
      stdout: stdout.handle,
      stderr: stderr.handle,
    });
    return {
      stdout: stdout.text,
      stderr: stderr.text,
      exitCode: result.exitCode,
    };
  }

  it.each([
    {
      name: 'redirect after heredoc declaration',
      script: `\
cat <<'END' > result
<markup attr="foo">$FOO $(echo hi)</markup>
END
cat result`,
      stdout: '<markup attr="foo">$FOO $(echo hi)</markup>\n',
    },
    {
      name: 'redirect before heredoc declaration',
      script: `\
cat > result <<'END'
hello
END
cat result`,
      stdout: 'hello\n',
    },
    {
      name: 'additional command argument after delimiter',
      script: `\
cat <<END -
hello
END`,
      stdout: 'hello\n',
    },
    {
      name: 'multiple heredocs in one command, last stdin wins',
      script: `\
cat <<A <<B
ignored
A
used
B`,
      stdout: 'used\n',
    },
    {
      name: 'two heredocs separated by a semicolon',
      script: `\
cat <<A; cat <<B
one
A
two
B`,
      stdout: `\
one
two
`,
    },
    {
      name: 'two heredocs separated by and-and',
      script: `\
cat <<A && cat <<B
one
A
two
B`,
      stdout: `\
one
two
`,
    },
    {
      name: 'heredocs on each side of a pipeline',
      script: `\
cat <<A | cat <<B
ignored
A
used
B`,
      stdout: 'used\n',
    },
    {
      name: 'heredoc followed by a command on the same line',
      script: `\
cat <<A; printf next
first
A`,
      stdout: `\
first
next`,
    },
    {
      name: 'heredoc followed by a separate source line',
      script: `\
cat <<A
first
A
printf next`,
      stdout: `\
first
next`,
    },
    {
      name: 'heredoc before an inline comment',
      script: `\
cat <<A # comment after declaration
first
A`,
      stdout: 'first\n',
    },
    {
      name: 'empty heredoc is zero bytes',
      script: `\
cat <<A
A`,
      stdout: '',
    },
    {
      name: 'one blank body line is one newline',
      script: `\
cat <<A

A`,
      stdout: '\n',
    },
    {
      name: 'preserves multiple trailing empty lines',
      script: `\
cat <<A
one


A`,
      stdout: 'one\n\n\n',
    },
    {
      name: 'preserves tab indentation with plain heredoc',
      script: `\
cat <<A
	one
A`,
      stdout: '\tone\n',
    },
    {
      name: 'strips only leading tabs with <<-',
      script: `\
cat <<-A
		one
	 two
	A`,
      stdout: `\
one
 two
`,
    },
    {
      name: 'single quotes prevent all body expansion',
      script: `\
cat <<'A'
$FOO $(printf hi) $((2 + 3))
A`,
      stdout: '$FOO $(printf hi) $((2 + 3))\n',
    },
    {
      name: 'double quotes prevent all body expansion',
      script: `\
cat <<"A"
$FOO
A`,
      stdout: '$FOO\n',
    },
    {
      name: 'partially quoted delimiter prevents body expansion',
      script: `\
cat <<A'B'C
$FOO
ABC`,
      stdout: '$FOO\n',
    },
    {
      name: 'backslash-quoted delimiter prevents body expansion',
      script: `\
cat <<A\\B
$FOO
AB`,
      stdout: '$FOO\n',
    },
    {
      name: 'ANSI-C quoted delimiter is quote-removed',
      script: `\
cat <<$'E\\x4fF'
$FOO
EOF`,
      stdout: '$FOO\n',
    },
    {
      name: 'locale-quoted delimiter is quote-removed',
      script: `\
cat <<$"EOF"
$FOO
EOF`,
      stdout: '$FOO\n',
    },
    {
      name: 'double-quoted delimiter retains backslashes before ordinary letters',
      script: `\
cat <<"E\\Q"
$FOO
E\\Q`,
      stdout: '$FOO\n',
    },
    {
      name: 'empty quoted delimiter ends at an empty line',
      script: `\
cat <<''
hello

printf next`,
      stdout: `\
hello
next`,
    },
    {
      name: 'unquoted delimiter expands the body',
      script: `\
cat <<A
$FOO $(printf hi) $((2 + 3))
A`,
      stdout: 'value hi 5\n',
    },
    {
      name: 'unquoted body backslashes escape special characters',
      script: `\
cat <<A
\\$FOO \\` + '`' + ` \\\\ \\x
A`,
      stdout: '$FOO ` \\ \\x\n',
    },
    {
      name: 'unquoted body treats double quote literally',
      script: `\
cat <<A
"$FOO"
A`,
      stdout: '"value"\n',
    },
    {
      name: 'unquoted backslash-newline joins body lines',
      script: `\
cat <<A
one\\
two
A`,
      stdout: 'onetwo\n',
    },
    {
      name: 'unquoted backslash-newline joins delimiter itself',
      script: `\
cat <<EOF
EO\\
F
printf next`,
      stdout: 'next',
    },
    {
      name: 'quoted backslash-newline remains literal',
      script: `\
cat <<'A'
one\\
two
A`,
      stdout: 'one\\\ntwo\n',
    },
    {
      name: 'a line with trailing whitespace is not the delimiter',
      script: `\
cat <<A
A${' '}
A`,
      stdout: 'A \n',
    },
    {
      name: 'a line with leading spaces is not the delimiter',
      script: `\
cat <<A
 A
A`,
      stdout: ' A\n',
    },
    {
      name: 'explicit input FD works with heredoc',
      script: `\
cat 0<<A
hello
A`,
      stdout: 'hello\n',
    },
    {
      name: 'input FD can be duplicated after a heredoc',
      script: `\
cat 3<<A 0<&3
hello
A`,
      stdout: 'hello\n',
    },
    {
      name: 'CRLF heredoc delimiter and body are preserved',
      script: ['cat <<A', 'hello', 'A', ''].join('\r\n'),
      stdout: 'hello\r\n',
    },
    {
      name: 'quoted CRLF heredoc preserves literal body',
      script: ["cat <<'A'", '$FOO', 'A', ''].join('\r\n'),
      stdout: '$FOO\r\n',
    },
    {
      name: 'even trailing backslashes do not continue the line',
      script: `\
cat <<A
one\\\\
two
A`,
      stdout: 'one\\\ntwo\n',
    },
    {
      name: 'odd trailing backslashes continue after the escaped pair',
      script: `\
cat <<A
one\\\\\\
two
A`,
      stdout: 'one\\two\n',
    },
    {
      name: 'a skipped conditional still consumes the heredoc body',
      script: `\
false && cat <<A
ignored
A
printf done`,
      stdout: 'done',
    },
    {
      name: 'heredoc body can occur in a brace group',
      script: `\
{ cat <<A; }
hello
A`,
      stdout: 'hello\n',
    },
    {
      name: 'heredoc body is opaque inside command substitution',
      script: `\
printf '<%s>' "$(cat <<A
)
A
)"`,
      stdout: '<)>',
    },
  ])('$name', async ({ script, stdout }) => {
    const result = await execute({ script });
    expect(result).toEqual({ stdout, stderr: '', exitCode: 0 });
  });

  it('preserves left-to-right stdin redirection precedence', async () => {
    const written = await execute({ script: "printf 'file content' > input" });
    expect(written.exitCode).toBe(0);

    const fromFile = await execute({
      script: `\
cat <<A < input
ignored
A`,
    });
    expect(fromFile.stdout).toBe('file content');
    expect(fromFile.stderr).toBe('');
    expect(fromFile.exitCode).toBe(0);

    const fromHereDoc = await execute({
      script: `\
cat < input <<A
used
A`,
    });
    expect(fromHereDoc.stdout).toBe('used\n');
    expect(fromHereDoc.stderr).toBe('');
    expect(fromHereDoc.exitCode).toBe(0);
  });

  it('attaches pending bodies to the right AST redirections', () => {
    const commandLine = `\
cat <<A <<-B > out
first
A
	second
	B
printf next`;
    const parsed = parseNextShellUnit({
      commandLine,
      env: new Map(),
      sourceCompletion: 'complete',
    });
    expect(parsed.kind).toBe('parsed');
    if (parsed.kind !== 'parsed') return;
    expect(parsed.consumedCharacters).toBe(commandLine.indexOf('printf next'));
    expect(parsed.node.kind).toBe('command');
    if (parsed.node.kind !== 'command') return;
    expect(parsed.node.redirections).toEqual([
      { fd: 0, type: 'heredoc', target: 'A', contentExpansion: 'variables', content: 'first\n' },
      { fd: 0, type: 'heredoc', target: 'B', contentExpansion: 'variables', content: 'second\n' },
      { fd: 1, type: 'write', target: 'out' },
    ]);
  });

  it('attaches heredocs in full-script parsing too', () => {
    const parsed = parseCommandLine({
      commandLine: `\
cat <<A; cat <<'B'
first
A
$FOO
B`,
      env: new Map(),
    });
    expect(parsed.kind).toBe('list');
    if (parsed.kind !== 'list') return;
    expect(parsed.parts).toHaveLength(2);
    const first = parsed.parts[0]?.node;
    const second = parsed.parts[1]?.node;
    expect(first?.kind).toBe('command');
    expect(second?.kind).toBe('command');
    if (first?.kind !== 'command' || second?.kind !== 'command') return;
    expect(first.redirections[0]?.content).toBe('first\n');
    expect(second.redirections[0]?.content).toBe('$FOO\n');
  });

  it('waits for all pending bodies when the source can continue', () => {
    const script = `\
cat <<A <<B
first
A
second`;
    expect(parseNextShellUnit({
      commandLine: script,
      env: new Map(),
      sourceCompletion: 'may-continue',
    })).toEqual({ kind: 'needs-more-source' });
    const complete = parseNextShellUnit({
      commandLine: `${script}\nB\n`,
      env: new Map(),
      sourceCompletion: 'may-continue',
    });
    expect(complete.kind).toBe('parsed');
  });

  it('handles heredocs larger than the kernel pipe buffer without blocking', async () => {
    const body = 'x'.repeat(64 * 1024 + 1);
    const result = await execute({
      script: `\
cat <<'END'
${body}
END`,
    });
    expect(result).toEqual({ stdout: `${body}\n`, stderr: '', exitCode: 0 });
  });

  it('handles a source delivered in chunks across redirection and delimiter tokens', async () => {
    const pieces = [
      'cat <', '<', "'EOF' > ", `\
output
line`, '\nEOF\n', 'cat output',
    ];
    let cursor = 0;
    const stdout = createTestWriteCaptureHandle();
    const stderr = createTestWriteCaptureHandle();
    const result = await wesh.execute({
      source: {
        kind: 'bytes',
        async read(): Promise<Uint8Array | undefined> {
          const piece = pieces[cursor];
          cursor += 1;
          return piece === undefined ? undefined : new TextEncoder().encode(piece);
        },
      },
      stdin: createTestReadHandleFromText({ text: '' }),
      stdout: stdout.handle,
      stderr: stderr.handle,
    });
    expect(stdout.text).toBe('line\n');
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
  });

  it.each([
    {
      name: 'unterminated heredoc with no body',
      script: 'cat <<EOF',
      stdout: '',
    },
    {
      name: 'unterminated heredoc with a complete body line',
      script: `\
cat <<EOF
hello
`,
      stdout: 'hello\n',
    },
    {
      name: 'unterminated heredoc with a final line lacking newline',
      script: `\
cat <<EOF
hello`,
      stdout: 'hello\n',
    },
    {
      name: 'unterminated heredoc with a trailing continuation',
      script: `\
cat <<EOF
hello\\
`,
      stdout: 'hello\n',
    },
  ])('$name produces a Bash-style warning when source ends', async ({ script, stdout }) => {
    const result = await execute({ script });
    expect(result.stdout).toBe(stdout);
    expect(result.stderr).toBe("wesh: warning: here-document delimited by end-of-file (wanted `EOF')\n");
    expect(result.exitCode).toBe(0);
  });
});
