import type {
  WeshProcess,
  WeshFileHandle,
  WeshIVirtualFileSystem,
  WeshWriteResult,
  WeshIOResult,
  WeshStat,
  WeshFileType,
  WeshOpenFlags,
  WeshWaitStatus,
  WeshProcessSignalDisposition,
  WeshEfficientBlobReadResult,
  WeshEfficientFileWriteResult,
  WeshFileHandleCloseSemantics,
} from './types';
import { WeshBrokenPipeError, weshWaitStatusToExitCode } from './types';
import { WeshHandleCloseSignal } from './utils/closeSignal';

const PIPE_BUFFER_LIMIT_BYTES = 64 * 1024;

abstract class WeshKernelProcessFileHandle implements WeshFileHandle {
  protected readonly state: {
    handle: WeshFileHandle;
    refCount: number;
  };
  protected readonly kernel: WeshKernel;
  protected readonly pid: number;
  protected closed = false;

  constructor({
    handle,
    kernel,
    pid,
  }: {
    handle: WeshFileHandle;
    kernel: WeshKernel;
    pid: number;
  }) {
    this.state = handle instanceof WeshKernelProcessFileHandle
      ? handle.state
      : {
        handle,
        refCount: 1,
      };
    if (handle instanceof WeshKernelProcessFileHandle) {
      this.state.refCount += 1;
    }
    this.kernel = kernel;
    this.pid = pid;
  }

  protected async writeWithBrokenPipeHandling(options: {
    operation: Promise<WeshWriteResult>;
  }): Promise<WeshWriteResult> {
    try {
      return await options.operation;
    } catch (error: unknown) {
      if (error instanceof WeshBrokenPipeError) {
        await this.kernel.kill({
          pid: this.pid,
          signal: 13,
        });
        return { bytesWritten: 0 };
      }
      throw error;
    }
  }

  async close(): Promise<void> {
    if (this.closed) {
      return;
    }
    this.closed = true;
    this.onClose();
    this.kernel.unregisterOwnedHandle({
      pid: this.pid,
      handle: this,
    });
    this.state.refCount -= 1;
    if (this.state.refCount <= 0) {
      await this.state.handle.close();
    }
  }

  async stat(): Promise<WeshStat> {
    return this.state.handle.stat();
  }

  async truncate(options: { size: number }): Promise<void> {
    await this.state.handle.truncate(options);
  }

  async ioctl(options: { request: number; arg?: unknown }): Promise<{ ret: number }> {
    return this.state.handle.ioctl(options);
  }

  protected onClose(): void {}

  abstract read(options: {
    buffer: Uint8Array;
    offset?: number;
    length?: number;
    position?: number;
  }): Promise<WeshIOResult>;

  abstract write(options: {
    buffer: Uint8Array;
    offset?: number;
    length?: number;
    position?: number;
  }): Promise<WeshWriteResult>;

  abstract cloneReference(): WeshKernelProcessFileHandle;

  abstract getCloseSemantics(): WeshFileHandleCloseSemantics;
}

class WeshKernelHardProcessFileHandle extends WeshKernelProcessFileHandle {
  async read(options: {
    buffer: Uint8Array;
    offset?: number;
    length?: number;
    position?: number;
  }): Promise<WeshIOResult> {
    return this.state.handle.read(options);
  }

  async write(options: {
    buffer: Uint8Array;
    offset?: number;
    length?: number;
    position?: number;
  }): Promise<WeshWriteResult> {
    return this.writeWithBrokenPipeHandling({
      operation: this.state.handle.write(options),
    });
  }

  cloneReference(): WeshKernelProcessFileHandle {
    return new WeshKernelHardProcessFileHandle({
      handle: this,
      kernel: this.kernel,
      pid: this.pid,
    });
  }

  getCloseSemantics(): WeshFileHandleCloseSemantics {
    return 'hard';
  }
}

class WeshKernelSoftProcessFileHandle extends WeshKernelProcessFileHandle {
  private readonly closeSignal = new WeshHandleCloseSignal({});

  async read(options: {
    buffer: Uint8Array;
    offset?: number;
    length?: number;
    position?: number;
  }): Promise<WeshIOResult> {
    return this.closeSignal.raceWithClose({
      operation: this.state.handle.read(options),
      buildClosedResult: () => ({ bytesRead: 0 }),
    });
  }

