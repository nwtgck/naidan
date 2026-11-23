import { assert, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { promiseAllKeyed } from '@/utils/promise';
import { Wesh } from './index';
import { catCommandDefinition } from './commands/cat/definition';
import { commandCommandDefinition } from './commands/command/definition';
import { evalCommandDefinition } from './commands/eval/definition';
import { execCommandDefinition } from './commands/exec/definition';
import { headCommandDefinition } from './commands/head/definition';
import { mkfifoCommandDefinition } from './commands/mkfifo/definition';
import { printfCommandDefinition } from './commands/printf/definition';
import { readCommandDefinition } from './commands/read/definition';
import { wcCommandDefinition } from './commands/wc/definition';
import { createTextShellSource } from './shell/source';
import { MockFileSystemDirectoryHandle } from './mocks/InMemoryFileSystem';
import type { WeshCommandFunction, WeshProcess } from './types';
import { createTestReadHandleFromText, createTestWriteCaptureHandle } from './utils/test-stream';

describe('Compound commands in pipelines', () => {
  it('keeps a numeric operand before a separate stderr redirection in a stage', async () => {
    const { result, stdout, stderr } = await execute({ script: "printf '%s' 7 >&2 | cat" });

    expect(result.exitCode).toBe(0);
    expect(stdout).toBe('');
    expect(stderr).toBe('7');
  });

  let wesh: Wesh;
  let root: MockFileSystemDirectoryHandle;

  beforeAll(async () => {
    await promiseAllKeyed({
      cat: catCommandDefinition.load(),
      command: commandCommandDefinition.loadShellBuiltin(),
      eval: evalCommandDefinition.loadShellBuiltin(),
      exec: execCommandDefinition.loadShellBuiltin(),
      head: headCommandDefinition.load(),
      mkfifo: mkfifoCommandDefinition.load(),
      printf: printfCommandDefinition.loadShellBuiltin(),
      read: readCommandDefinition.loadShellBuiltin(),
      wc: wcCommandDefinition.load(),
    });
  });

  beforeEach(async () => {
    root = new MockFileSystemDirectoryHandle({ name: 'root' });
    wesh = new Wesh({
      rootHandle: root as unknown as FileSystemDirectoryHandle,
    });
    await wesh.init();
  });

  async function execute({ script, signal }: { script: string, signal?: AbortSignal }) {
    const stdout = createTestWriteCaptureHandle();
    const stderr = createTestWriteCaptureHandle();
    const result = await wesh.execute({
      source: createTextShellSource({ text: script }),
      stdin: createTestReadHandleFromText({ text: '' }),
      stdout: stdout.handle,
      stderr: stderr.handle,
      signal,
    });
    return { result, stdout: stdout.text, stderr: stderr.text };
  }

  function failFirstOpenedFileClose() {
    const open = wesh.kernel.open.bind(wesh.kernel);
    return vi.spyOn(wesh.kernel, 'open').mockImplementationOnce(async options => {
      const handle = await open(options);
      const close = handle.close.bind(handle);
      handle.close = async () => {
        await close();
        throw new Error('mock close failure');
      };
      return handle;
    });
  }

  function recordSpawnedProcesses() {
    const processes: WeshProcess[] = [];
    const spawn = wesh.kernel.spawn.bind(wesh.kernel);
    const spy = vi.spyOn(wesh.kernel, 'spawn').mockImplementation(async options => {
      const result = await spawn(options);
      processes.push(result.process);
      return result;
    });
    return {
      processes,
      [Symbol.dispose]() {
        spy.mockRestore();
      },
    };
  }

  function registerSelfSignalingCommand() {
    const name = 'die-term';
    wesh.registerCommand({
      definition: {
        meta: { name, description: 'Signal only the test process', usage: name },
        load: async () => async ({ context }) => {
          await context.process.signalSelf({ signal: 15 });
          return { exitCode: 0 };
        },
      },
    });
    return name;
  }

  it.each([
    { script: `bash -c 'set -o pipefail; trap "printf EXIT:%s \\$?" EXIT; die-term | cat'`, shellOutput: 'EXIT:143', context: 'a fresh shell' },
    { script: `(trap 'printf EXIT:%s "$?"' EXIT; die-term)`, shellOutput: 'EXIT:143', context: 'a subshell' },
    { script: `set -o pipefail; { trap 'printf EXIT:%s "$?"' EXIT; die-term; } | cat`, shellOutput: 'EXIT:143', context: 'a compound pipeline stage' },
    { script: 'env die-term', shellOutput: '', context: 'an ordinary command starting a child' },
  ])('records a numeric exit for $context when only its child received SIGTERM', async ({ script, shellOutput }) => {
    const name = registerSelfSignalingCommand();
    using spawned = recordSpawnedProcesses();

    const { result, stdout, stderr } = await execute({ script });

    const child = spawned.processes.find(process => process.image === name);
    assert(child !== undefined);
    const parent = spawned.processes.find(process => process.pid === child.ppid);
    assert(parent !== undefined);
    expect(child.waitStatus).toEqual({ kind: 'signaled', signal: 15 });
    expect(parent.waitStatus).toEqual({ kind: 'exited', exitCode: 143 });
    expect(result).toEqual({ exitCode: 143, waitStatus: { kind: 'exited', exitCode: 143 } });
    expect(stdout).toBe(shellOutput);
    expect(stderr).toBe('');
  });

  it('retains a signal delivered to the image that replaced a shell with exec', async () => {
    const name = registerSelfSignalingCommand();
    using spawned = recordSpawnedProcesses();

    const { result, stdout, stderr } = await execute({ script: `bash -c 'trap "printf old" EXIT; exec die-term'` });

    expect(spawned.processes).toHaveLength(1);
    expect(spawned.processes[0]).toMatchObject({ image: name, waitStatus: { kind: 'signaled', signal: 15 } });
    expect(result).toEqual({ exitCode: 143, waitStatus: { kind: 'signaled', signal: 15 } });
    expect(stdout).toBe('');
    expect(stderr).toBe('');
  });

  it.each([
    'exec signal-then-stop',
    `bash -c 'exec signal-then-stop'`,
    '{ exec signal-then-stop; } | cat',
  ])('preserves an exec image signal when Stop follows it in %s', async script => {
    const controller = new AbortController();
    const name = 'signal-then-stop';
    wesh.registerCommand({
      definition: {
        meta: { name, description: 'Signal the test image before stopping the input', usage: name },
        load: async () => async ({ context }) => {
          await context.process.signalSelf({ signal: 15 });
          expect(context.process.getWaitStatus()).toEqual({ kind: 'signaled', signal: 15 });
          controller.abort();
          await wesh.interruptForeground({ foregroundSignal: controller.signal });
          return { exitCode: 0 };
        },
      },
    });
    const reaped: WeshProcess[] = [];
    const reap = wesh.kernel.reapProcess.bind(wesh.kernel);
    using _record = vi.spyOn(wesh.kernel, 'reapProcess').mockImplementation(({ pid }) => {
      const process = wesh.kernel.getProcess({ pid });
      if (process?.image === name) {
        reaped.push(process);
      }
      reap({ pid });
    });

    const { result, stdout, stderr } = await execute({ script, signal: controller.signal });

    expect(result).toEqual({ exitCode: 130, waitStatus: { kind: 'signaled', signal: 2 } });
    expect(reaped).toHaveLength(1);
    expect(reaped[0]?.waitStatus).toEqual({ kind: 'signaled', signal: 15 });
    expect(stdout).toBe('');
    expect(stderr).toBe('');
  });

  it.each([
    { script: `bash -c 'printf X'`, status: { kind: 'signaled', signal: 13 } },
    { script: `bash -c 'trap ":" EXIT; bash -c "printf X"'`, status: { kind: 'exited', exitCode: 141 } },
  ])('attributes a builtin SIGPIPE to the shell that wrote to the pipe in $script', async ({ script, status }) => {
    const { read, write } = await wesh.kernel.pipe();
    await read.close();
    await using _writer = { [Symbol.asyncDispose]: () => write.close() };
    using spawned = recordSpawnedProcesses();
    const stderr = createTestWriteCaptureHandle();

    const result = await wesh.execute({
      source: createTextShellSource({ text: script }),
      stdin: createTestReadHandleFromText({ text: '' }),
      stdout: write,
      stderr: stderr.handle,
    });

    const shells = spawned.processes.filter(process => process.image === '/bin/bash');
    expect(shells.at(-1)?.waitStatus).toEqual({ kind: 'signaled', signal: 13 });
    expect(shells[0]?.waitStatus).toEqual(status);
    expect(result).toEqual({ exitCode: 141, waitStatus: status });
    expect(stderr.text).toBe('');
  });

  function registerPidProbe() {
    wesh.registerCommand({
      definition: {
        meta: { name: 'stage-pid', description: 'Print the command PID', usage: 'stage-pid' },
        load: async () => async ({ context }) => {
          await context.text().print({ text: `${context.pid}\n` });
          return { exitCode: 0 };
        },
      },
    });
  }

  it.each([
    'eof-probe < <(exec 1>&-; park)',
    'eof-probe <(exec 1>&-; park)',
    'eof-probe < <(exec park >/dev/null)',
  ])('releases the pipe when the producer closes its descriptor: %s', async script => {
    const running = Promise.withResolvers<void>();
    const resume = Promise.withResolvers<void>();
    using _resume = { [Symbol.dispose]: () => resume.resolve() };
    let bytesRead: number | undefined;
    wesh.registerCommand({
      definition: {
        meta: { name: 'eof-probe', description: 'Wait for EOF from the producer', usage: 'eof-probe [file]' },
        load: async () => async ({ context }) => {
          const path = context.args[0];
          const input = path === undefined ? context.stdin : await context.files.open({
            path,
            flags: { access: 'read', creation: 'never', truncate: 'preserve', append: 'preserve' },
          });
          ({ bytesRead } = await input.read({ buffer: new Uint8Array(1) }));
          return { exitCode: 0 };
        },
      },
    });
    wesh.registerCommand({
      definition: {
        meta: { name: 'park', description: 'Keep the producer alive', usage: 'park' },
        load: async () => async () => {
          running.resolve();
          await resume.promise;
          return { exitCode: 0 };
        },
      },
    });

    const execution = execute({ script });
    await running.promise;
    await vi.waitFor(() => expect(bytesRead).toBe(0));
    resume.resolve();
    await expect(execution).resolves.toMatchObject({ result: { exitCode: 0 }, stderr: '' });
  });

  it('uses one process per stage with direct commands and a redirected subshell', async () => {
    registerPidProbe();
    const shell = wesh.kernel.getProcesses().find(process => process.image === 'wesh');
    assert(shell !== undefined);
    using spawned = recordSpawnedProcesses();

    const { result, stdout, stderr } = await execute({
      script: `\
stage-pid | (
  read -r upstream
  printf '%s:%s' "$upstream" "$BASHPID" >&3
  printf redirected
) 3>&1 >out | cat
`,
    });

    expect(result.exitCode).toBe(0);
    expect(stderr).toBe('');
    expect(spawned.processes).toHaveLength(3);
    const [left, middle, right] = spawned.processes;
    assert(left !== undefined && middle !== undefined && right !== undefined);
    expect(stdout).toBe(`${left.pid}:${middle.pid}`);
    expect(spawned.processes.map(process => process.ppid)).toEqual([shell.pid, shell.pid, shell.pid]);
    expect(spawned.processes.map(process => process.pgid)).toEqual([left.pgid, left.pgid, left.pgid]);
    const file = await root.getFileHandle('out');
    expect(await (await file.getFile()).text()).toBe('redirected');
  });

  it('runs a shebang interpreter on the stage PID and preserves its inherited descriptor', async () => {
    const file = await root.getFileHandle('stage-script', { create: true });
    const writer = await file.createWritable();
    await writer.write(`\
#!/bin/sh
printf '%s' "$BASHPID"
printf retained >&3
`);
    await writer.close();
    using spawned = recordSpawnedProcesses();

    const { result, stdout, stderr } = await execute({
      script: `\
exec 3>out
/stage-script | cat
exec 3>&-
`,
    });

    expect(result.exitCode).toBe(0);
    expect(stderr).toBe('');
    expect(spawned.processes).toHaveLength(2);
    const [scriptStage] = spawned.processes;
    assert(scriptStage !== undefined);
    expect(stdout).toBe(String(scriptStage.pid));
    const output = await root.getFileHandle('out');
    expect(await (await output.getFile()).text()).toBe('retained');
  });

  const stageBody = 'printf "%s\\n" "$BASHPID"; stage-pid; printf "tail:%s" "$BASHPID"';

  it.each([
    { name: 'eval', stage: `eval '${stageBody}'` },
    { name: 'command eval', stage: `command eval '${stageBody}'` },
    { name: 'a function', stage: 'stage-function' },
    { name: 'a brace group', stage: `{ ${stageBody}; }` },
    { name: 'a subshell', stage: `( ${stageBody} )` },
  ])('continues the stage after an ordinary command inside $name', async ({ stage }) => {
    registerPidProbe();
    using spawned = recordSpawnedProcesses();

    const { result, stdout, stderr } = await execute({
      script: `\
stage-function() { ${stageBody}; }
${stage} | cat
`,
    });

    expect(result.exitCode).toBe(0);
    expect(stderr).toBe('');
    expect(spawned.processes).toHaveLength(3);
    const [shellStage] = spawned.processes;
    assert(shellStage !== undefined);
    const child = spawned.processes.find(process => process.ppid === shellStage.pid);
    assert(child !== undefined);
    expect(stdout).toBe(`${shellStage.pid}\n${child.pid}\ntail:${shellStage.pid}`);
  });

  it('keeps parentheses inside a stage in their own child process', async () => {
    using spawned = recordSpawnedProcesses();

    const { result, stdout, stderr } = await execute({
      script: `\
( ( printf 'inner:%s\\n' "$BASHPID" ); printf 'stage:%s' "$BASHPID" ) | cat
`,
    });

    expect(result.exitCode).toBe(0);
    expect(stderr).toBe('');
    expect(spawned.processes).toHaveLength(3);
    const [stage] = spawned.processes;
    assert(stage !== undefined);
    const nested = spawned.processes.find(process => process.ppid === stage.pid);
    assert(nested !== undefined);
    expect(stdout).toBe(`inner:${nested.pid}\nstage:${stage.pid}`);
  });

  it('releases the downstream stage and reaps both stages when an ordinary stage is signaled', async () => {
    const originalProcesses = wesh.kernel.getProcesses();
    const { read, write } = await wesh.kernel.pipe();
    await using _pipe = {
      async [Symbol.asyncDispose]() {
        await write.close();
        await read.close();
      },
    };
    const left = Promise.withResolvers<number>();
    const right = Promise.withResolvers<void>();
    wesh.registerCommand({
      definition: {
        meta: { name: 'stage-read', description: 'Read a byte from a pipe', usage: 'stage-read SIDE' },
        load: async () => async ({ context }) => {
          const read = context.stdin.read({ buffer: new Uint8Array(1) });
          const upstream = context.args[0] === 'left';
          if (upstream) {
            left.resolve(context.pid);
          } else {
            right.resolve();
          }
          const { bytesRead } = await read;
          if (!upstream && bytesRead === 0) {
            await context.text().print({ text: 'eof' });
          }
          return { exitCode: 0 };
        },
      },
    });
    const stdout = createTestWriteCaptureHandle();
    const stderr = createTestWriteCaptureHandle();

    const execution = wesh.execute({
      source: createTextShellSource({ text: 'set -o pipefail; stage-read left | stage-read right' }),
      stdin: read,
      stdout: stdout.handle,
      stderr: stderr.handle,
    });
    const completed = vi.fn();
    void execution.then(completed, completed);
    const { pid } = await Promise.race([
      promiseAllKeyed({ pid: left.promise, downstream: right.promise }),
      execution.then(() => {
        throw new Error('Pipeline exited before both stages started reading');
      }),
    ]);
    await wesh.kernel.kill({ pid, signal: 15 });

    await vi.waitFor(() => expect(completed).toHaveBeenCalledOnce());
    await expect(execution).resolves.toMatchObject({ exitCode: 143, waitStatus: { kind: 'signaled', signal: 15 } });
    expect(stdout.text).toBe('eof');
    expect(stderr.text).toBe('');
    expect(write.hasOpenReferences()).toBe(true);
    expect(wesh.kernel.getProcesses()).toEqual(originalProcesses);
  });

  it('delivers EOF downstream while a redirected ordinary stage is still running', async () => {
    const started = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    using _release = { [Symbol.dispose]: () => release.resolve() };
    const received = vi.fn<(bytesRead: number) => void>();
    wesh.registerCommand({
      definition: {
        meta: { name: 'gate', description: 'Wait before writing', usage: 'gate' },
        load: async () => async ({ context }) => {
          started.resolve();
          await release.promise;
          await context.text().print({ text: 'redirected' });
          return { exitCode: 0 };
        },
      },
    });
    wesh.registerCommand({
      definition: {
        meta: { name: 'custom-reader', description: 'Read the pipeline input', usage: 'custom-reader' },
        load: async () => async ({ context }) => {
          await started.promise;
          const { bytesRead } = await context.stdin.read({ buffer: new Uint8Array(1) });
          received(bytesRead);
          return { exitCode: 0 };
        },
      },
    });

    const execution = execute({ script: 'gate >out | custom-reader' });

    await vi.waitFor(() => expect(received.mock.calls).toEqual([[0]]));
    release.resolve();
    const { result, stdout, stderr } = await execution;
    expect(result.exitCode).toBe(0);
    expect(stdout).toBe('');
    expect(stderr).toBe('');
    const output = await root.getFileHandle('out');
    expect(await (await output.getFile()).text()).toBe('redirected');
  });

  it('releases the reserved stages and their pipe when interrupted before the pipeline starts', async () => {
    const originalProcesses = wesh.kernel.getProcesses();
    const reserved = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    using _release = { [Symbol.dispose]: () => release.resolve() };
    const spawn = wesh.kernel.spawn.bind(wesh.kernel);
    using _spawn = vi.spyOn(wesh.kernel, 'spawn')
      .mockImplementationOnce(spawn)
      .mockImplementationOnce(async options => {
        const result = await spawn(options);
        reserved.resolve();
        await release.promise;
        return result;
      });
    using pipe = vi.spyOn(wesh.kernel, 'pipe');
    const command = vi.fn<WeshCommandFunction>(async () => ({ exitCode: 0 }));
    wesh.registerCommand({
      definition: {
        meta: { name: 'reservation-probe', description: 'Record execution', usage: 'reservation-probe' },
        load: async () => command,
      },
    });

    const execution = execute({ script: 'reservation-probe | reservation-probe; reservation-probe' });
    await reserved.promise;
    expect(wesh.kernel.getProcesses()).toHaveLength(originalProcesses.length + 2);
    const opened = pipe.mock.results[0];
    assert(opened?.type === 'return');
    const { read, write } = await opened.value;

    await expect(wesh.signalForegroundProcessGroup({ signal: 2 })).resolves.toBe(true);
    release.resolve();

    const { result, stdout, stderr } = await execution;
    expect(result).toMatchObject({ exitCode: 130, waitStatus: { kind: 'signaled', signal: 2 } });
    expect(stdout).toBe('');
    expect(stderr).toBe('');
    expect(command).not.toHaveBeenCalled();
    expect(read.hasOpenReferences()).toBe(false);
    expect(write.hasOpenReferences()).toBe(false);
    expect(wesh.kernel.getProcesses()).toEqual(originalProcesses);
  });

  it.each([
    {
      name: 'a loop produces pipeline input',
      script: `\
for item in alpha beta; do
  printf '%s\n' "$item"
done | cat`,
      output: `\
alpha
beta
`,
    },
    {
      name: 'a group isolates its state in the pipeline',
      script: `\
value=parent
{ value=child; printf '%s\n' "$value"; } | cat
printf '%s\n' "$value"`,
      output: `\
child
parent
`,
    },
    {
      name: 'a compound middle stage consumes input before producing more output',
      script: `\
printf 'head\n' | { cat; printf 'tail\n'; } | cat`,
      output: `\
head
tail
`,
    },
    {
      name: 'stderr shorthand keeps compound stdout connected to the pipe',
      script: '{ printf foo; } |& wc -c',
      output: '3\n',
    },
    {
      name: 'redirecting stderr keeps both pipes connected to a compound middle stage',
      script: 'printf X | { cat; } 2>errors | wc -c',
      output: '1\n',
    },
    {
      name: 'stderr shorthand follows explicit compound redirections',
      script: `\
{ printf out; printf err >&2; } 2>errors |& wc -c
printf 'file:'
cat errors`,
      output: `\
6
file:`,
    },
    {
      name: 'a subshell sends stderr through the shorthand pipe',
      script: '(printf out; printf err >&2) |& wc -c',
      output: '6\n',
    },
    {
      name: 'an inner redirection inherits the outer output file',
      script: `\
{ { printf X; } 2>errors; } >out | wc -c
cat out`,
      output: `\
0
X`,
    },
    {
      name: 'a nested redirection inherits the shorthand stderr pipe',
      script: '{ { printf err >&2; } >inner; } |& wc -c',
      output: '3\n',
    },
    {
      name: 'a stage can use an additional descriptor redirected on the group',
      script: `\
{ printf X >&3; } 3>out | wc -c
cat out`,
      output: `\
0
X`,
    },
    {
      name: 'replacing a stage writer lets the downstream reader reach EOF before the body completes',
      script: `\
mkfifo sync
exec 3<>sync
{ head -c 1 sync; } >save | { cat; printf X >&3; }
exec 3>&-
cat save`,
      output: 'X',
    },
    {
      name: 'replacing a stage reader lets the upstream writer finish before the body completes',
      script: `\
mkfifo sync
exec 3<>sync
printf '%131072s' X >large
{ cat large 2>/dev/null; printf X >&3; } | { head -c 1 sync; } </dev/null
exec 3>&-`,
      output: 'X',
    },
    {
      name: 'replacing a stage writer preserves a separate duplicated descriptor',
      script: `\
{ printf pipe >&3; printf file; } 3>&1 >out | wc -c
cat out`,
      output: `\
4
file`,
    },
    {
      name: 'a nested redirection retains the pipe writer for later commands in the stage',
      script: `\
{ { printf inner; } >out; printf pipe; } | wc -c
cat out`,
      output: `\
4
inner`,
    },
    {
      name: 'output process substitution retains its reference to the pipe writer',
      script: '{ printf out; } > >(cat) | wc -c',
      output: '3\n',
    },
    {
      name: 'a conditional stage consumes pipeline input',
      script: `\
printf 'payload\n' | if true; then cat; else printf wrong; fi`,
      output: `\
payload
`,
    },
  ])('$name', async ({ script, output }) => {
    const { result, stdout, stderr } = await execute({ script });
    expect(result.exitCode).toBe(0);
    expect(stderr).toBe('');
    expect(stdout).toBe(output);
  });

  it.each([
    { option: '+o', expectedExitCode: 0 },
    { option: '-o', expectedExitCode: 1 },
  ])('finishes both adjacent stages when a compound redirection fails with set $option pipefail', async ({ option, expectedExitCode }) => {
    const initialProcessCount = wesh.kernel.getProcesses().length;
    const { result, stdout, stderr } = await execute({
      script: `\
set ${option} pipefail
printf '%131072s' X | { printf hidden; } > missing/file | wc -c`,
    });
    expect(result).toEqual({
      exitCode: expectedExitCode,
      waitStatus: { kind: 'exited', exitCode: expectedExitCode },
    });
    expect(stdout).toBe('0\n');
    expect(stderr).toMatch(/^wesh: NotFoundError: [^\n]+\n$/);
    expect(wesh.kernel.getProcesses()).toHaveLength(initialProcessCount);
  });

  it.each([
    { stage: '{ printf out; } 2>broken 3>&1', diagnostic: 'mock close failure', output: '3\n' },
    { stage: '{ printf out; } 2>broken 3>&1 4>&9', diagnostic: '9: bad file descriptor', output: '0\n' },
    { stage: '{ exec 3>broken 4>&1; printf out; }', diagnostic: 'mock close failure', output: '3\n' },
  ])('releases a duplicated pipe after another descriptor fails to close ($stage)', async ({ stage, diagnostic, output }) => {
    using _open = failFirstOpenedFileClose();
    const initialProcessCount = wesh.kernel.getProcesses().length;
    const { result, stdout, stderr } = await execute({
      script: `\
set -o pipefail
${stage} | wc -c`,
    });
    expect(result).toEqual({
      exitCode: 1,
      waitStatus: { kind: 'exited', exitCode: 1 },
    });
    expect(stdout).toBe(output);
    expect(stderr).toBe(`wesh: ${diagnostic}\n`);
    expect(wesh.kernel.getProcesses()).toHaveLength(initialProcessCount);
  });

  it('closes a process-owned pipe even when closing a descriptor rejects', async () => {
    const failingHandle = createTestWriteCaptureHandle().handle;
    const close = failingHandle.close.bind(failingHandle);
    using _failingClose = vi.spyOn(failingHandle, 'close').mockImplementationOnce(async () => {
      await close();
      throw new Error('mock close failure');
    });
    const { read, write } = await wesh.kernel.pipe();
    using closePipeWriter = vi.spyOn(write, 'close');
    const { pid } = await wesh.kernel.spawn({
      image: 'test',
      args: [],
      fds: new Map([[3, failingHandle]]),
    });
    wesh.kernel.registerOwnedHandle({ pid, handle: write });
    await using _cleanup = {
      async [Symbol.asyncDispose]() {
        await read.close();
        await write.close();
        wesh.kernel.reapProcess({ pid });
      },
    };

    await expect(wesh.kernel.kill({ pid, signal: 2 })).rejects.toThrow('mock close failure');
    expect(closePipeWriter).toHaveBeenCalledOnce();
    expect(await read.read({ buffer: new Uint8Array(1) })).toEqual({ bytesRead: 0 });
  });

  it.each(['wait-command', 'set -o pipefail; wait-command | cat'])('keeps SIGTERM when an accepted close fails in %s', async script => {
    const handle = createTestWriteCaptureHandle().handle;
    const releaseClose = Promise.withResolvers<void>();
    using _release = { [Symbol.dispose]: () => releaseClose.resolve() };
    using close = vi.spyOn(handle, 'close').mockImplementationOnce(async () => {
      await releaseClose.promise;
      throw new Error('accepted close failed');
    });
    using _open = vi.spyOn(wesh.kernel, 'open').mockResolvedValueOnce(handle);
    using closing = vi.spyOn(wesh.kernel, 'closeProcessResources');
    const started = Promise.withResolvers<number>();
    const name = 'wait-command';
    wesh.registerCommand({
      definition: {
        meta: { name, description: 'Wait while a descriptor is open', usage: name },
        load: async () => async ({ context }) => {
          await context.files.open({
            path: '/owned',
            flags: { access: 'write', creation: 'never', truncate: 'preserve', append: 'preserve' },
          });
          started.resolve(context.pid);
          await context.process.waitForSignalOrTimeout({ timeoutMs: Infinity });
          return { exitCode: 0 };
        },
      },
    });
    const execution = execute({ script });
    const pid = await started.promise;
    const process = wesh.kernel.getProcess({ pid });
    assert(process !== undefined);
    const stopped = expect(wesh.kernel.kill({ pid, signal: 15 })).rejects.toThrow('accepted close failed');
    await vi.waitFor(() => expect(closing).toHaveBeenCalledWith({ pid }));
    expect(wesh.kernel.getProcess({ pid })).toBe(process);
    releaseClose.resolve();

    await stopped;
    const { result, stderr } = await execution;
    expect(result).toEqual({ exitCode: 143, waitStatus: { kind: 'signaled', signal: 15 } });
    expect(process.waitStatus).toEqual(result.waitStatus);
    expect(wesh.kernel.getProcess({ pid })).toBeUndefined();
    expect(close).toHaveBeenCalledOnce();
    expect(stderr).toBe('wesh: accepted close failed\n');
  });

  it.each([
    { bodyCode: 0, expected: 1 },
    { bodyCode: 7, expected: 7 },
  ])('combines a process-owned last-close failure with exit $bodyCode', async ({ bodyCode, expected }) => {
    const handle = createTestWriteCaptureHandle().handle;
    using close = vi.spyOn(handle, 'close').mockRejectedValueOnce(new Error('last close failed'));
    using _open = vi.spyOn(wesh.kernel, 'open').mockResolvedValueOnce(handle);
    using spawned = recordSpawnedProcesses();
    const name = 'leave-open';
    wesh.registerCommand({
      definition: {
        meta: { name, description: 'Leave a descriptor for process cleanup', usage: name },
        load: async () => async ({ context }) => {
          await context.files.open({
            path: '/owned',
            flags: { access: 'write', creation: 'never', truncate: 'preserve', append: 'preserve' },
          });
          return { exitCode: bodyCode };
        },
      },
    });

    const { result, stderr } = await execute({ script: name });

    expect(result).toEqual({ exitCode: expected, waitStatus: { kind: 'exited', exitCode: expected } });
    expect(spawned.processes.find(process => process.image === name)?.waitStatus).toEqual(result.waitStatus);
    expect(close).toHaveBeenCalledOnce();
    expect(stderr).toBe('wesh: last close failed\n');
  });

  it.each(['true | cat', 'true & true'])('reports a close failure after Stop before execution in %s', async script => {
    const controller = new AbortController();
    const handle = createTestWriteCaptureHandle().handle;
    using close = vi.spyOn(handle, 'close').mockRejectedValueOnce(new Error('unstarted descriptor close failed'));
    const spawn = wesh.kernel.spawn.bind(wesh.kernel);
    using _spawn = vi.spyOn(wesh.kernel, 'spawn').mockImplementationOnce(async options => {
      const spawned = await spawn(options);
      wesh.kernel.registerOwnedHandle({ pid: spawned.pid, handle });
      controller.abort();
      return spawned;
    });

    const { result, stderr } = await execute({ script, signal: controller.signal });

    expect(result).toEqual({ exitCode: 130, waitStatus: { kind: 'signaled', signal: 2 } });
    expect(close).toHaveBeenCalledOnce();
    expect(stderr).toBe('wesh: unstarted descriptor close failed\n');
  });

  it('keeps the stage-specific exit status when a command is missing with pipefail enabled', async () => {
    const { result, stdout, stderr } = await execute({
      script: `\
set -o pipefail
missing-pipeline-command | wc -c`,
    });
    expect(result).toEqual({
      exitCode: 127,
      waitStatus: { kind: 'exited', exitCode: 127 },
    });
    expect(stdout).toBe('0\n');
    expect(stderr).toBe('wesh: Command not found: missing-pipeline-command\n');
  });

  it('uses the shell descriptor changed by exec for a compound command outside the pipeline', async () => {
    const { result, stdout, stderr } = await execute({
      script: `\
exec >&2
{ exec 3>file; printf group; } 2>errors
printf tail`,
    });
    expect(result.exitCode).toBe(0);
    expect(stdout).toBe('');
    expect(stderr).toBe('grouptail');
  });

  it.each([
    {
      name: 'exec can leave a separate descriptor open after the group',
      script: `\
{ exec 3>persist; printf group; } >out
printf after >&3
exec 3>&-
cat out persist`,
      output: 'groupafter',
    },
    {
      name: 'exec replaces a redirected descriptor inside the group until its scope ends',
      script: `\
{ exec >other; printf X; } >out
printf 'tail:'
cat out other`,
      output: 'tail:X',
    },
    {
      name: 'a temporary descriptor restores the earlier descriptor after the group',
      script: `\
exec 3>first
{ printf inside >&3; } 3>second
printf after >&3
exec 3>&-
cat first second`,
      output: 'afterinside',
    },
  ])('$name', async ({ script, output }) => {
    const { result, stdout, stderr } = await execute({ script });
    expect(result.exitCode).toBe(0);
    expect(stderr).toBe('');
    expect(stdout).toBe(output);
  });

  it('publishes a persistent file when it is closed by a later execution', async () => {
    for (const script of ['exec 3>out', 'printf A >&3', '{ printf B >&3; } 2>errors', 'exec 3>&-']) {
      const { result, stdout, stderr } = await execute({ script });
      expect(result.exitCode).toBe(0);
      expect(stdout).toBe('');
      expect(stderr).toBe('');
    }

    const { result, stdout, stderr } = await execute({ script: 'cat out' });
    expect(result.exitCode).toBe(0);
    expect(stdout).toBe('AB');
    expect(stderr).toBe('');
  });

  it('keeps the replacement descriptor after the previous file close fails', async () => {
    using _open = failFirstOpenedFileClose();
    const { result, stdout, stderr } = await execute({
      script: `\
exec 3>broken
exec 3>new
printf X >&3
exec 3>&-
cat new`,
    });
    expect(result.exitCode).toBe(0);
    expect(stdout).toBe('X');
    expect(stderr).toBe('wesh: mock close failure\n');
  });

  it('removes the descriptor even when closing its file fails', async () => {
    using _open = failFirstOpenedFileClose();
    const { result, stdout, stderr } = await execute({
      script: `\
exec 3>broken
exec 3>&-
printf X >&3`,
    });
    expect(result.exitCode).toBe(1);
    expect(stdout).toBe('');
    expect(stderr).toBe(`\
wesh: mock close failure
wesh: 3: bad file descriptor
`);
  });
});
