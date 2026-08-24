import { beforeEach, describe, expect, it } from 'vitest';
import { Wesh } from './index';
import { MockFileSystemDirectoryHandle } from './mocks/InMemoryFileSystem';
import { createHandleShellSource, createTextShellSource } from './shell/source';
import {
  createTestReadHandleFromBytes,
  createTestReadHandleFromText,
  createTestWriteCaptureHandle,
} from './utils/test-stream';

describe('Wesh shell compatibility', () => {
  let wesh: Wesh;

  beforeEach(async () => {
    const rootHandle = new MockFileSystemDirectoryHandle({ name: 'root' });
    wesh = new Wesh({ rootHandle: rootHandle as unknown as FileSystemDirectoryHandle });
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
    return { result, stdout, stderr };
  }

  it('does not emit interactive job notifications for non-interactive execution', async () => {
    const { result, stdout, stderr } = await execute({
      script: `\
true &
wait
`,
    });

    expect(result.exitCode).toBe(0);
    expect(stdout.text).toBe('');
    expect(stderr.text).toBe('');
  });

  it('reports shell-source read failures as execution errors', async () => {
    const stdout = createTestWriteCaptureHandle();
    const stderr = createTestWriteCaptureHandle();
    const result = await wesh.execute({
      source: {
        kind: 'bytes',
        async read({ maximumBytes: _maximumBytes }: {
          maximumBytes: number,
        }): Promise<Uint8Array | undefined> {
          throw new Error('source read failed');
        },
      },
      stdin: createTestReadHandleFromText({ text: '' }),
      stdout: stdout.handle,
      stderr: stderr.handle,
    });

    expect(result.exitCode).toBe(1);
    expect(stdout.text).toBe('');
    expect(stderr.text).toBe('wesh: source read failed\n');
  });

  it('executes a complete byte-backed unit before the following source chunk is available', async () => {
    const stdout = createTestWriteCaptureHandle();
    const stderr = createTestWriteCaptureHandle();
    const encoder = new TextEncoder();
    let readCount = 0;
    let releaseSecondRead: (() => void) | undefined;
    let reportSecondReadStarted: (() => void) | undefined;
    const secondReadGate = new Promise<void>((resolve) => {
      releaseSecondRead = resolve;
    });
    const secondReadStarted = new Promise<void>((resolve) => {
      reportSecondReadStarted = resolve;
    });

    const execution = wesh.execute({
      source: {
        kind: 'bytes',
        async read({ maximumBytes: _maximumBytes }: {
          maximumBytes: number,
        }): Promise<Uint8Array | undefined> {
          readCount += 1;
          if (readCount === 1) {
            return encoder.encode("printf 'first\\n'\n");
          }
          if (readCount === 2) {
            reportSecondReadStarted?.();
            await secondReadGate;
            return encoder.encode(`\
printf 'second\\n'
`);
          }
          return undefined;
        },
      },
      stdin: createTestReadHandleFromText({ text: '' }),
      stdout: stdout.handle,
      stderr: stderr.handle,
    });

    await secondReadStarted;
    expect(stdout.text).toBe('first\n');
    expect(stderr.text).toBe('');

    releaseSecondRead?.();
    const result = await execution;
    expect(result.exitCode).toBe(0);
    expect(stdout.text).toBe(`\
first
second
`);
    expect(stderr.text).toBe('');
  });

  it('waits for more byte-backed source when the current unit is syntactically incomplete', async () => {
    const stdout = createTestWriteCaptureHandle();
    const stderr = createTestWriteCaptureHandle();
    const encoder = new TextEncoder();
    let readCount = 0;
    let releaseSecondRead: (() => void) | undefined;
    let reportSecondReadStarted: (() => void) | undefined;
    const secondReadGate = new Promise<void>((resolve) => {
      releaseSecondRead = resolve;
    });
    const secondReadStarted = new Promise<void>((resolve) => {
      reportSecondReadStarted = resolve;
    });

    const execution = wesh.execute({
      source: {
        kind: 'bytes',
        async read({ maximumBytes: _maximumBytes }: {
          maximumBytes: number,
        }): Promise<Uint8Array | undefined> {
          readCount += 1;
          if (readCount === 1) {
            return encoder.encode("printf '%s\\n' 'hel");
          }
          if (readCount === 2) {
            reportSecondReadStarted?.();
            await secondReadGate;
            return encoder.encode("lo'\n");
          }
          return undefined;
        },
      },
      stdin: createTestReadHandleFromText({ text: '' }),
      stdout: stdout.handle,
      stderr: stderr.handle,
    });

    await secondReadStarted;
    expect(stdout.text).toBe('');
    expect(stderr.text).toBe('');

    releaseSecondRead?.();
    const result = await execution;
    expect(result.exitCode).toBe(0);
    expect(stdout.text).toBe('hello\n');
    expect(stderr.text).toBe('');
  });

  it('waits for true end of a byte-backed source before executing a unit without a newline', async () => {
    const stdout = createTestWriteCaptureHandle();
    const stderr = createTestWriteCaptureHandle();
    const encoder = new TextEncoder();
    let readCount = 0;
    let releaseEndOfSource: (() => void) | undefined;
    let reportEndReadStarted: (() => void) | undefined;
    const endOfSourceGate = new Promise<void>((resolve) => {
      releaseEndOfSource = resolve;
    });
    const endReadStarted = new Promise<void>((resolve) => {
      reportEndReadStarted = resolve;
    });

    const execution = wesh.execute({
      source: {
        kind: 'bytes',
        async read({ maximumBytes: _maximumBytes }: {
          maximumBytes: number,
        }): Promise<Uint8Array | undefined> {
          readCount += 1;
          if (readCount === 1) {
            return encoder.encode("printf 'done\\n'");
          }
          reportEndReadStarted?.();
          await endOfSourceGate;
          return undefined;
        },
      },
      stdin: createTestReadHandleFromText({ text: '' }),
      stdout: stdout.handle,
      stderr: stderr.handle,
    });

    await endReadStarted;
    expect(stdout.text).toBe('');
    expect(stderr.text).toBe('');

    releaseEndOfSource?.();
    const result = await execution;
    expect(result.exitCode).toBe(0);
    expect(stdout.text).toBe('done\n');
    expect(stderr.text).toBe('');
  });

  it('waits for the rest of compound, and-or, and heredoc units before executing them', async () => {
    const cases = [
      {
        firstChunk: `\
if true; then
printf 'inside\\n'
`,
        secondChunk: "fi\n",
        expectedBeforeSecond: '',
        expectedFinal: 'inside\n',
      },
      {
        firstChunk: "printf 'left\\n' &&",
        secondChunk: " printf 'right\\n'\n",
        expectedBeforeSecond: '',
        expectedFinal: `\
left
right
`,
      },
      {
        firstChunk: "printf 'before\\n'\ncat <<EOF\n",
        secondChunk: `\
BODY
EOF
printf 'after\\n'
`,
        expectedBeforeSecond: 'before\n',
        expectedFinal: `\
before
BODY
after
`,
      },
    ] as const;

    for (const testCase of cases) {
      const stdout = createTestWriteCaptureHandle();
      const stderr = createTestWriteCaptureHandle();
      const encoder = new TextEncoder();
      let readCount = 0;
      let releaseSecondRead: (() => void) | undefined;
      let reportSecondReadStarted: (() => void) | undefined;
      const secondReadGate = new Promise<void>((resolve) => {
        releaseSecondRead = resolve;
      });
      const secondReadStarted = new Promise<void>((resolve) => {
        reportSecondReadStarted = resolve;
      });

      const execution = wesh.execute({
        source: {
          kind: 'bytes',
          async read({ maximumBytes: _maximumBytes }: {
            maximumBytes: number,
          }): Promise<Uint8Array | undefined> {
            readCount += 1;
            if (readCount === 1) {
              return encoder.encode(testCase.firstChunk);
            }
            if (readCount === 2) {
              reportSecondReadStarted?.();
              await secondReadGate;
              return encoder.encode(testCase.secondChunk);
            }
            return undefined;
          },
        },
        stdin: createTestReadHandleFromText({ text: '' }),
        stdout: stdout.handle,
        stderr: stderr.handle,
      });

      await secondReadStarted;
      expect(stdout.text).toBe(testCase.expectedBeforeSecond);
      expect(stderr.text).toBe('');

      releaseSecondRead?.();
      const result = await execution;
      expect(result.exitCode).toBe(0);
      expect(stdout.text).toBe(testCase.expectedFinal);
      expect(stderr.text).toBe('');
    }
  });

  it('reports a hard syntax error without waiting for another byte-backed source chunk', async () => {
    const stdout = createTestWriteCaptureHandle();
    const stderr = createTestWriteCaptureHandle();
    const encoder = new TextEncoder();
    let readCount = 0;

    const result = await wesh.execute({
      source: {
        kind: 'bytes',
        async read({ maximumBytes: _maximumBytes }: {
          maximumBytes: number,
        }): Promise<Uint8Array | undefined> {
          readCount += 1;
          if (readCount === 1) {
            return encoder.encode(')\n');
          }
          throw new Error('unexpected additional source read');
        },
      },
      stdin: createTestReadHandleFromText({ text: '' }),
      stdout: stdout.handle,
      stderr: stderr.handle,
    });

    expect(result.exitCode).toBe(2);
    expect(readCount).toBe(1);
    expect(stdout.text).toBe('');
    expect(stderr.text).not.toContain('unexpected additional source read');
  });

  it('lets a command consume bytes already retained from the same shell source', async () => {
    const stdout = createTestWriteCaptureHandle();
    const stderr = createTestWriteCaptureHandle();
    const handle = createTestReadHandleFromText({
      text: `\
IFS= read -r value
PAYLOAD
printf '<%s>\\n' "$value"
printf 'AFTER\\n'
`,
    });

    const result = await wesh.execute({
      source: createHandleShellSource({ handle }),
      stdin: handle,
      stdout: stdout.handle,
      stderr: stderr.handle,
    });

    expect(result.exitCode).toBe(0);
    expect(stdout.text).toBe(`\
<PAYLOAD>
AFTER
`);
    expect(stderr.text).toBe('');
  });

  it('lets bash -s builtins consume future commands from the shared stdin source', async () => {
    const result = await execute({
      script: `\
printf '%s\\n' 'IFS= read -r value' 'PAYLOAD' 'printf "<%s>\\n" "$value"' 'printf "AFTER\\n"' | bash -s
`,
    });

    expect(result.result.exitCode).toBe(0);
    expect(result.stdout.text).toBe(`\
<PAYLOAD>
AFTER
`);
    expect(result.stderr.text).toBe('');
  });

  it('lets a command drain the remaining shared shell source through stdin', async () => {
    const stdout = createTestWriteCaptureHandle();
    const stderr = createTestWriteCaptureHandle();
    const handle = createTestReadHandleFromText({
      text: `\
cat
printf 'AFTER\\n'
`,
    });

    const result = await wesh.execute({
      source: createHandleShellSource({ handle }),
      stdin: handle,
      stdout: stdout.handle,
      stderr: stderr.handle,
    });

    expect(result.exitCode).toBe(0);
    expect(stdout.text).toBe("printf 'AFTER\\n'\n");
    expect(stderr.text).toBe('');
  });


  it('preserves invalid UTF-8 bytes when a command drains the shared shell source', async () => {
    const stdout = createTestWriteCaptureHandle();
    const stderr = createTestWriteCaptureHandle();
    const command = new TextEncoder().encode('cat\n');
    const bytes = new Uint8Array(command.length + 3);
    bytes.set(command, 0);
    bytes.set([0xff, 0xfe, 0x0a], command.length);
    const handle = createTestReadHandleFromBytes({ bytes });

    const result = await wesh.execute({
      source: createHandleShellSource({ handle }),
      stdin: handle,
      stdout: stdout.handle,
      stderr: stderr.handle,
    });

    expect(result.exitCode).toBe(0);
    expect([...stdout.buffer]).toEqual([0xff, 0xfe, 0x0a]);
    expect(stderr.text).toBe('');
  });

  it('preserves invalid UTF-8 bytes embedded in single-quoted shell words', async () => {
    for (const invalidBytes of [
      Uint8Array.of(0xff),
      Uint8Array.of(0xc3, 0xff),
    ]) {
      const prefix = new TextEncoder().encode("printf '%s' '");
      const suffix = new TextEncoder().encode("'\n");
      const sourceBytes = new Uint8Array(prefix.length + invalidBytes.length + suffix.length);
      sourceBytes.set(prefix, 0);
      sourceBytes.set(invalidBytes, prefix.length);
      sourceBytes.set(suffix, prefix.length + invalidBytes.length);
      let emitted = false;
      const stdout = createTestWriteCaptureHandle();
      const stderr = createTestWriteCaptureHandle();

      const result = await wesh.execute({
        source: {
          kind: 'bytes',
          async read() {
            if (emitted) {
              return undefined;
            }
            emitted = true;
            return sourceBytes;
          },
        },
        stdin: createTestReadHandleFromText({ text: '' }),
        stdout: stdout.handle,
        stderr: stderr.handle,
      });

      expect(result.exitCode).toBe(0);
      expect([...stdout.buffer]).toEqual([...invalidBytes]);
      expect(stderr.text).toBe('');
    }
  });



  it('preserves every non-NUL raw source byte except the single-quote delimiter', async () => {
    const testedBytes = Array.from({ length: 0xff }, (_, index) => index + 1)
      .filter((byte) => byte !== 0x27);
    const prefix = new TextEncoder().encode("printf '%s' '");
    const suffix = new TextEncoder().encode("'\n");
    const sourceBytes = new Uint8Array(
      testedBytes.length * (prefix.length + 1 + suffix.length),
    );
    let sourceOffset = 0;
    for (const byte of testedBytes) {
      sourceBytes.set(prefix, sourceOffset);
      sourceOffset += prefix.length;
      sourceBytes[sourceOffset] = byte;
      sourceOffset += 1;
      sourceBytes.set(suffix, sourceOffset);
      sourceOffset += suffix.length;
    }
    let emitted = false;
    const stdout = createTestWriteCaptureHandle();
    const stderr = createTestWriteCaptureHandle();

    const result = await wesh.execute({
      source: {
        kind: 'bytes',
        async read() {
          if (emitted) {
            return undefined;
          }
          emitted = true;
          return sourceBytes;
        },
      },
      stdin: createTestReadHandleFromText({ text: '' }),
      stdout: stdout.handle,
      stderr: stderr.handle,
    });

    expect(result.exitCode).toBe(0);
    expect([...stdout.buffer]).toEqual(testedBytes);
    expect(stderr.text).toBe('');
  });

  it('preserves invalid source bytes through here-string redirection', async () => {
    const invalidBytes = Uint8Array.of(0xc3, 0xff);
    const prefix = new TextEncoder().encode("value='");
    const suffix = new TextEncoder().encode(`'
cat <<< "$value"
`);
    const sourceBytes = new Uint8Array(prefix.length + invalidBytes.length + suffix.length);
    sourceBytes.set(prefix, 0);
    sourceBytes.set(invalidBytes, prefix.length);
    sourceBytes.set(suffix, prefix.length + invalidBytes.length);
    let emitted = false;
    const source = {
      kind: 'bytes' as const,
      async read() {
        if (emitted) return undefined;
        emitted = true;
        return sourceBytes;
      },
    };
    const stdout = createTestWriteCaptureHandle();
    const stderr = createTestWriteCaptureHandle();

    const result = await wesh.execute({
      source,
      stdin: createTestReadHandleFromText({ text: '' }),
      stdout: stdout.handle,
      stderr: stderr.handle,
    });

    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
    expect([...stdout.buffer]).toEqual([...invalidBytes, 0x0a]);
  });

  it('preserves invalid source bytes through command substitution and variable expansion', async () => {
    const invalidBytes = Uint8Array.of(0xc3, 0xff);
    const prefix = new TextEncoder().encode("value=$(printf '%s' '");
    const suffix = new TextEncoder().encode(`\
')
printf '%s' "$value"
`);
    const sourceBytes = new Uint8Array(prefix.length + invalidBytes.length + suffix.length);
    sourceBytes.set(prefix, 0);
    sourceBytes.set(invalidBytes, prefix.length);
    sourceBytes.set(suffix, prefix.length + invalidBytes.length);
    let emitted = false;
    const stdout = createTestWriteCaptureHandle();
    const stderr = createTestWriteCaptureHandle();

    const result = await wesh.execute({
      source: {
        kind: 'bytes',
        async read() {
          if (emitted) {
            return undefined;
          }
          emitted = true;
          return sourceBytes;
        },
      },
      stdin: createTestReadHandleFromText({ text: '' }),
      stdout: stdout.handle,
      stderr: stderr.handle,
    });

    expect(result.exitCode).toBe(0);
    expect([...stdout.buffer]).toEqual([...invalidBytes]);
    expect(stderr.text).toBe('');
  });

  it('keeps a valid replacement character distinct from raw invalid bytes', async () => {
    const stdout = createTestWriteCaptureHandle();
    const stderr = createTestWriteCaptureHandle();
    const sourceBytes = new TextEncoder().encode("printf '%s' '�'\n");
    let emitted = false;

    const result = await wesh.execute({
      source: {
        kind: 'bytes',
        async read() {
          if (emitted) {
            return undefined;
          }
          emitted = true;
          return sourceBytes;
        },
      },
      stdin: createTestReadHandleFromText({ text: '' }),
      stdout: stdout.handle,
      stderr: stderr.handle,
    });

    expect(result.exitCode).toBe(0);
    expect([...stdout.buffer]).toEqual([0xef, 0xbf, 0xbd]);
    expect(stderr.text).toBe('');
  });

  it('keeps assignment status zero when a default operand is not evaluated', async () => {
    const result = await execute({
      script: `\
x=set
y=\${x:-$(false)}
printf '%s\n' "$?"
`,
    });

    expect(result.result.exitCode).toBe(0);
    expect(result.stdout.text).toBe('0\n');
    expect(result.stderr.text).toBe('');
  });

  it('keeps assignment status zero when an alternate operand is not evaluated', async () => {
    const result = await execute({
      script: `\
unset x
y=\${x:+$(false)}
printf '%s\n' "$?"
`,
    });

    expect(result.result.exitCode).toBe(0);
    expect(result.stdout.text).toBe('0\n');
    expect(result.stderr.text).toBe('');
  });

  it('supports legacy backquote command substitution and escape processing', async () => {
    const result = await execute({ script: `\
value=\`printf 'alpha\\n'\`
printf 'basic:<%s>\\n' "$value"
printf 'quoted:<%s>\\n' "\`printf 'a b'\`"
HOME=/tmp/backquote-home
printf 'dollar:<%s>\\n' \`printf '%s' \\$HOME\`
` });

    expect(result.stdout.text).toBe(`\
basic:<alpha>
quoted:<a b>
dollar:</tmp/backquote-home>
`);
    expect(result.stderr.text).toBe('');
    expect(result.result.exitCode).toBe(0);
  });

  it('uses the last command substitution status for an assignment-only command', async () => {
    const result = await execute({
      script: `\
a=$(true) b=$(false)
printf '%s\n' "$?"
`,
    });

    expect(result.result.exitCode).toBe(0);
    expect(result.stdout.text).toBe('1\n');
    expect(result.stderr.text).toBe('');
  });

  it('expands the prior command status inside a plain assignment', async () => {
    const result = await execute({
      script: `\
false
status=$?
printf '%s\n' "$status"
`,
    });

    expect(result.result.exitCode).toBe(0);
    expect(result.stdout.text).toBe('1\n');
    expect(result.stderr.text).toBe('');
  });

  it('executes a single-line brace group in the current shell', async () => {
    const result = await execute({
      script: `\
{ printf 'first\\n'; printf 'second\\n'; }
`,
    });

    expect(result.result.exitCode).toBe(0);
    expect(result.stdout.text).toBe(`\
first
second
`);
    expect(result.stderr.text).toBe('');
  });

  it('executes a multiline brace group as one complete shell unit', async () => {
    const result = await execute({
      script: `\
{
  printf 'first\\n'
  printf 'second\\n'
}
`,
    });

    expect(result.result.exitCode).toBe(0);
    expect(result.stdout.text).toBe(`\
first
second
`);
    expect(result.stderr.text).toBe('');
  });

  it('executes a script path through its handle-backed shell source', async () => {
    const result = await execute({
      script: `\
printf '%s\\n' '#!/bin/bash' 'printf "FILE-SOURCE\\n"' > /script.sh
bash /script.sh
`,
    });

    expect(result.result.exitCode).toBe(0);
    expect(result.stdout.text).toBe('FILE-SOURCE\n');
    expect(result.stderr.text).toBe('');
  });

  it('executes bash without a script path from its stdin-backed shell source', async () => {
    const result = await execute({
      script: `\
printf 'echo from-default-stdin\n' | bash
`,
    });

    expect(result.result.exitCode).toBe(0);
    expect(result.stdout.text).toBe('from-default-stdin\n');
    expect(result.stderr.text).toBe('');
  });

  it('executes bash -s from its stdin-backed shell source', async () => {
    const result = await execute({
      script: `\
printf 'echo from-stdin\n' | bash -s
`,
    });

    expect(result.result.exitCode).toBe(0);
    expect(result.stdout.text).toBe('from-stdin\n');
    expect(result.stderr.text).toBe('');
  });

  it('sources shell state and function definitions into the current shell', async () => {
    const result = await execute({
      script: `\
printf '%s\n' 'VALUE=loaded' 'loaded_function() { printf "function:%s\n" "$VALUE"; }' > /library.sh
. /library.sh
printf 'value:%s\n' "$VALUE"
loaded_function
`,
    });

    expect(result.result.exitCode).toBe(0);
    expect(result.stdout.text).toBe(`\
value:loaded
function:loaded
`);
    expect(result.stderr.text).toBe('');
  });

  it('temporarily replaces positional arguments while sourcing explicit arguments', async () => {
    const result = await execute({
      script: `\
printf '%s\n' 'printf "source:<%s>|<%s>\n" "$1" "$2"' 'return 7' > /args.sh
set -- parent
source /args.sh alpha 'beta gamma'
printf 'parent:<%s>|status:<%s>\n' "$1" "$?"
`,
    });

    expect(result.result.exitCode).toBe(0);
    expect(result.stdout.text).toBe(`\
source:<alpha>|<beta gamma>
parent:<parent>|status:<7>
`);
    expect(result.stderr.text).toBe('');
  });

  it('returns status 1 when a sourced file cannot be opened', async () => {
    const result = await execute({
      script: `\
source /missing.sh
printf '%s\n' "$?"
`,
    });

    expect(result.result.exitCode).toBe(0);
    expect(result.stdout.text).toBe('1\n');
    expect(result.stderr.text).not.toBe('');
  });

  it('propagates exit from a sourced file to the current shell', async () => {
    const result = await execute({
      script: `\
printf '%s\n' 'exit 4' > /exit.sh
source /exit.sh
printf 'unreachable\n'
`,
    });

    expect(result.result.exitCode).toBe(4);
    expect(result.stdout.text).toBe('');
    expect(result.stderr.text).toBe('');
  });

  it('ignores unquoted shell comments at token boundaries', async () => {
    const result = await execute({
      script: `\
echo before
# prepare the next step (punctuation such as ; && | is comment text)
echo after # trailing comment
`,
    });

    expect(result.stdout.text).toBe(`\
before
after
`);
    expect(result.stderr.text).toBe('');
    expect(result.result.exitCode).toBe(0);
  });


  it('stops the current shell when exit is executed', async () => {
    const result = await execute({
      script: `\
printf 'before\n'
exit 9
printf 'after\n'
`,
    });

    expect(result.stdout.text).toBe('before\n');
    expect(result.stderr.text).toBe('');
    expect(result.result.exitCode).toBe(9);
  });

  it('propagates exit through functions and conditional commands', async () => {
    const scripts = [
      `\
f() {
  exit 6
  printf 'after-function\n'
}
f
printf 'after-call\n'
`,
      `\
if exit 5; then
  printf 'then\n'
fi
printf 'after-if\n'
`,
    ];
    const expectedExitCodes = [6, 5];

    for (let index = 0; index < scripts.length; index++) {
      const script = scripts[index];
      const expectedExitCode = expectedExitCodes[index];
      if (script === undefined || expectedExitCode === undefined) {
        throw new Error('Missing shell exit regression fixture');
      }
      const result = await execute({ script });
      expect(result.stdout.text).toBe('');
      expect(result.stderr.text).toBe('');
      expect(result.result.exitCode).toBe(expectedExitCode);
    }
  });

  it('keeps exit in a child shell from terminating its caller', async () => {
    const result = await execute({
      script: `\
bash -c 'exit 7'
printf 'status=%s\n' "$?"
`,
    });

    expect(result.stdout.text).toBe('status=7\n');
    expect(result.stderr.text).toBe('');
    expect(result.result.exitCode).toBe(0);
  });

  it('publishes and waits for an output process-substitution child that exits', async () => {
    const result = await execute({
      script: `\
true > >(exit 9)
pid=$!
if [ -n "$pid" ]; then printf 'pid=set\n'; else printf 'pid=unset\n'; fi
wait "$pid"
printf 'wait=%s\n' "$?"
`,
    });

    expect(result.stdout.text).toBe(`\
pid=set
wait=9
`);
    expect(result.stderr.text).toBe('');
    expect(result.result.exitCode).toBe(0);
  });

  it('uses the shell syntax-error status for rejected root syntax', async () => {
    const scripts = [
      `printf 'alpha\n' |`,
      `if true; then printf 'alpha\n'`,
      `printf 'before\n' )`,
    ];

    for (const script of scripts) {
      const result = await execute({ script });
      expect(result.stdout.text).toBe('');
      expect(result.stderr.text).not.toBe('');
      expect(result.result.exitCode).toBe(2);
    }
  });

  it('executes completed top-level units before parsing a later invalid unit', async () => {
    const result = await execute({
      script: `\
printf 'before\n'
printf '%s\n' 'unfinished
`,
    });

    expect(result.stdout.text).toBe('before\n');
    expect(result.stderr.text).not.toBe('');
    expect(result.result.exitCode).toBe(2);
  });

  it('treats newline after a same-line semicolon as a top-level unit boundary', async () => {
    const result = await execute({
      script: `\
printf 'before\n';
printf '%s\n' 'unfinished
`,
    });

    expect(result.stdout.text).toBe('before\n');
    expect(result.stderr.text).not.toBe('');
    expect(result.result.exitCode).toBe(2);
  });

  it('does not execute an incomplete compound or and-or unit before its syntax is committed', async () => {
    const scripts = [
      `\
if true; then
  printf 'before\n'
  printf '%s\n' 'unfinished
`,
      `\
printf 'before\n' &&
printf '%s\n' 'unfinished
`,
    ];

    for (const script of scripts) {
      const result = await execute({ script });
      expect(result.stdout.text).toBe('');
      expect(result.stderr.text).not.toBe('');
      expect(result.result.exitCode).toBe(2);
    }
  });

  it('preserves shell exit control flow through eval', async () => {
    const result = await execute({
      script: `\
eval 'exit 7'
printf 'unreachable\n'
`,
    });

    expect(result.stdout.text).toBe('');
    expect(result.stderr.text).toBe('');
    expect(result.result.exitCode).toBe(7);
  });

  it('restores the caller after a later syntax error in eval source', async () => {
    const result = await execute({
      script: `\
eval "printf 'nested-before\n'
if"
printf 'status:%s\n' "$?"
`,
    });

    expect(result.stdout.text).toBe(`\
nested-before
status:2
`);
    expect(result.stderr.text).not.toBe('');
    expect(result.result.exitCode).toBe(0);
  });

  it('rejects incomplete quotes and substitutions with shell syntax status', async () => {
    const scripts = [
      `printf '%s\n' 'unfinished`,
      `printf '%s\n' "unfinished`,
      `printf '%s\n' "$(printf value"`,
      `printf '%s\n' "$((1 + 2)"`,
      `printf before &&`,
      `printf before ||`,
    ];

    for (const script of scripts) {
      const result = await execute({ script });
      expect(result.stdout.text).toBe('');
      expect(result.stderr.text).not.toBe('');
      expect(result.result.exitCode).toBe(2);
    }
  });

  it('preserves escaped shell metacharacters without expanding them', async () => {
    const result = await execute({
      script: `\
VALUE=expanded
printf '%s\\n' "\\$VALUE" \\$VALUE \\*`,
    });

    expect(result.stdout.text).toBe(`\
$VALUE
$VALUE
*
`);
    expect(result.stderr.text).toBe('');
    expect(result.result.exitCode).toBe(0);
  });

  it('removes backslash-newline continuations in unquoted and double-quoted words', async () => {
    const result = await execute({
      script: `\
printf '%s\\n' hel\\
lo "wor\\
ld"`,
    });

    expect(result.stdout.text).toBe(`\
hello
world
`);
    expect(result.stderr.text).toBe('');
    expect(result.result.exitCode).toBe(0);
  });

  it('accepts redirection-only simple commands', async () => {
    const result = await execute({
      script: `\
> output
printf 'status:%s\\n' "$?"
`,
    });

    expect(result.stdout.text).toBe('status:0\n');
    expect(result.stderr.text).toBe('');
    expect(result.result.exitCode).toBe(0);
  });

  it('keeps command-local descriptor closure from closing the caller output', async () => {
    const result = await execute({
      script: `\
printf hidden >&-
{ printf hidden-group; } >&-
printf after
`,
    });

    expect(result.stdout.text).toBe('after');
    expect(result.result.exitCode).toBe(0);
  });

  it('applies descriptor close and duplication left to right', async () => {
    const result = await execute({
      script: `\
printf restored 3>&1 1>&- 1>&3
{ printf restored-group; } 3>&1 1>&- 1>&3
printf after
`,
    });

    expect(result.stdout.text).toBe('restoredrestored-groupafter');
    expect(result.stderr.text).toBe('');
    expect(result.result.exitCode).toBe(0);
  });

  it('cleans up partial redirections without closing the caller output', async () => {
    const result = await execute({
      script: `\
printf hidden > partial 1>&9
printf 'status:%s\\n' "$?"
printf '<'
cat partial
printf '>'
`,
    });

    expect(result.stdout.text).toBe(`\
status:1
<>`);
    expect(result.stderr.text).toContain('bad file descriptor');
    expect(result.result.exitCode).toBe(0);
  });

  it('cleans up partial compound-command redirections', async () => {
    const result = await execute({
      script: `\
{ printf hidden; } > partial-group 1>&9
printf 'status:%s\\n' "$?"
printf '<'
cat partial-group
printf '>'
`,
    });

    expect(result.stdout.text).toBe(`\
status:1
<>`);
    expect(result.stderr.text).toContain('bad file descriptor');
    expect(result.result.exitCode).toBe(0);
  });

  it('keeps hash characters that are part of words or quoted text', async () => {
    const result = await execute({
      script: `\
printf '%s\\n' value#suffix '# quoted' "# double quoted"
`,
    });

    expect(result.stdout.text).toBe(`\
value#suffix
# quoted
# double quoted
`);
    expect(result.stderr.text).toBe('');
    expect(result.result.exitCode).toBe(0);
  });
  it('supports Bash-style ANSI-C quoted words without exposing them to later expansion', async () => {
    const result = await execute({ script: String.raw`printf '<%s>|<%s>|<%s>|<%s>\n' $'alpha\nbeta' $'\x41\101' $'\u03b1' $'literal * $HOME'` });
    expect(result.stdout.text).toBe(`\
<alpha
beta>|<AA>|<α>|<literal * $HOME>
`);
    expect(result.stderr.text).toBe('');
    expect(result.result.exitCode).toBe(0);
  });

  it('keeps escaped single quotes inside ANSI-C quoted words', async () => {
    const result = await execute({ script: String.raw`printf '<%s>\n' $'it\'s'` });
    expect(result.stdout.text).toBe("<it's>\n");
    expect(result.stderr.text).toBe('');
    expect(result.result.exitCode).toBe(0);
  });

  it('preserves high-byte ANSI-C hex and octal escapes as raw bytes', async () => {
    const stdout = createTestWriteCaptureHandle();
    const stderr = createTestWriteCaptureHandle();
    const result = await wesh.execute({
      source: createTextShellSource({ text: String.raw`printf '%s%s' $'\x80' $'\200'` }),
      stdin: createTestReadHandleFromText({ text: '' }),
      stdout: stdout.handle,
      stderr: stderr.handle,
    });

    expect([...stdout.buffer]).toEqual([0x80, 0x80]);
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
  });

  it('keeps ANSI-C Unicode escapes encoded as Unicode text', async () => {
    const stdout = createTestWriteCaptureHandle();
    const stderr = createTestWriteCaptureHandle();
    const result = await wesh.execute({
      source: createTextShellSource({ text: String.raw`printf '%s' $'\u0080'` }),
      stdin: createTestReadHandleFromText({ text: '' }),
      stdout: stdout.handle,
      stderr: stderr.handle,
    });

    expect([...stdout.buffer]).toEqual([0xc2, 0x80]);
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
  });

  it('expands here-string words after quote removal without pathname expansion', async () => {
    const result = await execute({ script: `\
VALUE='alpha beta'
cat <<< "$VALUE"` });
    expect(result.stdout.text).toBe('alpha beta\n');
    expect(result.stderr.text).toBe('');
    expect(result.result.exitCode).toBe(0);
  });

  it('rejects multi-match redirection targets as ambiguous', async () => {
    const result = await execute({ script: `\
printf alpha > alpha.txt
printf beta > beta.txt
printf changed > *.txt` });
    expect(result.stdout.text).toBe('');
    expect(result.stderr.text).toContain('ambiguous redirect');
    expect(result.result.exitCode).toBe(1);
  });

  it('continues a command list after an ordinary redirection failure', async () => {
    const result = await execute({ script: `\
cat < missing
printf 'status:%s\\n' "$?"` });
    expect(result.stdout.text).toBe('status:1\n');
    expect(result.stderr.text).not.toBe('');
    expect(result.result.exitCode).toBe(0);
  });

  it('lets a following command observe an ambiguous-redirection status', async () => {
    const result = await execute({ script: `\
printf alpha > alpha.txt
printf beta > beta.txt
printf changed > *.txt
printf 'status:%s\\n' "$?"` });
    expect(result.stdout.text).toBe('status:1\n');
    expect(result.stderr.text).toContain('ambiguous redirect');
    expect(result.result.exitCode).toBe(0);
  });

  it('accepts a physical newline after a pipeline operator but not a semicolon', async () => {
    const continued = await execute({ script: `\
printf 'alpha\\n' |
  cat
` });
    expect(continued.stdout.text).toBe('alpha\n');
    expect(continued.stderr.text).toBe('');
    expect(continued.result.exitCode).toBe(0);

    const invalid = await execute({ script: `printf 'alpha\n' | ; cat` });
    expect(invalid.stdout.text).toBe('');
    expect(invalid.stderr.text).not.toBe('');
    expect(invalid.result.exitCode).toBe(2);
  });

  it('returns the rightmost failing pipeline status when pipefail is enabled', async () => {
    const result = await execute({ script: `\
set -o pipefail
false | true
printf 'status:%s\\n' "$?"
` });

    expect(result.stdout.text).toBe('status:1\n');
    expect(result.stderr.text).toBe('');
    expect(result.result.exitCode).toBe(0);
  });

  it('restores last-command pipeline status when pipefail is disabled', async () => {
    const result = await execute({ script: `\
set -o pipefail
set +o pipefail
false | true
printf 'status:%s\\n' "$?"
` });

    expect(result.stdout.text).toBe('status:0\n');
    expect(result.stderr.text).toBe('');
    expect(result.result.exitCode).toBe(0);
  });

  it('stops a command list after an ordinary failure when errexit is enabled', async () => {
    const result = await execute({ script: `\
set -e
printf 'before\\n'
false
printf 'after\\n'
` });

    expect(result.stdout.text).toBe('before\n');
    expect(result.stderr.text).toBe('');
    expect(result.result.exitCode).toBe(1);
  });

  it('does not apply errexit to AND-list left operands or if conditions', async () => {
    const result = await execute({ script: `\
set -e
false && printf 'unexpected\\n'
if false; then printf 'unexpected\\n'; fi
printf 'after\\n'
` });

    expect(result.stdout.text).toBe('after\n');
    expect(result.stderr.text).toBe('');
    expect(result.result.exitCode).toBe(0);
  });

  it('preserves errexit suppression through redirection wrappers', async () => {
    const result = await execute({ script: `\
set -e
false > ignored.txt && printf 'unexpected\n'
printf 'after\n'
` });

    expect(result.stdout.text).toBe('after\n');
    expect(result.stderr.text).toBe('');
    expect(result.result.exitCode).toBe(0);
  });

  it('can disable errexit after enabling it', async () => {
    const result = await execute({ script: `\
set -e
set +e
false
printf 'status:%s\\n' "$?"
` });

    expect(result.stdout.text).toBe('status:1\n');
    expect(result.stderr.text).toBe('');
    expect(result.result.exitCode).toBe(0);
  });

  it('aborts on a direct unset parameter under nounset but permits a default operator', async () => {
    const fatal = await execute({ script: `\
set -u
printf 'before\\n'
printf '%s\\n' "$missing"
printf 'after\\n'
` });
    expect(fatal.stdout.text).toBe('before\n');
    expect(fatal.stderr.text).toContain('missing: unbound variable');
    expect(fatal.result.exitCode).toBe(127);

    const fallback = await execute({ script: `\
set -u
printf '<%s>\\n' "${'${missing:-fallback}'}"
` });
    expect(fallback.stdout.text).toBe('<fallback>\n');
    expect(fallback.stderr.text).toBe('');
    expect(fallback.result.exitCode).toBe(0);
  });

  it('accepts the common combined errexit nounset pipefail option form', async () => {
    const result = await execute({ script: `\
set -euo pipefail
value=ready
printf '%s\\n' "$value" | cat
` });

    expect(result.stdout.text).toBe('ready\n');
    expect(result.stderr.text).toBe('');
    expect(result.result.exitCode).toBe(0);
  });

  it('does not pathname-expand assignment right-hand sides', async () => {
    const result = await execute({ script: `\
printf x > present.txt
value=*
printf '<%s>\\n' "$value"` });
    expect(result.stdout.text).toBe('<*>\n');
    expect(result.stderr.text).toBe('');
    expect(result.result.exitCode).toBe(0);
  });

  it('sorts pathname expansion results like the C-locale Bash oracle', async () => {
    const result = await execute({ script: `\
printf x > b.txt
printf x > a.txt
printf '<%s>\\n' *.txt` });
    expect(result.stdout.text).toBe(`\
<a.txt>
<b.txt>
`);
    expect(result.stderr.text).toBe('');
    expect(result.result.exitCode).toBe(0);
  });

  it('evaluates command substitution inside a selected parameter default', async () => {
    const result = await execute({ script: `\
unset value
result=\${value:-$(printf 'fallback\\n')}
printf '<%s>\\n' "$result"
` });

    expect(result.stdout.text).toBe('<fallback>\n');
    expect(result.stderr.text).toBe('');
    expect(result.result.exitCode).toBe(0);
  });

  it('keeps an unquoted parameter operand substitution eligible for field splitting', async () => {
    const result = await execute({ script: `\
unset value
IFS=,
set -- \${value:-$(printf 'alpha,beta')}
printf 'count:%s first:<%s> second:<%s>\\n' "$#" "$1" "$2"
` });

    expect(result.stdout.text).toBe('count:2 first:<alpha> second:<beta>\n');
    expect(result.stderr.text).toBe('');
    expect(result.result.exitCode).toBe(0);
  });

  it('field-splits ordinary literal bytes selected from an unquoted parameter operand', async () => {
    const result = await execute({ script: `\
unset value
IFS=,
set -- \${value:-alpha,beta}
printf 'count:%s first:<%s> second:<%s>\n' "$#" "$1" "$2"` });

    expect(result.stdout.text).toBe('count:2 first:<alpha> second:<beta>\n');
    expect(result.stderr.text).toBe('');
    expect(result.result.exitCode).toBe(0);
  });

  it('preserves source quote protection inside an unquoted parameter operand', async () => {
    const result = await execute({ script: `\
unset value
IFS=,
set -- \${value:-alpha\\,beta} \${value:-'gamma,delta'} \${value:-"epsilon,zeta"}
printf 'count:%s <%s> <%s> <%s>\n' "$#" "$1" "$2" "$3"` });

    expect(result.stdout.text).toBe('count:3 <alpha,beta> <gamma,delta> <epsilon,zeta>\n');
    expect(result.stderr.text).toBe('');
    expect(result.result.exitCode).toBe(0);
  });

  it('keeps tilde expansion in a selected operand protected from later splitting and globbing', async () => {
    const result = await execute({ script: `\
unset value
HOME='/tmp/home with space'
set -- \${value:-~}
printf 'count:%s first:<%s>\n' "$#" "$1"
HOME='*'
printf 'glob:<%s>\n' \${value:-~}` });

    expect(result.stdout.text).toBe(`\
count:1 first:</tmp/home with space>
glob:<*>
`);
    expect(result.stderr.text).toBe('');
    expect(result.result.exitCode).toBe(0);
  });

  it('keeps operand pathname provenance through literal, escaped, quoted, and nested expansion', async () => {
    const result = await execute({ script: `\
mkdir work
cd work
touch alpha beta
unset value
nested='*'
printf 'literal:<%s>\n' \${value:-*}
printf 'escaped:<%s>\n' \${value:-\\*}
printf 'quoted:<%s>\n' \${value:-'*'}
printf 'nested:<%s>\n' \${value:-$nested}` });

    expect(result.stdout.text).toBe(`\
literal:<alpha>
literal:<beta>
escaped:<*>
quoted:<*>
nested:<alpha>
nested:<beta>
`);
    expect(result.stderr.text).toBe('');
    expect(result.result.exitCode).toBe(0);
  });

  it('parses parameter operands nested inside outer double quotes without leaking quote syntax', async () => {
    const result = await execute({ script: `\
unset value
printf '<%s>\n' "\${value:-"alpha beta"}"
printf '<%s>\n' "\${value:-$'gamma\\ndelta'}"` });

    expect(result.stdout.text).toBe(`\
<alpha beta>
<gamma
delta>
`);
    expect(result.stderr.text).toBe('');
    expect(result.result.exitCode).toBe(0);
  });

  it('keeps nested command-substitution quotes inside a parameter operand', async () => {
    const result = await execute({ script: `\
cat <(printf '%s' "\${x:-$(printf ")")}"; printf tail)
` });

    expect(result.stdout.text).toBe(')tail');
    expect(result.stderr.text).toBe('');
    expect(result.result.exitCode).toBe(0);
  });

  it('does not count parameter-operand parentheses as command-substitution delimiters', async () => {
    const result = await execute({ script: `\
unset value
closing=$(printf '<%s>\n' \${value:-)})
opening=$(printf '<%s>\n' \${value:-(})
printf '%s|%s\n' "$closing" "$opening"` });

    expect(result.stdout.text).toBe('<)>|<(>\n');
    expect(result.stderr.text).toBe('');
    expect(result.result.exitCode).toBe(0);
  });

  it('expands nested parameter defaults recursively', async () => {
    const unsetInner = await execute({ script: `\
unset outer inner
printf '<%s>\\n' "${'${outer:-${inner:-fallback}}'}"` });
    expect(unsetInner.stdout.text).toBe('<fallback>\n');
    expect(unsetInner.stderr.text).toBe('');
    expect(unsetInner.result.exitCode).toBe(0);

    const setInner = await execute({ script: `\
unset outer
inner=ready
printf '<%s>\\n' "${'${outer:-${inner:-fallback}}'}"` });
    expect(setInner.stdout.text).toBe('<ready>\n');
    expect(setInner.stderr.text).toBe('');
    expect(setInner.result.exitCode).toBe(0);
  });

  it('resolves braced positional parameters above nine', async () => {
    const result = await execute({ script: `\
show() {
  printf '<%s>|<%s>\\n' "${'${10}'}" "$#"
}
show one two three four five six seven eight nine ten` });
    expect(result.stdout.text).toBe('<ten>|<10>\n');
    expect(result.stderr.text).toBe('');
    expect(result.result.exitCode).toBe(0);
  });

  it('applies value operators and substring expansion to positional parameters', async () => {
    const result = await execute({ script: `\
show() {
  printf '<%s>|<%s>\n' "${'${10:-fallback}'}" "${'${1:1:2}'}"
}
show alpha two three four five six seven eight nine ten` });
    expect(result.stdout.text).toBe('<ten>|<lp>\n');
    expect(result.stderr.text).toBe('');
    expect(result.result.exitCode).toBe(0);
  });

  it('keeps dollar-dollar stable across subshells while BASHPID follows the active shell process', async () => {
    const result = await execute({ script: `\
outer=$$
outer_bashpid=$BASHPID
(
  [ "$$" = "$outer" ]
  printf 'dollar:%s\\n' "$?"
  [ "$BASHPID" != "$outer_bashpid" ]
  printf 'bashpid:%s\\n' "$?"
  case $PPID in ''|*[!0-9]*) printf 'ppid:no\\n' ;; *) printf 'ppid:yes\\n' ;; esac
)
inner=$(printf '%s' "$$")
[ "$inner" = "$outer" ]
printf 'command-substitution:%s\\n' "$?"
` });

    expect(result.stdout.text).toBe(`\
dollar:0
bashpid:0
ppid:yes
command-substitution:0
`);
    expect(result.stderr.text).toBe('');
    expect(result.result.exitCode).toBe(0);
  });

  it('shifts positional parameters in the current shell state', async () => {
    const result = await execute({ script: `\
set -- alpha beta gamma
shift
printf '%s|%s|%s\\n' "$#" "$1" "$2"
shift 1
printf '%s|%s\\n' "$#" "$1"
` });

    expect(result.stdout.text).toBe(`\
2|beta|gamma
1|gamma
`);
    expect(result.stderr.text).toBe('');
    expect(result.result.exitCode).toBe(0);
  });

  it('does not field-split or pathname-expand the HOME value introduced by tilde expansion', async () => {
    const result = await execute({ script: `\
HOME='home with space'
printf '<%s>\\n' ~
printf x > home-one
printf x > home-two
HOME='home-*'
printf '<%s>\\n' ~
` });

    expect(result.stdout.text).toBe(`\
<home with space>
<home-*>
`);
    expect(result.stderr.text).toBe('');
    expect(result.result.exitCode).toBe(0);
  });

  it('interprets leading-zero arithmetic literals as octal', async () => {
    const result = await execute({ script: `\
printf '%s\\n' "$((010 + 1))"
` });

    expect(result.stdout.text).toBe('9\n');
    expect(result.stderr.text).toBe('');
    expect(result.result.exitCode).toBe(0);
  });

  it('expands a leading tilde in parameter pattern operands', async () => {
    const result = await execute({ script: `\
HOME=/home
value=/home/child
printf '<%s>\\n' "\${value#~}"
` });

    expect(result.stdout.text).toBe('</child>\n');
    expect(result.stderr.text).toBe('');
    expect(result.result.exitCode).toBe(0);
  });

  it('keeps tilde-produced pattern metacharacters literal in parameter pattern operands', async () => {
    const result = await execute({ script: `\
HOME='*'
value=abc
printf '<%s>\\n' "\${value#~}"
` });

    expect(result.stdout.text).toBe('<abc>\n');
    expect(result.stderr.text).toBe('');
    expect(result.result.exitCode).toBe(0);
  });

  it('counts positional arguments for braced aggregate parameter lengths', async () => {
    const result = await execute({ script: `\
set -- 'a b' c ''
printf '%s:%s\n' "${'${#@}'}" "${'${#*}'}"` });
    expect(result.stdout.text).toBe('3:3\n');
    expect(result.stderr.text).toBe('');
    expect(result.result.exitCode).toBe(0);
  });

  it('counts and slices parameter values by Unicode scalar values', async () => {
    const result = await execute({ script: `\
value='a😀b'
printf '%s|<%s>|<%s>\n' "${'${#value}'}" "${'${value:1:1}'}" "${'${value:1:2}'}"` });
    expect(result.stdout.text).toBe('3|<😀>|<😀b>\n');
    expect(result.stderr.text).toBe('');
    expect(result.result.exitCode).toBe(0);
  });

  it('aborts the current non-interactive shell when a required parameter is unset', async () => {
    const result = await execute({ script: `\
unset value
printf 'before\\n'
printf '<%s>\\n' "\${value:?value is required}"
printf 'after\\n'
` });

    expect(result.stdout.text).toBe('before\n');
    expect(result.stderr.text).toContain('value: value is required');
    expect(result.result.exitCode).toBe(127);
  });

  it('rejects a negative substring end that falls before the selected offset', async () => {
    const result = await execute({ script: `\
value='a😀b'
printf '<%s>\n' "${'${value:3:-3}'}"` });
    expect(result.stdout.text).toBe('');
    expect(result.stderr.text).toContain('substring expression < 0');
    expect(result.result.exitCode).toBe(1);
  });

  it('expands aggregate positional parameters for argv forwarding', async () => {
    const result = await execute({ script: `\
sink() {
  printf 'count:%s\\n' "$#"
  for item in "$@"; do printf '<%s>\\n' "$item"; done
}
forward() { sink $@; }
sink alpha 'beta gamma' ''
forward alpha 'beta gamma'` });
    expect(result.stdout.text).toBe(`\
count:3
<alpha>
<beta gamma>
<>
count:3
<alpha>
<beta>
<gamma>
`);
    expect(result.stderr.text).toBe('');
    expect(result.result.exitCode).toBe(0);
  });

  it('attaches lexical edges to quoted at-expansion fields', async () => {
    const result = await execute({ script: `\
show() {
  printf 'count:%s\n' "$#"
  for item in "$@"; do printf '<%s>\n' "$item"; done
}
forward() { show pre"$@"post; }
forward alpha 'beta gamma' ''
forward alpha
forward` });
    expect(result.stdout.text).toBe(`\
count:3
<prealpha>
<beta gamma>
<post>
count:1
<prealphapost>
count:1
<prepost>
`);
    expect(result.stderr.text).toBe('');
    expect(result.result.exitCode).toBe(0);
  });

  it('handles braced aggregate positional forms inside larger words', async () => {
    const result = await execute({ script: `\
show_at() { printf '<%s>\n' pre"${'${@}'}"post; }
show_star() { IFS=:; printf '<%s>\n' pre"${'${*}'}"post; }
show_at alpha 'beta gamma'
show_at
show_star alpha beta` });
    expect(result.stdout.text).toBe(`\
<prealpha>
<beta gammapost>
<prepost>
<prealpha:betapost>
`);
    expect(result.stderr.text).toBe('');
    expect(result.result.exitCode).toBe(0);
  });

  it('joins quoted star with surrounding lexical text', async () => {
    const result = await execute({ script: `\
show() { printf 'count:%s first:<%s>\n' "$#" "$1"; }
forward() { show pre"$*"post; }
forward_custom() { IFS=,; show pre"$*"post; }
forward alpha 'beta gamma' ''
forward_custom alpha 'beta gamma' ''` });
    expect(result.stdout.text).toBe(`\
count:1 first:<prealpha beta gamma post>
count:1 first:<prealpha,beta gamma,post>
`);
    expect(result.stderr.text).toBe('');
    expect(result.result.exitCode).toBe(0);
  });

  it('field-splits unquoted aggregate positional expansions after edge attachment', async () => {
    const result = await execute({ script: `\
show() {
  printf 'count:%s\n' "$#"
  for item in "$@"; do printf '<%s>\n' "$item"; done
}
forward_at() { show pre$@post; }
forward_star() { show pre$*post; }
forward_at alpha 'beta gamma' ''
forward_star alpha 'beta gamma' ''` });
    expect(result.stdout.text).toBe(`\
count:4
<prealpha>
<beta>
<gamma>
<post>
count:4
<prealpha>
<beta>
<gamma>
<post>
`);
    expect(result.stderr.text).toBe('');
    expect(result.result.exitCode).toBe(0);
  });

  it('joins quoted star with the first IFS character', async () => {
    const result = await execute({ script: `\
show() {
  printf '<%s>\\n' "$*"
  IFS=,
  printf '<%s>\\n' "$*"
}
show alpha 'beta gamma' delta` });
    expect(result.stdout.text).toBe(`\
<alpha beta gamma delta>
<alpha,beta gamma,delta>
`);
    expect(result.stderr.text).toBe('');
    expect(result.result.exitCode).toBe(0);
  });

  it('treats only Bash IFS whitespace characters as collapsible delimiters', async () => {
    const nonBreakingSpace = '\u00a0';
    const result = await execute({
      script: `\
show() { printf 'count:%s first:<%s> second:<%s> third:<%s>\\n' "$#" "$1" "$2" "$3"; }
IFS='${nonBreakingSpace}'
value='alpha${nonBreakingSpace}${nonBreakingSpace}beta'
show $value
`,
    });
    expect(result.stdout.text).toBe('count:3 first:<alpha> second:<> third:<beta>\n');
    expect(result.stderr.text).toBe('');
    expect(result.result.exitCode).toBe(0);
  });

  it('iterates positional parameters when for omits an in-list', async () => {
    const result = await execute({ script: `\
show() {
  for value; do printf '<%s>\\n' "$value"; done
}
show one 'two words' three` });
    expect(result.stdout.text).toBe(`\
<one>
<two words>
<three>
`);
    expect(result.stderr.text).toBe('');
    expect(result.result.exitCode).toBe(0);
  });

  it('distinguishes set and unset variables with double-bracket -v', async () => {
    const result = await execute({ script: `\
value=ready
[[ -v value ]]
printf 'set:%s\\n' "$?"
[[ -v missing ]]
printf 'missing:%s\\n' "$?"` });
    expect(result.stdout.text).toBe(`\
set:0
missing:1
`);
    expect(result.stderr.text).toBe('');
    expect(result.result.exitCode).toBe(0);
  });

  it('unsets variables and functions through shell-owned state', async () => {
    const result = await execute({ script: `\
value=ready
probe() { printf 'function-body\\n'; }
unset -v value
printf '<%s>\\n' "${'${value-unset}'}"
unset -f probe
probe` });
    expect(result.stdout.text).toBe('<unset>\n');
    expect(result.stderr.text).toContain('Command not found: probe');
    expect(result.result.exitCode).toBe(127);
  });

  it('reports shell functions and registered commands through type -t', async () => {
    const result = await execute({ script: `\
probe_function() { :; }
type -t printf
type -t probe_function` });
    expect(result.stdout.text).toBe(`\
builtin
function
`);
    expect(result.stderr.text).toBe('');
    expect(result.result.exitCode).toBe(0);
  });

  it('treats quoted double-bracket pattern operands as literals', async () => {
    const result = await execute({ script: `\
value='report.txt'
pattern='*.txt'
[[ $value == '*.txt' ]]
printf 'literal:%s\n' "$?"
[[ $value == "$pattern" ]]
printf 'quoted-variable:%s\n' "$?"
[[ $value == $pattern ]]
printf 'active-variable:%s\n' "$?"
` });

    expect(result.stdout.text).toBe(`\
literal:1
quoted-variable:1
active-variable:0
`);
    expect(result.stderr.text).toBe('');
    expect(result.result.exitCode).toBe(0);
  });

  it('preserves empty unquoted expansions inside double-bracket tests', async () => {
    const result = await execute({ script: `\
unset missing
[[ -z $missing ]]
printf 'zero:%s\\n' "$?"
[[ -n $missing ]]
printf 'nonzero:%s\\n' "$?"` });
    expect(result.stdout.text).toBe(`\
zero:0
nonzero:1
`);
    expect(result.stderr.text).toBe('');
    expect(result.result.exitCode).toBe(0);
  });

  it('supports substring and indirect parameter expansion', async () => {
    const result = await execute({ script: `\
value=abcdef
target=VALUE
VALUE=resolved
printf '<%s>|<%s>|<%s>\\n' "${'${value:1:3}'}" "${'${value: -2}'}" "${'${!target}'}"` });
    expect(result.stdout.text).toBe('<bcd>|<ef>|<resolved>\n');
    expect(result.stderr.text).toBe('');
    expect(result.result.exitCode).toBe(0);
  });

  it('iterates shell options with getopts and updates OPTIND and OPTARG', async () => {
    const result = await execute({ script: `\
parse() {
  OPTIND=1
  while getopts 'ab:' opt; do
    printf 'opt:%s arg:<%s>\n' "$opt" "$OPTARG"
  done
  shift $((OPTIND - 1))
  printf 'rest:%s:<%s>\n' "$#" "$1"
}
parse -a -b value tail
parse -abvalue tail
` });

    expect(result.stderr.text).toBe('');
    expect(result.stdout.text).toBe(`\
opt:a arg:<>
opt:b arg:<value>
rest:1:<tail>
opt:a arg:<>
opt:b arg:<value>
rest:1:<tail>
`);
    expect(result.result.exitCode).toBe(0);
  });

  it('handles getopts unknown and missing-argument modes', async () => {
    const result = await execute({ script: `\
probe() {
  label=$1
  optstring=$2
  shift 2
  OPTIND=1
  unset OPTARG opt
  while getopts "$optstring" opt "$@"; do
    printf '%s:opt=%s arg=<%s> ind=%s\n' "$label" "$opt" "${'${OPTARG-}'}" "$OPTIND"
  done
  printf '%s:end ind=%s arg=<%s>\n' "$label" "$OPTIND" "${'${OPTARG-}'}"
}
probe silent-unknown ':a' -x
probe silent-missing ':b:' -b
` });

    expect(result.stderr.text).toBe('');
    expect(result.stdout.text).toBe(`\
silent-unknown:opt=? arg=<x> ind=2
silent-unknown:end ind=2 arg=<>
silent-missing:opt=: arg=<b> ind=2
silent-missing:end ind=2 arg=<>
`);
    expect(result.result.exitCode).toBe(0);
  });

  it('supports parameter pattern substitution variants', async () => {
    const result = await execute({ script: `\
value='alpha-beta-alpha'
printf '<%s>|<%s>|<%s>|<%s>\n' "${'${value/alpha/item}'}" "${'${value//alpha/item}'}" "${'${value/#alpha/item}'}" "${'${value/%alpha/item}'}"
value='abcabc'
printf '<%s>|<%s>\n' "${'${value/a*c/X}'}" "${'${value//a?/X}'}"
value='aba'
printf '<%s>|<%s>\n' "${'${value//b/}'}" "${'${value/a/}'}"
` });

    expect(result.stderr.text).toBe('');
    expect(result.stdout.text).toBe(`\
<item-beta-alpha>|<item-beta-item>|<item-beta-alpha>|<alpha-beta-item>
<X>|<XcXc>
<aa>|<ba>
`);
    expect(result.result.exitCode).toBe(0);
  });

  it('handles empty parameter substitution patterns like Bash', async () => {
    const result = await execute({ script: `\
value=abc
printf '<%s>|<%s>|<%s>|<%s>\n' "${'${value/}'}" "${'${value///X}'}" "${'${value/#/X}'}" "${'${value/%/X}'}"
` });

    expect(result.stderr.text).toBe('');
    expect(result.stdout.text).toBe('<abc>|<abc>|<Xabc>|<abcX>\n');
    expect(result.result.exitCode).toBe(0);
  });

  it('stops the current shell after exec runs its replacement command', async () => {
    const result = await execute({ script: `\
printf 'before\n'
exec printf 'after\n'
printf 'unreachable\n'
` });

    expect(result.stdout.text).toBe(`\
before
after
`);
    expect(result.stderr.text).toBe('');
    expect(result.result.exitCode).toBe(0);
  });

  it('applies whole-value parameter case conversion operators', async () => {
    const result = await execute({ script: `\
value='alpha BETA'
printf '<%s>|<%s>\n' "${'${value^^}'}" "${'${value,,}'}"
` });

    expect(result.stdout.text).toBe('<ALPHA BETA>|<alpha beta>\n');
    expect(result.stderr.text).toBe('');
    expect(result.result.exitCode).toBe(0);
  });

  it('evaluates let expressions in the current shell state', async () => {
    const result = await execute({ script: `\
value=1
let 'value += 2'
printf 'status:%s value:%s\n' "$?" "$value"
` });

    expect(result.stdout.text).toBe('status:0 value:3\n');
    expect(result.stderr.text).toBe('');
    expect(result.result.exitCode).toBe(0);
  });

  it('lets command bypass a same-named shell function', async () => {
    const result = await execute({ script: `\
printf() { echo 'function'; }
printf 'direct\n'
command printf 'builtin\n'
` });

    expect(result.stdout.text).toBe(`\
function
builtin
`);
    expect(result.stderr.text).toBe('');
    expect(result.result.exitCode).toBe(0);
  });

  it('lets builtin bypass a same-named shell function', async () => {
    const result = await execute({ script: `\
printf() { echo 'function'; }
printf 'direct\n'
builtin printf 'builtin\n'
` });

    expect(result.stdout.text).toBe(`\
function
builtin
`);
    expect(result.stderr.text).toBe('');
    expect(result.result.exitCode).toBe(0);
  });

  it('does not apply redirections after a failing prefix assignment expansion', async () => {
    const failed = await execute({ script: `\
set -u
value=$missing printf output > marker.txt
` });
    expect(failed.stdout.text).toBe('');
    expect(failed.stderr.text).toContain('missing: unbound variable');
    expect(failed.result.exitCode).not.toBe(0);

    const marker = await execute({ script: 'test -e marker.txt' });
    expect(marker.stdout.text).toBe('');
    expect(marker.stderr.text).toBe('');
    expect(marker.result.exitCode).toBe(1);
  });

  it('applies command redirections before shell intrinsic dispatch', async () => {
    const result = await execute({ script: `\
eval 'printf eval-output' > eval.txt
type printf > type.txt
printf '<%s>|<%s>\n' "$(cat eval.txt)" "$(cat type.txt)"
` });

    expect(result.stdout.text).toBe('<eval-output>|<printf is a shell builtin>\n');
    expect(result.stderr.text).toBe('');
    expect(result.result.exitCode).toBe(0);
  });

  it('applies prefix assignments temporarily to shell-owned commands', async () => {
    const result = await execute({ script: `\
value=outer
value=eval-prefix eval 'printf "eval:<%s>\\n" "$value"; value=eval-mutated'
printf 'after-eval:<%s>\\n' "$value"
value=builtin-prefix builtin eval 'printf "builtin-eval:<%s>\\n" "$value"; value=builtin-mutated'
printf 'after-builtin-eval:<%s>\\n' "$value"
printf '%s\\n' 'printf "source:<%s>\\\\n" "$value"' 'value=source-mutated' 'side=kept' > prefix-source.sh
value=source-prefix source prefix-source.sh
printf 'after-source:<%s>|side:<%s>\\n' "$value" "$side"
probe() {
  printf 'function:<%s>\\n' "$value"
  value=function-mutated
}
value=function-prefix probe
printf 'after-function:<%s>\\n' "$value"
chained() { printf 'chained:<%s>|<%s>\\n' "$first" "$second"; }
first=one second=$first chained
printf 'after-chained:<%s>|<%s>\\n' "${'${first-unset}'}" "${'${second-unset}'}"
` });

    expect(result.stdout.text).toBe(`\
eval:<eval-prefix>
after-eval:<outer>
builtin-eval:<builtin-prefix>
after-builtin-eval:<outer>
source:<source-prefix>
after-source:<outer>|side:<kept>
function:<function-prefix>
after-function:<outer>
chained:<one>|<one>
after-chained:<unset>|<unset>
`);
    expect(result.stderr.text).toBe('');
    expect(result.result.exitCode).toBe(0);
  });

  it('preserves eval and unset semantics through builtin dispatch', async () => {
    const evalHelp = await execute({ script: 'builtin eval --help' });
    expect(evalHelp.stdout.text).toContain('Evaluate arguments as shell code');
    expect(evalHelp.stderr.text).toBe('');
    expect(evalHelp.result.exitCode).toBe(2);

    const unsetHelp = await execute({ script: 'builtin unset --help' });
    expect(unsetHelp.stdout.text).toContain('Unset environment variables');
    expect(unsetHelp.stderr.text).toBe('');
    expect(unsetHelp.result.exitCode).toBe(0);

    const stateful = await execute({ script: `\
value=present
probe() { printf 'function\n'; }
builtin eval -- 'printf "eval:%s\n" "$value"'
builtin unset value
builtin unset -f probe
printf 'value:<%s>\n' "${'${value-unset}'}"
type -t probe || printf 'function:<missing>\n'
` });

    expect(stateful.stdout.text).toBe(`\
eval:present
value:<unset>
function:<missing>
`);
    expect(stateful.stderr.text).toBe('');
    expect(stateful.result.exitCode).toBe(0);
  });

  it('treats dynamically registered Wesh commands as builtins', async () => {
    wesh.registerCommand({
      definition: {
        meta: { name: 'custom-command', description: 'test command', usage: 'custom-command' },
        fn: async ({ context }) => {
          await context.text().print({ text: 'registered\n' });
          return { exitCode: 0 };
        },
      },
    });

    const result = await execute({ script: `\
custom-command() { printf 'function\n'; }
custom-command
builtin custom-command
unset -f custom-command
type -t custom-command
` });

    expect(result.stdout.text).toBe(`\
function
registered
builtin
`);
    expect(result.stderr.text).toBe('');
    expect(result.result.exitCode).toBe(0);
  });

  it('restores caller variables after local function assignments', async () => {
    const result = await execute({ script: `\
value=outer
show() { local value=inner; printf 'inside:%s\n' "$value"; }
show
printf 'outside:%s\n' "$value"
` });

    expect(result.stdout.text).toBe(`\
inside:inner
outside:outer
`);
    expect(result.stderr.text).toBe('');
    expect(result.result.exitCode).toBe(0);
  });

  it('applies invocation redirections to shell function bodies', async () => {
    const result = await execute({ script: `\
show() { printf 'function-output\\n'; }
show > function.txt
printf '<%s>\\n' "$(cat function.txt)"` });
    expect(result.stdout.text).toBe('<function-output>\n');
    expect(result.stderr.text).toBe('');
    expect(result.result.exitCode).toBe(0);
  });

  it('matches shell wildcard patterns without RegExp newline semantics', async () => {
    const result = await execute({
      script: `\
value='a
b'
case "$value" in
  a?b) printf 'question:newline-match\\n' ;;
  *) printf 'question:no-match\\n' ;;
esac
case b in
  [a-c]) printf 'range:match\\n' ;;
  *) printf 'range:no-match\\n' ;;
esac
case z in
  [!a-c]) printf 'negated:match\\n' ;;
  *) printf 'negated:no-match\\n' ;;
esac
emoji='😀'
case "$emoji" in
  ?) printf 'emoji:one-character\\n' ;;
  *) printf 'emoji:not-one-character\\n' ;;
esac
printf 'emoji-trim:<%s>\\n' "${'${emoji#?}'}"
literal='*'
case "$literal" in
  \\*) printf 'escaped:match\\n' ;;
  *) printf 'escaped:no-match\\n' ;;
esac
trim='
b'
printf 'trim:<%s>\\n' "${'${trim#?}'}"
`,
    });

    expect(result.stdout.text).toBe(`\
question:newline-match
range:match
negated:match
emoji:one-character
emoji-trim:<>
escaped:match
trim:<b>
`);
    expect(result.stderr.text).toBe('');
    expect(result.result.exitCode).toBe(0);
  });

  it('preserves quote provenance and trailing escapes in case patterns', async () => {
    const result = await execute({ script: `\
value='report.txt'
case "$value" in
  '*.txt') printf 'quoted:unexpected\n' ;;
  *.txt) printf 'quoted:literal\n' ;;
esac
value='abc\\'
pattern='*\\'
case "$value" in
  $pattern) printf 'trailing:unexpected\n' ;;
  *) printf 'trailing:no-match\n' ;;
esac
printf 'trim:<%s>\n' "${'${value%$pattern}'}"
` });

    expect(result.stdout.text).toBe(`\
quoted:literal
trailing:no-match
trim:<abc\\>
`);
    expect(result.stderr.text).toBe('');
    expect(result.result.exitCode).toBe(0);
  });

  it('supports POSIX character classes across shell pattern consumers', async () => {
    const result = await execute({ script: `\
value=5
case "$value" in
  [[:digit:]]) printf 'digit:yes\n' ;;
  *) printf 'digit:no\n' ;;
esac
newline='
'
case "$newline" in
  [[:space:]]) printf 'space:yes\n' ;;
  *) printf 'space:no\n' ;;
esac
value='5tail'
printf 'trim:<%s>\n' "${'${value#[[:digit:]]}'}"
` });

    expect(result.stdout.text).toBe(`\
digit:yes
space:yes
trim:<tail>
`);
    expect(result.stderr.text).toBe('');
    expect(result.result.exitCode).toBe(0);
  });

  it('strips leading tabs from <<- here-document bodies and delimiters', async () => {
    const result = await execute({ script: `\
cat <<-EOF
	alpha
		beta
	EOF
` });

    expect(result.stdout.text).toBe(`\
alpha
beta
`);
    expect(result.stderr.text).toBe('');
    expect(result.result.exitCode).toBe(0);
  });

  it('supports explicit arithmetic bases, exponentiation, and comma expressions', async () => {
    const result = await execute({ script: `\
value=1
left=right
right=7
printf '%s|%s|%s|%s|%s|%s\n' "$((16#10 + 2#10))" "$((2 ** 5))" "$((-2 ** 2))" "$((value += 1, value += 2))" "$(((1 + 2) * 3))" "$((left + 1))"
printf 'value:%s\n' "$value"
` });

    expect(result.stdout.text).toBe(`\
18|32|-4|4|9|8
value:4
`);
    expect(result.stderr.text).toBe('');
    expect(result.result.exitCode).toBe(0);
  });

  it('supports arithmetic shifts with additive precedence', async () => {
    const result = await execute({ script: `\
printf '%s|%s|%s|%s\n' "$((1 << 3))" "$((16 >> 2))" "$((1 + 1 << 2))" "$((16 >> 1 + 1))"
` });

    expect(result.stdout.text).toBe(`\
8|4|8|4
`);
    expect(result.stderr.text).toBe('');
    expect(result.result.exitCode).toBe(0);
  });

  it('does not treat non-shell Unicode whitespace as arithmetic whitespace', async () => {
    const nonBreakingSpace = '\u00a0';
    const result = await execute({
      script: `\
printf '<%s>\\n' "$((1${nonBreakingSpace}+${nonBreakingSpace}2))"
`,
    });

    expect(result.stdout.text).toBe('');
    expect(result.stderr.text).not.toBe('');
    expect(result.result.exitCode).toBe(1);
  });

  it('conditional quoted regex keeps the quoted expansion literal', async () => {
    const { result, stdout, stderr } = await execute({
      script: `\
value='item-42'
regex='^item-[0-9]+$'
[[ $value =~ "$regex" ]]
printf 'quoted:%s\n' "$?"
[[ $value =~ $regex ]]
printf 'unquoted:%s\n' "$?"
`,
    });

    expect(result.exitCode).toBe(0);
    expect(stdout.text).toBe(`\
quoted:1
unquoted:0
`);
    expect(stderr.text).toBe('');
  });

  it('pipeline stderr shorthand merges stderr into the pipe', async () => {
    const { result, stdout, stderr } = await execute({
      script: `\
sh -c 'printf "out\n"; printf "err\n" >&2' |& cat
`,
    });

    expect(result.exitCode).toBe(0);
    expect(stdout.text).toBe(`\
out
err
`);
    expect(stderr.text).toBe('');
  });

  it('redirect-both shorthand preserves stdout then stderr ordering', async () => {
    const { result, stdout, stderr } = await execute({
      script: `\
sh -c 'printf "out\n"; printf "err\n" >&2' &> combined
cat combined
`,
    });

    expect(result.exitCode).toBe(0);
    expect(stdout.text).toBe(`\
out
err
`);
    expect(stderr.text).toBe('');
  });

  it('redirection duplication observes earlier redirections in left-to-right order', async () => {
    const first = await execute({
      script: `\
printf 'line\n' 2>&1 >&2
`,
    });
    expect(first.result.exitCode).toBe(0);
    expect(first.stdout.text).toBe('line\n');
    expect(first.stderr.text).toBe('');

    const second = await execute({
      script: `\
printf 'line\n' 3>output >&3
cat output
`,
    });
    expect(second.result.exitCode).toBe(0);
    expect(second.stdout.text).toBe('line\n');
    expect(second.stderr.text).toBe('');
  });


  it('does not print job notifications in non-interactive execution', async () => {
    const { result, stdout, stderr } = await execute({
      script: `\
true &
pid=$!
wait "$pid"
printf 'wait:%s pid:%s\n' "$?" "$pid"
`,
    });

    expect(result.exitCode).toBe(0);
    expect(stdout.text).toMatch(/^wait:0 pid:[0-9]+\n$/);
    expect(stderr.text).toBe('');
  });

});