  async write(options: {
    buffer: Uint8Array;
    offset?: number;
    length?: number;
    position?: number;
  }): Promise<WeshWriteResult> {
    return this.writeWithBrokenPipeHandling({
      operation: this.closeSignal.raceWithClose({
        operation: this.state.handle.write(options),
        buildClosedResult: () => ({ bytesWritten: 0 }),
      }),
    });
  }

  cloneReference(): WeshKernelProcessFileHandle {
    return new WeshKernelSoftProcessFileHandle({
      handle: this,
      kernel: this.kernel,
      pid: this.pid,
    });
  }

  getCloseSemantics(): WeshFileHandleCloseSemantics {
    return 'soft';
  }

  protected override onClose(): void {
    this.closeSignal.close();
  }
}

function createWeshKernelProcessFileHandle(options: {
  handle: WeshFileHandle;
  kernel: WeshKernel;
  pid: number;
}): WeshKernelProcessFileHandle {
  const closeSemantics = options.handle instanceof WeshKernelProcessFileHandle
    ? options.handle.getCloseSemantics()
    : options.handle.getCloseSemantics?.() ?? 'hard';

  switch (closeSemantics) {
  case 'hard':
    return new WeshKernelHardProcessFileHandle(options);
  case 'soft':
    return new WeshKernelSoftProcessFileHandle(options);
  default: {
    const _ex: never = closeSemantics;
    throw new Error(`Unhandled close semantics: ${_ex}`);
  }
  }
}

// --- Pipe Implementation ---
class PipeHandle implements WeshFileHandle {
  private state: {
    buffer: Uint8Array[];
    bufferHeadIndex: number;
    bufferSize: number;
    headOffset: number;
    readWaiters: Array<() => void>;
    writeWaiters: Array<() => void>;
    readRefCount: number;
    writeRefCount: number;
  };
  private mode: 'r' | 'w';
  private closed = false;

  constructor(state: {
    buffer: Uint8Array[];
    bufferHeadIndex: number;
    bufferSize: number;
    headOffset: number;
    readWaiters: Array<() => void>;
    writeWaiters: Array<() => void>;
    readRefCount: number;
    writeRefCount: number;
  }, mode: 'r' | 'w') {
    this.state = state;
    this.mode = mode;
  }

  private wakeReadWaiters(): void {
    const waiters = this.state.readWaiters;
    this.state.readWaiters = [];
    for (const waiter of waiters) {
      waiter();
    }
  }

  private wakeWriteWaiters(): void {
    const waiters = this.state.writeWaiters;
    this.state.writeWaiters = [];
    for (const waiter of waiters) {
      waiter();
    }
  }

  async read(options: { buffer: Uint8Array; offset?: number; length?: number }): Promise<WeshIOResult> {
    switch (this.mode) {
    case 'r':
      break;
    case 'w':
      throw new Error('File not open for reading');
    default: {
      const _ex: never = this.mode;
      throw new Error(`Unhandled mode: ${_ex}`);
    }
    }

    while (this.state.bufferHeadIndex >= this.state.buffer.length) {
      if (this.closed || this.state.writeRefCount <= 0) return { bytesRead: 0 };
      await new Promise<void>(resolve => this.state.readWaiters.push(resolve));
    }

    const chunk = this.state.buffer[this.state.bufferHeadIndex]!;
    const bufferOffset = options.offset ?? 0;
    const maxLen = options.length ?? (options.buffer.length - bufferOffset);
    const available = chunk.length - this.state.headOffset;
    const copyLen = Math.min(available, maxLen);

    options.buffer.set(chunk.subarray(this.state.headOffset, this.state.headOffset + copyLen), bufferOffset);

    if (copyLen === available) {
      this.state.bufferHeadIndex += 1;
      this.state.headOffset = 0;
      if (this.state.bufferHeadIndex >= this.state.buffer.length) {
        this.state.buffer = [];
        this.state.bufferHeadIndex = 0;
      } else if (this.state.bufferHeadIndex >= 32 && this.state.bufferHeadIndex * 2 >= this.state.buffer.length) {
        this.state.buffer = this.state.buffer.slice(this.state.bufferHeadIndex);
        this.state.bufferHeadIndex = 0;
      }
    } else {
      this.state.headOffset += copyLen;
    }
    this.state.bufferSize -= copyLen;
    this.wakeWriteWaiters();

    return { bytesRead: copyLen };
  }

