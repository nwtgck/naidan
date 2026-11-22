import type {
  WeshProcess,
  WeshFileHandle,
  WeshIVirtualFileSystem,
  WeshWriteResult,
  WeshOwnedBytes,
  WeshIOResult,
  WeshStat,
  WeshOpenFlags,
  WeshWaitStatus,
  WeshSignalDeliveryError,
  WeshProcessSignalDisposition,
  WeshFileHandleCloseSemantics,
  WeshEntryRef,
  WeshFinalSymlinkTreatment,
} from './types';
import { WeshBrokenPipeError, weshWaitStatusToExitCode } from './types';
import { WeshHandleCloseSignal } from './utils/closeSignal';
import { acquireFileInputBuffer, duplicateFileReference, fileInputBuffer, OPEN_FILE_DESCRIPTION, openFileDescription, type WeshShellInput } from './utils/file-input';
import { closeFileHandleReferences } from './utils/fs';

const PIPE_BUFFER_LIMIT_BYTES = 64 * 1024;
const MAX_TIMER_DELAY_MS = 2_147_483_647;

abstract class WeshKernelProcessFileHandle implements WeshFileHandle {
  protected readonly state: {
    handle: WeshFileHandle,
    refCount: number,
    description: object,
  };
  protected readonly kernel: WeshKernel;
  protected readonly pid: number;
  protected readonly onBrokenPipe: (() => void) | undefined;
  private readonly process: WeshProcess | undefined;
  private closed = false;
  private closing: Promise<void> | undefined;
  private refillWaitCloseSignal: WeshHandleCloseSignal | undefined;

  constructor({
    handle,
    kernel,
    pid,
    onBrokenPipe,
  }: {
    handle: WeshFileHandle,
    kernel: WeshKernel,
    pid: number,
    onBrokenPipe: (() => void) | undefined,
  }) {
    this.state = handle instanceof WeshKernelProcessFileHandle
      ? handle.state
      : {
        handle,
        refCount: 1,
        description: openFileDescription({ handle }),
      };
    if (handle instanceof WeshKernelProcessFileHandle) {
      this.state.refCount += 1;
    }
    this.kernel = kernel;
    this.pid = pid;
    this.process = kernel.getProcess({ pid });
    this.onBrokenPipe = onBrokenPipe;
  }

  get [OPEN_FILE_DESCRIPTION](): object {
    return this.state.description;
  }

  protected get isOpen(): boolean {
    return !this.closed && this.process?.waitStatus === undefined;
  }

  protected async writeWithBrokenPipeHandling({ operation }: {
    operation: Promise<WeshWriteResult>,
  }): Promise<WeshWriteResult> {
    try {
      return await operation;
    } catch (error: unknown) {
      if (error instanceof WeshBrokenPipeError) {
        await this.signalBrokenPipe();
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
        await this.signalBrokenPipe();
        return;
      }
      throw error;
    }
  }

  private async signalBrokenPipe(): Promise<void> {
    if (this.onBrokenPipe === undefined) {
      await this.kernel.kill({ pid: this.pid, signal: 13 });
    } else {
      this.onBrokenPipe();
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
      await this.closing;
      return;
    }
    this.closed = true;
    this.refillWaitCloseSignal?.close();
    this.onClose();
    this.state.refCount -= 1;
    try {
      if (this.state.refCount === 0) {
        this.closing = this.state.handle.close();
        await this.closing;
      }
    } finally {
      this.closing = undefined;
      this.kernel.unregisterOwnedHandle({ pid: this.pid, handle: this });
    }
  }

  async stat(): Promise<WeshStat> {
    if (!this.isOpen) {
      throw new DOMException('File is closed', 'InvalidStateError');
    }
    return this.state.handle.stat();
  }

  async truncate({ size }: { size: number }): Promise<void> {
    if (!this.isOpen) {
      throw new DOMException('File is closed', 'InvalidStateError');
    }
    const options = { size };
    await this.state.handle.truncate(options);
  }

  async ioctl({ request, arg }: { request: number, arg?: unknown }): Promise<{ ret: number }> {
    if (!this.isOpen) {
      throw new DOMException('File is closed', 'InvalidStateError');
    }
    const options = { request, arg };
    return this.state.handle.ioctl(options);
  }

  protected onClose(): void {}

  duplicateOpenFile(): WeshFileHandle {
    return this.state.handle.cloneReference === undefined
      ? this
      : duplicateFileReference({ handle: this.state.handle });
  }

