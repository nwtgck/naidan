import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Wesh } from './index';
import { MockFileSystemDirectoryHandle } from './mocks/InMemoryFileSystem';
import { WeshShellChildren } from './shell/child-processes';
import { createTextShellSource } from './shell/source';
import type { WeshCommandFunction, WeshFileHandle } from './types';
import { openFileDescription } from './utils/file-input';
import { createTestReadHandleFromText, createTestWriteCaptureHandle } from './utils/test-stream';

describe('Wesh shell PID termination', () => {
  let root: MockFileSystemDirectoryHandle;
  let wesh: Wesh;

  beforeEach(async () => {
    root = new MockFileSystemDirectoryHandle({ name: 'root' });
    wesh = new Wesh({ rootHandle: root as unknown as FileSystemDirectoryHandle });
    await wesh.init();
  });

  function execute({ script, stdin, signal, stderr: stderrHandle }: {
    script: string,
    stdin?: WeshFileHandle,
    signal?: AbortSignal,
    stderr?: WeshFileHandle,
  }) {
    const stdout = createTestWriteCaptureHandle();
    const stderr = createTestWriteCaptureHandle();
    const result = wesh.execute({
      source: createTextShellSource({ text: script }),
      stdin: stdin ?? createTestReadHandleFromText({ text: '' }),
      stdout: stdout.handle,
      stderr: stderrHandle ?? stderr.handle,
      signal,
    });
    return { result, stdout, stderr };
  }

  function executeBash({ script, stdin, signal, stderr }: {
    script: string,
    stdin?: WeshFileHandle,
    signal?: AbortSignal,
    stderr?: WeshFileHandle,
  }) {
    return execute({ script: "bash -c '" + script.replaceAll("'", "'\"'\"'") + "'", stdin, signal, stderr });
  }

  function registerGatedCommand({ name, command }: { name: string, command: WeshCommandFunction }) {
    const started = Promise.withResolvers<number>();
    const resume = Promise.withResolvers<void>();
    wesh.registerCommand({
      definition: {
        meta: { name, description: 'Wait for the test to release the command', usage: name },
        load: async () => async invocation => {
          started.resolve(invocation.context.pid);
          await resume.promise;
          return command(invocation);
        },
      },
    });
    return {
      started: started.promise,
      release: resume.resolve,
      [Symbol.dispose]: resume.resolve,
    };
  }

  function registerWriter({ name, path, contents }: { name: string, path: string, contents: string }) {
    return registerGatedCommand({
      name,
      command: async ({ context }) => {
        const file = await context.files.open({
          path,
          flags: { access: 'write', creation: 'if-needed', truncate: 'truncate', append: 'preserve' },
        });
        await using _close = { [Symbol.asyncDispose]: () => file.close() };
        await file.write({ buffer: new TextEncoder().encode(contents) });
        return { exitCode: 0 };
      },
    });
  }

  function getBashProcess() {
    const shell = wesh.kernel.getProcesses().find(({ args }) => args[0] === 'bash');
    if (shell === undefined) {
      throw new Error('Expected a running Bash process');
    }
    return shell;
  }

  function observePipeRead({ handle }: { handle: WeshFileHandle }) {
    const description = openFileDescription({ handle });
    const prototype = Object.getPrototypeOf(handle) as Pick<WeshFileHandle, 'read'>;
    const read = prototype.read;
    const started = Promise.withResolvers<{ pendingRead: ReturnType<WeshFileHandle['read']> }>();
    const spy = vi.spyOn(prototype, 'read').mockImplementation(function (this: WeshFileHandle, options) {
      const pendingRead = read.call(this, options);
      if (openFileDescription({ handle: this }) === description) {
        started.resolve({ pendingRead });
      }
      return pendingRead;
    });
    return {
      started: started.promise,
      [Symbol.dispose]: () => spy.mockRestore(),
    };
  }

  it.each([
    {
      name: 'TERM',
      signal: 15,
      trapTail: '',
      exitCode: 143,
      waitStatus: { kind: 'signaled', signal: 15 },
      expected: 'EXIT:1\n',
    },
    {
      name: 'KILL',
      signal: 9,
      trapTail: '',
      exitCode: 137,
      waitStatus: { kind: 'signaled', signal: 9 },
      expected: '',
    },
    {
      name: 'TERM with an exit from the EXIT trap',
      signal: 15,
      trapTail: '; exit 42',
      exitCode: 143,
      waitStatus: { kind: 'signaled', signal: 15 },
      expected: 'EXIT:1\n',
    },
    {
      name: 'TERM with an exec from the EXIT trap',
      signal: 15,
      trapTail: '; exec bash -c "printf replaced; exit 42"',
      exitCode: 42,
      waitStatus: { kind: 'exited', exitCode: 42 },
      expected: `\
EXIT:1
replaced`,
    },
  ])('finishes the targeted Bash before its ordinary child on $name', async ({ signal, trapTail, exitCode, waitStatus, expected }) => {
    using child = registerWriter({ name: 'hold-child', path: '/finished', contents: 'child' });
    const running = executeBash({
      script: `\
trap 'printf "EXIT:%s\\n" "$?"${trapTail}' EXIT
false
hold-child
printf late
`,
    });
    const childPid = await child.started;
    const shell = getBashProcess();
    expect(wesh.kernel.getProcess({ pid: childPid })?.ppid).toBe(shell.pid);

    const delivery = wesh.kernel.kill({ pid: shell.pid, signal });
    await expect.poll(() => Promise.race([running.result, undefined])).toMatchObject({ exitCode, waitStatus });
    expect(shell.waitStatus).toEqual(waitStatus);
    expect(wesh.kernel.getProcess({ pid: shell.pid })).toBeUndefined();
    expect(wesh.kernel.getProcess({ pid: childPid })?.state).toBe('running');
    expect(running.stdout.text).toBe(expected);
    expect(running.stderr.text).toBe('');
    await expect(root.getFileHandle('finished')).rejects.toMatchObject({ name: 'NotFoundError' });

    child.release();
    await delivery;
    await expect.poll(() => wesh.kernel.getProcess({ pid: childPid })).toBeUndefined();
    const output = await root.getFileHandle('finished');
    await expect((await output.getFile()).text()).resolves.toBe('child');
  });

  it('stops an EXIT trap with KILL while leaving its ordinary children alive', async () => {
    using child = registerWriter({ name: 'hold-child', path: '/finished', contents: 'child' });
    using trapChild = registerWriter({ name: 'hold-trap', path: '/trap-finished', contents: 'trap child' });
    const running = executeBash({
      script: `\
trap 'printf "EXIT:%s\\n" "$?"; hold-trap; printf late-trap' EXIT
false
hold-child
printf late
`,
    });
    const childPid = await child.started;
    const shell = getBashProcess();
    const term = wesh.kernel.kill({ pid: shell.pid, signal: 15 });
    await expect.poll(() => Promise.race([trapChild.started, undefined])).toBeDefined();
    const trapPid = await trapChild.started;
    expect(wesh.kernel.getProcess({ pid: trapPid })?.ppid).toBe(shell.pid);
    expect(running.stdout.text).toBe('EXIT:1\n');

    const kill = wesh.kernel.kill({ pid: shell.pid, signal: 9 });
    const waitStatus = { kind: 'signaled', signal: 9 };
    await expect.poll(() => Promise.race([running.result, undefined])).toMatchObject({ exitCode: 137, waitStatus });
    expect(shell.waitStatus).toEqual(waitStatus);
    expect(running.stdout.text).toBe('EXIT:1\n');
    expect(running.stderr.text).toBe('');
    expect(wesh.kernel.getProcess({ pid: childPid })?.state).toBe('running');
    expect(wesh.kernel.getProcess({ pid: trapPid })?.state).toBe('running');

    child.release();
    trapChild.release();
    await term;
    await kill;
    await expect.poll(() => wesh.kernel.getProcess({ pid: childPid })).toBeUndefined();
    await expect.poll(() => wesh.kernel.getProcess({ pid: trapPid })).toBeUndefined();
    const output = await root.getFileHandle('finished');
    const trapOutput = await root.getFileHandle('trap-finished');
    await expect((await output.getFile()).text()).resolves.toBe('child');
    await expect((await trapOutput.getFile()).text()).resolves.toBe('trap child');
  });

  it.each([
    { invocation: 'kill -TERM "$BASHPID" >out', signal: 15, stdout: 'EXIT:outer:0', file: '' },
    { invocation: 'command kill -INT "$BASHPID" >out', signal: 2, stdout: 'EXIT:outer:0', file: '' },
    { invocation: 'builtin kill -TERM "$BASHPID" >out', signal: 15, stdout: 'EXIT:outer:0', file: '' },
    { invocation: '{ kill -TERM "$BASHPID"; } >out', signal: 15, stdout: 'EXIT:outer:0', file: '' },
    { invocation: 'f() { local value=inner; kill -TERM "$BASHPID"; }; f >out', signal: 15, stdout: 'EXIT:outer:0', file: '' },
    { invocation: `eval 'kill -TERM "$BASHPID"' >out`, signal: 15, stdout: '', file: 'EXIT:outer:0' },
  ])('runs EXIT at the source boundary for $invocation', async ({ invocation, signal, stdout, file }) => {
    const running = executeBash({
      script: `\
value=outer
trap 'printf "EXIT:%s:%s" "$value" "$?"' EXIT
false
${invocation}
printf unexpected`,
    });
    await expect(running.result).resolves.toMatchObject({
      exitCode: 128 + signal,
      waitStatus: { kind: 'signaled', signal },
    });
    expect(running.stdout.text).toBe(stdout);
    expect(running.stderr.text).toBe('');
    await expect((await (await root.getFileHandle('out')).getFile()).text()).resolves.toBe(file);
  });

  it('finishes on KILL while the EXIT trap is writing a parser diagnostic to a full pipe', async () => {
    using child = registerGatedCommand({
      name: 'hold-child',
      command: async () => ({ exitCode: 0 }),
    });
    const pipe = await wesh.kernel.pipe();
    await using _pipe = {
      async [Symbol.asyncDispose]() {
        await pipe.write.close();
        await pipe.read.close();
      },
    };
    const fill = new Uint8Array(64 * 1024);
    await expect(pipe.write.write({ buffer: fill })).resolves.toEqual({ bytesWritten: fill.length });
    const description = openFileDescription({ handle: pipe.write });
    const prototype = Object.getPrototypeOf(pipe.write) as Pick<WeshFileHandle, 'write'>;
    const write = prototype.write;
    const started = Promise.withResolvers<{ pendingWrite: ReturnType<WeshFileHandle['write']> }>();
    using _write = vi.spyOn(prototype, 'write').mockImplementation(function (this: WeshFileHandle, options) {
      const pendingWrite = write.call(this, options);
      if (openFileDescription({ handle: this }) === description) {
        started.resolve({ pendingWrite });
      }
      return pendingWrite;
    });
    const running = executeBash({
      script: "trap 'printf trap-ready; eval \"if\"' EXIT; hold-child; printf late",
      stderr: pipe.write,
    });
    const childPid = await child.started;
    const shell = getBashProcess();
    const term = wesh.kernel.kill({ pid: shell.pid, signal: 15 });
    const { pendingWrite } = await Promise.race([started.promise, running.result.then(() => {
      throw new Error('Bash exited before writing the diagnostic to the pipe');
    })]);
    expect(running.stdout.text).toBe('trap-ready');
    expect(await Promise.race([pendingWrite, undefined])).toBeUndefined();

    const kill = wesh.kernel.kill({ pid: shell.pid, signal: 9 });
    const waitStatus = { kind: 'signaled', signal: 9 };
    await expect.poll(() => Promise.race([running.result, undefined])).toMatchObject({ exitCode: 137, waitStatus });
    await expect.poll(() => Promise.race([pendingWrite, undefined])).toMatchObject({ bytesWritten: 0 });
    expect(shell.waitStatus).toEqual(waitStatus);
    expect(running.stdout.text).toBe('trap-ready');
    expect(wesh.kernel.getProcess({ pid: childPid })?.state).toBe('running');

    child.release();
    await term;
    await kill;
    await expect.poll(() => wesh.kernel.getProcess({ pid: childPid })).toBeUndefined();
  });

  it('uses the builtin redirection and function locals for EXIT when TERM interrupts read', async () => {
    const pipe = await wesh.kernel.pipe();
    await using _pipe = {
      async [Symbol.asyncDispose]() {
        await pipe.write.close();
        await pipe.read.close();
      },
    };
    using read = observePipeRead({ handle: pipe.read });
    const running = executeBash({
      script: `\
trap 'printf "EXIT:%s:%s\\n" "$?" "$detail"' EXIT
f() {
  local detail=inner
  false
  read value >scope
  printf late
}
f
`,
      stdin: pipe.read,
    });
    const { pendingRead } = await Promise.race([read.started, running.result.then(() => {
      throw new Error('Bash exited before the read builtin reached the pipe');
    })]);
    expect(await Promise.race([pendingRead, undefined])).toBeUndefined();
    const shell = getBashProcess();
    const delivery = wesh.kernel.kill({ pid: shell.pid, signal: 15 });
    await expect.poll(() => Promise.race([running.result, undefined])).toMatchObject({
      exitCode: 143,
      waitStatus: { kind: 'signaled', signal: 15 },
    });
    await delivery;
    expect(running.stdout.text).toBe('');
    expect(running.stderr.text).toBe('');
    const output = await root.getFileHandle('scope');
    await expect((await output.getFile()).text()).resolves.toBe('EXIT:1:inner\n');
  });

  it('uses shell stdout and function locals for EXIT when TERM interrupts an external wait', async () => {
    using child = registerWriter({ name: 'hold-child', path: '/finished', contents: 'child' });
    const running = executeBash({
      script: `\
trap 'printf "EXIT:%s:%s\\n" "$?" "$detail"' EXIT
f() {
  local detail=inner
  false
  hold-child >external
  printf late
}
f
`,
    });
    const childPid = await child.started;
    const shell = getBashProcess();
    expect(wesh.kernel.getProcess({ pid: childPid })?.ppid).toBe(shell.pid);
    const delivery = wesh.kernel.kill({ pid: shell.pid, signal: 15 });
    await expect.poll(() => Promise.race([running.result, undefined])).toMatchObject({
      exitCode: 143,
      waitStatus: { kind: 'signaled', signal: 15 },
    });
    expect(running.stdout.text).toBe('EXIT:1:inner\n');
    expect(running.stderr.text).toBe('');
    expect(wesh.kernel.getProcess({ pid: childPid })?.state).toBe('running');

    child.release();
    await delivery;
    await expect.poll(() => wesh.kernel.getProcess({ pid: childPid })).toBeUndefined();
    const redirected = await root.getFileHandle('external');
    const output = await root.getFileHandle('finished');
    await expect((await redirected.getFile()).text()).resolves.toBe('');
    await expect((await output.getFile()).text()).resolves.toBe('child');
  });

  it.each(['separate PID signals', 'one foreground group signal'])('preserves an accepted write on %s', async (route) => {
    const target = await root.getFileHandle('saved', { create: true });
    const writer = await target.createWritable({ keepExistingData: true });
    const write = writer.write.bind(writer);
    const close = writer.close.bind(writer);
    const resumeWrite = Promise.withResolvers<void>();
    const resumeClose = Promise.withResolvers<void>();
    using _resume = {
      [Symbol.dispose]() {
        resumeWrite.resolve();
        resumeClose.resolve();
      },
    };
    using _open = vi.spyOn(target, 'createWritable').mockResolvedValueOnce(writer);
    using writing = vi.spyOn(writer, 'write').mockImplementationOnce(async data => {
      await resumeWrite.promise;
      await write(data);
    });
    using closing = vi.spyOn(writer, 'close').mockImplementationOnce(async () => {
      await resumeClose.promise;
      await close();
    });
    const childStarted = Promise.withResolvers<number>();
    wesh.registerCommand({
      definition: {
        meta: { name: 'gated-write', description: 'Write on the redirected descriptor', usage: 'gated-write' },
        load: async () => async ({ context }) => {
          childStarted.resolve(context.pid);
          await context.stdout.write({ buffer: new TextEncoder().encode('bytes') });
          return { exitCode: 0 };
        },
      },
    });
    const controller = new AbortController();
    const running = executeBash({
      script: "trap 'printf EXIT' EXIT; gated-write >saved; printf late",
      signal: controller.signal,
    });
    const childPid = await childStarted.promise;
    await expect.poll(() => writing.mock.calls.length).toBe(1);
    const shell = getBashProcess();
    const child = wesh.kernel.getProcess({ pid: childPid });
    expect(child?.ppid).toBe(shell.pid);
    expect(child?.pgid).toBe(shell.pgid);

    const separately = route === 'separate PID signals';
    const childDelivery = separately ? wesh.kernel.kill({ pid: childPid, signal: 15 }) : undefined;
    const shellDelivery = separately
      ? wesh.kernel.kill({ pid: shell.pid, signal: 15 })
      : wesh.signalForegroundProcessGroup({ signal: 15, foregroundSignal: controller.signal });
    const waitStatus = { kind: 'signaled', signal: 15 };
    const terminated = { exitCode: 143, waitStatus };
    await expect.poll(() => child?.waitStatus).toEqual(waitStatus);
    if (separately) {
      await expect.poll(() => Promise.race([running.result, undefined])).toMatchObject(terminated);
      expect(running.stdout.text).toBe('EXIT');
    } else {
      expect(await Promise.race([running.result, new Promise<void>(resolve => setTimeout(resolve, 0))])).toBeUndefined();
    }
    expect(closing).not.toHaveBeenCalled();
    await expect((await target.getFile()).text()).resolves.toBe('');

    resumeWrite.resolve();
    await expect.poll(() => closing.mock.calls.length).toBe(1);
    if (!separately) {
      expect(await Promise.race([running.result, new Promise<void>(resolve => setTimeout(resolve, 0))])).toBeUndefined();
    }
    await expect((await target.getFile()).text()).resolves.toBe('');
    resumeClose.resolve();

    await expect(running.result).resolves.toMatchObject(terminated);
    await shellDelivery;
    await childDelivery;
    await expect.poll(() => wesh.kernel.getProcess({ pid: childPid })).toBeUndefined();
    await expect((await target.getFile()).text()).resolves.toBe('bytes');
    expect(writing).toHaveBeenCalledOnce();
    expect(closing).toHaveBeenCalledOnce();
    expect(running.stdout.text).toBe('EXIT');
    expect(running.stderr.text).toBe('');
  });

  it('retires the root shell after an exec failure in its TERM EXIT trap', async () => {
    using child = registerWriter({ name: 'hold-child', path: '/finished', contents: 'child' });
    const running = execute({
      script: "trap 'exec missing_program' EXIT; printf '%s' \"$BASHPID\"; hold-child; printf late",
    });
    const childPid = await child.started;
    const pid = Number(running.stdout.text);
    const shell = wesh.kernel.getProcess({ pid });
    expect(wesh.kernel.getProcess({ pid: childPid })?.ppid).toBe(pid);
    const delivery = wesh.kernel.kill({ pid, signal: 15 });
    await expect.poll(() => Promise.race([running.result, undefined])).toMatchObject({
      exitCode: 127,
      waitStatus: { kind: 'exited', exitCode: 127 },
    });
    expect(shell?.waitStatus).toEqual({ kind: 'exited', exitCode: 127 });
    expect(wesh.kernel.getProcess({ pid })).toBeUndefined();
    expect(running.stdout.text).toBe(String(pid));
    expect(running.stderr.text).toContain('missing_program');

    const next = execute({ script: 'printf "next:%s\\n" "$BASHPID"' });
    await expect(next.result).resolves.toMatchObject({ exitCode: 0 });
    expect(next.stdout.text).toMatch(/^next:\d+\n$/);
    expect(Number(next.stdout.text.split(':')[1])).not.toBe(pid);
    expect(next.stderr.text).toBe('');

    child.release();
    await delivery;
    await expect.poll(() => wesh.kernel.getProcess({ pid: childPid })).toBeUndefined();
    const output = await root.getFileHandle('finished');
    await expect((await output.getFile()).text()).resolves.toBe('child');
  });

  it('executes the first input after an idle root shell is terminated by PID', async () => {
    const initial = execute({ script: 'printf "%s" "$BASHPID"' });
    await expect(initial.result).resolves.toMatchObject({ exitCode: 0 });
    const pid = Number(initial.stdout.text);
    expect(wesh.kernel.getProcess({ pid })?.state).toBe('running');
    await wesh.kernel.kill({ pid, signal: 15 });

    const next = execute({ script: 'printf "next:%s\\n" "$BASHPID"' });
    await expect(next.result).resolves.toMatchObject({ exitCode: 0 });
    expect(next.stdout.text).toMatch(/^next:\d+\n$/);
    const nextPid = Number(next.stdout.text.split(':')[1]);
    expect(nextPid).not.toBe(pid);
    expect(wesh.kernel.getProcess({ pid })).toBeUndefined();
    expect(wesh.kernel.getProcess({ pid: nextPid })?.state).toBe('running');
    expect(next.stderr.text).toBe('');
  });

  it('lets an outer pipe see EOF while the terminated Bash leaves its inner pipeline running', async () => {
    using child = registerGatedCommand({
      name: 'late-write',
      command: async ({ context }) => {
        await context.stdout.write({ buffer: new TextEncoder().encode('bytes') });
        return { exitCode: 0 };
      },
    });
    const running = execute({
      script: "bash -c 'late-write 2>&- | cat > saved 2>&-' 2>&1 | cat > seen; printf done",
    });
    const childPid = await child.started;
    const shell = getBashProcess();
    expect(wesh.kernel.getProcess({ pid: childPid })?.ppid).toBe(shell.pid);
    await expect.poll(() => wesh.kernel.getProcesses().some(({ ppid, args }) => ppid === shell.pid && args[0] === 'cat')).toBe(true);

    const delivery = wesh.kernel.kill({ pid: shell.pid, signal: 15 });
    await expect.poll(() => Promise.race([running.result, undefined])).toMatchObject({ exitCode: 0 });
    expect(shell.waitStatus).toEqual({ kind: 'signaled', signal: 15 });
    expect(running.stdout.text).toBe('done');
    expect(running.stderr.text).toBe('');
    expect(wesh.kernel.getProcess({ pid: childPid })?.state).toBe('running');
    const seen = await root.getFileHandle('seen');
    const saved = await root.getFileHandle('saved');
    await expect((await seen.getFile()).text()).resolves.toBe('');
    await expect((await saved.getFile()).text()).resolves.toBe('');

    child.release();
    await delivery;
    await expect.poll(() => wesh.kernel.getProcesses().some(({ ppid }) => ppid === shell.pid)).toBe(false);
    await expect((await saved.getFile()).text()).resolves.toBe('bytes');
    await expect((await seen.getFile()).text()).resolves.toBe('');
  });

  it('terminates the shared root when PID TERM follows Stop on just one of two inputs', async () => {
    using firstChild = registerGatedCommand({
      name: 'hold-first',
      command: async () => ({ exitCode: 0 }),
    });
    using secondChild = registerGatedCommand({
      name: 'hold-second',
      command: async () => ({ exitCode: 0 }),
    });
    const first = execute({ script: 'printf "%s" "$BASHPID"; hold-first; printf late-first' });
    const firstPid = await firstChild.started;
    const pid = Number(first.stdout.text);
    const shell = wesh.kernel.getProcess({ pid });
    expect(shell?.state).toBe('running');
    expect(wesh.kernel.getProcess({ pid: firstPid })?.ppid).toBe(pid);
    const controller = new AbortController();
    const second = execute({
      script: 'printf "%s" "$BASHPID"; hold-second; printf late-second',
      signal: controller.signal,
    });
    const secondPid = await secondChild.started;
    expect(second.stdout.text).toBe(String(pid));
    expect(wesh.kernel.getProcess({ pid: secondPid })?.ppid).toBe(pid);

    controller.abort();
    const stop = wesh.interruptForeground({ foregroundSignal: controller.signal });
    const term = wesh.kernel.kill({ pid, signal: 15 });
    const waitStatus = { kind: 'signaled', signal: 15 };
    await expect.poll(() => Promise.race([first.result, undefined])).toMatchObject({ exitCode: 143, waitStatus });
    expect(shell?.waitStatus).toEqual(waitStatus);
    expect(wesh.kernel.getProcess({ pid })).toBeUndefined();
    expect(wesh.kernel.getProcess({ pid: firstPid })?.state).toBe('running');
    expect(first.stdout.text).toBe(String(pid));
    expect(first.stderr.text).toBe('');

    const next = execute({ script: 'printf "next:%s\\n" "$BASHPID"' });
    await expect(next.result).resolves.toMatchObject({ exitCode: 0 });
    expect(next.stdout.text).toMatch(/^next:\d+\n$/);
    expect(Number(next.stdout.text.split(':')[1])).not.toBe(pid);

    firstChild.release();
    secondChild.release();
    await stop;
    await term;
    await second.result;
    await expect.poll(() => wesh.kernel.getProcess({ pid: firstPid })).toBeUndefined();
    await expect.poll(() => wesh.kernel.getProcess({ pid: secondPid })).toBeUndefined();
  });

  it.each([
    { name: 'only Bash gets INT and the child exits 0', shellSignal: true, childSignal: false, childCode: 0, continuation: 0 },
    { name: 'only Bash gets INT and the child exits 130', shellSignal: true, childSignal: false, childCode: 130, continuation: 130 },
    { name: 'Bash and its child both get INT', shellSignal: true, childSignal: true, childCode: 0, continuation: undefined },
    { name: 'only the child gets INT', shellSignal: false, childSignal: true, childCode: 0, continuation: 130 },
  ])('uses the foreground child outcome when $name', async ({ shellSignal, childSignal, childCode, continuation }) => {
    using child = registerGatedCommand({
      name: 'hold-child',
      command: async () => ({ exitCode: childCode }),
    });
    const running = executeBash({
      script: `\
trap 'printf "EXIT:%s\\n" "$?"' EXIT
false
hold-child
printf 'next:%s\\n' "$?"
`,
    });
    const childPid = await child.started;
    const shell = getBashProcess();
    const process = wesh.kernel.getProcess({ pid: childPid });
    expect(process?.ppid).toBe(shell.pid);

    const shellDelivery = shellSignal ? wesh.kernel.kill({ pid: shell.pid, signal: 2 }) : undefined;
    const childDelivery = childSignal ? wesh.kernel.kill({ pid: childPid, signal: 2 }) : undefined;
    expect(await Promise.race([running.result, new Promise<void>(resolve => setTimeout(resolve, 0))])).toBeUndefined();
    expect(shell.waitStatus).toBeUndefined();
    expect(running.stdout.text).toBe('');

    child.release();
    await shellDelivery;
    await childDelivery;
    const terminated = { kind: 'signaled', signal: 2 };
    const waitStatus = continuation === undefined ? terminated : { kind: 'exited', exitCode: 0 };
    await expect(running.result).resolves.toMatchObject({
      exitCode: continuation === undefined ? 130 : 0,
      waitStatus,
    });
    expect(shell.waitStatus).toEqual(waitStatus);
    expect(process?.waitStatus).toEqual(childSignal ? terminated : { kind: 'exited', exitCode: childCode });
    expect(running.stdout.text).toBe(continuation === undefined ? 'EXIT:1\n' : `\
next:${continuation}
EXIT:0
`);
    expect(running.stderr.text).toBe('');
  });

  it.each([
    { order: 'signaled stage first with pipefail enabled', signaledFirst: true },
    { order: 'normal stage first with pipefail disabled', signaledFirst: false },
  ])('uses the pipeline completion order after a PID INT with $order', async ({ signaledFirst }) => {
    using signaled = registerGatedCommand({
      name: 'hold-signaled',
      command: async () => ({ exitCode: 0 }),
    });
    using normal = registerGatedCommand({
      name: 'hold-normal',
      command: async () => ({ exitCode: 0 }),
    });
    const shellOptions = signaledFirst ? 'set -o pipefail' : '';
    const running = executeBash({
      script: `\
trap 'printf "EXIT:%s\\n" "$?"' EXIT
${shellOptions}
false
hold-signaled | hold-normal
printf 'next:%s\\n' "$?"
`,
    });
    const signalPid = await signaled.started;
    const normalPid = await normal.started;
    const shell = getBashProcess();
    const signaledProcess = wesh.kernel.getProcess({ pid: signalPid });
    const normalProcess = wesh.kernel.getProcess({ pid: normalPid });
    expect(signaledProcess?.ppid).toBe(shell.pid);
    expect(normalProcess?.ppid).toBe(shell.pid);
    const shellDelivery = wesh.kernel.kill({ pid: shell.pid, signal: 2 });
    expect(await Promise.race([running.result, new Promise<void>(resolve => setTimeout(resolve, 0))])).toBeUndefined();

    const signalStage = { pid: signalPid, release: signaled.release };
    const normalStage = { pid: normalPid, release: normal.release };
    const stages = signaledFirst ? [signalStage, normalStage] : [normalStage, signalStage];
    for (const stage of stages) {
      const delivery = stage === signalStage ? wesh.kernel.kill({ pid: stage.pid, signal: 2 }) : undefined;
      stage.release();
      await delivery;
      await expect.poll(() => wesh.kernel.getProcess({ pid: stage.pid })).toBeUndefined();
    }
    await shellDelivery;

    const terminated = { kind: 'signaled', signal: 2 };
    const waitStatus = signaledFirst ? { kind: 'exited', exitCode: 0 } : terminated;
    await expect(running.result).resolves.toMatchObject({
      exitCode: signaledFirst ? 0 : 130,
      waitStatus,
    });
    expect(shell.waitStatus).toEqual(waitStatus);
    expect(signaledProcess?.waitStatus).toEqual(terminated);
    expect(normalProcess?.waitStatus).toEqual({ kind: 'exited', exitCode: 0 });
    expect(running.stdout.text).toBe(signaledFirst ? `\
next:130
EXIT:0
` : 'EXIT:1\n');
    expect(running.stderr.text).toBe('');
  });

  it.each([
    { exitCode: 0, expression: 'value=$(hold-substitution)' },
    { exitCode: 130, expression: 'value=$(hold-substitution)' },
    { exitCode: 0, expression: 'printf "unexpected:%s\\n" "$(hold-substitution)"' },
  ])('takes a PID INT after a command substitution returning $exitCode for $expression', async ({ exitCode, expression }) => {
    using child = registerGatedCommand({
      name: 'hold-substitution',
      command: async ({ context }) => {
        await context.text().print({ text: 'new-value' });
        return { exitCode };
      },
    });
    const running = executeBash({
      script: `\
value=original
trap 'printf "EXIT:%s:%s\\n" "$?" "$value"' EXIT
false
${expression}
printf late
`,
    });
    const childPid = await child.started;
    const shell = getBashProcess();
    const childProcess = wesh.kernel.getProcess({ pid: childPid });
    const substitution = childProcess === undefined ? undefined : wesh.kernel.getProcess({ pid: childProcess.ppid });
    expect(substitution?.ppid).toBe(shell.pid);
    const delivery = wesh.kernel.kill({ pid: shell.pid, signal: 2 });
    expect(await Promise.race([running.result, new Promise<void>(resolve => setTimeout(resolve, 0))])).toBeUndefined();
    expect(running.stdout.text).toBe('');

    child.release();
    await delivery;
    const waitStatus = { kind: 'signaled', signal: 2 };
    await expect(running.result).resolves.toMatchObject({ exitCode: 130, waitStatus });
    expect(shell.waitStatus).toEqual(waitStatus);
    expect(childProcess?.waitStatus).toEqual({ kind: 'exited', exitCode });
    expect(running.stdout.text).toBe('EXIT:1:original\n');
    expect(running.stderr.text).toBe('');
  });

  it.each([
    { name: 'the default disposition', trap: '', trapped: false },
    { name: 'a caught INT', trap: "trap 'printf \"INT:%s\\n\" \"$?\"' INT", trapped: true },
  ])('handles a command substitution killed by SIGINT with $name', async ({ trap, trapped }) => {
    const pipe = await wesh.kernel.pipe();
    await using _pipe = {
      async [Symbol.asyncDispose]() {
        await pipe.write.close();
        await pipe.read.close();
      },
    };
    using read = observePipeRead({ handle: pipe.read });
    const running = executeBash({
      script: `\
trap 'printf "EXIT:%s\\n" "$?"' EXIT
${trap}
false
value=$(IFS= read -r value)
printf 'after:%s\\n' "$?"
`,
      stdin: pipe.read,
    });
    const { pendingRead } = await Promise.race([read.started, running.result.then(() => {
      throw new Error('The command substitution exited before reading from the pipe');
    })]);
    expect(await Promise.race([pendingRead, undefined])).toBeUndefined();
    const shell = getBashProcess();
    const substitution = wesh.kernel.getProcesses().find(({ ppid }) => ppid === shell.pid);
    if (substitution === undefined) {
      throw new Error('Expected a command substitution process');
    }

    const delivery = wesh.kernel.kill({ pid: substitution.pid, signal: 2 });
    const terminated = { kind: 'signaled', signal: 2 };
    const waitStatus = trapped ? { kind: 'exited', exitCode: 0 } : terminated;
    await expect.poll(() => Promise.race([running.result, undefined])).toMatchObject({
      exitCode: trapped ? 0 : 130,
      waitStatus,
    });
    await delivery;
    expect(shell.waitStatus).toEqual(waitStatus);
    expect(substitution.waitStatus).toEqual(terminated);
    expect(running.stdout.text).toBe(trapped ? `\
INT:130
after:130
EXIT:0
` : 'EXIT:130\n');
    expect(running.stderr.text).toBe('');
  });

  it('does not run the INT trap for a numeric 130 from a command substitution', async () => {
    const running = executeBash({
      script: `\
trap 'printf "INT:%s\\n" "$?"' INT
trap 'printf "EXIT:%s\\n" "$?"' EXIT
value=$(exit 130)
printf 'after:%s\\n' "$?"
`,
    });
    await expect(running.result).resolves.toMatchObject({ exitCode: 0 });
    expect(running.stdout.text).toBe(`\
after:130
EXIT:0
`);
    expect(running.stderr.text).toBe('');
  });

  it('commits the complete assignment with partial substitution output before a child-only default INT exits', async () => {
    const pipe = await wesh.kernel.pipe();
    await using _pipe = {
      async [Symbol.asyncDispose]() {
        await pipe.write.close();
        await pipe.read.close();
      },
    };
    using read = observePipeRead({ handle: pipe.read });
    const running = executeBash({
      script: `\
value=original
other=before
trap 'printf "EXIT:%s:%s:%s\\n" "$?" "$value" "$other"' EXIT
false
value=pre$(printf new; IFS= read -r ignored)post other=late
printf unexpected
`,
      stdin: pipe.read,
    });
    const { pendingRead } = await Promise.race([read.started, running.result.then(() => {
      throw new Error('The command substitution exited before reading from the pipe');
    })]);
    expect(await Promise.race([pendingRead, undefined])).toBeUndefined();
    const shell = getBashProcess();
    const substitution = wesh.kernel.getProcesses().find(({ ppid }) => ppid === shell.pid);
    if (substitution === undefined) {
      throw new Error('Expected a command substitution process');
    }
    const delivery = wesh.kernel.kill({ pid: substitution.pid, signal: 2 });
    await expect.poll(() => Promise.race([running.result, undefined])).toMatchObject({
      exitCode: 130,
      waitStatus: { kind: 'signaled', signal: 2 },
    });
    await delivery;
    expect(substitution.waitStatus).toEqual({ kind: 'signaled', signal: 2 });
    expect(running.stdout.text).toBe('EXIT:130:prenewpost:late\n');
    expect(running.stderr.text).toBe('');
  });

  it('handles INT from a command substitution on its own input while a concurrent wait keeps waiting', async () => {
    using sub = registerGatedCommand({
      name: 'hold-substitution',
      command: async () => ({ exitCode: 0 }),
    });
    using child = registerGatedCommand({
      name: 'hold-waited',
      command: async () => ({ exitCode: 7 }),
    });
    const expanding = execute({
      script: `\
value=original
trap 'printf "INT:%s:%s\\n" "$?" "$value"' INT
value=$(printf new; exec hold-substitution)
printf 'after:%s:%s\\n' "$?" "$value"
`,
    });
    const subPid = await sub.started;
    const subProcess = wesh.kernel.getProcess({ pid: subPid });
    expect(subProcess?.args[0]).toBe('hold-substitution');

    using lookedUp = vi.spyOn(WeshShellChildren.prototype, 'get');
    const waiting = execute({
      script: 'hold-waited & printf "B-ready\\n"; wait "$!"; printf "B-wait:%s\\n" "$?"',
    });
    const childPid = await child.started;
    const childProcess = wesh.kernel.getProcess({ pid: childPid });
    expect(childProcess?.ppid).toBe(subProcess?.ppid);
    await expect.poll(() => lookedUp.mock.results.some(
      ({ value }) => value !== undefined && value.pid === childPid && value.waitStatus === undefined,
    )).toBe(true);

    const delivery = wesh.kernel.kill({ pid: subPid, signal: 2 });
    sub.release();
    await delivery;
    await expect(expanding.result).resolves.toMatchObject({ exitCode: 0 });
    expect(subProcess?.waitStatus).toEqual({ kind: 'signaled', signal: 2 });
    expect(expanding.stdout.text).toBe(`\
INT:130:new
after:130:new
`);
    expect(expanding.stderr.text).toBe('');
    expect(await Promise.race([waiting.result, new Promise<void>(resolve => setTimeout(resolve, 0))])).toBeUndefined();
    expect(waiting.stdout.text).toBe('B-ready\n');

    child.release();
    await expect(waiting.result).resolves.toMatchObject({ exitCode: 0 });
    expect(waiting.stdout.text).toBe(`\
B-ready
B-wait:7
`);
    expect(waiting.stderr.text).toBe('');
  });

  it('does not launch pipeline stages after a PID INT before the first pipe is created', async () => {
    const started = Promise.withResolvers<void>();
    const resume = Promise.withResolvers<void>();
    using _resume = { [Symbol.dispose]: resume.resolve };
    const createPipe = wesh.kernel.pipe.bind(wesh.kernel);
    using _pipe = vi.spyOn(wesh.kernel, 'pipe').mockImplementationOnce(async () => {
      started.resolve();
      await resume.promise;
      return createPipe();
    });
    using spawn = vi.spyOn(wesh.kernel, 'spawn');
    const running = executeBash({
      script: `\
trap 'printf "EXIT:%s\\n" "$?"' EXIT
false
true | true
printf late
`,
    });
    await expect(Promise.race([started.promise, running.result])).resolves.toBeUndefined();
    const shell = getBashProcess();
    expect(wesh.kernel.getProcesses().some(({ ppid }) => ppid === shell.pid)).toBe(false);
    const spawnedBeforeInterrupt = spawn.mock.calls.length;

    const delivery = wesh.kernel.kill({ pid: shell.pid, signal: 2 });
    resume.resolve();
    await delivery;
    const waitStatus = { kind: 'signaled', signal: 2 };
    await expect(running.result).resolves.toMatchObject({ exitCode: 130, waitStatus });
    expect(shell.waitStatus).toEqual(waitStatus);
    expect(spawn.mock.calls.slice(spawnedBeforeInterrupt).some(([{ ppid }]) => ppid === shell.pid)).toBe(false);
    expect(running.stdout.text).toBe('EXIT:1\n');
    expect(running.stderr.text).toBe('');
  });

  it('takes a PID INT while joining a process substitution after its foreground program was reaped', async () => {
    using child = registerGatedCommand({
      name: 'hold-substitution',
      command: async () => ({ exitCode: 0 }),
    });
    using spawn = vi.spyOn(wesh.kernel, 'spawn');
    const running = executeBash({
      script: `\
trap 'printf "EXIT:%s\\n" "$?"' EXIT
false
true <(hold-substitution)
printf late
`,
    });
    const substitutionChildPid = await child.started;
    const shell = getBashProcess();
    await expect.poll(() => spawn.mock.calls.some(([{ args, ppid }]) => args[0] === 'true' && ppid === shell.pid)).toBe(true);
    const index = spawn.mock.calls.findIndex(([{ args, ppid }]) => args[0] === 'true' && ppid === shell.pid);
    const foreground = await spawn.mock.results[index]?.value;
    if (foreground === undefined) {
      throw new Error('Expected the foreground true process to have been spawned');
    }
    await expect.poll(() => wesh.kernel.getProcess({ pid: foreground.pid })).toBeUndefined();
    expect(await Promise.race([running.result, undefined])).toBeUndefined();

    const delivery = wesh.kernel.kill({ pid: shell.pid, signal: 2 });
    const waitStatus = { kind: 'signaled', signal: 2 };
    await expect.poll(() => Promise.race([running.result, undefined])).toMatchObject({ exitCode: 130, waitStatus });
    expect(shell.waitStatus).toEqual(waitStatus);
    expect(running.stdout.text).toBe('EXIT:1\n');
    expect(running.stderr.text).toBe('');
    expect(wesh.kernel.getProcess({ pid: substitutionChildPid })?.state).toBe('running');

    child.release();
    await delivery;
    await expect.poll(() => wesh.kernel.getProcess({ pid: substitutionChildPid })).toBeUndefined();
  });
});
