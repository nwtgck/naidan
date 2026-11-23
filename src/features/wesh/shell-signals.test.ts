import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Wesh } from './index';
import { MockFileSystemDirectoryHandle } from './mocks/InMemoryFileSystem';
import { WeshShellChildren, type WeshShellChild } from './shell/child-processes';
import { createTextShellSource } from './shell/source';
import type { WeshCommandFunction, WeshFileHandle } from './types';
import { createTestReadHandleFromText, createTestWriteCaptureHandle } from './utils/test-stream';

describe('Wesh shell signal delivery', () => {
  let wesh: Wesh;
  let root: MockFileSystemDirectoryHandle;

  beforeEach(async () => {
    root = new MockFileSystemDirectoryHandle({ name: 'root' });
    wesh = new Wesh({ rootHandle: root as unknown as FileSystemDirectoryHandle });
    await wesh.init();
  });

  function execute({ script, signal, stdin }: { script: string, signal?: AbortSignal, stdin?: WeshFileHandle }) {
    const stdout = createTestWriteCaptureHandle();
    const stderr = createTestWriteCaptureHandle();
    const result = wesh.execute({
      source: createTextShellSource({ text: script }),
      stdin: stdin ?? createTestReadHandleFromText({ text: '' }),
      stdout: stdout.handle,
      stderr: stderr.handle,
      signal,
    });
    return { result, stdout, stderr };
  }

  function executeBash({ script }: { script: string }) {
    return execute({ script: "bash -c '" + script.replaceAll("'", "'\"'\"'") + "'" });
  }

  function registerHold({ exitCode }: { exitCode: number }) {
    const started = Promise.withResolvers<number>();
    const finish = Promise.withResolvers<void>();
    wesh.registerCommand({
      definition: {
        meta: { name: 'hold', description: 'Wait for the test to release the command', usage: 'hold' },
        load: async () => async ({ context }) => {
          started.resolve(context.pid);
          await finish.promise;
          return { exitCode };
        },
      },
    });
    return {
      started: started.promise,
      release: finish.resolve,
      [Symbol.dispose]: finish.resolve,
    };
  }

  function registerCold({ name, command }: { name: string, command: WeshCommandFunction }) {
    const started = Promise.withResolvers<void>();
    const load = Promise.withResolvers<WeshCommandFunction>();
    wesh.registerCommand({
      definition: {
        meta: { name, description: 'Wait for the test to load the command', usage: name },
        load: () => {
          started.resolve();
          return load.promise;
        },
      },
    });
    const release = () => load.resolve(command);
    return {
      started: started.promise,
      release,
      [Symbol.dispose]: release,
    };
  }

  function getBashProcess() {
    const shell = wesh.kernel.getProcesses().find(({ args }) => args[0] === 'bash');
    if (shell === undefined) {
      throw new Error('Expected a running Bash process');
    }
    return shell;
  }

  it('runs a trapped PID signal during wait and can wait for the same child again', async () => {
    using child = registerHold({ exitCode: 7 });
    const running = executeBash({
      script: `\
trap 'printf "TERM:%s\\n" "$?"' TERM
hold &
child=$!
printf 'ready\\n'
wait "$child"
printf 'wait:%s\\n' "$?"
wait "$child"
printf 'again:%s\\n' "$?"
`,
    });
    const childPid = await child.started;
    await expect.poll(() => running.stdout.text).toBe('ready\n');
    const shell = getBashProcess();

    await wesh.kernel.kill({ pid: shell.pid, signal: 15 });
    await expect.poll(() => running.stdout.text).toBe(`\
ready
TERM:143
wait:143
`);
    expect(shell.state).toBe('running');
    expect(shell.waitStatus).toBeUndefined();
    expect(wesh.kernel.getProcess({ pid: childPid })?.state).toBe('running');

    child.release();
    await expect(running.result).resolves.toMatchObject({ exitCode: 0 });
    expect(running.stdout.text).toBe(`\
ready
TERM:143
wait:143
again:7
`);
    expect(running.stderr.text).toBe('');
    expect(shell.waitStatus).toEqual({ kind: 'exited', exitCode: 0 });
  });

  it.each([
    { command: 'wait "$child"', trapInFile: false },
    { command: 'command wait "$child"', trapInFile: false },
    { command: "eval 'wait \"$child\"'", trapInFile: true },
    { command: 'source /wait.sh', trapInFile: true },
  ])('uses the correct trap output while $command has a redirection', async ({ command, trapInFile }) => {
    using child = registerHold({ exitCode: 7 });
    const source = await root.getFileHandle('wait.sh', { create: true });
    source.content = new TextEncoder().encode('wait "$child"\n');
    const target = await root.getFileHandle('out', { create: true });
    const writer = await target.createWritable({ keepExistingData: true });
    const close = writer.close.bind(writer);
    const resumeClose = Promise.withResolvers<void>();
    using _resume = { [Symbol.dispose]: resumeClose.resolve };
    using open = vi.spyOn(target, 'createWritable').mockResolvedValueOnce(writer);
    using closing = vi.spyOn(writer, 'close').mockImplementationOnce(async () => {
      await resumeClose.promise;
      await close();
    });
    const waiting = vi.fn();
    const getChild = WeshShellChildren.prototype.get;
    using _getChild = vi.spyOn(WeshShellChildren.prototype, 'get').mockImplementation(function (this: WeshShellChildren, options) {
      const entry = getChild.call(this, options);
      if (entry !== undefined && entry.waitStatus === undefined) {
        waiting();
      }
      return entry;
    });
    const running = executeBash({
      script: `\
trap 'printf "TERM:%s\\n" "$?"' TERM
hold &
child=$!
printf 'ready\\n'
${command} >out
printf 'wait:%s\\n' "$?"
wait "$child"
printf 'again:%s\\n' "$?"
`,
    });
    await child.started;
    await expect.poll(() => waiting.mock.calls.length).toBe(1);
    expect(open).toHaveBeenCalledOnce();
    const shell = getBashProcess();

    await wesh.kernel.kill({ pid: shell.pid, signal: 15 });
    await expect.poll(() => closing.mock.calls.length).toBe(1);
    expect(running.stdout.text).toBe('ready\n');
    resumeClose.resolve();

    await expect.poll(() => running.stdout.text).toContain('wait:143\n');
    await expect((await target.getFile()).text()).resolves.toBe(trapInFile ? 'TERM:143\n' : '');
    child.release();
    await expect(running.result).resolves.toMatchObject({ exitCode: 0 });
    expect(running.stdout.text.split('\n')).toEqual([
      'ready',
      ...(trapInFile ? [] : ['TERM:143']),
      'wait:143',
      'again:7',
      '',
    ]);
    expect(running.stderr.text).toBe('');
  });

  it('keeps a TERM received in the Stop turn pending until the next input', async () => {
    using child = registerHold({ exitCode: 7 });
    const controller = new AbortController();
    const running = execute({
      script: `\
trap 'printf "TERM\\n"' TERM
trap 'printf "INT:%s\\n" "$?"' INT
hold &
child=$!
printf '%s\\n' "$BASHPID"
wait "$child"
printf late
`,
      signal: controller.signal,
    });
    await child.started;
    await expect.poll(() => running.stdout.text).toMatch(/^\d+\n$/);
    const pid = Number(running.stdout.text);
    const shell = wesh.kernel.getProcess({ pid });
    expect(shell?.state).toBe('running');

    const delivery = wesh.kernel.kill({ pid, signal: 15 });
    controller.abort();
    const interrupt = wesh.interruptForeground({ foregroundSignal: controller.signal });
    await delivery;
    await interrupt;
    await expect.poll(() => Promise.race([running.result, undefined])).toMatchObject({
      exitCode: 130,
      waitStatus: { kind: 'signaled', signal: 2 },
    });
    expect(running.stdout.text).toBe(`\
${pid}
INT:130
`);
    expect(running.stderr.text).toBe('');
    expect(wesh.kernel.getProcess({ pid })).toBe(shell);

    const next = execute({ script: 'printf "after\\n"' });
    await expect(next.result).resolves.toMatchObject({ exitCode: 0 });
    expect(next.stdout.text).toBe(`\
TERM
after
`);
    expect(next.stderr.text).toBe('');
  });

  it('keeps the existing TERM trap after exec changes only file descriptors', async () => {
    using child = registerHold({ exitCode: 7 });
    const running = executeBash({
      script: `\
trap 'printf "TERM:%s\\n" "$?" >&3' TERM
exec 3>out
hold
printf 'child:%s\\n' "$?"
exec 3>&-
cat out
`,
    });
    await child.started;
    const shell = getBashProcess();
    await wesh.kernel.kill({ pid: shell.pid, signal: 15 });
    expect(shell.waitStatus).toBeUndefined();
    child.release();

    await expect(running.result).resolves.toMatchObject({ exitCode: 0 });
    expect(running.stdout.text).toBe(`\
child:7
TERM:7
`);
    expect(running.stderr.text).toBe('');
  });

  it('runs the TERM trap after a group signal kills an ordinary foreground child', async () => {
    const controller = new AbortController();
    await using _stop = {
      async [Symbol.asyncDispose]() {
        controller.abort();
        await wesh.interruptForeground({ foregroundSignal: controller.signal });
      },
    };
    const running = execute({
      script: `\
trap 'printf "TERM:%s\\n" "$?"' TERM
printf '%s\\n' "$BASHPID"
sleep 10
printf 'after:%s\\n' "$?"
`,
      signal: controller.signal,
    });
    await expect.poll(() => wesh.kernel.getProcesses().some(({ args }) => args[0] === 'sleep')).toBe(true);
    const child = wesh.kernel.getProcesses().find(({ args }) => args[0] === 'sleep');
    const pid = Number(running.stdout.text);
    const shell = wesh.kernel.getProcess({ pid });
    expect(child?.pgid).toBe(shell?.pgid);

    await expect(wesh.signalForegroundProcessGroup({ signal: 15, foregroundSignal: controller.signal })).resolves.toBe(true);
    await expect.poll(() => Promise.race([running.result, undefined])).toMatchObject({ exitCode: 0 });
    expect(child?.waitStatus).toEqual({ kind: 'signaled', signal: 15 });
    expect(shell?.waitStatus).toBeUndefined();
    expect(wesh.kernel.getProcess({ pid })).toBe(shell);
    expect(running.stdout.text).toBe(`\
${pid}
TERM:143
after:143
`);
  });

  it('interrupts the selected interactive input while another input is waiting', async () => {
    const firstInput = await wesh.kernel.pipe();
    const secondInput = await wesh.kernel.pipe();
    await using _close = {
      async [Symbol.asyncDispose]() {
        await firstInput.write.close();
        await secondInput.write.close();
        await firstInput.read.close();
        await secondInput.read.close();
      },
    };
    const firstController = new AbortController();
    const secondController = new AbortController();
    const first = execute({
      script: 'printf first-ready; read value; printf first-after',
      signal: firstController.signal,
      stdin: firstInput.read,
    });
    await expect.poll(() => first.stdout.text).toBe('first-ready');
    const second = execute({
      script: 'printf second-ready; read value; printf second-after',
      signal: secondController.signal,
      stdin: secondInput.read,
    });
    await expect.poll(() => second.stdout.text).toBe('second-ready');

    await expect(wesh.signalForegroundProcessGroup({ signal: 2, foregroundSignal: firstController.signal })).resolves.toBe(true);
    await expect.poll(() => Promise.race([first.result, undefined]), { timeout: 500 }).toEqual({
      exitCode: 130,
      waitStatus: { kind: 'signaled', signal: 2 },
    });
    expect(first.stdout.text).toBe('first-ready');
    expect(await Promise.race([second.result, undefined])).toBeUndefined();

    await secondInput.write.close();
    await expect(second.result).resolves.toMatchObject({ exitCode: 0 });
    expect(second.stdout.text).toBe('second-readysecond-after');
  });

  it.each([
    {
      delivery: 'one TERM',
      signals: [15],
      expected: `\
TERM:7
ERR:7
after:7
`,
    },
    {
      delivery: 'TERM, USR1, then TERM again',
      signals: [15, 10, 15],
      expected: `\
USR1:7
TERM:7
ERR:7
after:7
`,
    },
  ])('defers $delivery until an ordinary foreground command completes', async ({ signals, expected }) => {
    using child = registerHold({ exitCode: 7 });
    const running = executeBash({
      script: `\
trap 'printf "TERM:%s\\n" "$?"' TERM
trap 'printf "USR1:%s\\n" "$?"' USR1
trap 'printf "ERR:%s\\n" "$?"' ERR
hold
printf 'after:%s\\n' "$?"
`,
    });
    const childPid = await child.started;
    const shell = getBashProcess();
    for (const signal of signals) {
      await wesh.kernel.kill({ pid: shell.pid, signal });
    }
    expect(await Promise.race([running.result, new Promise<void>(resolve => setTimeout(resolve, 0))])).toBeUndefined();
    expect(running.stdout.text).toBe('');
    expect(shell.waitStatus).toBeUndefined();
    expect(wesh.kernel.getProcess({ pid: childPid })?.state).toBe('running');

    child.release();
    await expect(running.result).resolves.toMatchObject({ exitCode: 0 });
    expect(running.stdout.text).toBe(expected);
    expect(running.stderr.text).toBe('');
    expect(shell.waitStatus).toEqual({ kind: 'exited', exitCode: 0 });
  });

  it('interrupts only one of two waits on the same shell when its PID receives a trapped TERM', async () => {
    using child = registerHold({ exitCode: 7 });
    const launch = execute({
      script: `\
trap 'printf "TERM:%s\\n" "$?"' TERM
hold &
child=$!
printf '%s\\n' "$BASHPID"
`,
    });
    await expect(launch.result).resolves.toMatchObject({ exitCode: 0 });
    const childPid = await child.started;
    const pid = Number(launch.stdout.text);
    const shell = wesh.kernel.getProcess({ pid });
    expect(shell?.state).toBe('running');

    const script = 'printf "ready\\n"; wait "$child"; printf "wait:%s\\n" "$?"';
    const waits = [execute({ script }), execute({ script })];
    await expect.poll(() => waits.map(wait => wait.stdout.text)).toEqual(['ready\n', 'ready\n']);
    await wesh.kernel.kill({ pid, signal: 15 });
    await expect.poll(() => waits.filter(wait => wait.stdout.text.includes('wait:143\n')).length).toBe(1);

    const notified = waits.find(wait => wait.stdout.text.includes('wait:143\n'));
    const waiting = waits.find(wait => wait !== notified);
    if (notified === undefined || waiting === undefined) {
      throw new Error('Expected one interrupted wait and one pending wait');
    }
    await expect(notified.result).resolves.toMatchObject({ exitCode: 0 });
    expect(notified.stdout.text).toBe(`\
ready
TERM:143
wait:143
`);
    expect(await Promise.race([waiting.result, new Promise<void>(resolve => setTimeout(resolve, 0))])).toBeUndefined();
    expect(waiting.stdout.text).toBe('ready\n');
    expect(wesh.kernel.getProcess({ pid: childPid })?.state).toBe('running');

    child.release();
    await expect(waiting.result).resolves.toMatchObject({ exitCode: 0 });
    expect(waiting.stdout.text).toBe(`\
ready
wait:7
`);
    expect(notified.stderr.text).toBe('');
    expect(waiting.stderr.text).toBe('');
    expect(wesh.kernel.getProcess({ pid })).toBe(shell);
    expect(shell?.waitStatus).toBeUndefined();
  });

  it('keeps the child result if a trapped TERM follows its wait notification in the same turn', async () => {
    using child = registerHold({ exitCode: 7 });
    const entry = Promise.withResolvers<WeshShellChild>();
    const register = WeshShellChildren.prototype.register;
    using _register = vi.spyOn(WeshShellChildren.prototype, 'register').mockImplementationOnce(function (this: WeshShellChildren, options) {
      register.call(this, options);
      const registered = this.get({ pid: options.pid });
      if (registered === undefined) {
        throw new Error('Expected the child to be registered');
      }
      entry.resolve(registered);
    });
    const launch = execute({
      script: `\
trap 'printf "TERM:%s\\n" "$?"' TERM
hold &
child=$!
printf '%s\\n' "$BASHPID"
`,
    });
    await expect(launch.result).resolves.toMatchObject({ exitCode: 0 });
    await child.started;
    const pid = Number(launch.stdout.text);
    const childEntry = await entry.promise;
    const subscribe = childEntry.subscribe.bind(childEntry);
    const waiting = Promise.withResolvers<void>();
    const delivery = Promise.withResolvers<void>();
    using _subscribe = vi.spyOn(childEntry, 'subscribe').mockImplementationOnce(({ notify }) => {
      const unsubscribeWait = subscribe({ notify });
      const unsubscribeObserver = subscribe({
        notify: () => delivery.resolve(wesh.kernel.kill({ pid, signal: 15 })),
      });
      waiting.resolve();
      return () => {
        unsubscribeWait();
        unsubscribeObserver();
      };
    });

    const running = execute({ script: 'wait "$child"; printf "wait:%s\\n" "$?"' });
    await expect(Promise.race([waiting.promise, running.result])).resolves.toBeUndefined();
    child.release();
    await delivery.promise;

    await expect(running.result).resolves.toMatchObject({ exitCode: 0 });
    expect(running.stdout.text).toBe(`\
TERM:7
wait:7
`);
    expect(running.stderr.text).toBe('');
  });

  it('honors an explicit exit in the old shell trap before exec replaces it', async () => {
    const replacement = vi.fn<WeshCommandFunction>(async () => ({ exitCode: 0 }));
    using cold = registerCold({ name: 'replacement', command: replacement });
    const running = executeBash({
      script: "trap 'printf OLD; exit 42' TERM; exec replacement; printf late",
    });
    await expect(Promise.race([cold.started, running.result])).resolves.toBeUndefined();
    const shell = getBashProcess();
    await wesh.kernel.kill({ pid: shell.pid, signal: 15 });
    cold.release();

    await expect(running.result).resolves.toMatchObject({ exitCode: 42 });
    expect(running.stdout.text).toBe('OLD');
    expect(running.stderr.text).toBe('');
    expect(shell.waitStatus).toEqual({ kind: 'exited', exitCode: 42 });
    expect(replacement).not.toHaveBeenCalled();
  });

  it('keeps the forwarded FD closure when a trap opens the same FD before exec commits', async () => {
    const replacement = vi.fn<WeshCommandFunction>(async ({ context }) => {
      const fd = context.getFileDescriptor({ fd: 3 });
      await fd?.write({ buffer: new TextEncoder().encode('leaked') });
      await context.text().print({ text: fd === undefined ? 'closed' : 'open' });
      return { exitCode: 0 };
    });
    using cold = registerCold({ name: 'replaced', command: replacement });
    const running = executeBash({
      script: "exec 3>old; trap 'exec 3>new' TERM; command exec replaced 3>&-; printf late",
    });
    await expect(Promise.race([cold.started, running.result])).resolves.toBeUndefined();
    const shell = getBashProcess();
    await wesh.kernel.kill({ pid: shell.pid, signal: 15 });
    cold.release();

    await expect(running.result).resolves.toMatchObject({ exitCode: 0 });
    expect(running.stdout.text).toBe('closed');
    expect(running.stderr.text).toBe('');
    expect(replacement).toHaveBeenCalledOnce();
    const output = await root.getFileHandle('new');
    await expect((await output.getFile()).text()).resolves.toBe('');
  });

  it('delivers TERM to the program at the same PID after exec without running the old shell trap', async () => {
    using replacement = registerHold({ exitCode: 0 });
    const running = executeBash({
      script: "trap 'printf OLD; exit 42' TERM; printf '%s\\n' \"$BASHPID\"; exec hold; printf late",
    });
    const pid = await replacement.started;
    expect(running.stdout.text).toBe(String(pid) + '\n');
    const process = wesh.kernel.getProcess({ pid });
    expect(process?.args[0]).toBe('hold');

    await wesh.kernel.kill({ pid, signal: 15 });
    expect(process?.waitStatus).toEqual({ kind: 'signaled', signal: 15 });
    replacement.release();

    await expect(running.result).resolves.toMatchObject({ exitCode: 143 });
    expect(running.stdout.text).toBe(String(pid) + '\n');
    expect(running.stderr.text).toBe('');
    expect(wesh.kernel.getProcess({ pid })).toBeUndefined();
  });

  it.each([
    {
      name: 'trap exit',
      setup: "trap 'exit 42' TERM",
      expected: 'ready\n',
      exitCode: 42,
    },
    {
      name: 'errexit',
      setup: `\
set -e
trap 'printf "TERM:%s\\n" "$?"' TERM
trap 'printf "ERR:%s\\n" "$?"' ERR
`,
      expected: `\
ready
TERM:143
ERR:143
`,
      exitCode: 143,
    },
  ])('ends an interrupted wait normally when $name is active', async ({ setup, expected, exitCode }) => {
    using child = registerHold({ exitCode: 7 });
    const running = executeBash({
      script: `\
${setup}
hold &
child=$!
printf 'ready\\n'
wait "$child"
printf late
`,
    });
    const childPid = await child.started;
    await expect.poll(() => running.stdout.text).toBe('ready\n');
    const shell = getBashProcess();

    await wesh.kernel.kill({ pid: shell.pid, signal: 15 });
    await expect.poll(() => Promise.race([running.result, undefined])).toMatchObject({ exitCode });
    expect(shell.waitStatus).toEqual({ kind: 'exited', exitCode });
    expect(running.stdout.text).toBe(expected);
    expect(running.stderr.text).toBe('');
    expect(wesh.kernel.getProcess({ pid: childPid })?.state).toBe('running');
  });

  describe.each(['PID', 'PGID'])('%s delivery', route => {
    it.each([
      { name: 'WINCH', number: 28 },
      { name: 'URG', number: 23 },
      { name: 'CHLD', number: 17 },
      { name: 'CONT', number: 18 },
    ])('keeps running processes alive with the default $name disposition', async ({ number }) => {
      using child = registerHold({ exitCode: 0 });
      const controller = new AbortController();
      const running = execute({
        script: 'printf "%s\\n" "$BASHPID"; hold; printf after',
        signal: controller.signal,
      });
      const childPid = await child.started;
      const pid = Number(running.stdout.text);
      const shell = wesh.kernel.getProcess({ pid });
      expect(shell?.state).toBe('running');

      if (route === 'PID') {
        await wesh.kernel.kill({ pid, signal: number });
        await wesh.kernel.kill({ pid: childPid, signal: number });
      } else {
        await expect(wesh.signalForegroundProcessGroup({ signal: number, foregroundSignal: controller.signal })).resolves.toBe(true);
      }
      expect(shell?.state).toBe('running');
      expect(shell?.waitStatus).toBeUndefined();
      expect(wesh.kernel.getProcess({ pid: childPid })?.state).toBe('running');
      expect(running.stdout.text).toBe(String(pid) + '\n');

      child.release();
      await expect(running.result).resolves.toMatchObject({ exitCode: 0 });
      expect(running.stdout.text).toBe(String(pid) + '\nafter');
      expect(running.stderr.text).toBe('');
      expect(wesh.kernel.getProcess({ pid })).toBe(shell);
    });
  });
});