  read({ buffer, offset, length, position }: {
    buffer: Uint8Array,
    offset?: number,
    length?: number,
    position?: number,
  }): Promise<WeshIOResult> {
    if (!this.isOpen) {
      return Promise.resolve({ bytesRead: 0 });
    }
    const options = { buffer, offset, length, position };
    const input = position === undefined ? fileInputBuffer({ description: this.state.description }) : undefined;
    if (input === undefined) {
      return this.readUnbuffered(options);
    }
    const start = offset ?? 0;
    const size = length ?? (buffer.length - start);
    if (size <= 0) {
      return this.readUnbuffered(options);
    }
    const bytesRead = input.read({ buffer, offset: start, length: size });
    if (bytesRead > 0) {
      return Promise.resolve({ bytesRead });
    }
    const refill = input.pendingRefill;
    if (refill === undefined) {
      return this.readUnbuffered(options);
    }
    const closeSignal = this.refillWaitCloseSignal ??= new WeshHandleCloseSignal();
    const handle = this.state.handle;
    const release = handle instanceof PipeHandle ? handle.observeWait?.() : undefined;
    const waiting = closeSignal.raceWithClose({ operation: refill, buildClosedResult: () => 'cancelled' as const });
    return (release === undefined ? waiting : waiting.finally(release)).then(() => this.read(options));
  }

  abstract readUnbuffered({ buffer, offset, length, position }: {
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
  async readUnbuffered({ buffer, offset, length, position }: {
    buffer: Uint8Array,
    offset?: number,
    length?: number,
    position?: number,
  }): Promise<WeshIOResult> {
    if (!this.isOpen) {
      return { bytesRead: 0 };
    }
    const options = { buffer, offset, length, position };
    return this.state.handle.read(options);
  }

  async write({ buffer, offset, length, position }: {
    buffer: Uint8Array,
    offset?: number,
    length?: number,
    position?: number,
  }): Promise<WeshWriteResult> {
    if (!this.isOpen) {
      return { bytesWritten: 0 };
    }
    const options = { buffer, offset, length, position };
    return this.writeWithBrokenPipeHandling({
      operation: this.state.handle.write(options),
    });
  }

  async writeOwned({ chunk }: { chunk: WeshOwnedBytes }): Promise<void> {
    if (!this.isOpen) {
      return;
    }
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
      onBrokenPipe: this.onBrokenPipe,
    });
  }

  getCloseSemantics(): WeshFileHandleCloseSemantics {
    return 'hard';
  }
}

class WeshKernelSoftProcessFileHandle extends WeshKernelProcessFileHandle {
  private readonly closeSignal = new WeshHandleCloseSignal();

  async readUnbuffered({ buffer, offset, length, position }: {
    buffer: Uint8Array,
    offset?: number,
    length?: number,
    position?: number,
  }): Promise<WeshIOResult> {
    if (!this.isOpen) {
      return { bytesRead: 0 };
    }
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
    if (!this.isOpen) {
      return { bytesWritten: 0 };
    }
    const options = { buffer, offset, length, position };
    return this.writeWithBrokenPipeHandling({
      operation: this.closeSignal.raceWithClose({
        operation: this.state.handle.write(options),
        buildClosedResult: () => ({ bytesWritten: 0 }),
      }),
    });
  }

  async writeOwned({ chunk }: { chunk: WeshOwnedBytes }): Promise<void> {
    if (!this.isOpen) {
      return;
    }
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
      onBrokenPipe: this.onBrokenPipe,
    });
  }

  getCloseSemantics(): WeshFileHandleCloseSemantics {
    return 'soft';
  }

  protected override onClose(): void {
    this.closeSignal.close();
  }
}

