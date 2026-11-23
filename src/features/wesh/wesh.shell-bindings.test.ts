import { assert, describe, expect, it, vi } from 'vitest';
import { builtinCommands } from './commands';
import { aliasCommandDefinition } from './commands/alias/definition';
import { execCommandDefinition } from './commands/exec/definition';
import { Wesh } from './index';
import { MockFileSystemDirectoryHandle } from './mocks/InMemoryFileSystem';
import { createTextShellSource } from './shell/source';
import type { WeshCommandFunction, WeshFileHandle, WeshProcess } from './types';
import { createWriteHandleFromStream } from './utils/stream';
import { createTestReadHandleFromText, createTestWriteCaptureHandle } from './utils/test-stream';

const shellOnlyProperties = [
  'setCwd',
  'getAliases',
  'setAlias',
  'unsetAlias',
  'hasFunction',
  'getShellOption',
  'getShellOptions',
  'setShellOption',
  'getTrapAction',
  'getTraps',
  'setTraps',
  'getHistory',
  'getJobs',
  'sendSignal',
  'resolveCommand',
];

function createWesh() {
  return new Wesh({
    rootHandle: new MockFileSystemDirectoryHandle({ name: 'root' }) as unknown as FileSystemDirectoryHandle,
  });
}

async function execute({ wesh, script, signal }: { wesh: Wesh, script: string, signal?: AbortSignal }) {
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

function registerCommandProbe({ wesh, name }: { wesh: Wesh, name: string }) {
  const description = `Inspect the ordinary command context for ${name}`;
  const usage = `${name} [operand ...]`;
  const command = vi.fn<WeshCommandFunction>(async ({ context }) => {
    await context.text().print({ text: `ran ${name}\n` });
    return { exitCode: 0 };
  });
  const load = vi.fn(async () => command);
  wesh.registerCommand({ definition: { meta: { name, description, usage }, load } });
  return { command, load, description, usage };
}

function expectOrdinaryCommandContext({ invocation }: { invocation: Parameters<WeshCommandFunction>[0] }) {
  expect(Object.keys(invocation)).toEqual(['context']);
  const { context } = invocation;
  expect(shellOnlyProperties.filter(property => Object.hasOwn(context, property))).toEqual([]);
  expect(context.cwd).toBe('/');
  expect(context.env.get('PUBLIC')).toBe('visible');
  expect(context.env.has('PRIVATE')).toBe(false);
}

function createDelayedStdout() {
  const started = Promise.withResolvers<void>();
  const resume = Promise.withResolvers<void>();
  const printed: string[] = [];
  const handle = createWriteHandleFromStream({
    target: new WritableStream({
      async write(chunk) {
        printed.push(new TextDecoder().decode(chunk));
        started.resolve();
        await resume.promise;
      },
    }),
  });
  return { handle, printed, started, resume };
}

describe('Wesh shell builtin bindings', () => {
  it.each([false, true])('interrupts a foreground wait while leaving the background child alive (ignore SIGINT=%s)', async ignoreInterrupt => {
    const wesh = createWesh();
    const childStarted = Promise.withResolvers<void>();
    const finishChild = Promise.withResolvers<void>();
    using _release = { [Symbol.dispose]: () => finishChild.resolve() };
    const name = 'park';
    wesh.registerCommand({
      definition: {
        meta: { name, description: 'Wait for a test gate', usage: name },
        load: async () => async () => {
          childStarted.resolve();
          await finishChild.promise;
          return { exitCode: 7 };
        },
      },
    });
    const controller = new AbortController();
    const script = `\
park &
wait "$!"
printf late`;
    const execution = execute({
      wesh,
      signal: controller.signal,
      script: ignoreInterrupt ? `\
bash -c 'trap "" INT
${script}'` : `\
trap 'printf "INT:%s" "$?"' INT
${script}`,
    });
    const completed = vi.fn();
    void execution.then(completed, completed);
    await childStarted.promise;
    // Let the evaluator reach wait with the child still blocked on its gate.
    await new Promise(resolve => setTimeout(resolve, 0));

    if (ignoreInterrupt) {
      await expect(wesh.signalForegroundProcessGroup({ signal: 2, foregroundSignal: controller.signal })).resolves.toBe(true);
      expect(completed).not.toHaveBeenCalled();
    }
    controller.abort();
    await wesh.interruptForeground({ foregroundSignal: controller.signal });

    await vi.waitFor(() => expect(completed).toHaveBeenCalledOnce());
    await expect(execution).resolves.toEqual({
      result: { exitCode: 130, waitStatus: { kind: 'signaled', signal: 2 } },
      stdout: ignoreInterrupt ? '' : 'INT:130',
      stderr: '',
    });
    expect(wesh.kernel.getProcesses().some(process => process.image === name && process.state === 'running')).toBe(true);
    finishChild.resolve();
    await vi.waitFor(() => expect(wesh.kernel.getProcesses().some(process => process.image === name)).toBe(false));
  });

  it('returns zero after wait without operands has collected all children', async () => {
    const { result, stdout, stderr } = await execute({
      wesh: createWesh(),
      script: `\
(exit 7) &
(exit 5) &
wait`,
    });
    expect(result.exitCode).toBe(0);
    expect(stdout).toBe('');
    expect(stderr).toBe('');
  });

  it('leaves a background child running when its waiting shell receives SIGTERM by PID', async () => {
    const wesh = createWesh();
    const childStarted = Promise.withResolvers<number>();
    const finishChild = Promise.withResolvers<void>();
    using _release = { [Symbol.dispose]: () => finishChild.resolve() };
    const name = 'park';
    wesh.registerCommand({
      definition: {
        meta: { name, description: 'Wait for a test gate', usage: name },
        load: async () => async ({ context }) => {
          childStarted.resolve(context.pid);
          await finishChild.promise;
          return { exitCode: 7 };
        },
      },
    });
    const execution = execute({
      wesh,
      script: `\
bash -c 'park &
wait "$!"
printf late'`,
    });
    const completed = vi.fn();
    void execution.then(completed, completed);
    const childPid = await childStarted.promise;
    // Let the shell enter wait while the child is still blocked.
    await new Promise(resolve => setTimeout(resolve, 0));
    const shell = wesh.kernel.getProcesses().find(process => process.args[0] === 'bash');
    assert(shell !== undefined);

    await wesh.kernel.kill({ pid: shell.pid, signal: 15 });

    await vi.waitFor(() => expect(completed).toHaveBeenCalledOnce());
    expect(shell.waitStatus).toEqual({ kind: 'signaled', signal: 15 });
    const { result, stdout, stderr } = await execution;
    expect(result.exitCode).toBe(143);
    expect(stdout).toBe('');
    expect(stderr).toBe('');
    expect(wesh.kernel.getProcess({ pid: childPid })).toMatchObject({ state: 'running' });
    expect(wesh.kernel.getWaitStatus({ pid: childPid })).toBeUndefined();
    finishChild.resolve();
    await vi.waitFor(() => expect(wesh.kernel.getProcess({ pid: childPid })).toBeUndefined());
  });

  it.each([
    { stop: false, ownStatus: { kind: 'exited', exitCode: 0 } },
    { stop: true, ownStatus: { kind: 'signaled', signal: 2 } },
  ])('records the disposition of the recipient when a foreground input is interrupted (Stop=$stop)', async ({ stop, ownStatus }) => {
    const wesh = createWesh();
    const started = Promise.withResolvers<number>();
    const finish = Promise.withResolvers<void>();
    using _release = { [Symbol.dispose]: () => finish.resolve() };
    const name = 'hold';
    wesh.registerCommand({
      definition: {
        meta: { name, description: 'Wait for a test gate', usage: name },
        load: async () => async ({ context }) => {
          started.resolve(context.pid);
          await finish.promise;
          return { exitCode: 0 };
        },
      },
    });
    const controller = new AbortController();
    const execution = execute({ wesh, script: `bash -c 'trap "" INT; hold'`, signal: controller.signal });
    const pid = await started.promise;
    const child = wesh.kernel.getProcess({ pid });
    assert(child !== undefined);
    expect(child.signalDispositions?.get(2)).toBe('ignore');

    if (stop) {
      controller.abort();
      await wesh.interruptForeground({ foregroundSignal: controller.signal });
    } else {
      await wesh.signalForegroundProcessGroup({ signal: 2, foregroundSignal: controller.signal });
      expect(child.waitStatus).toBeUndefined();
    }
    finish.resolve();

    const { result } = await execution;
    expect(result.exitCode).toBe(130);
    expect(child.waitStatus).toEqual(ownStatus);
  });

  it('keeps a process disposition after its foreground input ended', async () => {
    const wesh = createWesh();
    const started = Promise.withResolvers<number>();
    const finish = Promise.withResolvers<void>();
    using _release = { [Symbol.dispose]: () => finish.resolve() };
    const name = 'hold';
    wesh.registerCommand({
      definition: {
        meta: { name, description: 'Wait for a test gate', usage: name },
        load: async () => async ({ context }) => {
          started.resolve(context.pid);
          await finish.promise;
          return { exitCode: 0 };
        },
      },
    });
    const { read, write } = await wesh.kernel.pipe();
    await using _pipe = {
      async [Symbol.asyncDispose]() {
        await read.close();
        await write.close();
      },
    };
    const reading = Promise.withResolvers<void>();
    const pipePrototype = Object.getPrototypeOf(read) as Pick<typeof read, 'read'>;
    const readPipe = pipePrototype.read;
    using _read = vi.spyOn(pipePrototype, 'read').mockImplementation(function (this: typeof read, options) {
      const pending = readPipe.call(this, options);
      reading.resolve();
      return pending;
    });
    const controller = new AbortController();
    const script = `\
exec 3< <(trap '' INT TERM; hold)
read value
printf late`;
    const execution = wesh.execute({
      source: createTextShellSource({ text: script }),
      stdin: read,
      stdout: createTestWriteCaptureHandle().handle,
      stderr: createTestWriteCaptureHandle().handle,
      signal: controller.signal,
    });
    const pid = await started.promise;
    await reading.promise;
    const child = wesh.kernel.getProcess({ pid });
    assert(child !== undefined);
    expect(child.signalDispositions?.get(15)).toBe('ignore');

    await wesh.signalForegroundProcessGroup({ signal: 15, foregroundSignal: controller.signal });
    await expect(execution).resolves.toEqual({ exitCode: 143, waitStatus: { kind: 'signaled', signal: 15 } });
    expect(child.waitStatus).toBeUndefined();

    finish.resolve();
    await vi.waitFor(() => expect(wesh.kernel.getProcess({ pid })).toBeUndefined());
    expect(child.waitStatus).toEqual({ kind: 'exited', exitCode: 0 });
    await execute({ wesh, script: 'exec 3<&-' });
  });

  it('delivers a process group signal from a persistent descriptor to a later input in that group', async () => {
    const wesh = createWesh();
    await wesh.init();
    const shell = wesh.kernel.getProcesses().find(process => process.image === 'wesh');
    assert(shell !== undefined);
    const senderStarted = Promise.withResolvers<number>();
    const sendSignal = Promise.withResolvers<void>();
    const recipientStarted = Promise.withResolvers<number>();
    wesh.registerCommand({
      definition: {
        meta: { name: 'group-after-gate', description: 'Signal the group when released', usage: 'group-after-gate' },
        load: async () => async ({ context }) => {
          senderStarted.resolve(context.pid);
          await sendSignal.promise;
          await context.process.signalGroup({ signal: 15 });
          return { exitCode: 0 };
        },
      },
    });
    wesh.registerCommand({
      definition: {
        meta: { name: 'wait-for-term', description: 'Wait for a signal', usage: 'wait-for-term' },
        load: async () => async ({ context }) => {
          const waiting = context.process.waitForSignalOrTimeout({ timeoutMs: Infinity });
          recipientStarted.resolve(context.pid);
          await waiting;
          return { exitCode: 0 };
        },
      },
    });
    const controller = new AbortController();
    await using _descriptor = {
      async [Symbol.asyncDispose]() {
        sendSignal.resolve();
        await execute({ wesh, script: 'exec 3<&-' });
      },
    };
    await expect(execute({ wesh, script: 'exec 3< <(group-after-gate)' })).resolves.toMatchObject({ result: { exitCode: 0 } });
    const senderPid = await senderStarted.promise;
    const sender = wesh.kernel.getProcess({ pid: senderPid });
    expect(sender?.pgid).toBe(shell.pgid);
    expect(sender?.state).toBe('running');

    const script = `\
trap 'printf handled >&2' TERM
wait-for-term
printf 'after:%s' "$?"`;
    const nextInput = execute({ wesh, script, signal: controller.signal });
    await using _stop = {
      async [Symbol.asyncDispose]() {
        controller.abort();
        await wesh.interruptForeground({ foregroundSignal: controller.signal });
        await Promise.allSettled([nextInput]);
      },
    };
    const completed = vi.fn();
    void nextInput.then(completed, completed);
    const recipientPid = await recipientStarted.promise;
    const recipient = wesh.kernel.getProcess({ pid: recipientPid });
    expect(recipient?.pgid).toBe(shell.pgid);

    sendSignal.resolve();
    await vi.waitFor(() => expect(completed).toHaveBeenCalledOnce());
    const waitStatus = { kind: 'signaled', signal: 15 };
    await expect(nextInput).resolves.toEqual({ result: { exitCode: 0, waitStatus: undefined }, stdout: 'after:143', stderr: 'handled' });
    expect(recipient?.waitStatus).toEqual(waitStatus);
    expect(shell.state).toBe('running');
    await expect(execute({ wesh, script: 'printf reusable' })).resolves.toMatchObject({ result: { exitCode: 0 }, stdout: 'reusable' });
    expect(wesh.kernel.getProcess({ pid: shell.pid })).toBe(shell);
  });

  it('delivers a group signal to the Bash shell in a background job', async () => {
    const wesh = createWesh();
    await wesh.init();
    const shell = wesh.kernel.getProcesses().find(process => process.image === 'wesh');
    assert(shell !== undefined);
    const childShell = Promise.withResolvers<WeshProcess>();
    wesh.registerCommand({
      definition: {
        meta: { name: 'send-term', description: 'Send TERM to the process group', usage: 'send-term' },
        load: async () => async ({ context }) => {
          const sender = wesh.kernel.getProcess({ pid: context.pid });
          assert(sender !== undefined);
          const parent = wesh.kernel.getProcess({ pid: sender.ppid });
          assert(parent !== undefined);
          expect(parent.args[0]).toBe('bash');
          expect(parent.pgid).toBe(sender.pgid);
          expect(parent.pgid).not.toBe(shell.pgid);
          childShell.resolve(parent);
          await context.process.signalGroup({ signal: 15 });
          return { exitCode: 0 };
        },
      },
    });

    const result = await execute({ wesh, script: `bash -c 'send-term; printf leaked' & wait "$!"` });
    expect(result).toMatchObject({ result: { exitCode: 143 }, stdout: '', stderr: '' });
    await expect(childShell.promise).resolves.toMatchObject({ exitCode: 143, waitStatus: { kind: 'signaled', signal: 15 } });
    expect(wesh.kernel.getProcess({ pid: shell.pid })).toBe(shell);
    expect(shell.state).toBe('running');
  });

  it('keeps a blocked child shell read open when it ignores the group SIGINT', async () => {
    const wesh = createWesh();
    const { read, write } = await wesh.kernel.pipe();
    const reading = Promise.withResolvers<void>();
    const pipePrototype = Object.getPrototypeOf(read) as Pick<typeof read, 'read'>;
    const readPipe = pipePrototype.read;
    using _read = vi.spyOn(pipePrototype, 'read').mockImplementation(function (this: typeof read, options) {
      const pending = readPipe.call(this, options);
      reading.resolve();
      return pending;
    });
    const stdout = createTestWriteCaptureHandle();
    const stderr = createTestWriteCaptureHandle();
    const controller = new AbortController();
    const script = `\
bash -c 'trap "" INT
printf ready
IFS= read -r value
printf "[%s]" "$value"'`;
    const execution = wesh.execute({
      source: createTextShellSource({ text: script }),
      stdin: read,
      stdout: stdout.handle,
      stderr: stderr.handle,
      signal: controller.signal,
    });
    await using _pipe = {
      async [Symbol.asyncDispose]() {
        await write.close();
        await read.close();
        await Promise.allSettled([execution]);
      },
    };
    const completed = vi.fn();
    void execution.then(completed, completed);
    await reading.promise;
    expect(stdout.text).toBe('ready');

    await expect(wesh.signalForegroundProcessGroup({ signal: 2, foregroundSignal: controller.signal })).resolves.toBe(true);
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(stdout.text).toBe('ready');
    expect(completed).not.toHaveBeenCalled();

    await write.write({ buffer: new TextEncoder().encode('payload\n') });
    await vi.waitFor(() => expect(completed).toHaveBeenCalledOnce());
    await expect(execution).resolves.toMatchObject({ exitCode: 130 });
    expect(stdout.text).toBe('ready[payload]');
    expect(stderr.text).toBe('');
  });

  it('stops the input during a child shell trap for a caught group SIGTERM', async () => {
    const wesh = createWesh();
    const holdStarted = Promise.withResolvers<void>();
    const stallStarted = Promise.withResolvers<void>();
    const resumeStall = Promise.withResolvers<void>();
    wesh.registerCommand({
      definition: {
        meta: { name: 'hold', description: 'Wait for a signal', usage: 'hold' },
        load: async () => async ({ context }) => {
          const waiting = context.process.waitForSignalOrTimeout({ timeoutMs: Infinity });
          holdStarted.resolve();
          await waiting;
          return { exitCode: 0 };
        },
      },
    });
    wesh.registerCommand({
      definition: {
        meta: { name: 'stall', description: 'Wait for the test to resume the trap', usage: 'stall' },
        load: async () => async () => {
          stallStarted.resolve();
          await resumeStall.promise;
          return { exitCode: 0 };
        },
      },
    });
    const controller = new AbortController();
    const script = `\
trap ':' TERM
bash -c 'trap "printf marker; stall" TERM
hold
printf late'
printf late`;
    const execution = execute({ wesh, script, signal: controller.signal });
    await using _release = {
      async [Symbol.asyncDispose]() {
        resumeStall.resolve();
        controller.abort();
        await wesh.interruptForeground({ foregroundSignal: controller.signal });
        await Promise.allSettled([execution]);
      },
    };
    await holdStarted.promise;
    const shell = wesh.kernel.getProcesses().find(process => process.args[0] === 'bash');
    assert(shell !== undefined);
    await expect(wesh.signalForegroundProcessGroup({ signal: 15, foregroundSignal: controller.signal })).resolves.toBe(true);
    await stallStarted.promise;

    controller.abort();
    await expect(wesh.interruptForeground({ foregroundSignal: controller.signal })).resolves.toBe(true);
    resumeStall.resolve();

    await expect(execution).resolves.toEqual({
      result: { exitCode: 130, waitStatus: { kind: 'signaled', signal: 2 } },
      stdout: 'marker',
      stderr: '',
    });
    expect(shell.exitCode).toBe(130);
    expect(shell.waitStatus).toEqual({ kind: 'signaled', signal: 2 });
  });

  it.each([
    { first: 'TERM', exitSignal: 15, exitCode: 143 },
    { first: 'Stop', exitSignal: 2, exitCode: 130 },
  ] as const)('keeps the first signal while the child shell closes its script descriptor ($first first)', async ({ first, exitSignal, exitCode }) => {
    const wesh = createWesh();
    const { read, write } = await wesh.kernel.pipe();
    const reading = Promise.withResolvers<void>();
    const closing = Promise.withResolvers<void>();
    const resumeClose = Promise.withResolvers<void>();
    const path = '/slow-close';
    wesh.vfs.registerSpecialFile({
      path,
      type: 'fifo',
      handler: () => ({
        read(options) {
          const pending = read.read(options);
          reading.resolve();
          return pending;
        },
        write: options => read.write(options),
        stat: () => read.stat(),
        truncate: options => read.truncate(options),
        ioctl: options => read.ioctl(options),
        async close() {
          closing.resolve();
          await resumeClose.promise;
          await read.close();
        },
      }),
    });
    const controller = new AbortController();
    const execution = execute({ wesh, script: `bash ${path}`, signal: controller.signal });
    await using _release = {
      async [Symbol.asyncDispose]() {
        resumeClose.resolve();
        await write.close();
        await read.close();
        await Promise.allSettled([execution]);
      },
    };
    const completed = vi.fn();
    void execution.then(completed, completed);
    await reading.promise;
    const shell = wesh.kernel.getProcesses().find(process => process.args.includes(path));
    assert(shell !== undefined);

    const sendTerm = () => wesh.signalForegroundProcessGroup({ signal: 15, foregroundSignal: controller.signal });
    const sendStop = () => {
      controller.abort();
      return wesh.interruptForeground({ foregroundSignal: controller.signal });
    };
    const waitStatus = { kind: 'signaled', signal: exitSignal };
    const firstSignal = first === 'TERM' ? sendTerm() : sendStop();
    await closing.promise;
    expect(shell.waitStatus).toEqual(waitStatus);
    expect(shell.exitCode).toBe(exitCode);

    const secondSignal = first === 'TERM' ? sendStop() : sendTerm();
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(shell.waitStatus).toEqual(waitStatus);
    expect(shell.exitCode).toBe(exitCode);
    expect(completed).not.toHaveBeenCalled();

    resumeClose.resolve();
    await expect(firstSignal).resolves.toBe(true);
    await expect(secondSignal).resolves.toBe(true);
    await expect(execution).resolves.toEqual({
      result: { exitCode, waitStatus },
      stdout: '',
      stderr: '',
    });
    expect(shell.waitStatus).toEqual(waitStatus);
    expect(shell.exitCode).toBe(exitCode);
    expect(wesh.kernel.getProcess({ pid: shell.pid })).toBeUndefined();
  });

  it.each([
    { parent: "trap '' INT", child: 'trap - INT', exitCode: 130, stdout: 'ready' },
    { parent: ':', child: "trap '' INT", exitCode: 0, stdout: 'readysurvived' },
  ])('uses the live disposition when signaling a child shell PID after $child', async ({ parent, child, exitCode, stdout }) => {
    const wesh = createWesh();
    await wesh.init();
    const root = wesh.kernel.getProcesses().find(process => process.image === 'wesh');
    assert(root !== undefined);
    const output = createDelayedStdout();
    using _release = { [Symbol.dispose]: () => output.resume.resolve() };
    const execution = wesh.execute({
      source: createTextShellSource({ text: `${parent}; (${child}; printf ready; printf survived)` }),
      stdin: createTestReadHandleFromText({ text: '' }),
      stdout: output.handle,
      stderr: createTestWriteCaptureHandle().handle,
    });

    await output.started.promise;
    const process = wesh.kernel.getProcesses().find(process => process.ppid === root.pid && process.image === 'wesh');
    assert(process !== undefined);
    const interrupt = wesh.kernel.kill({ pid: process.pid, signal: 2 });
    output.resume.resolve();
    await interrupt;
    await expect(execution).resolves.toMatchObject({ exitCode });
    expect(output.printed.join('')).toBe(stdout);
  });

  it('interrupts only the selected input when two live inputs share a process group', async () => {
    const wesh = createWesh();
    await wesh.init();
    const started = Promise.withResolvers<void>();
    const resume = Promise.withResolvers<void>();
    using _resume = {
      [Symbol.dispose]() {
        resume.resolve();
      },
    };
    const groups: number[] = [];
    wesh.registerCommand({
      definition: {
        meta: { name: 'wait-for-input', description: 'Wait until both inputs have started', usage: 'wait-for-input label' },
        load: async () => async ({ context }) => {
          groups.push(context.process.getGroupId());
          if (groups.length === 2) {
            started.resolve();
          }
          await resume.promise;
          await context.text().print({ text: context.args[0] ?? '' });
          return { exitCode: 0 };
        },
      },
    });
    const stopFirst = new AbortController();
    const first = execute({ wesh, script: 'wait-for-input first', signal: stopFirst.signal });
    const second = execute({ wesh, script: 'wait-for-input second' });
    await started.promise;
    expect(new Set(groups).size).toBe(1);
    await expect(wesh.interruptForeground({ foregroundSignal: stopFirst.signal })).resolves.toBe(false);
    stopFirst.abort();
    await expect(wesh.interruptForeground({ foregroundSignal: stopFirst.signal })).resolves.toBe(true);
    resume.resolve();

    await expect(first).resolves.toMatchObject({ result: { exitCode: 130 }, stdout: '' });
    await expect(second).resolves.toMatchObject({ result: { exitCode: 0 }, stdout: 'second' });
  });

  it('waits for a file write accepted before Stop and blocks a later write', async () => {
    const wesh = createWesh();
    await wesh.init();
    const writing = Promise.withResolvers<void>();
    const closing = Promise.withResolvers<void>();
    const commit = Promise.withResolvers<void>();
    const tryLateWrite = Promise.withResolvers<void>();
    const lateWriteResult = Promise.withResolvers<number>();
    const events: string[] = [];
    const durableFile = {
      ...createTestWriteCaptureHandle().handle,
      getCloseSemantics: () => 'hard',
      async write({ buffer }) {
        writing.resolve();
        await commit.promise;
        events.push('committed');
        return { bytesWritten: buffer.length };
      },
      async close() {
        closing.resolve();
        await commit.promise;
      },
    } satisfies WeshFileHandle;
    const laterFile = createTestWriteCaptureHandle();
    const open = vi.spyOn(wesh.kernel, 'open').mockImplementation(async ({ path }) => (
      path === '/durable' ? durableFile : laterFile.handle
    ));
    using _cleanup = {
      [Symbol.dispose]() {
        commit.resolve();
        tryLateWrite.resolve();
        open.mockRestore();
      },
    };
    wesh.registerCommand({
      definition: {
        meta: { name: 'store', description: 'Write to two files', usage: 'store' },
        load: async () => async ({ context }) => {
          const flags = { access: 'write', creation: 'if-needed', truncate: 'preserve', append: 'preserve' } as const;
          const durable = await context.files.open({ path: '/durable', flags });
          const later = await context.files.open({ path: '/late', flags });
          const buffer = new TextEncoder().encode('data');
          const pending = durable.write({ buffer });
          await tryLateWrite.promise;
          lateWriteResult.resolve((await later.write({ buffer })).bytesWritten);
          await pending;
          return { exitCode: 0 };
        },
      },
    });

    const stop = new AbortController();
    const execution = execute({ wesh, script: "trap '' INT; store; printf late", signal: stop.signal });
    await writing.promise;
    const process = wesh.kernel.getProcesses().find(entry => entry.image === 'store');
    assert(process !== undefined);
    await wesh.signalForegroundProcessGroup({ signal: 2, foregroundSignal: stop.signal });
    expect(process.waitStatus).toBeUndefined();

    stop.abort();
    const interruption = wesh.interruptForeground({ foregroundSignal: stop.signal }).then(result => {
      events.push('interrupted');
      return result;
    });
    await closing.promise;
    expect(process.waitStatus).toEqual({ kind: 'signaled', signal: 2 });
    tryLateWrite.resolve();
    await expect(lateWriteResult.promise).resolves.toBe(0);
    expect(laterFile.text).toBe('');
    expect(events).toEqual([]);

    commit.resolve();
    await expect(interruption).resolves.toBe(true);
    await expect(execution).resolves.toMatchObject({ result: { exitCode: 130 }, stdout: '' });
    expect(events).toEqual(['committed', 'interrupted']);
  });

  it.each([
    "bash -c 'kill -INT 0; printf inner' | cat; printf after",
    "(bash -c 'kill -INT 0; printf inner'); printf after",
  ])('keeps the shell running when a separate child group signals itself: %s', async script => {
    const wesh = createWesh();
    const { result, stdout, stderr } = await execute({ wesh, script });

    expect(result.exitCode).toBe(0);
    expect(stdout).toBe('after');
    expect(stderr).toBe('');
  });

  it.each(['echo x >&-', 'exec echo x >&-'])('reports a closed stdout through stderr: %s', async script => {
    const { result, stdout, stderr } = await execute({ wesh: createWesh(), script });

    expect(result.exitCode).toBe(1);
    expect(stdout).toBe('');
    expect(stderr).toContain('echo: Bad file descriptor\n');
  });

  it('runs shell builtins in the shell process and gives ordinary commands child processes', async () => {
    const wesh = createWesh();
    await wesh.init();
    const shell = wesh.kernel.getProcesses().find(process => process.image === 'wesh');
    assert(shell !== undefined);
    const { command } = registerCommandProbe({ wesh, name: 'scope-probe' });
    const spawn = vi.spyOn(wesh.kernel, 'spawn');
    using _spawn = { [Symbol.dispose]: () => spawn.mockRestore() };

    const { result, stdout, stderr } = await execute({
      wesh,
      script: `\
printf '%s\\n' "$BASHPID"
command eval 'printf "%s\\n" "$BASHPID"'
builtin printf '%s\\n' "$BASHPID"
scope-probe
env scope-probe
`,
    });

    expect(result.exitCode).toBe(0);
    expect(stderr).toBe('');
    expect(stdout).toBe(`${shell.pid}\n`.repeat(3) + 'ran scope-probe\n'.repeat(2));
    expect(spawn.mock.calls.map(([options]) => options.image)).toEqual(['scope-probe', 'env', 'scope-probe']);
    const [direct, env, child] = await Promise.all(spawn.mock.results
      .filter(result => result.type === 'return').map(({ value }) => value));
    assert(direct !== undefined && env !== undefined && child !== undefined);
    expect(direct.process.ppid).toBe(shell.pid);
    expect(env.process.ppid).toBe(shell.pid);
    expect(child.process.ppid).toBe(env.pid);
    expect(command.mock.calls.map(([{ context }]) => context.pid)).toEqual([direct.pid, child.pid]);
  });

  it('keeps compound pipeline builtins in their stage processes', async () => {
    const wesh = createWesh();
    await wesh.init();
    const shell = wesh.kernel.getProcesses().find(process => process.image === 'wesh');
    assert(shell !== undefined);
    const spawn = vi.spyOn(wesh.kernel, 'spawn');
    using _spawn = { [Symbol.dispose]: () => spawn.mockRestore() };

    const { result, stdout, stderr } = await execute({
      wesh,
      script: `\
printf '%s\\n' "$BASHPID" | {
  read -r upstream
  command eval 'printf "%s:%s" "$upstream" "$BASHPID"'
}
`,
    });

    expect(result.exitCode).toBe(0);
    expect(stderr).toBe('');
    expect(spawn).toHaveBeenCalledTimes(2);
    const [left, right] = await Promise.all(spawn.mock.results
      .filter(result => result.type === 'return').map(({ value }) => value));
    assert(left !== undefined && right !== undefined);
    expect(left.process.ppid).toBe(shell.pid);
    expect(right.process.ppid).toBe(shell.pid);
    expect(right.process.pgid).toBe(left.process.pgid);
    expect(stdout).toBe(`${left.pid}:${right.pid}`);
    expect(wesh.kernel.getProcesses()).toContain(shell);
  });

  it('executes a replacement in the current shell process without spawning', async () => {
    const wesh = createWesh();
    await wesh.init();
    const shell = wesh.kernel.getProcesses().find(process => process.image === 'wesh');
    assert(shell !== undefined);
    const { command } = registerCommandProbe({ wesh, name: 'scope-probe' });
    const spawn = vi.spyOn(wesh.kernel, 'spawn');
    using _spawn = { [Symbol.dispose]: () => spawn.mockRestore() };

    const { result, stdout, stderr } = await execute({ wesh, script: 'command exec scope-probe; printf unreachable' });

    expect(result.exitCode).toBe(0);
    expect(stdout).toBe('ran scope-probe\n');
    expect(stderr).toBe('');
    expect(command.mock.calls.map(([{ context }]) => context.pid)).toEqual([shell.pid]);
    expect(spawn).not.toHaveBeenCalled();
    expect(wesh.kernel.getProcess({ pid: shell.pid })).toBeUndefined();
  });

  it('provides the ordinary context in shell, command, explicit path, and child invocations', async () => {
    const wesh = createWesh();
    const { command } = registerCommandProbe({ wesh, name: 'scope-probe' });
    const script = `\
PRIVATE=hidden
export PUBLIC=visible
parent_only() { true; }
scope-probe direct
command scope-probe command
/bin/scope-probe path
env scope-probe child
`;
    const { result, stdout, stderr } = await execute({ wesh, script });

    expect(result.exitCode).toBe(0);
    expect(stderr).toBe('');
    expect(stdout).toBe('ran scope-probe\n'.repeat(4));
    expect(command.mock.calls.map(([invocation]) => invocation.context.args)).toEqual([
      ['direct'], ['command'], ['path'], ['child'],
    ]);
    for (const [invocation] of command.mock.calls) {
      expectOrdinaryCommandContext({ invocation });
    }
  });

  it.each([
    { name: 'exec', operands: 'true' },
    { name: 'set', operands: '-- after' },
    { name: 'unset', operands: 'PRIVATE' },
  ])('uses a registered $name replacement for metadata and every command route', async ({ name, operands }) => {
    const wesh = createWesh();
    const { command, load, description, usage } = registerCommandProbe({ wesh, name });
    const setup = await execute({ wesh, script: 'PRIVATE=hidden; export PUBLIC=visible' });
    const help = await execute({ wesh, script: `help ${name}` });

    expect(setup.result.exitCode).toBe(0);
    expect(help.result.exitCode).toBe(0);
    expect(help.stderr).toBe('');
    expect(help.stdout).toContain(`${description}\n`);
    expect(help.stdout).toContain(`usage: ${usage}\n`);
    expect(wesh.listCommands().filter(entry => entry.name === name)).toHaveLength(1);
    expect(load).not.toHaveBeenCalled();

    for (const route of ['', 'command ', 'builtin ', '/bin/', 'env ']) {
      const script = `${route}${name} ${operands}`;
      const { result, stdout, stderr } = await execute({ wesh, script });
      expect(result.exitCode, script).toBe(0);
      expect(stderr, script).toBe('');
      expect(stdout, script).toBe(`ran ${name}\n`);
    }

    expect(load).toHaveBeenCalledOnce();
    expect(command).toHaveBeenCalledTimes(5);
    for (const [invocation] of command.mock.calls) {
      expectOrdinaryCommandContext({ invocation });
    }
    expect(wesh.getShellState().env.PRIVATE).toBe('hidden');
  });

  it('uses the ordinary loader when a registered definition also has a shell builtin loader', async () => {
    const wesh = createWesh();
    const command = vi.fn<WeshCommandFunction>(async () => ({ exitCode: 7 }));
    const load = vi.fn(async () => command);
    const loadShellBuiltin = vi.fn(async () => {
      throw new Error('Unexpected shell builtin loader');
    });
    const definition = { meta: execCommandDefinition.meta, load, loadShellBuiltin };
    wesh.registerCommand({ definition });

    const { result, stdout, stderr } = await execute({ wesh, script: 'exec true' });

    expect(result.exitCode).toBe(7);
    expect(stdout).toBe('');
    expect(stderr).toBe('');
    expect(load).toHaveBeenCalledOnce();
    expect(loadShellBuiltin).not.toHaveBeenCalled();
    expect(command).toHaveBeenCalledOnce();
    expect(Object.keys(command.mock.calls[0]![0])).toEqual(['context']);
  });

  it('shares the exec implementation load between preload and every execution route', async () => {
    const load = vi.spyOn(execCommandDefinition, 'loadShellBuiltin');
    using _load = { [Symbol.dispose]: () => load.mockRestore() };
    const wesh = createWesh();
    const loadUnrelatedCommand = vi.fn(async () => {
      throw new Error('Unexpected unrelated command loader');
    });
    for (const definition of builtinCommands) {
      if (definition === execCommandDefinition) {
        break;
      }
      if (definition.meta.name === 'command' || definition.meta.name === 'env') {
        continue;
      }
      wesh.registerCommand({ definition: { meta: definition.meta, load: loadUnrelatedCommand } });
    }

    const help = await execute({ wesh, script: 'help exec' });
    expect(help.result.exitCode).toBe(0);
    expect(help.stdout).toContain(execCommandDefinition.meta.description);
    expect(load).not.toHaveBeenCalled();

    let hasMore = true;
    while (hasMore && load.mock.calls.length === 0) {
      ({ hasMore } = await wesh.preloadNextBuiltinCommand());
    }
    expect(load).toHaveBeenCalledOnce();

    for (const route of ['', 'command ', 'builtin ', '/bin/', 'env ']) {
      const script = `${route}exec --help`;
      const { result, stdout, stderr } = await execute({ wesh, script });
      expect(result.exitCode, script).toBe(0);
      expect(stdout, script).toContain(execCommandDefinition.meta.usage);
      expect(stderr, script).toBe('');
    }
    expect(load).toHaveBeenCalledOnce();
    expect(loadUnrelatedCommand).not.toHaveBeenCalled();
  });

  it('does not persist an exec redirection when cancellation wins during the builtin load', async () => {
    const started = Promise.withResolvers<void>();
    const resume = Promise.withResolvers<void>();
    const loadExec = execCommandDefinition.loadShellBuiltin;
    const spy = vi.spyOn(execCommandDefinition, 'loadShellBuiltin').mockImplementation(async () => {
      started.resolve();
      await resume.promise;
      return loadExec();
    });
    using _release = {
      [Symbol.dispose]() {
        resume.resolve();
        spy.mockRestore();
      },
    };
    const wesh = createWesh();
    const stdout = createTestWriteCaptureHandle();
    const stderr = createTestWriteCaptureHandle();
    const abort = new AbortController();
    const execution = wesh.execute({
      source: createTextShellSource({ text: 'exec 3>held; printf forbidden' }),
      stdin: createTestReadHandleFromText({ text: '' }),
      stdout: stdout.handle,
      stderr: stderr.handle,
      signal: abort.signal,
    });

    await started.promise;
    abort.abort();
    const interrupted = wesh.interruptForeground({ foregroundSignal: abort.signal });
    resume.resolve();

    await expect(interrupted).resolves.toBe(true);
    await expect(execution).resolves.toMatchObject({ exitCode: 130 });
    expect(stdout.text).toBe('');
    expect(stderr.text).toBe('');
    const next = await execute({ wesh, script: 'printf leaked >&3; cat held' });
    expect(next.result.exitCode).toBe(0);
    expect(next.stdout).toBe('');
    expect(next.stderr).toContain('3: bad file descriptor');
  });

  it.each(['/slow', 'command /slow', 'env /slow'])('does not launch a child after a signal interrupts path resolution in %s', async (script) => {
    const root = new MockFileSystemDirectoryHandle({ name: 'root' });
    const file = await root.getFileHandle('slow', { create: true });
    const writable = await file.createWritable();
    await writable.write(`\
#!/bin/bash
printf late >late
`);
    await writable.close();

    const started = Promise.withResolvers<void>();
    const resume = Promise.withResolvers<void>();
    const getFileHandle = root.getFileHandle.bind(root);
    const lookup = vi.spyOn(root, 'getFileHandle').mockImplementation(async (name, options) => {
      if (name === 'slow') {
        started.resolve();
        await resume.promise;
      }
      return getFileHandle(name, options);
    });
    const wesh = new Wesh({ rootHandle: root as unknown as FileSystemDirectoryHandle });
    const spawn = vi.spyOn(wesh.kernel, 'spawn');
    using _release = {
      [Symbol.dispose]() {
        resume.resolve();
        lookup.mockRestore();
        spawn.mockRestore();
      },
    };

    const execution = execute({ wesh, script });
    await started.promise;
    const originalSpawnCount = spawn.mock.calls.length;
    await expect(wesh.signalForegroundProcessGroup({ signal: 2 })).resolves.toBe(true);
    resume.resolve();

    const { result, stdout, stderr } = await execution;
    expect(result).toMatchObject({ exitCode: 130, waitStatus: { kind: 'signaled', signal: 2 } });
    expect(stdout).toBe('');
    expect(stderr).toBe('');
    expect(spawn).toHaveBeenCalledTimes(originalSpawnCount);
    await expect(root.getFileHandle('late')).rejects.toThrow();
  });

  it('interrupts a nested eval, delivers the trap once, and restores the shell descriptors', async () => {
    const wesh = createWesh();
    const setup = await execute({ wesh, script: 'exec 3>retained' });
    expect(setup.result.exitCode).toBe(0);
    const shell = wesh.kernel.getProcesses().find(process => process.image === 'wesh');
    assert(shell !== undefined);
    const stdout = createDelayedStdout();
    const stderr = createTestWriteCaptureHandle();
    const controller = new AbortController();
    using _resume = {
      [Symbol.dispose]() {
        stdout.resume.resolve();
      },
    };

    const execution = wesh.execute({
      source: createTextShellSource({
        text: `\
trap 'printf trapped >&2' INT
command eval 'command eval "printf ready >&3; alias late=late"' 3>&1 >redirected
`,
      }),
      stdin: createTestReadHandleFromText({ text: '' }),
      stdout: stdout.handle,
      stderr: stderr.handle,
      signal: controller.signal,
    });

    await stdout.started.promise;
    controller.abort();
    await expect(wesh.interruptForeground({ foregroundSignal: controller.signal })).resolves.toBe(true);
    stdout.resume.resolve();

    await expect(execution).resolves.toMatchObject({ exitCode: 130, waitStatus: { kind: 'signaled', signal: 2 } });
    expect(stdout.printed.join('')).toBe('ready');
    expect(stderr.text).toBe('trapped');
    const next = await execute({ wesh, script: 'printf restored >&3; exec 3>&-; cat retained; alias late' });
    expect(next.result.exitCode).toBe(1);
    expect(next.stdout).toBe('restored');
    expect(next.stderr).toBe('alias: late: not found\n');
    expect(wesh.kernel.getProcess({ pid: shell.pid })).toBe(shell);
    expect(shell.state).toBe('running');
  });

  it('keeps the shell usable after an ordinary command signals its group', async () => {
    const wesh = createWesh();
    await wesh.init();
    const shell = wesh.kernel.getProcesses().find(process => process.image === 'wesh');
    assert(shell !== undefined);

    const interrupted = await execute({ wesh, script: "trap 'printf trapped >&2' INT; env kill -INT 0" });
    expect(interrupted.result).toMatchObject({ exitCode: 130, waitStatus: { kind: 'signaled', signal: 2 } });
    expect(interrupted.stdout).toBe('');
    expect(interrupted.stderr).toBe('trapped');

    const next = await execute({ wesh, script: "alias next='printf resumed'; alias next" });
    expect(next.result.exitCode).toBe(0);
    expect(next.stdout).toBe("alias next='printf resumed'\n");
    expect(next.stderr).toBe('');
    expect(wesh.kernel.getProcess({ pid: shell.pid })).toBe(shell);
    expect(shell.state).toBe('running');
  });

  it.each([false, true])('routes a shell self-signal only to the input running kill (caught: %s)', async caught => {
    const wesh = createWesh();
    const send = Promise.withResolvers<void>();
    const finish = Promise.withResolvers<void>();
    const sendReady = Promise.withResolvers<void>();
    const finishReady = Promise.withResolvers<void>();
    using _release = {
      [Symbol.dispose]() {
        send.resolve();
        finish.resolve();
      },
    };
    wesh.registerCommand({
      definition: {
        meta: { name: 'park', description: 'Park until released', usage: 'park ID' },
        load: async () => async ({ context }) => {
          if (context.args[0] === 'sender') {
            sendReady.resolve();
            await send.promise;
          } else {
            finishReady.resolve();
            await finish.promise;
          }
          return { exitCode: 0 };
        },
      },
    });
    const sender = execute({
      wesh,
      script: caught
        ? `\
park sender
trap 'printf "caught:%s;" "$?"' USR1
kill -USR1 "$BASHPID"
printf after`
        : 'park sender; kill -INT "$BASHPID"; printf leaked',
    });
    await sendReady.promise;
    const sibling = execute({
      wesh,
      script: `\
park sibling &
wait "$!"
printf sibling`,
    });
    await finishReady.promise;
    await new Promise(resolve => setTimeout(resolve, 0));

    send.resolve();
    if (caught) {
      await expect(sender).resolves.toMatchObject({ result: { exitCode: 0 }, stdout: 'caught:0;after' });
    } else {
      await expect(sender).resolves.toMatchObject({
        result: { exitCode: 130, waitStatus: { kind: 'signaled', signal: 2 } },
        stdout: '',
      });
    }

    finish.resolve();
    await expect(sibling).resolves.toMatchObject({ result: { exitCode: 0 }, stdout: 'sibling' });
  });

  it('keeps a foreground Stop trap pipeline in a separate process group', async () => {
    const wesh = createWesh();
    await wesh.init();
    const rootPid = wesh.kernel.getProcesses().find(({ image }) => image === 'wesh')?.pid;
    assert(rootPid !== undefined);
    const selected = await wesh.kernel.pipe();
    const sibling = await wesh.kernel.pipe();
    await using _pipes = {
      async [Symbol.asyncDispose]() {
        await Promise.all([selected.read.close(), selected.write.close(), sibling.read.close(), sibling.write.close()]);
      },
    };
    const controller = new AbortController();
    const selectedOutput = createTestWriteCaptureHandle();
    const siblingOutput = createTestWriteCaptureHandle();
    const selectedInput = wesh.execute({
      source: createTextShellSource({ text: "trap 'kill -TERM 0 | cat' INT; printf ready; read" }),
      stdin: selected.read,
      stdout: selectedOutput.handle,
      stderr: createTestWriteCaptureHandle().handle,
      signal: controller.signal,
    });
    await expect.poll(() => selectedOutput.text).toBe('ready');
    const siblingInput = wesh.execute({
      source: createTextShellSource({ text: 'printf ready; read; printf resumed' }),
      stdin: sibling.read,
      stdout: siblingOutput.handle,
      stderr: createTestWriteCaptureHandle().handle,
    });
    await expect.poll(() => siblingOutput.text).toBe('ready');

    controller.abort();
    await wesh.interruptForeground({ foregroundSignal: controller.signal });
    await expect(selectedInput).resolves.toMatchObject({ exitCode: 130 });
    expect(wesh.kernel.getProcess({ pid: rootPid })?.state).toBe('running');

    await sibling.write.write({ buffer: new TextEncoder().encode('\n') });
    await expect(siblingInput).resolves.toMatchObject({ exitCode: 0 });
    expect(siblingOutput.text).toBe('readyresumed');
  });

  it('sends to all operands and reports missing PIDs before a fatal self-signal takes effect', async () => {
    const wesh = createWesh();
    const execution = await execute({
      wesh,
      script: `\
bash <<'SCRIPT'
sleep 120 &
printf "%s;" "$!"
trap 'printf "EXIT:%s" "$?"' EXIT
false
kill -TERM "$BASHPID" "$!" 999999
printf leaked
SCRIPT`,
    });
    expect(execution.result).toMatchObject({ exitCode: 143, waitStatus: { kind: 'signaled', signal: 15 } });
    expect(execution.stdout).toMatch(/^\d+;EXIT:0$/u);
    expect(execution.stderr).toContain('999999');
    const pid = Number(execution.stdout.split(';')[0]);
    expect(wesh.kernel.getProcess({ pid })?.state).not.toBe('running');
  });

  it.each([
    { setup: '', signal: 'TERM', exitCode: 143 },
    { setup: "trap 'printf unexpected' EXIT", signal: 'KILL', exitCode: 137 },
  ])('takes an unhandled self $signal before the next operand', async ({ setup, signal, exitCode }) => {
    const wesh = createWesh();
    const execution = await execute({
      wesh,
      script: `\
bash <<'SCRIPT'
${setup}
kill -${signal} "$BASHPID" 999999
printf leaked
SCRIPT`,
    });
    expect(execution.result.exitCode).toBe(exitCode);
    expect(execution.stdout).toBe('');
    expect(execution.stderr).toBe('');
  });

  it.each([
    { script: 'env read X', command: 'read' },
    { script: "env eval 'read X'", command: 'eval' },
    { script: 'env bash -c cat', command: 'cat' },
  ])('interrupts the child of $script while it is blocked on a pipe', async ({ script, command }) => {
    const wesh = createWesh();
    await wesh.init();
    const shell = wesh.kernel.getProcesses().find(process => process.image === 'wesh');
    assert(shell !== undefined);
    const { read, write } = await wesh.kernel.pipe();
    await using _pipe = {
      async [Symbol.asyncDispose]() {
        await write.close();
        await read.close();
      },
    };
    const started = Promise.withResolvers<void>();
    const pipePrototype = Object.getPrototypeOf(read) as Pick<typeof read, 'read'>;
    const readPipe = pipePrototype.read;
    using _read = vi.spyOn(pipePrototype, 'read').mockImplementation(function (this: typeof read, options) {
      const reading = readPipe.call(this, options);
      started.resolve();
      return reading;
    });
    const stdout = createTestWriteCaptureHandle();
    const stderr = createTestWriteCaptureHandle();

    const execution = wesh.execute({
      source: createTextShellSource({ text: script }),
      stdin: read,
      stdout: stdout.handle,
      stderr: stderr.handle,
    });
    const completed = vi.fn();
    void execution.then(completed, completed);
    await Promise.race([started.promise, execution.then(() => {
      throw new Error('Command exited before reading from the pipe');
    })]);

    const child = wesh.kernel.getProcesses().find(process => process.args[0] === command);
    assert(child !== undefined);
    await wesh.kernel.kill({ pid: child.pid, signal: 15 });

    await vi.waitFor(() => expect(completed).toHaveBeenCalledOnce());
    expect(child.waitStatus).toEqual({ kind: 'signaled', signal: 15 });
    await expect(execution).resolves.toEqual({ exitCode: 143, waitStatus: { kind: 'exited', exitCode: 143 } });
    expect(write.hasOpenReferences()).toBe(true);
    expect(stdout.text).toBe('');
    expect(stderr.text).toBe('');

    const next = await execute({ wesh, script: 'printf resumed' });
    expect(next.result.exitCode).toBe(0);
    expect(next.stdout).toBe('resumed');
    expect(next.stderr).toBe('');
    expect(wesh.kernel.getProcess({ pid: shell.pid })).toBe(shell);
    expect(shell.state).toBe('running');
  });

  it('passes an ignored PIPE disposition to a builtin started by env', async () => {
    const wesh = createWesh();
    const { read, write } = await wesh.kernel.pipe();
    await using _write = { [Symbol.asyncDispose]: () => write.close() };
    await read.close();
    const stderr = createTestWriteCaptureHandle();

    const result = await wesh.execute({
      source: createTextShellSource({ text: "trap '' PIPE; env printf discarded" }),
      stdin: createTestReadHandleFromText({ text: '' }),
      stdout: write,
      stderr: stderr.handle,
    });

    expect(result.exitCode).toBe(0);
    expect(stderr.text).toBe('');
  });

  it('interrupts exec while writing a diagnostic for a missing program', async () => {
    const wesh = createWesh();
    const stderr = createDelayedStdout();
    using _resume = {
      [Symbol.dispose]() {
        stderr.resume.resolve();
      },
    };
    const execution = wesh.execute({
      source: createTextShellSource({ text: 'exec /missing-program; printf unavailable' }),
      stdin: createTestReadHandleFromText({ text: '' }),
      stdout: createTestWriteCaptureHandle().handle,
      stderr: stderr.handle,
    });
    const completed = vi.fn();
    void execution.then(completed, completed);
    await stderr.started.promise;
    const shell = wesh.kernel.getProcesses().find(process => process.image === 'wesh');
    assert(shell !== undefined);
    await expect(wesh.signalForegroundProcessGroup({ signal: 2 })).resolves.toBe(true);

    await vi.waitFor(() => expect(completed).toHaveBeenCalledOnce());
    await expect(execution).resolves.toMatchObject({ exitCode: 130 });
    expect(wesh.kernel.getProcess({ pid: shell.pid })).toBe(shell);
    expect(shell.state).toBe('running');
  });

  it('skips alias changes that resume after interruption while printing an alias', async () => {
    const wesh = createWesh();
    const initial = await execute({ wesh, script: "alias present='printf older'" });
    expect(initial.result.exitCode).toBe(0);

    const { handle, printed, started, resume } = createDelayedStdout();
    using _resume = {
      [Symbol.dispose]() {
        resume.resolve();
      },
    };
    const stderr = createTestWriteCaptureHandle();
    const abort = new AbortController();
    const execution = wesh.execute({
      source: createTextShellSource({ text: "alias present late='printf leaked'" }),
      stdin: createTestReadHandleFromText({ text: '' }),
      stdout: handle,
      stderr: stderr.handle,
      signal: abort.signal,
    });

    await started.promise;
    abort.abort();
    const interrupted = wesh.interruptForeground({ foregroundSignal: abort.signal });
    resume.resolve();

    await expect(interrupted).resolves.toBe(true);
    await expect(execution).resolves.toMatchObject({ exitCode: 130 });
    expect(printed.join('')).toBe("alias present='printf older'\n");
    expect(stderr.text).toBe('');
    expect(wesh.listCommands()).toContainEqual(expect.objectContaining({ name: 'present', kind: 'alias' }));
    expect(wesh.listCommands()).not.toContainEqual(expect.objectContaining({ name: 'late', kind: 'alias' }));
  });

  it('expires the alias binding when its invocation returns while the body waits for output', async () => {
    const stdout = createDelayedStdout();
    const attempted = Promise.withResolvers<void>();
    const loadAlias = aliasCommandDefinition.loadShellBuiltin;
    let delayedBody: Promise<unknown> | undefined;
    const spy = vi.spyOn(aliasCommandDefinition, 'loadShellBuiltin').mockImplementation(async () => {
      const command = await loadAlias();
      return async ({ context, shell }) => {
        if (context.args[0] !== 'present') {
          return command({ context, shell });
        }
        delayedBody = command({
          context,
          shell: {
            ...shell,
            setAlias: ({ name, value }) => {
              attempted.resolve();
              shell.setAlias({ name, value });
            },
          },
        });
        void delayedBody.catch(() => {});
        await stdout.started.promise;
        return { exitCode: 0 };
      };
    });
    using _release = {
      [Symbol.dispose]() {
        stdout.resume.resolve();
        spy.mockRestore();
      },
    };
    const wesh = createWesh();
    const initial = await execute({ wesh, script: "alias present='printf older'" });
    expect(initial.result.exitCode).toBe(0);
    const stderr = createTestWriteCaptureHandle();

    const result = await wesh.execute({
      source: createTextShellSource({ text: "alias present late='printf leaked'" }),
      stdin: createTestReadHandleFromText({ text: '' }),
      stdout: stdout.handle,
      stderr: stderr.handle,
    });
    expect(result.exitCode).toBe(0);
    expect(stdout.printed.join('')).toBe("alias present='printf older'\n");
    expect(stderr.text).toBe('');

    stdout.resume.resolve();
    await attempted.promise;
    await expect(delayedBody).resolves.toMatchObject({ exitCode: 0 });
    expect(wesh.listCommands()).not.toContainEqual(expect.objectContaining({ name: 'late', kind: 'alias' }));
  });
});
