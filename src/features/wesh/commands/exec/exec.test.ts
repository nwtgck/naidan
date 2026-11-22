import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { Wesh } from '@/features/wesh/index';
import { createTextShellSource } from '@/features/wesh/shell/source';
import { MockFileSystemDirectoryHandle } from '@/features/wesh/mocks/InMemoryFileSystem';
import {
  createTestReadHandleFromText,
  createTestWriteCaptureHandle,
} from '@/features/wesh/utils/test-stream';
import { execCommandDefinition } from './definition';

beforeAll(async () => {
  await execCommandDefinition.loadShellBuiltin();
});

describe('wesh exec', () => {
  let wesh: Wesh;
  let rootHandle: MockFileSystemDirectoryHandle;

  beforeEach(async () => {
    rootHandle = new MockFileSystemDirectoryHandle({ name: 'root' });
    wesh = new Wesh({ rootHandle: rootHandle as unknown as FileSystemDirectoryHandle });
    await wesh.init();
  });

  async function execute({
    script,
    signal,
  }: {
    script: string,
    signal?: AbortSignal,
  }) {
    const stdout = createTestWriteCaptureHandle();
    const stderr = createTestWriteCaptureHandle();

    const result = await wesh.execute({
      source: createTextShellSource({ text: script }),
      stdin: createTestReadHandleFromText({ text: '' }),
      stdout: stdout.handle,
      stderr: stderr.handle,
      signal,
    });

    return { result, stdout, stderr };
  }

  it('prints help and rejects invalid options', async () => {
    const help = await execute({ script: 'exec --help' });
    const invalid = await execute({ script: 'exec --bogus' });

    expect(help.stdout.text).toContain('Replace the shell command context');
    expect(help.stdout.text).toContain('usage: exec [-cl] [-a name] [command [arg...]]');
    expect(help.stdout.text).toContain('--help');
    expect(help.stderr.text).toBe('');
    expect(help.result.exitCode).toBe(0);

    expect(invalid.stdout.text).toBe('');
    expect(invalid.stderr.text).toContain("exec: unrecognized option '--bogus'");
    expect(invalid.stderr.text).toContain('usage: exec [-cl] [-a name] [command [arg...]]');
    expect(invalid.stderr.text).toContain('try:');
    expect(invalid.result.exitCode).toBe(2);
  });

  it('accepts Bash exec option bundles and argv0 forms before a command', async () => {
    for (const script of [
      'exec -c',
      'exec -l',
      'exec -cl',
      'exec -lc',
      'exec -a custom',
      'exec -acustom',
    ]) {
      const { result, stdout, stderr } = await execute({ script });
      expect(stdout.text).toBe('');
      expect(stderr.text).toBe('');
      expect(result.exitCode).toBe(0);
    }
  });

  it('keeps command arguments out of exec option parsing', async () => {
    for (const script of [
      'exec true -c',
      'exec true -l',
      'exec true -a',
      'exec -- true -c',
    ]) {
      const { result, stdout, stderr } = await execute({ script });
      expect(stdout.text).toBe('');
      expect(stderr.text).toBe('');
      expect(result.exitCode).toBe(0);
    }
  });

  it('rejects a missing exec -a value as an argv error', async () => {
    const { result, stdout, stderr } = await execute({ script: 'exec -a' });

    expect(stdout.text).toBe('');
    expect(stderr.text).toContain('-a requires a value for NAME');
    expect(result.exitCode).toBe(2);
  });

  it('consumes -- as the required value of -a before reading the program', async () => {
    const { result, stdout, stderr } = await execute({
      script: 'exec -a -- bash -c \'printf "%s\\n" "$0"\'',
    });

    expect(stdout.text).toBe('--\n');
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
  });

  it('runs the new shell in the same process and retires it before the next input', async () => {
    const script = `\
printf '%s:%s\\n' "$BASHPID" "$PPID"
trap 'printf "old EXIT\\n"' EXIT
exec bash -c 'printf "%s:%s\\n" "$BASHPID" "$PPID"; trap "echo new EXIT" EXIT; exit 7'
printf unreachable
`;
    const { result, stdout, stderr } = await execute({ script });
    const [oldProcess, newProcess, ...remaining] = stdout.text.trimEnd().split('\n');

    expect(oldProcess).toMatch(/^\d+:\d+$/u);
    expect(newProcess).toBe(oldProcess);
    expect(remaining).toEqual(['new EXIT']);
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(7);
    expect(wesh.kernel.getProcesses()).toHaveLength(1);

    const next = await execute({ script: 'printf "%s:%s" "$BASHPID" "$PPID"' });
    expect(next.stdout.text).not.toBe(oldProcess);
  });

  it('publishes inherited and command-specific file descriptors when the new program exits', async () => {
    const script = `\
exec 3>inherited
exec bash -c 'printf old-fd >&3; printf new-fd >&4' 4>redirected
printf unreachable
`;
    const { result, stdout, stderr } = await execute({ script });
    expect(result.exitCode).toBe(0);
    expect(stdout.text).toBe('');
    expect(stderr.text).toBe('');

    const next = await execute({ script: 'cat inherited redirected' });
    expect(next.stdout.text).toBe('old-fdnew-fd');
    expect(next.stderr.text).toBe('');
  });

  it('applies exec flags to the program argv and exported environment', async () => {
    const script = `\
export MARKER=old
MARKER=prefix exec -cl -a custom bash -c 'printf "%s:%s" "$0" "\${MARKER-unset}"'
`;
    const { result, stdout, stderr } = await execute({ script });

    expect(stdout.text).toBe('-custom:unset');
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
  });

  it('runs the old EXIT trap when a target cannot be resolved inside a conditional', async () => {
    const script = `\
trap 'printf "EXIT\\n"' EXIT
if exec /missing/true; then printf unexpected; fi
printf unreachable
`;
    const { result, stdout, stderr } = await execute({ script });

    expect(stdout.text).toBe('EXIT\n');
    expect(stderr.text).toContain('Command not found: /missing/true');
    expect(result.exitCode).toBe(127);
  });

  it('ends the current shell on an exec lookup failure and uses the active redirections for its EXIT trap', async () => {
    const script = `\
trap 'printf old-exit >&2' EXIT
eval 'exec missing-program 2>failure'
printf unreachable
`;
    const failed = await execute({ script });

    expect(failed.stdout.text).toBe('');
    expect(failed.stderr.text).toBe('');
    expect(failed.result.exitCode).toBe(127);

    const logHandle = await rootHandle.getFileHandle('failure');
    const log = await logHandle.getFile();
    const logged = await log.text();
    expect(logged).toContain('Command not found: missing-program');
    expect(logged).toMatch(/old-exit$/u);
  });

  it('reports an exec lookup failure in a subshell to its parent without exiting it', async () => {
    const { result, stdout, stderr } = await execute({ script: '(exec missing-program 2>&-; printf unreachable); printf "%s" "$?"' });

    expect(stdout.text).toBe('127');
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
  });

  it('keeps process substitution available until the replacement program finishes', async () => {
    const { result, stdout, stderr } = await execute({ script: 'exec cat <(seq 1 20000) | wc -c' });

    expect(stdout.text.trim()).toBe('108894');
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
  });

  it('releases the reader before waiting on a partially consumed process substitution', async () => {
    const { result, stdout, stderr } = await execute({ script: 'exec head -n 1 <(seq 1 20000)' });

    expect(stdout.text).toBe('1\n');
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
  });

  it('passes an explicitly closed standard descriptor to the new shell', async () => {
    const { result, stdout, stderr } = await execute({ script: `exec bash -c 'cat <&0 || printf closed' 0<&-` });

    expect(stdout.text).toBe('closed');
    expect(stderr.text).toContain('bad file descriptor');
    expect(result.exitCode).toBe(0);
  });

  it('continues shell evaluation when its diagnostic descriptor is closed', async () => {
    const { result, stdout, stderr } = await execute({ script: 'exec 2>&-; missing-command; printf after' });

    expect(stdout.text).toBe('after');
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
  });

  it('releases the new program’s redirections before waiting for a substitution producer', async () => {
    const { result, stdout, stderr } = await execute({ script: 'exec true < <(seq 1 20000)' });

    expect(stdout.text).toBe('');
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
  });

  it.each(['exec', 'command exec'])('keeps a substitution producer connected to an FD installed by %s', async (command) => {
    const setup = await execute({ script: `${command} 3< <(seq 1 20000); printf ready` });

    expect(setup.stdout.text).toBe('ready');
    expect(setup.stderr.text).toBe('');
    expect(setup.result.exitCode).toBe(0);

    const consume = await execute({ script: 'cat <&3 | wc -c; exec 3<&-' });
    expect(consume.stdout.text.trim()).toBe('108894');
    expect(consume.stderr.text).toBe('');
    expect(consume.result.exitCode).toBe(0);
  });

  it('allows a duplicated persistent FD to feed a substitution consumer before waiting for it', async () => {
    const script = `\
exec 3> >(wc -c >bytes)
consumer=$!
exec 4>&3 3>&-
seq 1 '20000' >&4
exec 4>&-
wait "$consumer"
cat bytes
`;
    const { result, stdout, stderr } = await execute({ script });

    expect(stdout.text.trim()).toBe('108894');
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
  });

  it('keeps an interrupted exec from installing a descriptor after its implementation loads', async () => {
    const loading = Promise.withResolvers<void>();
    const loaded = Promise.withResolvers<void>();
    const load = execCommandDefinition.loadShellBuiltin;
    const spy = vi.spyOn(execCommandDefinition, 'loadShellBuiltin').mockImplementation(async () => {
      loading.resolve();
      await loaded.promise;
      return load();
    });
    using _cleanup = {
      [Symbol.dispose]() {
        loaded.resolve();
        spy.mockRestore();
      },
    };
    const controller = new AbortController();
    const execution = execute({ script: 'exec 3>held; printf unreachable', signal: controller.signal });

    await loading.promise;
    controller.abort();
    await wesh.interruptForeground({ foregroundSignal: controller.signal });
    loaded.resolve();

    expect((await execution).result.exitCode).toBe(130);
    const next = await execute({ script: 'printf leaked >&3; exec 3>&-; cat held' });
    expect(next.stdout.text).toBe('');
    expect(next.stderr.text).toContain('3: bad file descriptor');
  });

  it('preserves the signal dispositions ignored at the new shell startup', async () => {
    const script = `\
trap '' INT
exec bash -c 'trap "printf changed" INT; trap -p INT'
`;
    const { result, stdout, stderr } = await execute({ script });

    expect(stdout.text).toBe("trap -- '' SIGINT\n");
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
  });

  it('preserves a replacement from an EXIT trap and omits timing after a replacement', async () => {
    const fromTrap = await execute({ script: `trap 'exec false' EXIT; exit 0` });
    const timed = await execute({ script: 'time -p exec printf replaced; printf unreachable' });

    expect(fromTrap.result.exitCode).toBe(1);
    expect(fromTrap.stderr.text).toBe('');
    expect(timed.result.exitCode).toBe(0);
    expect(timed.stdout.text).toBe('replaced');
    expect(timed.stderr.text).toBe('');
  });
});