function createWeshKernelProcessFileHandle({ handle, kernel, pid, onBrokenPipe }: {
  handle: WeshFileHandle,
  kernel: WeshKernel,
  pid: number,
  onBrokenPipe: (() => void) | undefined,
}): WeshKernelProcessFileHandle {
  const options = { handle, kernel, pid, onBrokenPipe };
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

export interface WeshPipeEnd extends WeshFileHandle {
  hasOpenReferences(): boolean,
}

class PipeHandle implements WeshPipeEnd {
  readonly [OPEN_FILE_DESCRIPTION]: object;
  observeWait?: () => () => void;
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

  constructor({ state, mode, description }: {
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
    description?: object,
  }) {
    this.state = state;
    this.mode = mode;
    this[OPEN_FILE_DESCRIPTION] = description ?? this;
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
      if (this.closed || this.state.writeRefCount <= 0) {
        return { bytesRead: 0 };
      }
      const release = this.observeWait?.();
      try {
        await new Promise<void>(resolve => this.state.readWaiters.push(resolve));
      } finally {
        release?.();
      }
    }
    if (this.closed) {
      return { bytesRead: 0 };
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
        const release = this.observeWait?.();
        try {
          await new Promise<void>(resolve => this.state.writeWaiters.push(resolve));
        } finally {
          release?.();
        }
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
      ino: 0,
      uid: 0,
      gid: 0,
    };
  }

  async truncate(): Promise<void> {}

  async ioctl(): Promise<{ ret: number }> {
    return { ret: 0 };
  }

  getCloseSemantics(): WeshFileHandleCloseSemantics {
    return 'hard';
  }

  hasOpenReferences(): boolean {
    switch (this.mode) {
    case 'r':
      return this.state.readRefCount > 0;
    case 'w':
      return this.state.writeRefCount > 0;
    default: {
      const _ex: never = this.mode;
      throw new Error(`Unhandled mode: ${_ex}`);
    }
    }
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
    return new PipeHandle({ state: this.state, mode: this.mode, description: this[OPEN_FILE_DESCRIPTION] });
  }
}

interface WeshProcessSubstitutionPeer {
  readonly pid: number,
  readonly foregroundSignal: AbortSignal | undefined,
}

interface WeshProcessSubstitutionWait {
  readonly pid: number,
  readonly foregroundSignal: AbortSignal | undefined,
  readonly peer: WeshProcessSubstitutionPeer,
}

type WeshSignalStatus = Extract<WeshWaitStatus, { kind: 'signaled' }>;

export interface WeshProcessSignalHandler {
  catchSignal({ signal }: { signal: number }): boolean,
  terminate({ waitStatus }: { waitStatus: WeshSignalStatus }): boolean,
}