  async write(options: { buffer: Uint8Array; offset?: number; length?: number }): Promise<WeshWriteResult> {
    switch (this.mode) {
    case 'w':
      break;
    case 'r':
      throw new Error('File not open for writing');
    default: {
      const _ex: never = this.mode;
      throw new Error(`Unhandled mode: ${_ex}`);
    }
    }
    const bufferOffset = options.offset ?? 0;
    const length = options.length ?? (options.buffer.length - bufferOffset);
    let bytesWritten = 0;

    while (bytesWritten < length) {
      if (this.closed) {
        return { bytesWritten };
      }
      if (this.state.readRefCount <= 0) {
        if (bytesWritten > 0) {
          return { bytesWritten };
        }
        throw new WeshBrokenPipeError();
      }

      const availableCapacity = PIPE_BUFFER_LIMIT_BYTES - this.state.bufferSize;
      if (availableCapacity <= 0) {
        await new Promise<void>(resolve => this.state.writeWaiters.push(resolve));
        continue;
      }

      const chunkLength = Math.min(length - bytesWritten, availableCapacity);
      const start = bufferOffset + bytesWritten;
      const data = new Uint8Array(options.buffer.subarray(start, start + chunkLength));
      this.state.buffer.push(data);
      this.state.bufferSize += chunkLength;
      bytesWritten += chunkLength;
      this.wakeReadWaiters();
    }

    return { bytesWritten };
  }

  async close(): Promise<void> {
    if (this.closed) {
      return;
    }
    this.closed = true;
    switch (this.mode) {
    case 'r':
      this.state.readRefCount -= 1;
      break;
    case 'w':
      this.state.writeRefCount -= 1;
      break;
    default: {
      const _ex: never = this.mode;
      throw new Error(`Unhandled mode: ${_ex}`);
    }
    }
    this.wakeReadWaiters();
    this.wakeWriteWaiters();
  }

  async stat(): Promise<WeshStat> {
    return {
      size: this.state.bufferSize,
      mode: 0o600,
      type: 'fifo',
      mtime: Date.now(),
      ino: 0, uid: 0, gid: 0
    };
  }

  async truncate(): Promise<void> {}
  async ioctl(): Promise<{ ret: number }> {
    return { ret: 0 };
  }

  getCloseSemantics(): WeshFileHandleCloseSemantics {
    return 'hard';
  }

  cloneReference(): WeshFileHandle {
    switch (this.mode) {
    case 'r':
      this.state.readRefCount += 1;
      break;
    case 'w':
      this.state.writeRefCount += 1;
      break;
    default: {
      const _ex: never = this.mode;
      throw new Error(`Unhandled mode: ${_ex}`);
    }
    }
    return new PipeHandle(this.state, this.mode);
  }
}


export class WeshKernel {
  private processes: Map<number, WeshProcess> = new Map();
  private nextPid = 1;
  private vfs: WeshIVirtualFileSystem;

  constructor({ vfs }: { vfs: WeshIVirtualFileSystem }) {
    this.vfs = vfs;
    // PID 1 (init) placeholder
    this.processes.set(1, {
      pid: 1,
      ppid: 0,
      pgid: 1,
      state: 'running',
      pendingSignals: [],
      ownedHandles: new Set(),
      env: new Map(),
      cwd: '/',
      args: ['init'],
      fds: new Map()
    });
    this.nextPid = 2;
  }

  async spawn(options: {
    image: string;
    args: string[];
    env?: Map<string, string>;
    cwd?: string;
    fds?: Map<number, WeshFileHandle>;
    ppid?: number;
    pgid?: number;
    signalDispositions?: Map<number, WeshProcessSignalDisposition>;
  }): Promise<{ pid: number; process: WeshProcess }> {
    const pid = this.nextPid++;
    const process: WeshProcess = {
      pid,
      ppid: options.ppid ?? 1,
      pgid: options.pgid ?? pid,
      state: 'running',
      pendingSignals: [],
      signalDispositions: options.signalDispositions ? new Map(options.signalDispositions) : new Map(),
      ownedHandles: new Set(),
      env: options.env ? new Map(options.env) : new Map(),
      cwd: options.cwd || '/',
      args: options.args,
      fds: options.fds ? new Map(options.fds) : new Map()
    };

    this.processes.set(pid, process);
    return { pid, process };
  }

