import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Wesh } from './index';
import { MockFileSystemDirectoryHandle } from './mocks/InMemoryFileSystem';
import { createTextShellSource } from './shell/source';
import type { WeshFileHandle } from './types';
import { openFileDescription } from './utils/file-input';
import { createWriteHandleFromStream } from './utils/stream';
import { createTestReadHandleFromText, createTestWriteCaptureHandle } from './utils/test-stream';

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

describe('Wesh shell child waiting', () => {
  let wesh: Wesh;

  beforeEach(async () => {
    const rootHandle = new MockFileSystemDirectoryHandle({ name: 'root' });
    wesh = new Wesh({ rootHandle: rootHandle as unknown as FileSystemDirectoryHandle });
    await wesh.init();
  });

  function execute({ script, signal }: { script: string, signal?: AbortSignal }) {
    const stdout = createTestWriteCaptureHandle();
    const stderr = createTestWriteCaptureHandle();
    const result = wesh.execute({
      source: createTextShellSource({ text: script }),
      stdin: createTestReadHandleFromText({ text: '' }),
      stdout: stdout.handle,
      stderr: stderr.handle,
      signal,
    });
    return { result, stdout, stderr };
  }

  function registerHold({ name, exitCode }: { name: string, exitCode: number }) {
    const started = Promise.withResolvers<void>();
    const completed = Promise.withResolvers<void>();
    wesh.registerCommand({
      definition: {
        meta: { name, description: 'Wait for the test to release the command', usage: name },
        load: async () => async () => {
          started.resolve();
          await completed.promise;
          return { exitCode };
        },
      },
    });
    return { started: started.promise, release: completed.resolve };
  }

  it('retains explicit wait results and the latest child PID across inputs', async () => {
    const launch = execute({
      script: `\
(exit 7) & first=$!
(exit 9) & second=$!
wait "$first"; printf 'first=%s\\n' "$?"
wait "$first" "$first"; printf 'duplicate=%s\\n' "$?"
wait "$first" "$second"; printf 'multi=%s\\n' "$?"
printf 'latest=%s\\n' "$!"
`,
    });
    await expect(launch.result).resolves.toMatchObject({ exitCode: 0 });
    expect(launch.stdout.text).toMatch(/^first=7\nduplicate=7\nmulti=9\nlatest=\d+\n$/);
    expect(launch.stderr.text).toBe('');
    const latestPid = launch.stdout.text.match(/latest=(\d+)/)?.[1];

    const next = execute({
      script: `\
printf 'latest=%s\\n' "$!"
exec 7>/output
exec 7>&-
wait "$first"; printf 'first=%s\\n' "$?"
wait "$BASHPID" "$second"; printf 'valid-last=%s\\n' "$?"
wait "$second" "$BASHPID"; printf 'invalid-last=%s\\n' "$?"
`,
    });
    await expect(next.result).resolves.toMatchObject({ exitCode: 0 });
    expect(next.stdout.text).toBe(`\
latest=${latestPid}
first=7
valid-last=9
invalid-last=127
`);
    expect(next.stderr.text.match(/not a child of this shell/g)).toHaveLength(2);
  });

  it('lists only the active jobs owned by the current shell', async () => {
    const parent = registerHold({ name: 'hold-parent', exitCode: 7 });
    const nested = registerHold({ name: 'hold-nested', exitCode: 9 });
    using _release = {
      [Symbol.dispose]() {
        parent.release();
        nested.release();
      },
    };

    await expect(execute({ script: 'hold-parent & parent=$!' }).result).resolves.toMatchObject({ exitCode: 0 });
    await parent.started;
    const forked = execute({ script: '(jobs; wait "$parent"; printf "forked=%s\\n" "$?")' });
    await expect(forked.result).resolves.toMatchObject({ exitCode: 0 });
    expect(forked.stdout.text).toBe('forked=127\n');
    expect(forked.stderr.text).toContain('not a child of this shell');

    const childShell = execute({
      script: `bash -c 'hold-nested & child=$!; jobs; wait "$child"; printf "nested=%s\\n" "$?"; jobs'`,
    });
    await nested.started;
    const outside = execute({ script: 'jobs' });
    await expect(outside.result).resolves.toMatchObject({ exitCode: 0 });
    expect(outside.stdout.text).toMatch(/^\[1\] running [^\n]+\n$/);
    expect(outside.stderr.text).toBe('');

    nested.release();
    await expect(childShell.result).resolves.toMatchObject({ exitCode: 0 });
    expect(childShell.stdout.text).toMatch(/^\[1\] running [^\n]+\nnested=9\n$/);
    expect(childShell.stderr.text).toBe('');

    parent.release();
    const joined = execute({ script: 'wait "$parent"; printf "parent=%s\\n" "$?"; jobs' });
    await expect(joined.result).resolves.toMatchObject({ exitCode: 0 });
    expect(joined.stdout.text).toBe('parent=7\n');
    expect(joined.stderr.text).toBe('');
  });

  it('waits for the children present at a bare wait and clears only their background results', async () => {
    const background = registerHold({ name: 'hold-background', exitCode: 7 });
    const substitution = registerHold({ name: 'hold-substitution', exitCode: 8 });
    const later = registerHold({ name: 'hold-later', exitCode: 9 });
    using _release = {
      [Symbol.dispose]() {
        background.release();
        substitution.release();
        later.release();
      },
    };
    const launch = execute({
      script: `\
hold-background & background=$!
(exit 6) & previous=$!
wait "$previous"
exec 3< <(hold-substitution)
substitution=$!
`,
    });
    await expect(launch.result).resolves.toMatchObject({ exitCode: 0 });
    await background.started;
    await substitution.started;

    const waiting = execute({ script: 'printf "READY\\n"; wait; printf "all=%s\\n" "$?"' });
    await expect.poll(() => waiting.stdout.text).toBe('READY\n');
    const lateLaunch = execute({
      script: 'hold-later & later=$!; (exit 5) & laterCompleted=$!; wait "$laterCompleted"',
    });
    await expect(lateLaunch.result).resolves.toMatchObject({ exitCode: 5 });
    await later.started;
    background.release();
    expect(await Promise.race([waiting.result, new Promise<void>(resolve => setTimeout(resolve, 0))])).toBeUndefined();

    substitution.release();
    await expect.poll(() => Promise.race([waiting.result, undefined])).toMatchObject({ exitCode: 0 });
    expect(waiting.stdout.text).toBe(`\
READY
all=0
`);
    expect(waiting.stderr.text).toBe('');

    later.release();
    const statuses = execute({
      script: `\
wait "$background"; printf 'background=%s\\n' "$?"
wait "$previous"; printf 'previous=%s\\n' "$?"
wait "$substitution"; printf 'substitution=%s\\n' "$?"
wait "$laterCompleted"; printf 'later-completed=%s\\n' "$?"
wait "$later"; printf 'later=%s\\n' "$?"
exec 3<&-
`,
    });
    await expect(statuses.result).resolves.toMatchObject({ exitCode: 0 });
    expect(statuses.stdout.text).toBe(`\
background=127
previous=127
substitution=8
later-completed=5
later=9
`);
    expect(statuses.stderr.text.match(/not a child of this shell/g)).toHaveLength(2);
  });

  it.each([
    { title: 'keeps a prior process substitution when the stopped command only inherits its descriptor', signal: undefined, readsPrefix: false },
    { title: 'keeps a prior process substitution when a pipe read has finished before Stop', signal: undefined, readsPrefix: true },
    { title: 'delivers SIGTERM to a prior input process substitution in the same group', signal: 15, readsPrefix: false },
  ])('$title', async ({ signal, readsPrefix }) => {
    const path = '/gate';
    await wesh.vfs.mknod({ path, type: 'fifo', mode: 0o600 });
    const writer = await wesh.vfs.open({
      path,
      flags: { access: 'read-write', creation: 'never', truncate: 'preserve', append: 'preserve' },
    });
    await using _release = {
      async [Symbol.asyncDispose]() {
        await writer.write({ buffer: new TextEncoder().encode('released\n') });
        await writer.close();
      },
    };
    using pipe = vi.spyOn(wesh.kernel, 'pipe');
    const writePrefix = readsPrefix ? 'IFS= read -r prefix <&9; printf X; ' : '';
    const launch = execute({
      script: `\
exec 9<>/gate
exec 3< <(${writePrefix}IFS= read -r value <&9; printf '%s' "$value"; exit 7)
substitution=$!
printf '%s' "$substitution"
`,
    });
    await expect(launch.result).resolves.toMatchObject({ exitCode: 0 });
    const pid = Number(launch.stdout.text);
    const substitution = wesh.kernel.getProcess({ pid });
    expect(substitution?.state).toBe('running');
    const ends = await pipe.mock.results[0]?.value;
    if (ends === undefined) {
      throw new Error('Expected a process substitution pipe');
    }
    using observedRead = readsPrefix ? observePipeRead({ handle: ends.read }) : undefined;

    const controller = new AbortController();
    const readPrefix = readsPrefix ? 'head -c1 <&3; ' : '';
    const stopped = execute({ script: readPrefix + 'sleep 5 <&3; printf late', signal: controller.signal });
    if (observedRead !== undefined) {
      const { pendingRead } = await Promise.race([observedRead.started, stopped.result.then(() => {
        throw new Error('Head exited before reading the process substitution pipe');
      })]);
      expect(await Promise.race([pendingRead, undefined])).toBeUndefined();
      await writer.write({ buffer: new TextEncoder().encode('prefix\n') });
      await expect(pendingRead).resolves.toMatchObject({ bytesRead: 1 });
    }
    await expect.poll(() => wesh.kernel.getProcesses().find(({ args }) => args[0] === 'sleep')?.pgid).toBe(substitution?.pgid);
    const expectedOutput = readsPrefix ? 'X' : '';
    expect(stopped.stdout.text).toBe(expectedOutput);
    if (signal !== undefined) {
      await expect(wesh.signalForegroundProcessGroup({ signal, foregroundSignal: controller.signal })).resolves.toBe(true);
      await expect.poll(() => Promise.race([stopped.result, undefined])).toMatchObject({ exitCode: 128 + signal });
      await expect.poll(() => substitution?.waitStatus).toEqual({ kind: 'signaled', signal });
      await expect.poll(() => wesh.kernel.getProcess({ pid })).toBeUndefined();
      expect(stopped.stdout.text).toBe('');
      return;
    }
    controller.abort();
    await wesh.interruptForeground({ foregroundSignal: controller.signal });
    await expect.poll(() => Promise.race([stopped.result, undefined])).toMatchObject({ exitCode: 130 });
    expect(stopped.stdout.text).toBe(expectedOutput);
    expect(wesh.kernel.getProcess({ pid })?.state).toBe('running');

    await writer.write({ buffer: new TextEncoder().encode('GOOD\n') });
    const next = execute({
      script: 'cat <&3; wait "$substitution"; printf ":%s\\n" "$?"; exec 3<&- 9<&-',
    });
    await expect(next.result).resolves.toMatchObject({ exitCode: 0 });
    expect(next.stdout.text).toBe('GOOD:7\n');
    expect(next.stderr.text).toBe('');
    expect(wesh.kernel.getProcess({ pid })).toBeUndefined();
  });

  it.each([
    { bodyCode: 0, expected: 1 },
    { bodyCode: 7, expected: 7 },
  ])('waits for descriptor cleanup before reporting $expected for a child that exited $bodyCode', async ({ bodyCode, expected }) => {
    const closing = vi.fn();
    const release = Promise.withResolvers<void>();
    using _release = { [Symbol.dispose]: release.resolve };
    const handle = createWriteHandleFromStream({
      target: new WritableStream<Uint8Array>({
        async close() {
          closing();
          await release.promise;
          throw new Error('child descriptor close failed');
        },
      }),
    });
    using open = vi.spyOn(wesh.kernel, 'open').mockResolvedValueOnce(handle);
    const launch = execute({
      script: `{ exec 8>/owned; exit ${bodyCode}; } & child=$!; printf '%s' "$child"`,
    });
    await expect(launch.result).resolves.toMatchObject({ exitCode: 0 });
    expect(open).toHaveBeenCalledOnce();
    const pid = Number(launch.stdout.text);
    await expect.poll(() => closing.mock.calls.length).toBe(1);
    expect(wesh.kernel.getWaitStatus({ pid })).toEqual({ kind: 'exited', exitCode: bodyCode });

    const waiting = execute({ script: 'printf READY; wait "$child"' });
    await expect.poll(() => waiting.stdout.text).toBe('READY');
    expect(await Promise.race([waiting.result, new Promise<void>(resolve => setTimeout(resolve, 0))])).toBeUndefined();

    release.resolve();
    await expect(waiting.result).resolves.toMatchObject({ exitCode: expected });
    expect(launch.stderr.text).toBe('wesh: child descriptor close failed\n');
    expect(waiting.stderr.text).toBe('');
    expect(wesh.kernel.getProcess({ pid })).toBeUndefined();
    await expect(execute({ script: 'wait "$child"' }).result).resolves.toMatchObject({ exitCode: expected });
    expect(closing).toHaveBeenCalledOnce();
  });

  it('runs the INT trap once when stopping wait and can wait for the same child again', async () => {
    const child = registerHold({ name: 'hold-child', exitCode: 7 });
    using _release = { [Symbol.dispose]: child.release };
    const launch = execute({
      script: `\
exec 7>/events
trap 'printf "INT:%s\\n" "$?" >&7' INT
hold-child & child=$!
printf '%s' "$child"
`,
    });
    await expect(launch.result).resolves.toMatchObject({ exitCode: 0 });
    await child.started;
    const pid = Number(launch.stdout.text);

    const controller = new AbortController();
    const stopped = execute({ script: 'printf READY; wait "$child"; printf late', signal: controller.signal });
    await expect.poll(() => stopped.stdout.text).toBe('READY');
    controller.abort();
    await wesh.interruptForeground({ foregroundSignal: controller.signal });
    await expect.poll(() => Promise.race([stopped.result, undefined])).toMatchObject({
      exitCode: 130,
      waitStatus: { kind: 'signaled', signal: 2 },
    });
    expect(stopped.stdout.text).toBe('READY');
    expect(stopped.stderr.text).toBe('');
    expect(wesh.kernel.getProcess({ pid })?.state).toBe('running');

    child.release();
    const retried = execute({
      script: 'wait "$child"; printf "child=%s\\n" "$?"; exec 7>&-; cat /events',
    });
    await expect(retried.result).resolves.toMatchObject({ exitCode: 0 });
    expect(retried.stdout.text).toBe(`\
child=7
INT:130
`);
    expect(retried.stderr.text).toBe('');
    expect(wesh.kernel.getProcess({ pid })).toBeUndefined();
  });

  it.each(['wait', 'exec'])('keeps cwd and PWD in sync across concurrent input and %s', async (command) => {
    const child = registerHold({ name: 'hold-child', exitCode: 7 });
    using _release = { [Symbol.dispose]: child.release };
    await expect(execute({ script: 'mkdir /work; hold-child & child=$!' }).result).resolves.toMatchObject({ exitCode: 0 });
    await child.started;

    const older = execute({ script: 'printf READY; wait "$child"; pwd' });
    await expect.poll(() => older.stdout.text).toBe('READY');
    const change = execute({ script: 'cd /work; printf READY; wait "$child"' });
    await expect.poll(() => change.stdout.text).toBe('READY');

    if (command === 'exec') {
      const replacement = execute({ script: 'exec pwd' });
      await expect(replacement.result).resolves.toMatchObject({ exitCode: 0 });
      expect(replacement.stdout.text).toBe('/work\n');
      await expect(older.result).resolves.toMatchObject({ exitCode: 1 });
      await expect(change.result).resolves.toMatchObject({ exitCode: 1 });
      expect(older.stdout.text).toBe('READY');
    }
    const state = execute({ script: 'pwd; printf "%s\\n" "$PWD"' });
    await expect(state.result).resolves.toMatchObject({ exitCode: 0 });
    expect(state.stdout.text).toBe(`\
/work
/work
`);
    expect(wesh.getShellState()).toMatchObject({ cwd: '/work', env: { PWD: '/work' } });

    child.release();
    if (command === 'wait') {
      await expect(change.result).resolves.toMatchObject({ exitCode: 7 });
      await expect(older.result).resolves.toMatchObject({ exitCode: 0 });
      expect(older.stdout.text).toBe('READY/work\n');
      expect(wesh.getShellState()).toMatchObject({ cwd: '/work', env: { PWD: '/work' } });
    }
  });

  it('keeps the real PID termination reason after another input has reaped the shell', async () => {
    const background = registerHold({ name: 'hold-child', exitCode: 7 });
    const foreground = registerHold({ name: 'hold-foreground', exitCode: 0 });
    using _release = {
      [Symbol.dispose]() {
        foreground.release();
        background.release();
      },
    };
    const launch = execute({ script: 'hold-child & child=$!; printf "%s" "$BASHPID"' });
    await expect(launch.result).resolves.toMatchObject({ exitCode: 0 });
    await background.started;
    const pid = Number(launch.stdout.text);
    const running = execute({ script: 'hold-foreground; printf late' });
    await foreground.started;
    const waiting = execute({ script: 'printf READY; wait "$child"' });
    await expect.poll(() => waiting.stdout.text).toBe('READY');

    await wesh.kernel.kill({ pid, signal: 15 });
    const terminated = { exitCode: 143, waitStatus: { kind: 'signaled', signal: 15 } };
    await expect(waiting.result).resolves.toMatchObject(terminated);
    expect(wesh.kernel.getProcess({ pid })).toBeUndefined();
    const fresh = execute({ script: 'printf "%s\\n" "$BASHPID"' });
    await expect(fresh.result).resolves.toMatchObject({ exitCode: 0 });
    expect(Number(fresh.stdout.text)).not.toBe(pid);

    foreground.release();
    await expect(running.result).resolves.toMatchObject(terminated);
    expect(running.stdout.text).toBe('');
    expect(waiting.stdout.text).toBe('READY');
  });

  it('retires pending waits with their old shell image when another input runs exec', async () => {
    const child = registerHold({ name: 'hold-child', exitCode: 7 });
    using _release = { [Symbol.dispose]: child.release };
    const launch = execute({ script: 'hold-child & child=$!; value=before; printf "%s" "$child"' });
    await expect(launch.result).resolves.toMatchObject({ exitCode: 0 });
    await child.started;
    const pid = Number(launch.stdout.text);

    const old = execute({ script: "trap 'printf INT' INT; printf READY; wait \"$child\"; value=stale; printf late" });
    await expect.poll(() => old.stdout.text).toBe('READY');
    await expect(execute({ script: 'exec true' }).result).resolves.toMatchObject({ exitCode: 0 });
    await expect.poll(() => Promise.race([old.result, undefined])).toMatchObject({ exitCode: 1 });
    expect((await old.result).waitStatus?.kind).not.toBe('signaled');
    expect(old.stdout.text).toBe('READY');

    const fresh = execute({ script: 'value=fresh' });
    await expect(fresh.result).resolves.toMatchObject({ exitCode: 0 });
    child.release();
    await expect.poll(() => wesh.kernel.getProcess({ pid })).toBeUndefined();
    const state = execute({
      script: 'printf "value=%s latest=<%s>\\n" "$value" "$!"; wait "$child"; printf "wait=%s\\n" "$?"; jobs',
    });
    await expect(state.result).resolves.toMatchObject({ exitCode: 0 });
    expect(state.stdout.text).toBe(`\
value=fresh latest=<>
wait=127
`);
    expect(state.stderr.text).toContain('not a child of this shell');
  });
});