export class WeshKernel {
  private processes: Map<number, WeshProcess> = new Map();
  private readonly signalWaiters = new WeakMap<WeshProcess, Set<({ status }: { status: WeshWaitStatus }) => void>>();
  private readonly signalHandlers = new WeakMap<WeshProcess, WeshProcessSignalHandler>();
  private readonly closingProcessResources = new WeakMap<WeshProcess, Promise<void>>();
  private readonly processCloseFailures = new WeakMap<WeshProcess, { error: unknown }>();
  private readonly backgroundJobs = new WeakSet<WeshProcess>();
  private backgroundProcessGroups?: Map<number, number>;
  private processSubstitutionPeers?: WeakMap<object, WeshProcessSubstitutionPeer>;
  private processSubstitutionWaits?: Set<WeshProcessSubstitutionWait>;
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
      image: 'init',
      args: ['init'],
      fds: new Map(),
    });
    this.nextPid = 2;
  }

  async spawn({ image, args, env, cwd, fds, ppid, pgid, signalDispositions, foregroundSignal, backgroundJob, onSpawn }: {
    image: string,
    args: string[],
    env?: Iterable<readonly [string, string]>,
    cwd?: string,
    fds?: Map<number, WeshFileHandle>,
    ppid?: number,
    pgid?: number,
    signalDispositions?: Map<number, WeshProcessSignalDisposition>,
    foregroundSignal?: AbortSignal,
    backgroundJob?: true,
    onSpawn?: ({ process }: { process: WeshProcess }) => void,
  }): Promise<{ pid: number, process: WeshProcess }> {
    const pid = this.nextPid++;
    const process: WeshProcess = {
      pid,
      ppid: ppid ?? 1,
      pgid: pgid ?? pid,
      state: 'running',
      pendingSignals: [],
      signalDispositions: signalDispositions ? new Map(signalDispositions) : new Map(),
      foregroundSignal,
      ownedHandles: new Set(),
      env: new Map(env),
      cwd: cwd || '/',
      image,
      args: args,
      fds: fds ? new Map(fds) : new Map(),
    };

    if (backgroundJob === true) {
      this.backgroundJobs.add(process);
      if (process.pgid === pid) {
        (this.backgroundProcessGroups ??= new Map()).set(process.pgid, 0);
      }
    }
    const backgroundGroups = this.backgroundProcessGroups;
    const groupMembers = backgroundGroups?.get(process.pgid);
    if (backgroundGroups !== undefined && groupMembers !== undefined) {
      backgroundGroups.set(process.pgid, groupMembers + 1);
    }
    this.processes.set(pid, process);
    onSpawn?.({ process });
    return { pid, process };
  }

  async kill({ pid, signal }: { pid: number, signal: number }): Promise<void> {
    const proc = this.processes.get(pid);
    if (!proc) {
      return;
    }
    await this.deliverSignal({ proc, waitStatus: Object.freeze({ kind: 'signaled', signal }) });
  }

  sendSignal({ sender, target, signal, deferSelf }: {
    sender: WeshProcess,
    target: number,
    signal: number,
    deferSelf: (({ signal, deliver }: {
      signal: number,
      deliver: ({ handler }: { handler: WeshProcessSignalHandler | undefined }) => void,
    }) => void) | undefined,
  }): WeshSignalDeliveryError | undefined {
    if (this.processes.get(sender.pid) !== sender || sender.state !== 'running') {
      return 'interrupted';
    }
    if (target === -1 || signal === 19 || signal === 20 || signal === 21 || signal === 22) {
      return 'unsupported';
    }
    const process = target > 0 ? this.processes.get(target) : undefined;
    const recipients = target > 0 ? (process === undefined ? [] : [process])
      : this.getProcessesByGroup({ pgid: target === 0 ? sender.pgid : -target });
    if (recipients.length === 0) {
      return 'no-such-process';
    }
    if (signal === 0) {
      return undefined;
    }
    if (recipients.every(proc => proc.pid === 1)) {
      return 'not-permitted';
    }
    const waitStatus = Object.freeze({ kind: 'signaled', signal });
    for (const proc of recipients) {
      if (proc.pid === 1) {
        continue;
      }
      const deliver = ({ handler }: { handler: WeshProcessSignalHandler | undefined }) => {
        // The receiver owns descriptor cleanup and its result.
        void this.deliverSignal({ proc, waitStatus, handler })?.catch(() => {});
      };
      if (proc === sender && deferSelf !== undefined) {
        deferSelf({ signal, deliver });
      } else {
        deliver({ handler: undefined });
      }
    }
    return undefined;
  }

  setSignalHandler({ process, handle }: { process: WeshProcess, handle: WeshProcessSignalHandler | undefined }): void {
    if (handle === undefined) {
      this.signalHandlers.delete(process);
    } else {
      this.signalHandlers.set(process, handle);
    }
  }

  private deliverSignal({ proc, waitStatus, handler }: {
    proc: WeshProcess,
    waitStatus: WeshSignalStatus,
    handler?: WeshProcessSignalHandler,
  }): Promise<void> | undefined {
    const { signal } = waitStatus;
    if (signal === 0 || proc.state === 'terminated' || proc.state === 'zombie') {
      return;
    }
    const receiver = handler ?? this.signalHandlers.get(proc);
    if (signal !== 9 && signal !== 19) {
      const disposition = proc.signalDispositions?.get(signal);
      if (disposition === 'ignore' || receiver?.catchSignal({ signal }) === true) {
        return;
      }
    }
    switch (signal) {
    case 17: // CHLD
    case 18: // CONT has no effect on a running process.
    case 23: // URG
    case 28: // WINCH
      return;
    }

    if (receiver?.terminate({ waitStatus }) === true) {
      return;
    }
    return this.terminateProcess({ proc, waitStatus });
  }

  private async terminateProcess({ proc, waitStatus }: {
    proc: WeshProcess,
    waitStatus: Extract<WeshWaitStatus, { kind: 'signaled' }>,
  }): Promise<void> {
    if (proc.state === 'terminated' || proc.state === 'zombie') {
      return;
    }
    const { signal } = waitStatus;
    proc.pendingSignals ??= [];
    proc.pendingSignals.push(signal);
    proc.terminationStatus = waitStatus;
    this.recordWaitStatus({ process: proc, waitStatus });
    await this.closeProcessFileDescriptors({
      proc,
    });
  }

  recordWaitStatus({ process, waitStatus }: {
    process: WeshProcess,
    waitStatus: WeshWaitStatus,
  }): void {
    switch (waitStatus.kind) {
    case 'exited':
    case 'signaled':
      process.state = 'terminated';
      break;
    case 'stopped':
      process.state = 'stopped';
      break;
    default: {
      const _ex: never = waitStatus;
      throw new Error(`Unhandled wait status: ${JSON.stringify(_ex)}`);
    }
    }
    process.waitStatus = waitStatus;
    process.exitCode = weshWaitStatusToExitCode({ waitStatus });
    // Wake the body so it can unwind while the kernel closes descriptors.
    const waiters = this.signalWaiters.get(process);
    if (waiters !== undefined) {
      for (const notify of waiters) {
        notify({ status: waitStatus });
      }
    }
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

  subscribeWaitStatus({ process, notify }: {
    process: WeshProcess,
    notify({ status }: { status: WeshWaitStatus }): void,
  }): () => void {
    const waiters = this.signalWaiters.get(process) ?? new Set();
    waiters.add(notify);
    this.signalWaiters.set(process, waiters);
    return () => {
      if (waiters.delete(notify) && waiters.size === 0) {
        this.signalWaiters.delete(process);
      }
    };
  }

  async waitForSignalOrTimeout({ pid, timeoutMs }: { pid: number, timeoutMs: number }): Promise<WeshWaitStatus | undefined> {
    const process = this.processes.get(pid);
    if (process === undefined || !(timeoutMs > 0)) {
      return process?.waitStatus;
    }
    if (process.waitStatus !== undefined) {
      this.consumePendingSignals({ pid });
      return process.waitStatus;
    }

    const { promise, resolve } = Promise.withResolvers<WeshWaitStatus | undefined>();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = ({ status }: { status: WeshWaitStatus | undefined }) => {
      if (timer !== undefined) {
        clearTimeout(timer);
      }
      unsubscribe();
      resolve(status);
    };
    const unsubscribe = this.subscribeWaitStatus({ process, notify: finish });
    if (Number.isFinite(timeoutMs)) {
      const deadline = performance.now() + timeoutMs;
      const armTimer = () => {
        const remaining = deadline - performance.now();
        if (remaining <= 0) {
          finish({ status: undefined });
          return;
        }
        timer = setTimeout(armTimer, Math.min(MAX_TIMER_DELAY_MS, Math.ceil(remaining)));
      };
      armTimer();
    }
    const status = await promise;
    if (status !== undefined) {
      this.consumePendingSignals({ pid });
    }
    return status;
  }

  async killProcessGroups({ pgids, signal, excludedPids }: {
    pgids: ReadonlySet<number>,
    signal: number,
    excludedPids?: number[],
  }): Promise<void> {
    const excluded = new Set(excludedPids);
    const targets = this.getProcesses().filter(proc => pgids.has(proc.pgid) && !excluded.has(proc.pid));
    // All recipients observe the same delivery from this group operation.
    const waitStatus = Object.freeze({ kind: 'signaled', signal });
    await Promise.all(targets.map(proc => this.deliverSignal({ proc, waitStatus })));
  }

  async interruptInputProcesses({ pids, foregroundSignals }: {
    pids: Set<number>,
    foregroundSignals: ReadonlySet<AbortSignal>,
  }): Promise<void> {
    this.includeWaitingProcessSubstitutions({ pids, foregroundSignals });
    const waitStatus = Object.freeze({ kind: 'signaled', signal: 2 });
    const deliveries: Promise<void>[] = [];
    for (const pid of pids) {
      const proc = this.processes.get(pid);
      if (proc !== undefined) {
        deliveries.push(this.terminateProcess({ proc, waitStatus }));
      }
    }
    await Promise.all(deliveries);
  }

  private includeWaitingProcessSubstitutions({ pids, foregroundSignals }: {
    pids: Set<number>,
    foregroundSignals: ReadonlySet<AbortSignal>,
  }): void {
    if (!this.processSubstitutionWaits?.size) {
      return;
    }
    const waitersByPeer = new Map<WeshProcessSubstitutionPeer, WeshProcessSubstitutionWait[]>();
    for (const wait of this.processSubstitutionWaits) {
      const process = this.processes.get(wait.pid);
      const signal = wait.foregroundSignal;
      if (process === undefined || process.waitStatus !== undefined
        || (signal?.aborted === true && !foregroundSignals.has(signal))) {
        continue;
      }
      const waiters = waitersByPeer.get(wait.peer);
      if (waiters === undefined) {
        waitersByPeer.set(wait.peer, [wait]);
      } else {
        waiters.push(wait);
      }
    }
    let childrenByParent: Map<number, WeshProcess[]> | undefined;
    let added: boolean;
    do {
      added = false;
      for (const [peer, waiters] of waitersByPeer) {
        if (!waiters.every(({ pid, foregroundSignal }) => pids.has(pid)
          || (foregroundSignal !== undefined && foregroundSignals.has(foregroundSignal)))) {
          continue;
        }
        waitersByPeer.delete(peer);
        if (childrenByParent === undefined) {
          childrenByParent = new Map();
          for (const child of this.processes.values()) {
            const children = childrenByParent.get(child.ppid);
            if (children === undefined) {
              childrenByParent.set(child.ppid, [child]);
            } else {
              children.push(child);
            }
          }
        }
        // A pipeline in the substitution may have a different PGID and can
        // still own the other pipe end after the substitution shell exits.
        const subtree = [peer.pid];
        for (const pid of subtree) {
          pids.add(pid);
          for (const child of childrenByParent.get(pid) ?? []) {
            if (child.foregroundSignal === peer.foregroundSignal && !this.backgroundJobs.has(child)) {
              subtree.push(child.pid);
            }
          }
        }
        added = true;
      }
    } while (added && waitersByPeer.size !== 0);
  }

  registerProcessSubstitutionPipe({ handle, peerPid }: { handle: WeshPipeEnd, peerPid: number }): void {
    const peers = this.processSubstitutionPeers ??= new WeakMap();
    peers.set(openFileDescription({ handle }), { pid: peerPid, foregroundSignal: this.processes.get(peerPid)?.foregroundSignal });
  }

  private observeProcessSubstitutionWait({ handle, pid, foregroundSignal }: {
    handle: WeshFileHandle,
    pid: number,
    foregroundSignal: AbortSignal | undefined,
  }): void {
    if (!(handle instanceof PipeHandle)) {
      return;
    }
    const peer = this.processSubstitutionPeers?.get(handle[OPEN_FILE_DESCRIPTION]);
    if (peer === undefined) {
      return;
    }
    handle.observeWait = () => {
      const wait: WeshProcessSubstitutionWait = { pid, foregroundSignal, peer };
      const waits = this.processSubstitutionWaits ??= new Set();
      waits.add(wait);
      return () => {
        waits.delete(wait);
      };
    };
  }

  bindFileHandle({ pid, handle, trackOwnership, foregroundSignal }: {
    pid: number,
    handle: WeshFileHandle,
    trackOwnership: boolean,
    foregroundSignal?: AbortSignal,
  }): WeshFileHandle {
    if (this.processSubstitutionPeers !== undefined && handle instanceof PipeHandle) {
      this.observeProcessSubstitutionWait({ handle, pid, foregroundSignal: foregroundSignal ?? this.processes.get(pid)?.foregroundSignal });
    }
    const boundHandle = createWeshKernelProcessFileHandle({
      handle: handle,
      kernel: this,
      pid: pid,
      onBrokenPipe: undefined,
    });
    if (trackOwnership) {
      this.registerOwnedHandle({
        pid: pid,
        handle: boundHandle,
      });
    }
    return boundHandle;
  }

  bindShellFileDescriptor({ pid, handle, onBrokenPipe, foregroundSignal }: {
    pid: number,
    handle: WeshFileHandle,
    onBrokenPipe: () => void,
    foregroundSignal: AbortSignal | undefined,
  }): WeshFileHandle {
    const duplicate = this.duplicateFileDescriptor({ handle });
    this.observeProcessSubstitutionWait({ handle: duplicate, pid, foregroundSignal });
    const reference = createWeshKernelProcessFileHandle({
      pid,
      kernel: this,
      handle: duplicate,
      onBrokenPipe,
    });
    this.registerOwnedHandle({ pid, handle: reference });
    return reference;
  }

  bindFdTable({ pid, fdTable }: {
    pid: number,
    fdTable: ReadonlyMap<number, WeshFileHandle>,
  }): Map<number, WeshFileHandle> {
    return new Map(
      Array.from(fdTable.entries()).map(([fd, handle]) => [
        fd,
        this.bindFileHandle({
          pid: pid,
          handle: this.duplicateFileDescriptor({ handle }),
          trackOwnership: false,
        }),
      ]),
    );
  }

  async pipe(): Promise<{ read: WeshPipeEnd, write: WeshPipeEnd }> {
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

  duplicateFileDescriptor({ handle }: {
    handle: WeshFileHandle,
  }): WeshFileHandle {
    if (handle instanceof WeshKernelProcessFileHandle) {
      return handle.duplicateOpenFile();
    }
    return duplicateFileReference({ handle });
  }

  openInputForShell({ pid, handle, foregroundSignal }: {
    pid: number,
    handle: WeshFileHandle,
    foregroundSignal: AbortSignal | undefined,
  }): WeshShellInput & { close: () => Promise<void> } {
    const proc = this.getProcess({ pid });
    const duplicate = this.duplicateFileDescriptor({ handle });
    const reference = duplicate === handle ? handle : this.bindFileHandle({
      pid,
      handle: duplicate,
      trackOwnership: true,
      foregroundSignal,
    });
    const buffer = acquireFileInputBuffer({ handle });
    let closed = false;
    const isClosed = () => closed || proc?.waitStatus !== undefined;
    const observeWait = duplicate instanceof PipeHandle ? duplicate.observeWait : undefined;
    let refillWaitCloseSignal: WeshHandleCloseSignal | undefined;
    const waitForRefill: WeshShellInput['waitForRefill'] = observeWait === undefined ? undefined : ({ operation }) => {
      const closeSignal = refillWaitCloseSignal ??= new WeshHandleCloseSignal();
      const release = observeWait();
      return closeSignal.raceWithClose({ operation, buildClosedResult: () => 'cancelled' as const }).finally(release);
    };
    return {
      buffer,
      read: ({ buffer, offset, length, position }) => {
        if (isClosed()) {
          return Promise.resolve({ bytesRead: 0 });
        }
        const options = { buffer, offset, length, position };
        return reference instanceof WeshKernelProcessFileHandle ? reference.readUnbuffered(options) : reference.read(options);
      },
      isClosed,
      waitForRefill,
      close: () => {
        if (closed) {
          return Promise.resolve();
        }
        closed = true;
        refillWaitCloseSignal?.close();
        buffer.detachReader();
        return duplicate === handle ? Promise.resolve() : reference.close();
      },
    };
  }

  open({ path, flags, mode, checkActive }: { path: string, flags: WeshOpenFlags, mode?: number, checkActive?: () => void }): Promise<WeshFileHandle> {
    return this.vfs.open({ path, flags, mode, checkActive });
  }

  createTemporaryFile: WeshIVirtualFileSystem['createTemporaryFile'] = ({ path, siblingOf, checkActive }) =>
    this.vfs.createTemporaryFile({ path, siblingOf, checkActive });

  createTemporarySymlink: WeshIVirtualFileSystem['createTemporarySymlink'] = ({ path, targetPath, mode, siblingOf, checkActive }) =>
    this.vfs.createTemporarySymlink({ path, targetPath, mode, siblingOf, checkActive });

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

  tryReadBlobEfficiently: WeshIVirtualFileSystem['tryReadBlobEfficiently'] = ({ path, entry }) =>
    this.vfs.tryReadBlobEfficiently(entry === undefined ? { path } : { entry });

  tryCreateFileWriterEfficiently: WeshIVirtualFileSystem['tryCreateFileWriterEfficiently'] = ({ path, lookup, expected, mode, sharedOutput, checkActive }) =>
    this.vfs.tryCreateFileWriterEfficiently(lookup === undefined ? { path, expected, mode, sharedOutput, checkActive } : { lookup, mode, checkActive });

  readDir: WeshIVirtualFileSystem['readDir'] = ({ path, checkActive }) => this.vfs.readDir({ path, checkActive });

  getReadOnlyForPath: WeshIVirtualFileSystem['getReadOnlyForPath'] = ({ path }) => this.vfs.getReadOnlyForPath({ path });

  async resolveEntry({
    path,
    finalSymlinkTreatment,
    pinBacking,
  }: {
    path: string,
    finalSymlinkTreatment: WeshFinalSymlinkTreatment,
    pinBacking?: true,
  }): Promise<WeshEntryRef> {
    return this.vfs.resolveEntry({ path, finalSymlinkTreatment, pinBacking });
  }

  tryLookupEntryWithoutFollowingSymlinks: WeshIVirtualFileSystem['tryLookupEntryWithoutFollowingSymlinks'] = ({ path, checkActive }) =>
    this.vfs.tryLookupEntryWithoutFollowingSymlinks({ path, checkActive });

  readDirEntry: WeshIVirtualFileSystem['readDirEntry'] = ({ entry, checkActive }) => this.vfs.readDirEntry({ entry, checkActive });

  async statEntry({ entry }: { entry: WeshEntryRef }): Promise<WeshStat> {
    return this.vfs.statEntry({ entry });
  }

  openEntry: WeshIVirtualFileSystem['openEntry'] = ({ entry, flags, mode, checkActive }) =>
    this.vfs.openEntry({ entry, flags, mode, checkActive });

  async readlinkEntry({
    entry,
  }: {
    entry: WeshEntryRef<'symlink'>,
  }): Promise<string> {
    return this.vfs.readlinkEntry({ entry });
  }

  mkdir: WeshIVirtualFileSystem['mkdir'] = ({ path, mode, recursive, symlinkTreatment, onCreate, checkActive }) => this.vfs.mkdir({ path, mode, recursive, symlinkTreatment, onCreate, checkActive });
  symlink: WeshIVirtualFileSystem['symlink'] = ({ path, targetPath, mode, expected, checkActive }) => this.vfs.symlink({ path, targetPath, mode, expected, checkActive });
  mknod: WeshIVirtualFileSystem['mknod'] = ({ path, type, mode, checkActive }) => this.vfs.mknod({ path, type, mode, checkActive });
  unlink: WeshIVirtualFileSystem['unlink'] = ({ path, expected, checkActive }) => this.vfs.unlink({ path, expected, checkActive });
  rmdir: WeshIVirtualFileSystem['rmdir'] = ({ path, checkActive }) => this.vfs.rmdir({ path, checkActive });
  rename: WeshIVirtualFileSystem['rename'] = ({ oldPath, newPath, expectedSource, expectedDestination, noReplace, checkActive }) =>
    this.vfs.rename({ oldPath, newPath, expectedSource, expectedDestination, noReplace, checkActive });
  publishEntries: WeshIVirtualFileSystem['publishEntries'] = ({ changes, checkActive }) => this.vfs.publishEntries({ changes, checkActive });

  replaceEntry: WeshIVirtualFileSystem['replaceEntry'] = ({ entry, path, expected, backupPath, expectedBackup, checkActive }) =>
    this.vfs.replaceEntry({ entry, path, expected, backupPath, expectedBackup, checkActive });

  compareEntryIdentity: WeshIVirtualFileSystem['compareEntryIdentity'] = ({ first, second }) => this.vfs.compareEntryIdentity({ first, second });

  reapProcess({ pid }: { pid: number }): void {
    const process = this.processes.get(pid);
    if (process === undefined) {
      return;
    }
    if (this.closingProcessResources.has(process)) {
      throw new Error(`Cannot reap process during descriptor cleanup: ${pid}`);
    }
    switch (process.state) {
    case 'terminated':
    case 'zombie':
      this.processes.delete(pid);
      if (this.backgroundProcessGroups !== undefined) {
        const members = this.backgroundProcessGroups.get(process.pgid);
        if (members === 1) {
          this.backgroundProcessGroups.delete(process.pgid);
        } else if (members !== undefined) {
          this.backgroundProcessGroups.set(process.pgid, members - 1);
        }
      }
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

  isBackgroundProcessGroup({ pgid }: { pgid: number }): boolean {
    return this.backgroundProcessGroups?.has(pgid) === true;
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
    let failure = this.processCloseFailures.get(proc);
    try {
      await this.closeProcessFileDescriptors({ proc });
    } catch (error: unknown) {
      failure ??= { error };
    }
    this.processCloseFailures.delete(proc);
    if (failure !== undefined) {
      throw failure.error;
    }
  }

  private async closeProcessFileDescriptors({ proc }: {
    proc: WeshProcess,
  }): Promise<void> {
    const pending = this.closingProcessResources.get(proc);
    if (pending !== undefined) {
      return pending;
    }
    if (proc.fds.size === 0 && !proc.ownedHandles?.size) {
      return;
    }
    const { promise, resolve, reject } = Promise.withResolvers<void>();
    this.closingProcessResources.set(proc, promise);
    try {
      const closed = new Set<WeshFileHandle>();
      let closeFailure: { error: unknown } | undefined;
      while (true) {
        const handles = [...proc.fds.values(), ...(proc.ownedHandles ?? [])]
          .filter(handle => !closed.has(handle));
        if (handles.length === 0) {
          break;
        }
        for (const handle of handles) {
          closed.add(handle);
        }
        const failure = await closeFileHandleReferences({ handles });
        closeFailure ??= failure;
        // An open accepted before the signal may acquire a handle while this
        // cleanup is waiting for another descriptor to finish closing.
      }
      if (closeFailure !== undefined) {
        throw closeFailure.error;
      }
      resolve();
    } catch (error: unknown) {
      if (!this.processCloseFailures.has(proc)) {
        this.processCloseFailures.set(proc, { error });
      }
      reject(error);
    } finally {
      this.closingProcessResources.delete(proc);
    }
    return promise;
  }
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
