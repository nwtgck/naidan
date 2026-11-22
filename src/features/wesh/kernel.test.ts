import { describe, expect, it, vi } from 'vitest';
import { WeshKernel } from './kernel';
import { MockFileSystemDirectoryHandle } from './mocks/InMemoryFileSystem';
import { createHandleShellSource, createShellSourceReader } from './shell/source';
import { createWeshOwnedBytes } from './types';
import { createTestWriteCaptureHandle } from './utils/test-stream';
import { WeshVFS } from './vfs';

function createKernel() {
  return new WeshKernel({
    vfs: new WeshVFS({
      rootHandle: new MockFileSystemDirectoryHandle({ name: 'root' }) as unknown as FileSystemDirectoryHandle,
    }),
  });
}

describe('Wesh kernel Stop and process substitution pipes', () => {
  it.each([
    { secondConsumer: false, inputOwned: true },
    { secondConsumer: true, inputOwned: true },
    { secondConsumer: false, inputOwned: false },
  ])('follows blocked pipes across process groups (shared: $secondConsumer, input-owned: $inputOwned)', async ({ secondConsumer, inputOwned }) => {
    const kernel = createKernel();
    const earlier = inputOwned ? new AbortController().signal : undefined;
    const current = new AbortController().signal;
    const { pid: producer } = await kernel.spawn({ image: 'producer', args: [], foregroundSignal: earlier });
    const { pid: upstream } = await kernel.spawn({ image: 'upstream', args: [], foregroundSignal: earlier });
    const { pid: stage } = await kernel.spawn({ image: 'stage', args: [], ppid: producer, foregroundSignal: earlier });
    const { pid: background } = await kernel.spawn({ image: 'background', args: [], ppid: producer, backgroundJob: true });
    const { pid: consumer } = await kernel.spawn({ image: 'consumer', args: [], foregroundSignal: current });
    const { pid: other } = await kernel.spawn({ image: 'other', args: [], foregroundSignal: new AbortController().signal });
    const fromUpstream = await kernel.pipe();
    const fromProducer = await kernel.pipe();
    kernel.registerProcessSubstitutionPipe({ handle: fromUpstream.read, peerPid: upstream });
    kernel.registerProcessSubstitutionPipe({ handle: fromProducer.read, peerPid: producer });
    const upstreamWriter = kernel.bindFileHandle({ pid: upstream, handle: fromUpstream.write, trackOwnership: true });
    kernel.bindFileHandle({ pid: producer, handle: fromProducer.write, trackOwnership: true });
    const spare = secondConsumer ? fromUpstream.read.cloneReference?.() : undefined;
    const spareRead = spare === undefined ? undefined : kernel.bindFileHandle({ pid: other, handle: spare, trackOwnership: true });
    const stageRead = kernel.bindFileHandle({ pid: stage, handle: fromUpstream.read, trackOwnership: true });
    const consumerRead = kernel.bindFileHandle({ pid: consumer, handle: fromProducer.read, trackOwnership: true });
    const reading = consumerRead.read({ buffer: new Uint8Array(1) });
    const feeding = stageRead.read({ buffer: new Uint8Array(1) });
    const spareBuffer = new Uint8Array(1);
    const spareResult = spareRead?.read({ buffer: spareBuffer });

    await kernel.interruptInputProcesses({ pids: new Set([consumer]), foregroundSignals: new Set([current]) });
    const interrupted = { kind: 'signaled', signal: 2 };
    for (const pid of [consumer, producer, stage]) {
      expect(kernel.getWaitStatus({ pid })).toEqual(interrupted);
    }
    expect(kernel.getWaitStatus({ pid: background })).toBeUndefined();
    expect(kernel.getWaitStatus({ pid: upstream })).toEqual(secondConsumer ? undefined : interrupted);
    await expect(reading).resolves.toEqual({ bytesRead: 0 });
    await expect(feeding).resolves.toEqual({ bytesRead: 0 });
    if (spareRead !== undefined) {
      await upstreamWriter.write({ buffer: new Uint8Array([65]) });
      await expect(spareResult).resolves.toEqual({ bytesRead: 1 });
      expect(spareBuffer[0]).toBe(65);
      await spareRead.close();
      await upstreamWriter.close();
    }
  });

  it('reaches the other end of a full process substitution pipe on Stop of a shell builtin', async () => {
    const kernel = createKernel();
    const { pid: shell } = await kernel.spawn({ image: 'shell', args: [] });
    const { pid: reader } = await kernel.spawn({ image: 'reader', args: [] });
    const input = new AbortController().signal;
    const { read, write } = await kernel.pipe();
    kernel.registerProcessSubstitutionPipe({ handle: write, peerPid: reader });
    kernel.bindFileHandle({ pid: reader, handle: read, trackOwnership: true });
    const output = kernel.bindShellFileDescriptor({ pid: shell, handle: write, onBrokenPipe: vi.fn(), foregroundSignal: input });
    await write.close();
    const pending = output.writeOwned?.({ chunk: createWeshOwnedBytes({ bytes: new Uint8Array(128 * 1024) }) });
    expect(pending).toBeInstanceOf(Promise);
    expect(await Promise.race([pending, undefined])).toBeUndefined();
    await kernel.interruptInputProcesses({ pids: new Set(), foregroundSignals: new Set([input]) });
    expect(kernel.getWaitStatus({ pid: shell })).toBeUndefined();
    expect(kernel.getWaitStatus({ pid: reader })).toEqual({ kind: 'signaled', signal: 2 });
    await pending;
    await output.close();
  });

  it.each([false, true])('stops a descendant still holding the pipe after its parent exits (reaped: %s)', async reaped => {
    const kernel = createKernel();
    const { pid: shell } = await kernel.spawn({ image: 'shell', args: [] });
    const earlier = new AbortController().signal;
    const current = new AbortController().signal;
    const { pid: peer } = await kernel.spawn({ image: 'peer', args: [], foregroundSignal: earlier });
    const { pid: child } = await kernel.spawn({ image: 'child', args: [], ppid: peer, foregroundSignal: earlier });
    const { read, write } = await kernel.pipe();
    kernel.registerProcessSubstitutionPipe({ handle: read, peerPid: peer });
    kernel.bindFileHandle({ pid: child, handle: write, trackOwnership: true });
    const input = kernel.bindShellFileDescriptor({ pid: shell, handle: read, onBrokenPipe: vi.fn(), foregroundSignal: current });
    await read.close();
    await kernel.kill({ pid: peer, signal: 15 });
    if (reaped) {
      kernel.reapProcess({ pid: peer });
    }
    const reading = input.read({ buffer: new Uint8Array(1) });
    expect(await Promise.race([reading, undefined])).toBeUndefined();

    await kernel.interruptInputProcesses({ pids: new Set(), foregroundSignals: new Set([current]) });
    expect(kernel.getWaitStatus({ pid: peer })).toEqual(reaped ? undefined : { kind: 'signaled', signal: 15 });
    expect(kernel.getWaitStatus({ pid: child })).toEqual({ kind: 'signaled', signal: 2 });
    await expect(reading).resolves.toEqual({ bytesRead: 0 });
    await input.close();
  });

  it('keeps a producer when another input in the same shell joins its source read', async () => {
    const kernel = createKernel();
    const { pid: shell } = await kernel.spawn({ image: 'shell', args: [] });
    const { pid: producer } = await kernel.spawn({ image: 'producer', args: [] });
    const { read, write } = await kernel.pipe();
    kernel.registerProcessSubstitutionPipe({ handle: read, peerPid: producer });
    const writer = kernel.bindFileHandle({ pid: producer, handle: write, trackOwnership: true });
    const first = new AbortController();
    const second = new AbortController();
    const firstInput = kernel.openInputForShell({ handle: read, pid: shell, foregroundSignal: first.signal });
    const secondInput = kernel.openInputForShell({ handle: read, pid: shell, foregroundSignal: second.signal });
    const source = createHandleShellSource({ handle: read });
    const firstReader = createShellSourceReader({ source, input: firstInput });
    const secondReader = createShellSourceReader({ source, input: secondInput });
    const firstRead = firstReader.read();
    const secondRead = secondReader.read();
    expect(await Promise.race([firstRead, secondRead, undefined])).toBeUndefined();

    first.abort();
    const closing = firstInput.close();
    await kernel.interruptInputProcesses({ pids: new Set(), foregroundSignals: new Set([first.signal]) });
    await closing;
    expect(kernel.getWaitStatus({ pid: producer })).toBeUndefined();
    await expect(firstRead).resolves.toMatchObject({ text: '' });
    await writer.write({ buffer: new TextEncoder().encode('echo alive\n') });
    await expect(secondRead).resolves.toMatchObject({ text: 'echo alive\n' });
    await secondInput.close();
    await writer.close();
    await read.close();
  });
});