  async wait(options: { pid: number; flags?: number }): Promise<{ pid: number; exitCode: number }> {
    const proc = this.processes.get(options.pid);
    if (!proc) throw new Error(`No such process: ${options.pid}`);

    if (proc.state === 'terminated' || proc.state === 'zombie') {
      return { pid: options.pid, exitCode: proc.exitCode ?? 0 };
    }

    return new Promise(resolve => {
      const check = setInterval(() => {
        if (proc.state === 'terminated' || proc.state === 'zombie') {
          clearInterval(check);
          resolve({ pid: options.pid, exitCode: proc.exitCode ?? 0 });
        }
      }, 50);
    });
  }

  async kill(options: { pid: number; signal: number }): Promise<void> {
    const proc = this.processes.get(options.pid);
    if (!proc) return;
    if (proc.state === 'terminated' || proc.state === 'zombie') {
      return;
    }

    const disposition = proc.signalDispositions?.get(options.signal) ?? 'default';
    switch (disposition) {
    case 'default':
      break;
    case 'ignore':
      return;
    default: {
      const _ex: never = disposition;
      throw new Error(`Unhandled signal disposition: ${_ex}`);
    }
    }

    proc.pendingSignals ??= [];
    proc.pendingSignals.push(options.signal);
    proc.state = 'terminated';
    proc.waitStatus = {
      kind: 'signaled',
      signal: options.signal,
    };
    proc.exitCode = weshWaitStatusToExitCode({
      waitStatus: proc.waitStatus,
    });
    proc.terminationSignal = options.signal;
    await this.closeProcessFileDescriptors({
      proc,
    });
  }

  getPendingSignals(options: { pid: number }): number[] {
    const proc = this.processes.get(options.pid);
    return proc?.pendingSignals ? [...proc.pendingSignals] : [];
  }

  consumePendingSignals(options: { pid: number }): number[] {
    const proc = this.processes.get(options.pid);
    if (proc?.pendingSignals === undefined || proc.pendingSignals.length === 0) {
      return [];
    }

    const pendingSignals = [...proc.pendingSignals];
    proc.pendingSignals = [];
    return pendingSignals;
  }

  getWaitStatus(options: { pid: number }) {
    return this.processes.get(options.pid)?.waitStatus;
  }

  async waitForSignalOrTimeout(options: {
    pid: number;
    timeoutMs: number;
    pollIntervalMs?: number;
  }): Promise<WeshWaitStatus | undefined> {
    const deadline = Date.now() + options.timeoutMs;
    const pollIntervalMs = options.pollIntervalMs ?? 10;

    while (Date.now() < deadline) {
      const waitStatus = this.getWaitStatus({ pid: options.pid });
      if (waitStatus !== undefined) {
        this.consumePendingSignals({ pid: options.pid });
        return waitStatus;
      }

      await new Promise(resolve => setTimeout(resolve, Math.min(pollIntervalMs, deadline - Date.now())));
    }

    return this.getWaitStatus({ pid: options.pid });
  }

  async killProcessGroup(options: {
    pgid: number;
    signal: number;
    excludedPids?: number[];
  }): Promise<void> {
    const excludedPids = new Set(options.excludedPids ?? []);
    const targets = Array.from(this.processes.values()).filter(proc => (
      proc.pgid === options.pgid &&
      !excludedPids.has(proc.pid)
    ));
    await Promise.all(targets.map(proc => this.kill({
      pid: proc.pid,
      signal: options.signal,
    })));
  }

  bindFileHandle(options: {
    pid: number;
    handle: WeshFileHandle;
    trackOwnership: boolean;
  }): WeshFileHandle {
    const boundHandle = createWeshKernelProcessFileHandle({
      handle: options.handle,
      kernel: this,
      pid: options.pid,
    });
    if (options.trackOwnership) {
      this.registerOwnedHandle({
        pid: options.pid,
        handle: boundHandle,
      });
    }
    return boundHandle;
  }

  bindFdTable(options: {
    pid: number;
    fdTable: Map<number, WeshFileHandle>;
  }): Map<number, WeshFileHandle> {
    return new Map(
      Array.from(options.fdTable.entries()).map(([fd, handle]) => [
        fd,
        this.bindFileHandle({
          pid: options.pid,
          handle: handle instanceof WeshKernelProcessFileHandle
            ? handle
            : this.createDuplicatedHandleReference({ handle }),
          trackOwnership: false,
        }),
      ]),
    );
  }

