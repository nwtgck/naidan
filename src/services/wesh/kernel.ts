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
} from './types';
import { WeshBrokenPipeError, weshWaitStatusToExitCode } from './types';

class WeshKernelProcessFileHandle implements WeshFileHandle {
  private readonly handle: WeshFileHandle;
  private readonly kernel: WeshKernel;
  private readonly pid: number;
  private closed = false;

  constructor({
    handle,
    kernel,
    pid,
  }: {
    handle: WeshFileHandle;
    kernel: WeshKernel;
    pid: number;
  }) {
    this.handle = handle;
    this.kernel = kernel;
    this.pid = pid;
  }

  async read(options: {
    buffer: Uint8Array;
    offset?: number;
    length?: number;
    position?: number;
  }): Promise<WeshIOResult> {
    return this.handle.read(options);
  }

  async write(options: {
    buffer: Uint8Array;
    offset?: number;
    length?: number;
    position?: number;
  }): Promise<WeshWriteResult> {
    try {
      return await this.handle.write(options);
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
    this.kernel.unregisterOwnedHandle({
      pid: this.pid,
      handle: this,
    });
    await this.handle.close();
  }

  async stat(): Promise<WeshStat> {
    return this.handle.stat();
  }

  async truncate(options: { size: number }): Promise<void> {
    await this.handle.truncate(options);
  }

  async ioctl(options: { request: number; arg?: unknown }): Promise<{ ret: number }> {
    return this.handle.ioctl(options);
  }
}

// --- Pipe Implementation ---
class PipeHandle implements WeshFileHandle {
  private state: {
    buffer: Uint8Array[];
    waiters: Array<() => void>;
    closed: boolean;
  };
  private mode: 'r' | 'w';

  constructor(state: { buffer: Uint8Array[]; waiters: Array<() => void>; closed: boolean }, mode: 'r' | 'w') {
    this.state = state;
    this.mode = mode;
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

    while (this.state.buffer.length === 0) {
      if (this.state.closed) return { bytesRead: 0 };
      await new Promise<void>(resolve => this.state.waiters.push(resolve));
    }

    const chunk = this.state.buffer.shift()!;
    const bufferOffset = options.offset ?? 0;
    const maxLen = options.length ?? (options.buffer.length - bufferOffset);
    const copyLen = Math.min(chunk.length, maxLen);

    options.buffer.set(chunk.subarray(0, copyLen), bufferOffset);

    if (chunk.length > copyLen) {
      this.state.buffer.unshift(chunk.subarray(copyLen));
    }

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
    if (this.state.closed) throw new WeshBrokenPipeError();


    const bufferOffset = options.offset ?? 0;
    const length = options.length ?? (options.buffer.length - bufferOffset);
    const data = new Uint8Array(options.buffer.subarray(bufferOffset, bufferOffset + length));

    this.state.buffer.push(data);

    // Wake up readers
    const waiters = this.state.waiters;
    this.state.waiters = [];
    waiters.forEach(w => w());

    return { bytesWritten: length };
  }

  async close(): Promise<void> {
    this.state.closed = true;
    const waiters = this.state.waiters;
    this.state.waiters = [];
    waiters.forEach(w => w());
  }

  async stat(): Promise<WeshStat> {
    return {
      size: this.state.buffer.reduce((acc, b) => acc + b.length, 0),
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
    const boundHandle = new WeshKernelProcessFileHandle({
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
          handle,
          trackOwnership: false,
        }),
      ]),
    );
  }

  async pipe(): Promise<{ read: WeshFileHandle; write: WeshFileHandle }> {
    const state = { buffer: [], waiters: [], closed: false };
    return {
      read: new PipeHandle(state, 'r'),
      write: new PipeHandle(state, 'w')
    };
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

  async readDir(options: { path: string }): Promise<Array<{ name: string; type: WeshFileType }>> {
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

  private async closeProcessFileDescriptors(options: {
    proc: WeshProcess;
  }): Promise<void> {
    const closedHandles = new Set<WeshFileHandle>();
    for (const [fd, handle] of options.proc.fds.entries()) {
      if (fd === 1 || fd === 2) {
        continue;
      }
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
