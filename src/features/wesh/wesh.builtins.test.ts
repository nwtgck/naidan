import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { promiseAllKeyed } from '@/utils/promise';
import { Wesh } from './index';
import { createTextShellSource } from '@/features/wesh/shell/source';
import type { WeshProcess } from './types';
import { aliasCommandDefinition } from './commands/alias/definition';
import { catCommandDefinition } from './commands/cat/definition';
import { cdCommandDefinition } from './commands/cd/definition';
import { commandCommandDefinition } from './commands/command/definition';
import { execCommandDefinition } from './commands/exec/definition';
import { mkdirCommandDefinition } from './commands/mkdir/definition';
import { printfCommandDefinition } from './commands/printf/definition';
import { shoptCommandDefinition } from './commands/shopt/definition';
import { sleepCommandDefinition } from './commands/sleep/definition';
import { trapCommandDefinition } from './commands/trap/definition';
import { MockFileSystemDirectoryHandle } from './mocks/InMemoryFileSystem';
import {
  createTestReadHandleFromText,
  createTestWriteCaptureHandle,
} from './utils/test-stream';

describe('wesh shell builtins', () => {
  let wesh: Wesh;
  let rootHandle: MockFileSystemDirectoryHandle;

  beforeAll(async () => {
    await promiseAllKeyed({
      alias: aliasCommandDefinition.loadShellBuiltin(),
      cat: catCommandDefinition.load(),
      cd: cdCommandDefinition.loadShellBuiltin(),
      command: commandCommandDefinition.loadShellBuiltin(),
      exec: execCommandDefinition.loadShellBuiltin(),
      mkdir: mkdirCommandDefinition.load(),
      printf: printfCommandDefinition.loadShellBuiltin(),
      shopt: shoptCommandDefinition.loadShellBuiltin(),
      sleep: sleepCommandDefinition.load(),
      trap: trapCommandDefinition.loadShellBuiltin(),
    });
  });

  beforeEach(async () => {
    rootHandle = new MockFileSystemDirectoryHandle({ name: 'root' });
    wesh = new Wesh({ rootHandle: rootHandle as unknown as FileSystemDirectoryHandle });
    await wesh.init();
  });

  async function writeFile({
    name,
    data,
  }: {
    name: string,
    data: string,
  }) {
    const handle = await rootHandle.getFileHandle(name, { create: true });
    const writable = await handle.createWritable();
    await writable.write(data);
    await writable.close();
  }

  async function execute({
    script,
  }: {
    script: string,
  }) {
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

  it('runs eval in the current shell context', async () => {
    const evaluated = await execute({
      script: 'eval \'FOO=bar; echo "$FOO"\'',
    });

    expect(evaluated.stdout.text).toBe('bar\n');
    expect(evaluated.stderr.text).toBe('');
    expect(evaluated.result.exitCode).toBe(0);

    const persisted = await execute({
      script: 'echo "$FOO"',
    });

    expect(persisted.stdout.text).toBe('bar\n');
    expect(persisted.stderr.text).toBe('');
    expect(persisted.result.exitCode).toBe(0);
  });

  it('keeps the shell running when exec has no replacement command after option parsing', async () => {
    const executed = await execute({
      script: `\
exec --
printf 'after\n'
`,
    });

    expect(executed.stdout.text).toBe('after\n');
    expect(executed.stderr.text).toBe('');
    expect(executed.result.exitCode).toBe(0);
  });

  it('keeps the shell running after exec help', async () => {
    const executed = await execute({
      script: `\
exec --help
printf 'after\n'
`,
    });

    expect(executed.stdout.text).toContain('usage: exec');
    expect(executed.stdout.text).toMatch(/after\n$/u);
    expect(executed.stderr.text).toBe('');
    expect(executed.result.exitCode).toBe(0);
  });

  it('supports exec with persistent read-write file descriptors for read -u', async () => {
    await writeFile({
      name: 'fd.txt',
      data: `\
alpha
beta
`,
    });

    const executed = await execute({
      script: `\
exec 3<> fd.txt
read -u 3 first
read -u 3 second
echo "$first,$second"`,
    });

    expect(executed.stdout.text).toBe('alpha,beta\n');
    expect(executed.stderr.text).toBe('');
    expect(executed.result.exitCode).toBe(0);
  });

  it('supports input fd duplication with <&n redirection', async () => {
    await writeFile({ name: 'dup.txt', data: 'from-fd\n' });

    const executed = await execute({
      script: `\
exec 3< dup.txt
cat <&3`,
    });

    expect(executed.stdout.text).toBe('from-fd\n');
    expect(executed.stderr.text).toBe('');
    expect(executed.result.exitCode).toBe(0);
  });

  it('expands aliases before appending invocation arguments', async () => {
    const executed = await execute({
      script: `\
alias greet='echo hello'
greet world`,
    });

    expect(executed.stdout.text).toBe('hello world\n');
    expect(executed.stderr.text).toBe('');
    expect(executed.result.exitCode).toBe(0);
  });

  it('resolves aliases before shell functions for the invoked command name', async () => {
    const executed = await execute({
      script: `\
greet() {
  echo function "$@"
}
alias greet='echo alias'
greet world`,
    });

    expect(executed.stdout.text).toBe('alias world\n');
    expect(executed.stderr.text).toBe('');
    expect(executed.result.exitCode).toBe(0);
  });

  it('supports output fd duplication with >&n redirection', async () => {
    const executed = await execute({
      script: 'echo duplicated >&2',
    });

    expect(executed.stdout.text).toBe('');
    expect(executed.stderr.text).toBe('duplicated\n');
    expect(executed.result.exitCode).toBe(0);
  });

  it('supports chained file descriptor duplication for output handles', async () => {
    const executed = await execute({
      script: `\
exec 3>&2
exec 4>&3
echo chained >&4`,
    });

    expect(executed.stdout.text).toBe('');
    expect(executed.stderr.text).toBe('chained\n');
    expect(executed.result.exitCode).toBe(0);
  });

  it('releases replaced exec descriptor references so FIFO readers observe EOF', async () => {
    const executed = await execute({
      script: `\
mkfifo fifo
cat fifo > output.txt &
pid=$!
exec 3> fifo
printf 'line\n' >&3
exec 3>&-
wait "$pid"
cat output.txt
`,
    });

    expect(executed.stdout.text).toBe('line\n');
    expect(executed.stderr.text).toBe('');
    expect(executed.result.exitCode).toBe(0);
  });

  it('does not leak subshell-local exec descriptors into later top-level execution', async () => {
    const subshell = await execute({
      script: '(exec 3> subshell-only.txt)',
    });
    expect(subshell.stdout.text).toBe('');
    expect(subshell.stderr.text).toBe('');
    expect(subshell.result.exitCode).toBe(0);

    const parent = await execute({
      script: 'printf leaked >&3',
    });
    const handle = await rootHandle.getFileHandle('subshell-only.txt');
    const file = await handle.getFile();

    expect(await file.text()).toBe('');
    expect(parent.stdout.text).toBe('');
    expect(parent.stderr.text).toContain('bad file descriptor');
    expect(parent.result.exitCode).not.toBe(0);
  });

  it('keeps duplicated input descriptors readable after closing the original descriptor', async () => {
    await writeFile({ name: 'dup-input.txt', data: 'alpha\n' });

    const executed = await execute({
      script: `\
exec 3< dup-input.txt
exec 4<&3
exec 3<&-
cat <&4`,
    });

    expect(executed.stdout.text).toBe('alpha\n');
    expect(executed.stderr.text).toBe('');
    expect(executed.result.exitCode).toBe(0);
  });

  it.each([
    { script: '/bin/sh -c \'printf "%s:%s:%s:%s:%s" "$$" "$BASHPID" "$PPID" "$0" "$1"\' child-zero arg', commands: ['/bin/sh'] },
    { script: 'launch-shell', commands: ['launch-shell', '/bin/sh'] },
  ])('executes a shell program in its command process for $script', async ({ script, commands }) => {
    wesh.registerCommand({
      definition: {
        meta: { name: 'launch-shell', description: 'Run a child shell', usage: 'launch-shell' },
        load: async () => async ({ context }) => context.executeCommand({
          command: '/bin/sh',
          args: ['-c', 'printf "%s:%s:%s:%s:%s" "$$" "$BASHPID" "$PPID" "$0" "$1"', 'child-zero', 'arg'],
        }),
      },
    });
    const rootPid = wesh.kernel.getProcesses().find(process => process.image === 'wesh')!.pid;
    const spawned: WeshProcess[] = [];
    const spawn = wesh.kernel.spawn.bind(wesh.kernel);
    using _spawn = vi.spyOn(wesh.kernel, 'spawn').mockImplementation(async options => {
      const result = await spawn(options);
      spawned.push(result.process);
      return result;
    });

    const executed = await execute({ script });
    const shell = spawned.at(-1)!;
    expect(spawned.map(process => process.args[0])).toEqual(commands);
    expect(shell.ppid).toBe(spawned.at(-2)?.pid ?? rootPid);
    expect(executed.stdout.text).toBe(`${shell.pid}:${shell.pid}:${shell.ppid}:child-zero:arg`);
    expect(executed.stderr.text).toBe('');
    expect(executed.result.exitCode).toBe(0);
  });

  it('uses the shell program descriptors and respects an explicitly closed descriptor', async () => {
    await writeFile({ name: 'input', data: 'input' });
    const executed = await execute({
      script: `\
exec 3>persist
sh -c 'cat; printf A >&3; printf err >&2' <input >output 2>errors
bash -c 'printf hidden >&3' 3>&-
printf 'status:%s\n' "$?"
bash -c 'printf B >&3; exec 4>child-only; printf child >&4'
exec 3>&-
cat output errors persist child-only`,
    });
    expect(executed.result.exitCode).toBe(0);
    expect(executed.stdout.text).toBe(`\
status:1
inputerrABchild`);
    expect(executed.stderr.text).toBe('wesh: 3: bad file descriptor\n');
  });

  it('starts a fresh shell with exported variables, inherited ignores, and its own exit trap', async () => {
    const executed = await execute({
      script: `\
mkdir sub
cd sub
export CHILD_EXPORTED=visible
CHILD_LOCAL=hidden
alias inherited='printf wrong'
parent_fn() { printf wrong; }
shopt -s nullglob
trap 'printf parent-int' INT
trap 'printf parent-exit' EXIT
trap '' PIPE
/bin/bash -c 'alias; command -v parent_fn; trap -p INT EXIT PIPE; printf "%s:%s:%s:%s:%s\\n" "$0" "$PWD" "$CHILD_EXPORTED" "$CHILD_LOCAL" missing-*; trap "printf child-exit" EXIT'
trap - EXIT INT PIPE`,
    });
    expect(executed.result.exitCode).toBe(0);
    expect(executed.stdout.text).toBe(`\
trap -- '' SIGPIPE
/bin/bash:/sub:visible::missing-*
child-exit`);
    expect(executed.stderr.text).toBe('');
  });

  it('runs the child INT and EXIT traps and the caller INT trap once on interruption', async () => {
    const controller = new AbortController();
    const waiting = Promise.withResolvers<void>();
    const wait = wesh.kernel.waitForSignalOrTimeout.bind(wesh.kernel);
    using _wait = vi.spyOn(wesh.kernel, 'waitForSignalOrTimeout').mockImplementation(options => {
      waiting.resolve();
      return wait(options);
    });
    const stdout = createTestWriteCaptureHandle();
    const stderr = createTestWriteCaptureHandle();
    const script = `\
trap 'printf root-int' INT
sh -c "trap 'printf child-int' INT; trap 'printf child-exit' EXIT; sleep 5; printf late"
printf late`;
    const execution = wesh.execute({
      source: createTextShellSource({ text: script }),
      stdin: createTestReadHandleFromText({ text: '' }),
      stdout: stdout.handle,
      stderr: stderr.handle,
      signal: controller.signal,
    });
    await waiting.promise;
    controller.abort();
    await wesh.interruptForeground({ foregroundSignal: controller.signal });

    await expect(execution).resolves.toMatchObject({ exitCode: 130, waitStatus: { kind: 'signaled', signal: 2 } });
    expect(stdout.text).toBe('child-intchild-exitroot-int');
    expect(stderr.text).toBe('');
  });
});
