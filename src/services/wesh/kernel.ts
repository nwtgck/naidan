import type {
  WeshProcess,
  WeshFileHandle,
  WeshIVirtualFileSystem,
  WeshWriteResult,
  WeshOwnedBytes,
  WeshIOResult,
  WeshStat,
  WeshFileType,
  WeshOpenFlags,
  WeshWaitStatus,
  WeshProcessSignalDisposition,
  WeshEfficientBlobReadResult,
  WeshEfficientFileWriteResult,
  WeshFileHandleCloseSemantics,
  WeshEntryRef,
  WeshFinalSymlinkTreatment,
} from './types';
import { WeshBrokenPipeError, weshWaitStatusToExitCode } from './types';
import { WeshHandleCloseSignal } from './utils/closeSignal';

const PIPE_BUFFER_LIMIT_BYTES = 64 * 1024;

abstract class WeshKernelProcessFileHandle implements WeshFileHandle {
  protected readonly state: {
    handle: WeshFileHandle,
    refCount: number,
  };
  protected readonly kernel: WeshKernel;
  protected readonly pid: number;
  protected closed = false;

  constructor({
    handle,
    kernel,
    pid,
  }: {
    handle: WeshFileHandle,
    kernel: WeshKernel,
    pid: number,
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

  protected async writeWithBrokenPipeHandling({ operation }: {
    operation: Promise<WeshWriteResult>,
  }): Promise<WeshWriteResult> {
    try {
      return await operation;
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

  protected async writeOwnedWithBrokenPipeHandling({ operation }: {
    operation: Promise<void>,
  }): Promise<void> {
    try {
      await operation;
    } catch (error: unknown) {
      if (error instanceof WeshBrokenPipeError) {
        await this.kernel.kill({
          pid: this.pid,
          signal: 13,
        });
        return;
      }
      throw error;
    }
  }

  protected async writeOwnedUsingBorrowedWrites({ chunk }: {
    chunk: WeshOwnedBytes,
  }): Promise<void> {
    let offset = 0;
    while (offset < chunk.bytes.byteLength) {
      const result = await this.write({
        buffer: chunk.bytes,
        offset,
        length: chunk.bytes.byteLength - offset,
      });
      if (result.bytesWritten === 0) {
        return;
      }
      offset += result.bytesWritten;
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

  async truncate({ size }: { size: number }): Promise<void> {
    const options = { size };
    await this.state.handle.truncate(options);
  }

  async ioctl({ request, arg }: { request: number, arg?: unknown }): Promise<{ ret: number }> {
    const options = { request, arg };
    return this.state.handle.ioctl(options);
  }

  protected onClose(): void {}

  abstract read({ buffer, offset, length, position }: {
    buffer: Uint8Array,
    offset?: number,
    length?: number,
    position?: number,
  }): Promise<WeshIOResult>;

  abstract write({ buffer, offset, length, position }: {
    buffer: Uint8Array,
    offset?: number,
    length?: number,
    position?: number,
  }): Promise<WeshWriteResult>;

  abstract cloneReference(): WeshKernelProcessFileHandle;

  abstract getCloseSemantics(): WeshFileHandleCloseSemantics;
}

class WeshKernelHardProcessFileHandle extends WeshKernelProcessFileHandle {
  async read({ buffer, offset, length, position }: {
    buffer: Uint8Array,
    offset?: number,
    length?: number,
    position?: number,
  }): Promise<WeshIOResult> {
    const options = { buffer, offset, length, position };
    return this.state.handle.read(options);
  }

  async write({ buffer, offset, length, position }: {
    buffer: Uint8Array,
    offset?: number,
    length?: number,
    position?: number,
  }): Promise<WeshWriteResult> {
    const options = { buffer, offset, length, position };
    return this.writeWithBrokenPipeHandling({
      operation: this.state.handle.write(options),
    });
  }

  async writeOwned({ chunk }: { chunk: WeshOwnedBytes }): Promise<void> {
    if (this.state.handle.writeOwned === undefined) {
      await this.writeOwnedUsingBorrowedWrites({ chunk });
      return;
    }
    await this.writeOwnedWithBrokenPipeHandling({
      operation: this.state.handle.writeOwned({ chunk }),
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
  private readonly closeSignal = new WeshHandleCloseSignal();

  async read({ buffer, offset, length, position }: {
    buffer: Uint8Array,
    offset?: number,
    length?: number,
    position?: number,
  }): Promise<WeshIOResult> {
    const options = { buffer, offset, length, position };
    return this.closeSignal.raceWithClose({
      operation: this.state.handle.read(options),
      buildClosedResult: () => ({ bytesRead: 0 }),
    });
  }

  async write({ buffer, offset, length, position }: {
    buffer: Uint8Array,
    offset?: number,
    length?: number,
    position?: number,
  }): Promise<WeshWriteResult> {
    const options = { buffer, offset, length, position };
    return this.writeWithBrokenPipeHandling({
      operation: this.closeSignal.raceWithClose({
        operation: this.state.handle.write(options),
        buildClosedResult: () => ({ bytesWritten: 0 }),
      }),
    });
  }

  async writeOwned({ chunk }: { chunk: WeshOwnedBytes }): Promise<void> {
    if (this.state.handle.writeOwned === undefined) {
      await this.writeOwnedUsingBorrowedWrites({ chunk });
      return;
    }
    await this.writeOwnedWithBrokenPipeHandling({
      operation: this.closeSignal.raceWithClose({
        operation: this.state.handle.writeOwned({ chunk }),
        buildClosedResult: () => undefined,
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

function createWeshKernelProcessFileHandle({ handle, kernel, pid }: {
  handle: WeshFileHandle,
  kernel: WeshKernel,
  pid: number,
}): WeshKernelProcessFileHandle {
  const options = { handle, kernel, pid };
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
    buffer: Uint8Array[],
    bufferHeadIndex: number,
    bufferSize: number,
    headOffset: number,
    readWaiters: Array<() => void>,
    writeWaiters: Array<() => void>,
    readRefCount: number,
    writeRefCount: number,
  };
  private mode: 'r' | 'w';
  private closed = false;

  constructor({ state, mode }: {
    state: {
      buffer: Uint8Array[],
      bufferHeadIndex: number,
      bufferSize: number,
      headOffset: number,
      readWaiters: Array<() => void>,
      writeWaiters: Array<() => void>,
      readRefCount: number,
      writeRefCount: number,
    },
    mode: 'r' | 'w',
  }) {
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

  async read({ buffer, offset, length }: { buffer: Uint8Array, offset?: number, length?: number }): Promise<WeshIOResult> {
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
    const bufferOffset = offset ?? 0;
    const maxLen = length ?? (buffer.length - bufferOffset);
    const available = chunk.length - this.state.headOffset;
    const copyLen = Math.min(available, maxLen);

    buffer.set(chunk.subarray(this.state.headOffset, this.state.headOffset + copyLen), bufferOffset);

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

  private async writeBuffer({
    buffer,
    offset,
    length,
    ownership,
  }: {
    buffer: Uint8Array,
    offset: number,
    length: number,
    ownership: 'borrowed' | 'owned',
  }): Promise<number> {
    let bytesWritten = 0;
    while (bytesWritten < length) {
      if (this.closed) {
        return bytesWritten;
      }
      if (this.state.readRefCount <= 0) {
        if (bytesWritten > 0) {
          return bytesWritten;
        }
        throw new WeshBrokenPipeError();
      }

      const availableCapacity = PIPE_BUFFER_LIMIT_BYTES - this.state.bufferSize;
      if (availableCapacity <= 0) {
        await new Promise<void>(resolve => this.state.writeWaiters.push(resolve));
        continue;
      }

      const chunkLength = Math.min(length - bytesWritten, availableCapacity);
      const start = offset + bytesWritten;
      const view = buffer.subarray(start, start + chunkLength);
      const data = (() => {
        switch (ownership) {
        case 'borrowed':
          return new Uint8Array(view);
        case 'owned':
          return view;
        default: {
          const _exhaustiveCheck: never = ownership;
          throw new Error(`Unhandled byte ownership: ${String(_exhaustiveCheck)}`);
        }
        }
      })();
      this.state.buffer.push(data);
      this.state.bufferSize += chunkLength;
      bytesWritten += chunkLength;
      this.wakeReadWaiters();
    }
    return bytesWritten;
  }

  async write({ buffer, offset, length: requestedLength }: { buffer: Uint8Array, offset?: number, length?: number }): Promise<WeshWriteResult> {
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
    const bufferOffset = offset ?? 0;
    const length = requestedLength ?? (buffer.length - bufferOffset);
    return {
      bytesWritten: await this.writeBuffer({
        buffer,
        offset: bufferOffset,
        length,
        ownership: 'borrowed',
      }),
    };
  }

  async writeOwned({ chunk }: { chunk: WeshOwnedBytes }): Promise<void> {
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
    const bytesWritten = await this.writeBuffer({
      buffer: chunk.bytes,
      offset: 0,
      length: chunk.bytes.byteLength,
      ownership: 'owned',
    });
    if (bytesWritten !== chunk.bytes.byteLength) {
      throw new WeshBrokenPipeError();
    }
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
      ino: 0, uid: 0, gid: 0,
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
    return new PipeHandle({ state: this.state, mode: this.mode });
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
      fds: new Map(),
    });
    this.nextPid = 2;
  }

  async spawn({ image: _image, args, env, cwd, fds, ppid, pgid, signalDispositions }: {
    image: string,
    args: string[],
    env?: Map<string, string>,
    cwd?: string,
    fds?: Map<number, WeshFileHandle>,
    ppid?: number,
    pgid?: number,
    signalDispositions?: Map<number, WeshProcessSignalDisposition>,
  }): Promise<{ pid: number, process: WeshProcess }> {
    const pid = this.nextPid++;
    const process: WeshProcess = {
      pid,
      ppid: ppid ?? 1,
      pgid: pgid ?? pid,
      state: 'running',
      pendingSignals: [],
      signalDispositions: signalDispositions ? new Map(signalDispositions) : new Map(),
      ownedHandles: new Set(),
      env: env ? new Map(env) : new Map(),
      cwd: cwd || '/',
      args: args,
      fds: fds ? new Map(fds) : new Map(),
    };

    this.processes.set(pid, process);
    return { pid, process };
  }

  async wait({ pid, flags: _flags }: { pid: number, flags?: number }): Promise<{ pid: number, exitCode: number }> {
    const proc = this.processes.get(pid);
    if (!proc) throw new Error(`No such process: ${pid}`);

    if (proc.state === 'terminated' || proc.state === 'zombie') {
      return { pid: pid, exitCode: proc.exitCode ?? 0 };
    }

    return new Promise(resolve => {
      const check = setInterval(() => {
        if (proc.state === 'terminated' || proc.state === 'zombie') {
          clearInterval(check);
          resolve({ pid: pid, exitCode: proc.exitCode ?? 0 });
        }
      }, 50);
    });
  }

  async kill({ pid, signal }: { pid: number, signal: number }): Promise<void> {
    const proc = this.processes.get(pid);
    if (!proc) return;
    if (proc.state === 'terminated' || proc.state === 'zombie') {
      return;
    }

    const disposition = proc.signalDispositions?.get(signal) ?? 'default';
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
    proc.pendingSignals.push(signal);
    proc.state = 'terminated';
    proc.waitStatus = {
      kind: 'signaled',
      signal: signal,
    };
    proc.exitCode = weshWaitStatusToExitCode({
      waitStatus: proc.waitStatus,
    });
    proc.terminationSignal = signal;
    await this.closeProcessFileDescriptors({
      proc,
    });
  }

  getPendingSignals({ pid }: { pid: number }): number[] {
    const proc = this.processes.get(pid);
    return proc?.pendingSignals ? [...proc.pendingSignals] : [];
  }

  consumePendingSignals({ pid }: { pid: number }): number[] {
    const proc = this.processes.get(pid);
    if (proc?.pendingSignals === undefined || proc.pendingSignals.length === 0) {
      return [];
    }

    const pendingSignals = [...proc.pendingSignals];
    proc.pendingSignals = [];
    return pendingSignals;
  }

  getWaitStatus({ pid }: { pid: number }) {
    return this.processes.get(pid)?.waitStatus;
  }

  async waitForSignalOrTimeout({ pid, timeoutMs, pollIntervalMs: requestedPollIntervalMs }: {
    pid: number,
    timeoutMs: number,
    pollIntervalMs?: number,
  }): Promise<WeshWaitStatus | undefined> {
    const deadline = Date.now() + timeoutMs;
    const pollIntervalMs = requestedPollIntervalMs ?? 10;

    while (Date.now() < deadline) {
      const waitStatus = this.getWaitStatus({ pid: pid });
      if (waitStatus !== undefined) {
        this.consumePendingSignals({ pid: pid });
        return waitStatus;
      }

      await new Promise(resolve => setTimeout(resolve, Math.min(pollIntervalMs, deadline - Date.now())));
    }

    return this.getWaitStatus({ pid: pid });
  }

  async killProcessGroup({ pgid, signal, excludedPids: excludedPidList }: {
    pgid: number,
    signal: number,
    excludedPids?: number[],
  }): Promise<void> {
    const excludedPids = new Set(excludedPidList ?? []);
    const targets = Array.from(this.processes.values()).filter(proc => (
      proc.pgid === pgid &&
      !excludedPids.has(proc.pid)
    ));
    await Promise.all(targets.map(proc => this.kill({
      pid: proc.pid,
      signal: signal,
    })));
  }

  bindFileHandle({ pid, handle, trackOwnership }: {
    pid: number,
    handle: WeshFileHandle,
    trackOwnership: boolean,
  }): WeshFileHandle {
    const boundHandle = createWeshKernelProcessFileHandle({
      handle: handle,
      kernel: this,
      pid: pid,
    });
    if (trackOwnership) {
      this.registerOwnedHandle({
        pid: pid,
        handle: boundHandle,
      });
    }
    return boundHandle;
  }

  bindFdTable({ pid, fdTable }: {
    pid: number,
    fdTable: Map<number, WeshFileHandle>,
  }): Map<number, WeshFileHandle> {
    return new Map(
      Array.from(fdTable.entries()).map(([fd, handle]) => [
        fd,
        this.bindFileHandle({
          pid: pid,
          handle: handle instanceof WeshKernelProcessFileHandle
            ? handle
            : this.createDuplicatedHandleReference({ handle }),
          trackOwnership: false,
        }),
      ]),
    );
  }

  async pipe(): Promise<{ read: WeshFileHandle, write: WeshFileHandle }> {
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
      read: new PipeHandle({ state, mode: 'r' }),
      write: new PipeHandle({ state, mode: 'w' }),
    };
  }

  private createDuplicatedHandleReference({ handle }: {
    handle: WeshFileHandle,
  }): WeshFileHandle {
    if (typeof (handle as WeshFileHandle & { cloneReference?: () => WeshFileHandle }).cloneReference === 'function') {
      return (handle as WeshFileHandle & { cloneReference: () => WeshFileHandle }).cloneReference();
    }
    return handle;
  }

  async open({ path, flags, mode }: { path: string, flags: WeshOpenFlags, mode?: number }): Promise<WeshFileHandle> {
    return this.vfs.open({ path: path, flags: flags, mode: mode });
  }

  async stat({ path }: { path: string }): Promise<WeshStat> {
    return this.vfs.stat({ path: path });
  }

  async lstat({ path }: { path: string }): Promise<WeshStat> {
    return this.vfs.lstat({ path: path });
  }

  async readlink({ path }: { path: string }): Promise<string> {
    return this.vfs.readlink({ path: path });
  }

  async resolve({ path }: { path: string }): Promise<{ fullPath: string, stat: WeshStat }> {
    const options = { path };
    return this.vfs.resolve(options);
  }

  async tryReadBlobEfficiently({ path }: { path: string }): Promise<WeshEfficientBlobReadResult> {
    return this.vfs.tryReadBlobEfficiently({ path: path });
  }

  async tryCreateFileWriterEfficiently({ path, mode }: {
    path: string,
    mode: 'truncate' | 'append',
  }): Promise<WeshEfficientFileWriteResult> {
    return this.vfs.tryCreateFileWriterEfficiently({
      path: path,
      mode: mode,
    });
  }

  readDir({ path }: { path: string }) {
    return this.vfs.readDir({ path: path });
  }

  async resolveEntry({
    path,
    finalSymlinkTreatment,
  }: {
    path: string,
    finalSymlinkTreatment: WeshFinalSymlinkTreatment,
  }): Promise<WeshEntryRef> {
    return this.vfs.resolveEntry({ path, finalSymlinkTreatment });
  }

  readDirEntry({
    entry,
  }: {
    entry: WeshEntryRef<'directory'>,
  }): AsyncIterable<WeshEntryRef> {
    return this.vfs.readDirEntry({ entry });
  }

  async statEntry({ entry }: { entry: WeshEntryRef }): Promise<WeshStat> {
    return this.vfs.statEntry({ entry });
  }

  async openEntry({
    entry,
    flags,
    mode,
  }: {
    entry: WeshEntryRef,
    flags: WeshOpenFlags,
    mode?: number,
  }): Promise<WeshFileHandle> {
    return this.vfs.openEntry({ entry, flags, mode });
  }

  async readlinkEntry({
    entry,
  }: {
    entry: WeshEntryRef<'symlink'>,
  }): Promise<string> {
    return this.vfs.readlinkEntry({ entry });
  }

  async mkdir({ path, mode, recursive }: { path: string, mode?: number, recursive?: boolean }): Promise<void> {
    const options = { path, mode, recursive };
    return this.vfs.mkdir(options);
  }

  async symlink({ path, targetPath, mode }: { path: string, targetPath: string, mode?: number }): Promise<void> {
    const options = { path, targetPath, mode };
    return this.vfs.symlink(options);
  }

  async mknod({ path, type, mode }: { path: string, type: WeshFileType, mode?: number }): Promise<void> {
    const options = { path, type, mode };
    return this.vfs.mknod(options);
  }

  async unlink({ path }: { path: string }): Promise<void> {
    const options = { path };
    return this.vfs.unlink(options);
  }

  async rmdir({ path }: { path: string }): Promise<void> {
    const options = { path };
    return this.vfs.rmdir(options);
  }

  async rename({ oldPath, newPath }: { oldPath: string, newPath: string }): Promise<void> {
    const options = { oldPath, newPath };
    return this.vfs.rename(options);
  }

  reapProcess({ pid }: { pid: number }): void {
    const process = this.processes.get(pid);
    if (process === undefined) {
      return;
    }
    switch (process.state) {
    case 'terminated':
    case 'zombie':
      this.processes.delete(pid);
      return;
    case 'running':
    case 'stopped':
      throw new Error(`Cannot reap live process: ${pid}`);
    default: {
      const _ex: never = process.state;
      throw new Error(`Unhandled process state: ${_ex}`);
    }
    }
  }

  getProcess({ pid }: { pid: number }): WeshProcess | undefined {
    return this.processes.get(pid);
  }

  getProcessesByGroup({ pgid }: { pgid: number }): WeshProcess[] {
    return Array.from(this.processes.values()).filter(proc => proc.pgid === pgid);
  }

  getProcesses(): WeshProcess[] {
    return Array.from(this.processes.values());
  }

  registerOwnedHandle({ pid, handle }: {
    pid: number,
    handle: WeshFileHandle,
  }): void {
    const proc = this.processes.get(pid);
    if (proc === undefined) {
      return;
    }
    proc.ownedHandles ??= new Set();
    proc.ownedHandles.add(handle);
  }

  unregisterOwnedHandle({ pid, handle }: {
    pid: number,
    handle: WeshFileHandle,
  }): void {
    const proc = this.processes.get(pid);
    proc?.ownedHandles?.delete(handle);
  }

  async closeProcessResources({ pid }: {
    pid: number,
  }): Promise<void> {
    const proc = this.processes.get(pid);
    if (proc === undefined) {
      return;
    }
    await this.closeProcessFileDescriptors({ proc });
  }

  private async closeProcessFileDescriptors({ proc }: {
    proc: WeshProcess,
  }): Promise<void> {
    const closedHandles = new Set<WeshFileHandle>();
    for (const handle of proc.fds.values()) {
      if (closedHandles.has(handle)) {
        continue;
      }
      closedHandles.add(handle);
      await handle.close();
    }

    for (const handle of proc.ownedHandles ?? []) {
      if (closedHandles.has(handle)) {
        continue;
      }
      closedHandles.add(handle);
      await handle.close();
    }
  }
}
