import { beforeEach, describe, expect, it } from 'vitest';
import { Wesh } from '@/features/wesh/index';
import { createTextShellSource } from '@/features/wesh/shell/source';
import { MockFileSystemDirectoryHandle } from '@/features/wesh/mocks/InMemoryFileSystem';
import {
  createTestReadHandleFromText,
  createTestWriteCaptureHandle,
} from '@/features/wesh/utils/test-stream';

describe('wesh time', () => {
  let wesh: Wesh;
  let rootHandle: MockFileSystemDirectoryHandle;

  beforeEach(async () => {
    rootHandle = new MockFileSystemDirectoryHandle({ name: 'root' });
    wesh = new Wesh({ rootHandle: rootHandle as unknown as FileSystemDirectoryHandle });
    await wesh.init();
  });

  async function execute({
    script,
    stdinText,
    signal,
  }: {
    script: string,
    stdinText?: string,
    signal?: AbortSignal,
  }) {
    const stdout = createTestWriteCaptureHandle();
    const stderr = createTestWriteCaptureHandle();

    const result = await wesh.execute({
      source: createTextShellSource({ text: script }),
      stdin: createTestReadHandleFromText({ text: stdinText ?? '' }),
      stdout: stdout.handle,
      stderr: stderr.handle,
      signal,
    });

    return { result, stdout, stderr };
  }

  it('prints help and usage errors', async () => {
    const help = await execute({ script: 'time --help' });
    const missing = await execute({ script: 'time' });
    const optionLikeCommand = await execute({ script: 'time --nope true' });

    expect(help.stdout.text).toContain('Measure command execution time');
    expect(help.stdout.text).toContain('usage: time [-p] COMMAND [ARG]...');
    expect(help.stdout.text).toContain('-p');
    expect(help.stderr.text).toBe('');
    expect(help.result.exitCode).toBe(0);

    expect(missing.stdout.text).toBe('');
    expect(missing.stderr.text).toContain('time: missing command operand');
    expect(missing.stderr.text).toContain('usage: time [-p] COMMAND [ARG]...');
    expect(missing.result.exitCode).toBe(1);

    expect(optionLikeCommand.stdout.text).toBe('');
    expect(optionLikeCommand.stderr.text).toContain('time: cannot run --nope: No such file or directory');
    expect(optionLikeCommand.stderr.text).toContain('real');
    expect(optionLikeCommand.result.exitCode).toBe(127);
  });

  it('passes option-like arguments to the timed command', async () => {
    const { result, stdout, stderr } = await execute({
      script: `time -p printf '%s\n' --help`,
    });

    expect(stdout.text).toBe('--help\n');
    expect(stderr.text).toMatch(/^real \d+\.\d{2}\nuser 0\.00\nsys 0\.00\n$/);
    expect(result.exitCode).toBe(0);
  });

  it('reports command-not-found after timing the failed launch', async () => {
    const { result, stdout, stderr } = await execute({
      script: 'time -p definitely-missing-time-command',
    });

    expect(stdout.text).toBe('');
    expect(stderr.text).toMatch(
      /^time: cannot run definitely-missing-time-command: No such file or directory\nreal \d+\.\d{2}\nuser 0\.00\nsys 0\.00\n$/,
    );
    expect(result.exitCode).toBe(127);
  });

  it('supports -- before the command operand', async () => {
    const { result, stdout, stderr } = await execute({
      script: 'time -p -- false',
    });

    expect(stdout.text).toBe('');
    expect(stderr.text).toMatch(/^real \d+\.\d{2}\nuser 0\.00\nsys 0\.00\n$/);
    expect(result.exitCode).toBe(1);
  });

  it('passes stdout through and writes timing to stderr', async () => {
    const { result, stdout, stderr } = await execute({
      script: 'time printf hello',
    });

    expect(stdout.text).toBe('hello');
    expect(stderr.text).toMatch(/^real\t\d+m\d+\.\d{3}s\nuser\t0m0\.000s\nsys\t0m0\.000s\n$/);
    expect(result.exitCode).toBe(0);
  });

  it('supports the portable -p format and preserves exit codes', async () => {
    const { result, stdout, stderr } = await execute({
      script: 'time -p false',
    });

    expect(stdout.text).toBe('');
    expect(stderr.text).toMatch(/^real \d+\.\d{2}\nuser 0\.00\nsys 0\.00\n$/);
    expect(result.exitCode).toBe(1);
  });

  it('times commands that consume stdin', async () => {
    const { result, stdout, stderr } = await execute({
      script: 'time cat -',
      stdinText: 'from-stdin\n',
    });

    expect(stdout.text).toBe('from-stdin\n');
    expect(stderr.text).toContain('real');
    expect(stderr.text).toContain('user');
    expect(stderr.text).toContain('sys');
    expect(result.exitCode).toBe(0);
  });

  it('keeps a same-named shell function ahead of the time builtin', async () => {
    const { result, stdout, stderr } = await execute({
      script: `\
time() { printf 'function %s\\n' "$1"; }
time echo
`,
    });

    expect(stdout.text).toBe('function echo\n');
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
  });

  it('times a shell function and returns its status', async () => {
    const { result, stdout, stderr } = await execute({
      script: `\
report() { TIMED=yes; printf '<%s>\\n' "$1"; return 7; }
time -p report 'two words'
status=$?
printf 'timed=%s\\n' "$TIMED"
exit "$status"
`,
    });

    expect(stdout.text).toBe(`\
<two words>
timed=yes
`);
    expect(stderr.text).toMatch(/^real \d+\.\d{2}\nuser 0\.00\nsys 0\.00\n$/u);
    expect(result.exitCode).toBe(7);
  });

  it('reports timing and exits the current shell when the timed eval exits', async () => {
    const { result, stdout, stderr } = await execute({ script: "time -p eval 'exit 9'; printf unreachable" });

    expect(stdout.text).toBe('');
    expect(stderr.text).toMatch(/^real \d+\.\d{2}\nuser 0\.00\nsys 0\.00\n$/u);
    expect(result.exitCode).toBe(9);
  });

  it('prints timing to the current stderr after a timed function redirects it', async () => {
    const { result, stdout, stderr } = await execute({
      script: `\
report() { exec 2>timing; printf 'function\\n' >&2; }
time -p report
printf 'after\\n' >&2
exec 2>&1
cat timing
`,
    });

    expect(stdout.text).toMatch(/^function\nreal \d+\.\d{2}\nuser 0\.00\nsys 0\.00\nafter\n$/u);
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
  });

  it('keeps assignments completed before interrupting a timed shell function', async () => {
    const started = Promise.withResolvers<void>();
    wesh.registerCommand({
      definition: {
        meta: { name: 'wait-for-int', description: 'Wait for an interrupt', usage: 'wait-for-int' },
        load: async () => async ({ context }) => {
          started.resolve();
          const waitStatus = await context.process.waitForSignalOrTimeout({ timeoutMs: 1000 });
          return { exitCode: waitStatus === undefined ? 0 : 130, waitStatus };
        },
      },
    });
    const controller = new AbortController();
    const current = execute({
      script: `\
VALUE=before
trap 'printf "caught=%s\\n" "$VALUE"' INT
report() { VALUE=inside; wait-for-int; }
time -p report
printf 'unreachable\\n'
`,
      signal: controller.signal,
    });
    await started.promise;
    controller.abort();
    await wesh.interruptForeground({ foregroundSignal: controller.signal });
    const interrupted = await current;
    const next = await execute({ script: 'printf "next=%s\\n" "$VALUE"' });

    expect(interrupted.stdout.text).toBe('caught=inside\n');
    expect(interrupted.result.exitCode).toBe(130);
    expect(next.stdout.text).toBe('next=inside\n');
  });

  it('treats only one leading -p as a time option', async () => {
    const repeated = await execute({ script: 'time -p -p true' });
    const unknown = await execute({ script: 'time -x' });

    expect(repeated.stdout.text).toBe('');
    expect(repeated.stderr.text).toContain('time: cannot run -p: No such file or directory');
    expect(repeated.result.exitCode).toBe(127);

    expect(unknown.stdout.text).toBe('');
    expect(unknown.stderr.text).toContain('time: cannot run -x: No such file or directory');
    expect(unknown.result.exitCode).toBe(127);
  });

  it('treats a non-standalone help token as the command operand', async () => {
    const { result, stdout, stderr } = await execute({ script: 'time -p --help' });

    expect(result.exitCode).toBe(127);
    expect(stdout.text).toBe('');
    expect(stderr.text).toMatch(/^time: cannot run --help: No such file or directory\nreal \d+\.\d{2}\nuser 0\.00\nsys 0\.00\n$/u);
  });
});