  async pipe(): Promise<{ read: WeshFileHandle; write: WeshFileHandle }> {
    const state = {
      buffer: [],
      bufferHeadIndex: 0,
      bufferSize: 0,
      headOffset: 0,
      readWaiters: [],
      writeWaiters: [],
      readRefCount: 1,
      writeRefCount: 1,
    };
    return {
      read: new PipeHandle(state, 'r'),
      write: new PipeHandle(state, 'w')
    };
  }

  private createDuplicatedHandleReference(options: {
    handle: WeshFileHandle;
  }): WeshFileHandle {
    if (typeof (options.handle as WeshFileHandle & { cloneReference?: () => WeshFileHandle }).cloneReference === 'function') {
      return (options.handle as WeshFileHandle & { cloneReference: () => WeshFileHandle }).cloneReference();
    }
    return options.handle;
  }

  async open(options: { path: string; flags: WeshOpenFlags; mode?: number }): Promise<WeshFileHandle> {
    return this.vfs.open({ path: options.path, flags: options.flags, mode: options.mode });
  }

  async stat(options: { path: string }): Promise<WeshStat> {
    return this.vfs.stat({ path: options.path });
  }

  async lstat(options: { path: string }): Promise<WeshStat> {
    return this.vfs.lstat({ path: options.path });
  }

  async readlink(options: { path: string }): Promise<string> {
    return this.vfs.readlink({ path: options.path });
  }

  async resolve(options: { path: string }): Promise<{ fullPath: string; stat: WeshStat }> {
    return this.vfs.resolve(options);
  }

  async tryReadBlobEfficiently(options: { path: string }): Promise<WeshEfficientBlobReadResult> {
    return this.vfs.tryReadBlobEfficiently({ path: options.path });
  }

  async tryCreateFileWriterEfficiently(options: {
    path: string;
    mode: 'truncate' | 'append';
  }): Promise<WeshEfficientFileWriteResult> {
    return this.vfs.tryCreateFileWriterEfficiently({
      path: options.path,
      mode: options.mode,
    });
  }

  readDir(options: { path: string }) {
    return this.vfs.readDir({ path: options.path });
  }

  async mkdir(options: { path: string; mode?: number; recursive?: boolean }): Promise<void> {
    return this.vfs.mkdir(options);
  }

  async symlink(options: { path: string; targetPath: string; mode?: number }): Promise<void> {
    return this.vfs.symlink(options);
  }

  async mknod(options: { path: string; type: WeshFileType; mode?: number }): Promise<void> {
    return this.vfs.mknod(options);
  }

  async unlink(options: { path: string }): Promise<void> {
    return this.vfs.unlink(options);
  }

  async rmdir(options: { path: string }): Promise<void> {
    return this.vfs.rmdir(options);
  }

  async rename(options: { oldPath: string; newPath: string }): Promise<void> {
    return this.vfs.rename(options);
  }

  getProcess(options: { pid: number }): WeshProcess | undefined {
    return this.processes.get(options.pid);
  }

  getProcessesByGroup(options: { pgid: number }): WeshProcess[] {
    return Array.from(this.processes.values()).filter(proc => proc.pgid === options.pgid);
  }

  getProcesses(): WeshProcess[] {
    return Array.from(this.processes.values());
  }

  registerOwnedHandle(options: {
    pid: number;
    handle: WeshFileHandle;
  }): void {
    const proc = this.processes.get(options.pid);
    if (proc === undefined) {
      return;
    }
    proc.ownedHandles ??= new Set();
    proc.ownedHandles.add(options.handle);
  }

  unregisterOwnedHandle(options: {
    pid: number;
    handle: WeshFileHandle;
  }): void {
    const proc = this.processes.get(options.pid);
    proc?.ownedHandles?.delete(options.handle);
  }

  async closeProcessResources(options: {
    pid: number;
  }): Promise<void> {
    const proc = this.processes.get(options.pid);
    if (proc === undefined) {
      return;
    }
    await this.closeProcessFileDescriptors({ proc });
  }

  private async closeProcessFileDescriptors(options: {
    proc: WeshProcess;
  }): Promise<void> {
    const closedHandles = new Set<WeshFileHandle>();
    for (const handle of options.proc.fds.values()) {
      if (closedHandles.has(handle)) {
        continue;
      }
      closedHandles.add(handle);
      await handle.close();
    }

    for (const handle of options.proc.ownedHandles ?? []) {
      if (closedHandles.has(handle)) {
        continue;
      }
      closedHandles.add(handle);
      await handle.close();
    }
  }
}
