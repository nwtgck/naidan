import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Wesh } from '@/features/wesh/index';
import { builtinCommands } from '@/features/wesh/commands';
import { createTextShellSource } from '@/features/wesh/shell/source';
import { MockFileSystemDirectoryHandle } from '@/features/wesh/mocks/InMemoryFileSystem';
import {
  createTestReadHandleFromText,
  createTestWriteCaptureHandle,
} from '@/features/wesh/utils/test-stream';

describe('wesh trap', () => {
  let wesh: Wesh;

  beforeAll(async () => {
    const names = new Set(['cat', 'env', 'eval', 'head', 'printf', 'trap']);
    await Promise.all(builtinCommands.filter(definition => names.has(definition.meta.name)).map(async definition => {
      if ('loadShellBuiltin' in definition) {
        await definition.loadShellBuiltin();
      } else {
        await definition.load();
      }
    }));
  });

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

  it('shows inherited definitions without running parent handlers in forked shells', async () => {
    const execution = await execute({
      script: `\
trap 'printf "parent exit\\n"' EXIT
trap 'printf "parent error\\n"' ERR
( ( trap -p EXIT ERR; false; : ); : )
{ trap -p EXIT; printf 'pipeline\\n'; } | cat
printf '%s\\n' "$(trap -p EXIT; printf substitution)"
printf 'parent\\n'
`,
    });

    expect(execution.stdout.text).toBe(`\
trap -- 'printf "parent exit\\n"' EXIT
trap -- 'printf "parent error\\n"' ERR
trap -- 'printf "parent exit\\n"' EXIT
pipeline
trap -- 'printf "parent exit\\n"' EXIT
substitution
parent
parent exit
`);
    expect(execution.stderr.text).toBe('');
    expect(execution.result.exitCode).toBe(0);
  });

  it('switches from inherited listings to live traps on an assignment attempt', async () => {
    const execution = await execute({
      script: `\
trap 'printf "parent exit\\n"' EXIT
trap '' INT
(
  trap -p EXIT INT
  trap -p NOSUCH 2>/dev/null
  trap -p EXIT
  trap 'printf invalid' NOSUCH 2>/dev/null
  trap -p EXIT INT
  trap - INT
  trap -p INT
)
trap -p INT
`,
    });

    expect(execution.stdout.text).toBe(`\
trap -- 'printf "parent exit\\n"' EXIT
trap -- '' SIGINT
trap -- 'printf "parent exit\\n"' EXIT
trap -- '' SIGINT
trap -- '' SIGINT
parent exit
`);
    expect(execution.stderr.text).toBe('');
    expect(execution.result.exitCode).toBe(0);
  });

  it('keeps startup ignores in a new shell even when a nested fork attempts to reset them', async () => {
    const execution = await execute({
      script: `\
trap '' TERM
trap 'printf "outer exit\\n"' EXIT
bash -c '
  trap -p EXIT TERM
  trap "printf inner" EXIT
  (trap -p EXIT TERM; trap - TERM; trap -p EXIT TERM)
'
`,
    });

    expect(execution.stdout.text).toBe(`\
trap -- '' SIGTERM
trap -- 'printf inner' EXIT
trap -- '' SIGTERM
trap -- '' SIGTERM
innerouter exit
`);
    expect(execution.stderr.text).toBe('');
    expect(execution.result.exitCode).toBe(0);
  });

  it('carries startup ignores into a builtin launched as a command', async () => {
    const execution = await execute({
      script: `\
trap '' TERM
env trap -p TERM
env eval 'trap - TERM; trap -p TERM'
`,
    });

    expect(execution.stdout.text).toBe("trap -- '' SIGTERM\n".repeat(2));
    expect(execution.stderr.text).toBe('');
    expect(execution.result.exitCode).toBe(0);
  });

  it('runs child EXIT traps using the descriptors in effect when that shell completes', async () => {
    const execution = await execute({
      script: `\
{ trap 'printf "stage exit\\n"' EXIT; printf 'stage body\\n'; } >stage | cat
cat stage
{ trap 'printf "job exit\\n"' EXIT; printf 'job body\\n'; } >job &
wait "$!"
cat job
{ trap 'printf "unredirected job exit\\n"' EXIT; printf 'unredirected job body\\n'; } &
wait "$!"
printf 'capture: %s\\n' "$({ trap 'printf "capture exit"' EXIT; printf 'capture body\\n'; } >captured)"
cat captured
cat <({ trap 'printf "process exit\\n"' EXIT; printf 'process body\\n'; } >substituted)
cat substituted
printf 'after exec: [%s]\\n' "$(exec >capture-exec; trap 'printf "exec exit\\n"' EXIT)"
cat capture-exec
`,
    });

    expect(execution.stdout.text).toBe(`\
stage body
stage exit
job body
job exit
unredirected job body
unredirected job exit
capture: capture exit
capture body
process exit
process body
after exec: []
exec exit
`);
    expect(execution.stderr.text).toBe('');
    expect(execution.result.exitCode).toBe(0);
  });

  it('uses an explicit exit from a child EXIT trap as the child status', async () => {
    const execution = await execute({
      script: `\
(trap 'exit 17' EXIT; exit 7)
printf 'subshell=%s\\n' "$?"
value=$(trap 'exit 18' EXIT; false)
printf 'substitution=%s\\n' "$?"
set -o pipefail
{ trap 'exit 19' EXIT; :; } | cat
printf 'pipeline=%s\\n' "$?"
`,
    });

    expect(execution.stdout.text).toBe(`\
subshell=17
substitution=18
pipeline=19
`);
    expect(execution.stderr.text).toBe('');
    expect(execution.result.exitCode).toBe(0);
  });

  it('leaves EXIT inactive for a bare control structure in a pipeline or background job', async () => {
    const execution = await execute({
      script: `\
set -o pipefail
for item in value; do trap 'exit 19' EXIT; done >stage | cat
printf 'pipeline=%s\\n' "$?"
if :; then trap 'exit 20' EXIT; fi &
wait "$!"
printf 'job=%s\\n' "$?"
{ for item in value; do trap 'printf grouped' EXIT; done; } | cat
`,
    });

    expect(execution.stdout.text).toBe(`\
pipeline=0
job=0
grouped`);
    expect(execution.stderr.text).toBe('');
    expect(execution.result.exitCode).toBe(0);
  });

  it('runs a child EXIT trap on an expansion error and leaves the parent evaluating', async () => {
    const execution = await execute({
      script: `\
(set -u; trap 'printf "child exit\\n" >&2' EXIT; printf '%s' "$missing")
printf survived
`,
    });

    expect(execution.stdout.text).toBe('survived');
    expect(execution.stderr.text).toContain('missing: unbound variable');
    expect(execution.stderr.text.endsWith('child exit\n')).toBe(true);
    expect(execution.result.exitCode).toBe(0);
  });

  it('reports a failing foreground brace group through ERR once', async () => {
    const execution = await execute({
      script: `\
trap 'printf "err\\n"' ERR
{ false; }; printf survived
`,
    });

    expect(execution.stdout.text).toBe(`\
err
survived`);
    expect(execution.stderr.text).toBe('');
    expect(execution.result.exitCode).toBe(0);
  });
});
