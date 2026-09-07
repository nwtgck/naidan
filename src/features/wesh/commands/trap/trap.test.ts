import { beforeEach, describe, expect, it } from 'vitest';
import { Wesh } from '@/features/wesh/index';
import { createTextShellSource } from '@/features/wesh/shell/source';
import { MockFileSystemDirectoryHandle } from '@/features/wesh/mocks/InMemoryFileSystem';
import {
  createTestReadHandleFromText,
  createTestWriteCaptureHandle,
} from '@/features/wesh/utils/test-stream';

describe('wesh trap', () => {
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

  it('normalizes EXIT and signal-number aliases when printing traps', async () => {
    const execution = await execute({
      script: `\
trap 'printf exit\\n' 0
trap 'printf int\\n' 2
trap -p 0 INT
`,
    });

    expect(execution.stdout.text).toBe(`\
trap -- 'printf exit\\n' EXIT
trap -- 'printf int\\n' SIGINT
exitn`);
    expect(execution.stderr.text).toBe('');
    expect(execution.result.exitCode).toBe(0);
  });

  it('filters print requests in operand order', async () => {
    const execution = await execute({
      script: `\
trap 'printf exit\\n' EXIT
trap 'printf int\\n' INT
trap -p INT EXIT
`,
    });

    expect(execution.stdout.text).toBe(`\
trap -- 'printf int\\n' SIGINT
trap -- 'printf exit\\n' EXIT
exitn`);
    expect(execution.stderr.text).toBe('');
    expect(execution.result.exitCode).toBe(0);
  });

  it('uses Bash numeric whitespace rules for trap signal specifications', async () => {
    const accepted = [
      '2',
      ' 2',
      '\t2',
      '\n2',
      '\v2',
      '\f2',
      '\r2',
      '2 ',
      '2\t',
      '\n\t2 \t',
      '+2',
      '02',
    ];
    const rejected = [
      '2\n',
      '2\v',
      '2\f',
      '2\r',
      '\u00A02',
      '2\u00A0',
      '\u20032',
      '2\u2003',
      '\uFEFF2',
      '2\uFEFF',
    ];

    for (const value of accepted) {
      const trapped = await execute({ script: `trap '' '${value}'` });
      expect(trapped.stdout.text).toBe('');
      expect(trapped.stderr.text, JSON.stringify(value)).toBe('');
      expect(trapped.result.exitCode).toBe(0);
    }

    for (const value of rejected) {
      const trapped = await execute({ script: `trap '' '${value}'` });
      expect(trapped.stdout.text).toBe('');
      expect(trapped.stderr.text).toContain('invalid signal specification');
      expect(trapped.result.exitCode).toBe(1);
    }
  });

  it('rejects historical libc signal aliases that Bash does not accept', async () => {
    for (const value of ['IOT', 'SIGIOT', 'CLD', 'SIGCLD', 'POLL', 'SIGPOLL']) {
      const trapped = await execute({ script: `trap '' '${value}'` });
      expect(trapped.stdout.text).toBe('');
      expect(trapped.stderr.text).toContain('invalid signal specification');
      expect(trapped.result.exitCode).toBe(1);
    }
  });

  it('does not normalize non-ASCII lookalikes in signal names', async () => {
    const execution = await execute({
      script: `\
trap '' '\u017Figint'
printf 'long-s=%s\n' "$?"
trap '' 's\u0131gint'
printf 'dotless-i=%s\n' "$?"
`,
    });

    expect(execution.stdout.text).toBe(`\
long-s=1
dotless-i=1
`);
    expect(execution.stderr.text).toContain('invalid signal specification');
    expect(execution.result.exitCode).toBe(0);
  });

  it('rejects invalid signal specifications while applying valid operands', async () => {
    const execution = await execute({
      script: `\
trap 'printf int\\n' INT NOTASIGNAL
printf 'status=%s\\n' "$?"
trap -p INT
`,
    });

    expect(execution.stdout.text).toBe(`\
status=1
trap -- 'printf int\\n' SIGINT
`);
    expect(execution.stderr.text).toContain('invalid signal specification');
    expect(execution.result.exitCode).toBe(0);
  });

  // Dispatching signals to the current shell requires the core process/trap integration tracked by sessions 133 and 141.

  // Signal disposition for the current shell requires the core process/trap integration tracked by sessions 133 and 141.

  it('resets traps through zero and dash aliases', async () => {
    const execution = await execute({
      script: `\
trap 'printf bad\\n' EXIT
trap - 0
printf body\\n
`,
    });

    expect(execution.stdout.text).toBe('bodyn');
    expect(execution.stderr.text).toBe('');
    expect(execution.result.exitCode).toBe(0);
  });

  it('lists the canonical Linux signal table', async () => {
    const execution = await execute({ script: 'trap -l | head -n 2' });

    expect(execution.stdout.text).toBe(`\
 1) SIGHUP\t 2) SIGINT\t 3) SIGQUIT\t 4) SIGILL\t 5) SIGTRAP
 6) SIGABRT\t 7) SIGBUS\t 8) SIGFPE\t 9) SIGKILL\t10) SIGUSR1
`);
    expect(execution.stderr.text).toBe('');
    expect(execution.result.exitCode).toBe(0);
  });
});
