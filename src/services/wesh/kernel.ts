import type {
  WeshProcess,
  WeshFileHandle,
  WeshIVirtualFileSystem,
  WeshWriteResult,
  WeshIOResult,
  WeshStat,
  WeshFileType,
  WeshOpenFlags,
} from './types';
import { WeshBrokenPipeError, weshWaitStatusToExitCode } from './types';

export class WeshProcessSignalError extends Error {
  public readonly signal: number;

  constructor({
    signal,
  }: {
    signal: number;
  }) {
    // TODO(wesh-signal): Remove this temporary exception type once pipe/VFS I/O can
    // interrupt command execution through kernel-managed waitStatus transitions
    // without surfacing a JS exception object through handle.write().
    super(`Process terminated by signal ${signal}`);
    this.signal = signal;
    this.name = 'WeshProcessSignalError';
  }
}

class WeshKernelProcessFileHandle implements WeshFileHandle {
  private readonly handle: WeshFileHandle;
  private readonly kernel: WeshKernel;
  private readonly pid: number;

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
        // TODO(wesh-signal): Remove this temporary BrokenPipe-to-SIGPIPE bridge once
        // pipe/VFS write paths deliver SIGPIPE through kernel-managed process state
        // transitions instead of surfacing a structured JS error to this wrapper.
        await this.kernel.kill({
          pid: this.pid,
          signal: 13,
        });
        throw new WeshProcessSignalError({
          signal: 13,
        });
      }
      throw error;
    }
  }

  async close(): Promise<void> {
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
  }): Promise<{ pid: number; process: WeshProcess }> {
    const pid = this.nextPid++;
    const process: WeshProcess = {
      pid,
      ppid: options.ppid ?? 1,
      pgid: options.pgid ?? pid,
      state: 'running',
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

    proc.state = 'terminated';
    proc.waitStatus = {
      kind: 'signaled',
      signal: options.signal,
    };
    proc.exitCode = weshWaitStatusToExitCode({
      waitStatus: proc.waitStatus,
    });
    proc.terminationSignal = options.signal;
  }

  async killProcessGroup(options: { pgid: number; signal: number }): Promise<void> {
    const targets = Array.from(this.processes.values()).filter(proc => proc.pgid === options.pgid);
    await Promise.all(targets.map(proc => this.kill({
      pid: proc.pid,
      signal: options.signal,
    })));
  }

  bindFileHandle(options: {
    pid: number;
    handle: WeshFileHandle;
  }): WeshFileHandle {
    return new WeshKernelProcessFileHandle({
      handle: options.handle,
      kernel: this,
      pid: options.pid,
    });
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
}