describe('Wesh kernel process waits', () => {
  it('waits a minute with one timer and releases it on timeout', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
    using _timers = { [Symbol.dispose]: () => vi.useRealTimers() };
    using scheduled = vi.spyOn(globalThis, 'setTimeout');
    const kernel = createKernel();
    const { pid } = await kernel.spawn({ image: 'test', args: [] });
    const settled = vi.fn();
    const wait = kernel.waitForSignalOrTimeout({ pid, timeoutMs: 60_000 });
    void wait.then(settled);

    expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(59_999);
    expect(settled).not.toHaveBeenCalled();
    expect(scheduled).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(1);

    await expect(wait).resolves.toBeUndefined();
    expect(vi.getTimerCount()).toBe(0);
    expect(scheduled).toHaveBeenCalledOnce();
  });

  it('splits a delay above the timer limit at its monotonic deadline', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
    using _timers = { [Symbol.dispose]: () => vi.useRealTimers() };
    using scheduled = vi.spyOn(globalThis, 'setTimeout');
    const kernel = createKernel();
    const { pid } = await kernel.spawn({ image: 'test', args: [] });
    const maximum = 2_147_483_647;
    const settled = vi.fn();
    const wait = kernel.waitForSignalOrTimeout({ pid, timeoutMs: maximum + 100 });
    void wait.then(settled);

    expect(scheduled.mock.calls.map(([, delay]) => delay)).toEqual([maximum]);
    await vi.advanceTimersByTimeAsync(maximum);
    expect(settled).not.toHaveBeenCalled();
    expect(scheduled.mock.calls.map(([, delay]) => delay)).toEqual([maximum, 100]);
    expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(100);

    await expect(wait).resolves.toBeUndefined();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('continues waiting if the host timer fires before the deadline', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    using _timers = { [Symbol.dispose]: () => vi.useRealTimers() };
    using now = vi.spyOn(performance, 'now').mockReturnValue(0);
    const kernel = createKernel();
    const { pid } = await kernel.spawn({ image: 'test', args: [] });
    const settled = vi.fn();
    const wait = kernel.waitForSignalOrTimeout({ pid, timeoutMs: 10 });
    void wait.then(settled);

    now.mockReturnValue(9.5);
    await vi.advanceTimersByTimeAsync(10);
    expect(settled).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(1);

    now.mockReturnValue(10.5);
    await vi.advanceTimersByTimeAsync(1);
    await expect(wait).resolves.toBeUndefined();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('wakes all current waiters only for a delivered interrupt and clears the deadline', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
    using _timers = { [Symbol.dispose]: () => vi.useRealTimers() };
    const kernel = createKernel();
    const { pid } = await kernel.spawn({
      image: 'test',
      args: [],
      signalDispositions: new Map([[2, 'ignore']]),
    });
    const indefinitely = kernel.waitForSignalOrTimeout({ pid, timeoutMs: Infinity });
    const settled = vi.fn();
    void indefinitely.then(settled);
    expect(vi.getTimerCount()).toBe(0);
    const finite = kernel.waitForSignalOrTimeout({ pid, timeoutMs: 100 });
    expect(vi.getTimerCount()).toBe(1);
    await kernel.kill({ pid, signal: 2 });
    expect(settled).not.toHaveBeenCalled();
    expect(kernel.getWaitStatus({ pid })).toBeUndefined();

    await kernel.interruptInputProcesses({ pids: new Set([pid]), foregroundSignals: new Set() });

    const waitStatus = await indefinitely;
    expect(waitStatus).toEqual({ kind: 'signaled', signal: 2 });
    expect(await finite).toBe(waitStatus);
    expect(vi.getTimerCount()).toBe(0);
    await expect(kernel.waitForSignalOrTimeout({ pid, timeoutMs: 100 })).resolves.toBe(waitStatus);
    kernel.reapProcess({ pid });
    await expect(kernel.waitForSignalOrTimeout({ pid, timeoutMs: Infinity })).resolves.toBeUndefined();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('wakes the body before FD cleanup and joins an overlapping close through late acquisitions', async () => {
    const kernel = createKernel();
    const first = createTestWriteCaptureHandle().handle;
    const late = createTestWriteCaptureHandle().handle;
    const releaseFirst = Promise.withResolvers<void>();
    const releaseLate = Promise.withResolvers<void>();
    const lateStarted = Promise.withResolvers<void>();
    using _release = {
      [Symbol.dispose]() {
        releaseFirst.resolve();
        releaseLate.resolve();
      },
    };
    using firstClose = vi.spyOn(first, 'close').mockImplementationOnce(() => releaseFirst.promise);
    using lateClose = vi.spyOn(late, 'close').mockImplementationOnce(() => {
      lateStarted.resolve();
      return releaseLate.promise;
    });
    const { pid } = await kernel.spawn({ image: 'test', args: [], fds: new Map([[1, first]]) });
    const waiting = kernel.waitForSignalOrTimeout({ pid, timeoutMs: Infinity });
    const kill = kernel.kill({ pid, signal: 15 });
    const cleanup = kernel.closeProcessResources({ pid });
    const completed = vi.fn();
    void cleanup.then(completed);
    kernel.registerOwnedHandle({ pid, handle: late });

    await expect(waiting).resolves.toEqual({ kind: 'signaled', signal: 15 });
    expect(firstClose).toHaveBeenCalledOnce();
    expect(completed).not.toHaveBeenCalled();
    expect(() => kernel.reapProcess({ pid })).toThrow('descriptor cleanup');

    releaseFirst.resolve();
    await lateStarted.promise;
    expect(lateClose).toHaveBeenCalledOnce();
    expect(completed).not.toHaveBeenCalled();

    releaseLate.resolve();
    await Promise.all([kill, cleanup]);
    expect(completed).toHaveBeenCalledOnce();
    kernel.reapProcess({ pid });
    expect(kernel.getProcess({ pid })).toBeUndefined();
  });

  it('acknowledges a signal before cleanup and preserves a failure until the receiver collects it', async () => {
    const kernel = createKernel();
    const fd = createTestWriteCaptureHandle().handle;
    const close = Promise.withResolvers<void>();
    using _release = { [Symbol.dispose]: () => close.resolve() };
    using closeFile = vi.spyOn(fd, 'close')
      .mockImplementationOnce(() => close.promise)
      .mockResolvedValue(undefined);
    const { process: sender } = await kernel.spawn({ image: 'sender', args: [] });
    const { pid } = await kernel.spawn({ image: 'receiver', args: [], fds: new Map([[1, fd]]) });

    expect(kernel.sendSignal({ sender, target: pid, signal: 15, deferSelf: undefined })).toBeUndefined();
    expect(kernel.getWaitStatus({ pid })).toEqual({ kind: 'signaled', signal: 15 });
    expect(closeFile).toHaveBeenCalledOnce();
    expect(() => kernel.reapProcess({ pid })).toThrow('descriptor cleanup');

    const failure = new Error('publication failed');
    close.reject(failure);
    await new Promise(resolve => setTimeout(resolve, 0));

    await expect(kernel.closeProcessResources({ pid })).rejects.toBe(failure);
    await expect(kernel.closeProcessResources({ pid })).resolves.toBeUndefined();
    expect(kernel.sendSignal({ sender, target: pid, signal: 0, deferSelf: undefined })).toBeUndefined();
    kernel.reapProcess({ pid });
    expect(kernel.sendSignal({ sender, target: pid, signal: 0, deferSelf: undefined })).toBe('no-such-process');
  });

  it('rejects signal requests from a process that belongs to another kernel', async () => {
    const kernel = createKernel();
    const { pid } = await kernel.spawn({ image: 'local', args: [] });
    const { process: sender } = await createKernel().spawn({ image: 'foreign', args: [] });
    expect(sender.pid).toBe(pid);
    expect(kernel.sendSignal({ sender, target: pid, signal: 9, deferSelf: undefined })).toBe('interrupted');
    expect(kernel.getWaitStatus({ pid })).toBeUndefined();
  });

  it('keeps a background process group until its last member is reaped', async () => {
    const kernel = createKernel();
    const leader = await kernel.spawn({ image: 'job shell', args: [], backgroundJob: true });
    const pgid = leader.process.pgid;
    const member = await kernel.spawn({ image: 'job child', args: [], ppid: leader.pid, pgid });
    await kernel.kill({ pid: leader.pid, signal: 15 });
    kernel.reapProcess({ pid: leader.pid });
    expect(kernel.isBackgroundProcessGroup({ pgid })).toBe(true);

    await kernel.kill({ pid: member.pid, signal: 15 });
    kernel.reapProcess({ pid: member.pid });
    expect(kernel.isBackgroundProcessGroup({ pgid })).toBe(false);
  });
});
