import type { ChatGroupId, ChatId } from '@/01-models/ids';
import type { NaidanSysfsVisibility } from '@/01-models/naidan-sysfs';
import type { ManagedVolumeReference } from '@/01-models/volume-access';
import type { WeshShellVariables } from './shell/variables';
import type { WeshExecutionOptions } from './shell/invocation';
export type { NaidanSysfsAccessScope, NaidanSysfsVisibility } from '@/01-models/naidan-sysfs';

// --- Kernel & Process Types ---

export type WeshFileType = 'file' | 'directory' | 'fifo' | 'chardev' | 'symlink';
export type WeshSpecialFileType = Extract<WeshFileType, 'file' | 'fifo' | 'chardev'>;

export interface WeshStat {
  size: number,
  mode: number, // Unix-style mode (permissions + type)
  type: WeshFileType,
  mtime: number,
  ino: number,
  uid: number,
  gid: number,
}

export interface WeshIOResult {
  bytesRead: number,
}

export interface WeshWriteResult {
  bytesWritten: number,
}

const weshOwnedBytesBrand: unique symbol = Symbol('wesh-owned-bytes');

export interface WeshOwnedBytes {
  readonly bytes: Uint8Array,
  readonly [weshOwnedBytesBrand]: true,
}

export function createWeshOwnedBytes({ bytes }: { bytes: Uint8Array }): WeshOwnedBytes {
  return {
    bytes,
    [weshOwnedBytesBrand]: true,
  };
}

export type WeshFileHandleCloseSemantics = 'hard' | 'soft';

export class WeshBrokenPipeError extends Error {
  constructor() {
    super('Broken pipe');
    this.name = 'WeshBrokenPipeError';
  }
}

export class WeshCommandInterruptedError extends Error {
  constructor() {
    super('Command is no longer running');
    this.name = 'WeshCommandInterruptedError';
  }
}

export class WeshEntryChangedError extends Error {
  readonly path: string;

  constructor({ path, cause }: { path: string, cause?: unknown }) {
    super(`Entry changed: ${path}`, { cause });
    this.name = 'WeshEntryChangedError';
    this.path = path;
  }
}

export class WeshNotDirectoryError extends Error {
  readonly path: string;

  constructor({ path }: { path: string }) {
    super(`Not a directory: ${path}`);
    this.name = 'WeshNotDirectoryError';
    this.path = path;
  }
}

export class WeshRenameIncompleteError extends Error {
  constructor({ message, cause }: { message: string, cause: unknown }) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    super(`${message}: ${detail}`, { cause });
    this.name = 'WeshRenameIncompleteError';
  }
}

/**
 * Low-level File Handle (similar to a file descriptor in kernel)
 */
export interface WeshFileHandle {
  /**
   * Read data into a buffer (Bring Your Own Buffer)
   */
  read({ buffer, offset, length, position }: {
    buffer: Uint8Array,
    offset?: number, // Offset in the buffer to start writing at
    length?: number, // Maximum number of bytes to read
    position?: number, // File position (seek). If undefined, use current cursor.
  }): Promise<WeshIOResult>,

  /**
   * Write data from a buffer
   */
  write({ buffer, offset, length, position }: {
    buffer: Uint8Array,
    offset?: number, // Offset in the buffer to start reading from
    length?: number, // Number of bytes to write
    position?: number, // File position (seek). If undefined, use current cursor.
  }): Promise<WeshWriteResult>,

  /**
   * Transfer ownership of a complete byte chunk to the handle. Callers must not
   * mutate the underlying bytes after invoking this method.
   */
  writeOwned?({ chunk }: { chunk: WeshOwnedBytes }): Promise<void>,

  close(): Promise<void>,

  stat(): Promise<WeshStat>,

  truncate({ size }: { size: number }): Promise<void>,

  /**
   * Control device/handle specific operations (e.g. terminal size, blocking mode)
   */
  ioctl({ request, arg }: { request: number, arg?: unknown }): Promise<{ ret: number }>,

  cloneReference?(): WeshFileHandle,

  getCloseSemantics?(): WeshFileHandleCloseSemantics,
}

export type WeshWaitStatus =
  | { readonly kind: 'exited', readonly exitCode: number }
  | { readonly kind: 'signaled', readonly signal: number }
  | { readonly kind: 'stopped', readonly signal: number };

export type WeshProcessSignalDisposition = 'default' | 'ignore';

export function weshWaitStatusToExitCode({
  waitStatus,
}: {
  waitStatus: WeshWaitStatus,
}): number {
  switch (waitStatus.kind) {
  case 'exited':
    return waitStatus.exitCode;
  case 'signaled':
  case 'stopped':
    return 128 + waitStatus.signal;
  default: {
    const _ex: never = waitStatus;
    throw new Error(`Unhandled wait status: ${JSON.stringify(_ex)}`);
  }
  }
}

export interface WeshProcess {
  pid: number,
  ppid: number,
  pgid: number, // Process Group ID
  state: 'running' | 'stopped' | 'zombie' | 'terminated',
  exitCode?: number,
  terminationStatus?: Extract<WeshWaitStatus, { kind: 'signaled' }>,
  waitStatus?: WeshWaitStatus,
  pendingSignals?: number[],
  signalDispositions?: Map<number, WeshProcessSignalDisposition>,
  foregroundSignal?: AbortSignal,

  env: Map<string, string>,
  cwd: string,
  image: string,
  args: string[],

  /** File Descriptor Table: fd -> handle */
  fds: Map<number, WeshFileHandle>,
  ownedHandles?: Set<WeshFileHandle>,
}

export interface WeshProcessSnapshot {
  pid: number,
  ppid: number,
  pgid: number,
  state: WeshProcess['state'],
  user: string,
  image: string,
  argv0: string,
  args: string[],
  cwd: string,
}

// --- Virtual File System ---

/**
 * File access permissions
 */
export type WeshOpenAccess = 'read' | 'write' | 'read-write';

/**
 * File creation behavior
 * - 'always': Create new. Error if already exists.
 * - 'if-needed': Create if not exists.
 * - 'never': Do not create. Error if not exists.
 */
export type WeshOpenCreation = 'always' | 'if-needed' | 'never';

/**
 * File truncation settings
 */
export type WeshOpenTruncate = 'truncate' | 'preserve';

/**
 * File append settings
 */
export type WeshOpenAppend = 'append' | 'preserve';

export interface WeshOpenFlags {
  access: WeshOpenAccess,
  creation: WeshOpenCreation,
  truncate: WeshOpenTruncate,
  append: WeshOpenAppend,
}

export interface WeshEfficientFileWriter {
  write({ chunk }: { chunk: Uint8Array }): Promise<void>,
  close(): Promise<void>,
  abort({ reason }: { reason: unknown }): Promise<void>,
}

export interface WeshDirEntry {
  name: string,
  type: WeshFileType,
  fullPath: string,
}

declare const weshEntryRefBrand: unique symbol;

/**
 * Opaque reference to an entry already resolved by one Wesh VFS instance.
 *
 * The reference is execution-local and must not be persisted or transferred
 * across Worker/API boundaries. Commands may inspect its stable presentation
 * fields, but only the owning VFS can use the backend-specific reference.
 */
export type WeshEntryRef<
  TType extends WeshFileType = WeshFileType,
> = TType extends WeshFileType
  ? {
      readonly name: string,
      readonly type: TType,
      readonly fullPath: string,
      readonly [weshEntryRefBrand]: TType,
    }
  : never;

export type WeshFinalSymlinkTreatment = 'follow' | 'no-follow';

/** The observed leaf of a path whose ancestors were checked without following symlinks. */
export interface WeshEntryLookup {
  readonly path: string,
  readonly entry: WeshEntryRef | undefined,
  /** Stop tracking changes at this path once the lookup is no longer needed. */
  release(): void,
}

export interface WeshTemporaryEntry {
  entry: WeshEntryRef,
  /** Remove the exclusively created entry if it still occupies its original path. */
  discard(): Promise<void>,
  /** Release the observation of a staged sibling without removing it. */
  release?: () => void,
}

export interface WeshTemporaryFile extends WeshTemporaryEntry {
  handle: WeshFileHandle,
}

export interface WeshPreparedRename {
  operation: 'rename',
  entry: WeshEntryRef,
  path: string,
  expected: WeshEntryRef | undefined,
}

export type WeshEntryChange = WeshPreparedRename | { operation: 'unlink', entry: WeshEntryRef };

export interface WeshIVirtualFileSystem {
  hasPendingFilePublications(): boolean,
  mount({ path, handle, readOnly }: { path: string, handle: FileSystemDirectoryHandle, readOnly?: boolean }): Promise<void>,
  mountVirtual({
    path,
    readOnly,
    provider,
  }: {
    path: string,
    readOnly: boolean,
    provider: WeshVirtualMountProvider,
  }): void,
  unmount({ path }: { path: string }): Promise<void>,

  /**
   * Open a file by path.
   * Handles translation of VFS paths to handles.
   */
  open({ path, flags, mode, checkActive }: { path: string, flags: WeshOpenFlags, mode?: number, checkActive?: () => void }): Promise<WeshFileHandle>,
  createTemporaryFile({ path, siblingOf, checkActive }: { path: string, siblingOf?: WeshEntryLookup, checkActive?: () => void }): Promise<WeshTemporaryFile>,
  createTemporarySymlink({ path, targetPath, mode, siblingOf, checkActive }: { path: string, targetPath: string, mode?: number, siblingOf?: WeshEntryLookup, checkActive?: () => void }): Promise<WeshTemporaryEntry>,

  stat({ path }: { path: string }): Promise<WeshStat>,
  lstat({ path }: { path: string }): Promise<WeshStat>,
  readlink({ path }: { path: string }): Promise<string>,

  resolve({ path }: { path: string }): Promise<{ fullPath: string, stat: WeshStat }>,

  tryReadBlobEfficiently({ path, entry }: {
    path: string, entry?: never,
  } | {
    path?: never, entry: WeshEntryRef,
  }): Promise<WeshEfficientBlobReadResult>,
  tryCreateFileWriterEfficiently({ path, lookup, expected, mode, sharedOutput, checkActive }: {
    path: string, lookup?: never, expected?: WeshEntryRef<'file'>, mode: 'truncate' | 'append', sharedOutput?: WeshFileHandle, checkActive?: () => void,
  } | {
    path?: never, lookup: WeshEntryLookup, expected?: never, mode: 'truncate' | 'append', sharedOutput?: never, checkActive?: () => void,
  }): Promise<WeshEfficientFileWriteResult>,

  readDir({ path, checkActive }: { path: string, checkActive?: () => void }): AsyncIterable<WeshDirEntry>,

  /** Request pinBacking when a later mutation must match the backing of a registry entry. */
  resolveEntry({
    path,
    finalSymlinkTreatment,
    pinBacking,
  }: {
    path: string,
    finalSymlinkTreatment: WeshFinalSymlinkTreatment,
    pinBacking?: true,
  }): Promise<WeshEntryRef>,
  /** Check a path without following symlinks. Undefined means no observation was established. */
  tryLookupEntryWithoutFollowingSymlinks({ path, checkActive }: { path: string, checkActive?: () => void }): Promise<WeshEntryLookup | undefined>,
  compareEntryIdentity({ first, second }: { first: WeshEntryRef, second: WeshEntryRef }): Promise<'same' | 'shared-backing' | 'different' | 'unknown'>,
  readDirEntry({
    entry,
    checkActive,
  }: {
    entry: WeshEntryRef<'directory'>,
    checkActive?: () => void,
  }): AsyncIterable<WeshEntryRef>,
  statEntry({ entry }: { entry: WeshEntryRef }): Promise<WeshStat>,
  openEntry({
    entry,
    flags,
    mode,
    checkActive,
  }: {
    entry: WeshEntryRef,
    flags: WeshOpenFlags,
    mode?: number,
    checkActive?: () => void,
  }): Promise<WeshFileHandle>,
  readlinkEntry({ entry }: { entry: WeshEntryRef<'symlink'> }): Promise<string>,

  mkdir({ path, mode, recursive, symlinkTreatment, onCreate, checkActive }: { path: string, mode?: number, recursive?: boolean, symlinkTreatment?: 'no-follow', onCreate?: ({ path }: { path: string }) => Promise<void>, checkActive?: () => void }): Promise<void>,

  symlink({ path, targetPath, mode, expected, checkActive }: { path: string, targetPath: string, mode?: number, expected?: WeshEntryLookup, checkActive?: () => void }): Promise<void>,

  /** Verify the entry to remove and any entry that must survive the removal. */
  unlink({ path, expected, checkActive }: {
    path: string,
    expected?: { entry: WeshEntryRef, retainedEntries?: readonly WeshEntryRef[] },
    checkActive?: () => void,
  }): Promise<void>,
  rmdir({ path, checkActive }: { path: string, checkActive?: () => void }): Promise<void>,
  mknod({ path, type, mode, checkActive }: { path: string, type: WeshFileType, mode?: number, checkActive?: () => void }): Promise<void>,
  rename({ oldPath, newPath, expectedSource, expectedDestination, noReplace, checkActive }: {
    oldPath: string,
    newPath: string,
    expectedSource?: WeshEntryRef,
    expectedDestination?: WeshEntryRef,
    noReplace?: true,
    checkActive?: () => void,
  }): Promise<void>,
  /** Apply ordered changes to verified entries, settling accepted publication after Stop. */
  publishEntries({ changes, checkActive }: { changes: readonly WeshEntryChange[], checkActive?: () => void }): Promise<void>,
  replaceEntry({ entry, path, expected, backupPath, expectedBackup, checkActive }: {
    entry: WeshEntryRef,
    path: string,
    expected: WeshEntryRef | WeshEntryLookup | undefined,
    backupPath: string | undefined,
    expectedBackup?: { entry: WeshEntryRef | undefined },
    checkActive?: () => void,
  }): Promise<WeshEntryRef>,

  registerSpecialFile({ path, type, handler }: { path: string, type: WeshSpecialFileType, handler: () => WeshFileHandle }): void,
  unregisterSpecialFile({ path }: { path: string }): void,

  /**
   * Returns the underlying native FileSystemHandle for the given path, or null
   * if the path resolves to a synthetic directory, special file, or registry entry.
   */
  getNativeHandle({ path }: { path: string }): Promise<FileSystemHandle | null>,

  /**
   * Returns whether the given path is read-only based on the owning mount.
   * Paths outside every real mount (synthetic intermediate directories) return true.
   */
  getReadOnlyForPath({ path }: { path: string }): boolean,
}

export type NaidanSysfsBinaryObjectAccess =
  | 'none'
  | 'metadata_only'
  | 'data';

export const NAIDAN_SYSFS_MOUNT_PATH = '/sys/fs/naidan' as const;

export interface WeshDirectoryMount {
  type: 'directory',
  path: string,
  handle: FileSystemDirectoryHandle,
  readOnly: boolean,
}

export interface WeshManagedDirectoryMount {
  type: 'managed_directory',
  path: string,
  reference: ManagedVolumeReference,
  readOnly: boolean,
}

export interface WeshNaidanSysfsMount {
  type: 'naidan_sysfs',
  path: typeof NAIDAN_SYSFS_MOUNT_PATH,
  readOnly: true,
  storageType: 'local' | 'opfs' | 'memory',
  visibility: NaidanSysfsVisibility,
  binaryObjectAccess: NaidanSysfsBinaryObjectAccess,
  currentChatId: ChatId,
  currentChatGroupId: ChatGroupId | undefined,
}

export type WeshMount = WeshDirectoryMount | WeshManagedDirectoryMount | WeshNaidanSysfsMount;

export type WeshVirtualEntryRef =
  | {
      readonly type: 'file' | 'fifo' | 'chardev',
      readonly name: string,
      readonly fullPath: string,
      stat(): Promise<WeshStat>,
      open({ flags, mode }: { flags: WeshOpenFlags, mode?: number }): Promise<WeshFileHandle>,
    }
  | {
      readonly type: 'directory',
      readonly name: string,
      readonly fullPath: string,
      stat(): Promise<WeshStat>,
      readDir(): AsyncIterable<WeshVirtualEntryRef>,
    }
  | {
      readonly type: 'symlink',
      readonly name: string,
      readonly fullPath: string,
      stat(): Promise<WeshStat>,
      readlink(): Promise<string>,
    };

export interface WeshVirtualMountProvider {
  resolveEntryRef?({
    path,
    finalSymlinkTreatment,
  }: {
    path: string,
    finalSymlinkTreatment: WeshFinalSymlinkTreatment,
  }): Promise<WeshVirtualEntryRef>,
  open({
    path,
    flags,
    mode,
  }: {
    path: string,
    flags: WeshOpenFlags,
    mode?: number,
  }): Promise<WeshFileHandle>,
  stat({ path }: { path: string }): Promise<WeshStat>,
  lstat({ path }: { path: string }): Promise<WeshStat>,
  readDir({ path }: { path: string }): AsyncIterable<WeshDirEntry>,
  readlink({ path }: { path: string }): Promise<string>,
}

export const WESH_EFFICIENT_BLOB_READ_FALLBACK_REQUIRED = Symbol('WESH_EFFICIENT_BLOB_READ_FALLBACK_REQUIRED');
export const WESH_EFFICIENT_FILE_WRITE_FALLBACK_REQUIRED = Symbol('WESH_EFFICIENT_FILE_WRITE_FALLBACK_REQUIRED');

export type WeshEfficientBlobReadResult =
  | { kind: 'blob', blob: Blob }
  | { kind: 'fallback_required', reason: typeof WESH_EFFICIENT_BLOB_READ_FALLBACK_REQUIRED };

export type WeshEfficientFileWriteResult =
  | { kind: 'writer', writer: WeshEfficientFileWriter }
  | { kind: 'fallback_required', reason: typeof WESH_EFFICIENT_FILE_WRITE_FALLBACK_REQUIRED };

// --- Shell / Command Execution Context ---


export interface WeshShellStateSnapshot {
  cwd: string,
  env: Record<string, string>,
}

export type WeshCommandListEntryKind = 'builtin' | 'alias';

export interface WeshCommandListEntry {
  name: string,
  kind: WeshCommandListEntryKind,
  description: string,
  usage: string,
}

export interface WeshCommandResult {
  exitCode: number,
  waitStatus?: WeshWaitStatus,
}

export interface WeshShellExecutionResult extends WeshCommandResult {
  controlFlow?:
    | { kind: 'break', levels: number }
    | { kind: 'continue', levels: number }
    | { kind: 'return', exitCode: number }
    | { kind: 'exit', exitCode: number }
    | { kind: 'exec' },
}

export function isExecCompletion({ result }: {
  result: WeshShellExecutionResult,
}): boolean {
  const controlFlow = result.controlFlow;
  if (controlFlow === undefined) {
    return false;
  }
  switch (controlFlow.kind) {
  case 'exec':
    return true;
  case 'break':
  case 'continue':
  case 'return':
  case 'exit':
    return false;
  default: {
    const _ex: never = controlFlow;
    throw new Error(`Unhandled shell control flow: ${JSON.stringify(_ex)}`);
  }
  }
}

export type WeshTrapDisposition =
  | { kind: 'run', action: string }
  | { kind: 'ignore' };

export type WeshShellOption = 'dotglob' | 'extglob' | 'failglob' | 'globstar' | 'nullglob';

export type WeshResolvedCommand =
  | {
      kind: 'builtin',
      name: string,
      meta: WeshCommandMeta,
      invocationPath: string | undefined,
      resolution: 'builtin-name' | 'path-lookup' | 'explicit-path',
    }
  | { kind: 'not_found', name: string };

export interface WeshCommandContext {
  pid: number,
  args: string[],
  env: ReadonlyMap<string, string>,
  cwd: string,

  // Standard Streams (FDs 0, 1, 2)
  stdin: WeshFileHandle,
  stdout: WeshFileHandle,
  stderr: WeshFileHandle,

  text(): {
    input: AsyncIterable<string>,
    print({ text }: { text: string }): Promise<void>,
    error({ text }: { text: string }): Promise<void>,
  },

  // Commands depend on capability-scoped APIs instead of the raw kernel so they
  // cannot accidentally reach across process boundaries, bypass process-owned
  // resource tracking, or couple themselves to internal runtime details.

  getArgumentEntryRef({ index }: { index: number }): WeshEntryRef | undefined,
  getWeshCommandMeta({ name }: { name: string }): WeshCommandMeta | undefined,
  getCommandNames(): string[],
  getProcesses(): WeshProcessSnapshot[],
  executeCommand({ command, args, argumentEntryRefs, stdin, stdout, cwd, env }: {
    command: string,
    args: string[],
    argumentEntryRefs?: readonly (WeshEntryRef | undefined)[],
    stdin?: WeshFileHandle,
    stdout?: WeshFileHandle,
    cwd?: string,
    env?: ReadonlyMap<string, string>,
  }): Promise<WeshCommandResult>,
  files: {
    open({ path, flags, mode }: {
      path: string,
      flags: WeshOpenFlags,
      mode?: number,
    }): Promise<WeshFileHandle>,
    createTemporaryFile({ path, siblingOf }: { path: string, siblingOf?: WeshEntryLookup }): Promise<WeshTemporaryFile>,
    createTemporarySymlink({ path, targetPath, mode, siblingOf }: { path: string, targetPath: string, mode?: number, siblingOf?: WeshEntryLookup }): Promise<WeshTemporaryEntry>,
    stat({ path }: { path: string }): Promise<WeshStat>,
    lstat({ path }: { path: string }): Promise<WeshStat>,
    readDir({ path }: { path: string }): AsyncIterable<WeshDirEntry>,
    readlink({ path }: { path: string }): Promise<string>,
    resolve({ path }: { path: string }): Promise<{ fullPath: string, stat: WeshStat }>,
    /** Query the mount grant for an already resolved path. */
    getReadOnlyForPath: WeshIVirtualFileSystem['getReadOnlyForPath'],
    resolveEntry: WeshIVirtualFileSystem['resolveEntry'],
    tryLookupEntryWithoutFollowingSymlinks({ path }: { path: string }): Promise<WeshEntryLookup | undefined>,
    readDirEntry({
      entry,
    }: {
      entry: WeshEntryRef<'directory'>,
    }): AsyncIterable<WeshEntryRef>,
    statEntry({ entry }: { entry: WeshEntryRef }): Promise<WeshStat>,
    openEntry({
      entry,
      flags,
      mode,
    }: {
      entry: WeshEntryRef,
      flags: WeshOpenFlags,
      mode?: number,
    }): Promise<WeshFileHandle>,
    readlinkEntry({ entry }: { entry: WeshEntryRef<'symlink'> }): Promise<string>,
    tryReadBlobEfficiently: WeshIVirtualFileSystem['tryReadBlobEfficiently'],
    tryCreateFileWriterEfficiently({ path, lookup, expected, mode, sharedOutput }: {
      path: string, lookup?: never, expected?: WeshEntryRef<'file'>, mode: 'truncate' | 'append', sharedOutput?: WeshFileHandle,
    } | {
      path?: never, lookup: WeshEntryLookup, expected?: never, mode: 'truncate' | 'append', sharedOutput?: never,
    }): Promise<WeshEfficientFileWriteResult>,
    mkdir({ path, mode, recursive, symlinkTreatment, onCreate }: { path: string, mode?: number, recursive?: boolean, symlinkTreatment?: 'no-follow', onCreate?: ({ path }: { path: string }) => Promise<void> }): Promise<void>,
    symlink({ path, targetPath, mode, expected }: { path: string, targetPath: string, mode?: number, expected?: WeshEntryLookup }): Promise<void>,
    mknod({ path, type, mode }: { path: string, type: WeshFileType, mode?: number }): Promise<void>,
    unlink({ path, expected }: { path: string, expected?: { entry: WeshEntryRef, retainedEntries?: readonly WeshEntryRef[] } }): Promise<void>,
    rmdir({ path }: { path: string }): Promise<void>,
    rename({ oldPath, newPath, expectedSource, expectedDestination, noReplace }: {
      oldPath: string,
      newPath: string,
      expectedSource?: WeshEntryRef,
      expectedDestination?: WeshEntryRef,
      noReplace?: true,
    }): Promise<void>,
    publishEntries({ changes }: { changes: readonly WeshEntryChange[] }): Promise<void>,
    /** Publish a staged entry and return the identity that was installed. */
    replaceEntry({ entry, path, expected, backupPath, expectedBackup }: {
      entry: WeshEntryRef,
      path: string,
      expected: WeshEntryRef | WeshEntryLookup | undefined,
      backupPath: string | undefined,
      expectedBackup?: { entry: WeshEntryRef | undefined },
    }): Promise<WeshEntryRef>,
    compareEntryIdentity: WeshIVirtualFileSystem['compareEntryIdentity'],
  },
  process: {
    getPid(): number,
    getGroupId(): number,
    getWaitStatus(): WeshWaitStatus | undefined,
    signalSelf({ signal }: { signal: number }): Promise<void>,
    signalGroup({ signal }: { signal: number }): Promise<void>,
    waitForSignalOrTimeout({ timeoutMs }: { timeoutMs: number }): Promise<WeshWaitStatus | undefined>,
  },
  getFileDescriptor({ fd }: { fd: number }): WeshFileHandle | undefined,
}

export type WeshCommandFunction = ({ context }: { context: WeshCommandContext }) => Promise<WeshCommandResult>;

export type WeshSignalDeliveryError = 'no-such-process' | 'not-permitted' | 'unsupported' | 'interrupted';

export interface WeshShellBuiltinContext {
  setCwd({ path }: { path: string }): void,
  getHistory(): string[],
  getAliases(): Array<{ name: string, value: string }>,
  setAlias({ name, value }: { name: string, value: string }): void,
  unsetAlias({ name }: { name: string }): void,
  hasFunction({ name }: { name: string }): boolean,
  getJobs(): Array<{ id: number, command: string, status: 'running' | 'done' }>,
  sendSignal({ target, signal }: { target: number, signal: number }): WeshSignalDeliveryError | undefined,
  getShellOption({ name }: { name: WeshShellOption }): boolean,
  setShellOption({ name, enabled }: { name: WeshShellOption, enabled: boolean }): void,
  getExecutionOption({ name }: { name: keyof WeshExecutionOptions }): boolean,
  setExecutionOption({ name, enabled }: { name: keyof WeshExecutionOptions, enabled: boolean }): void,
  setTraps({ conditions, disposition }: { conditions: readonly string[], disposition: WeshTrapDisposition | undefined }): void,
  getTraps(): Array<[string, WeshTrapDisposition]>,
  readonly variables: Pick<WeshShellVariables, 'get' | 'set' | 'unset' | 'entries' | 'exportDeclarations' | 'setExport'>,
  getSearchPath(): string | undefined,
  evaluateCommand({ command, args, searchPathOverride, functionLookup }: {
    command: string,
    args: string[],
    searchPathOverride?: string,
    functionLookup: 'allow' | 'bypass',
  }): Promise<WeshShellExecutionResult>,
  evaluateSource({ script }: { script: string }): Promise<WeshShellExecutionResult>,
  exec({ command, args, argv0, login, clearEnvironment }: {
    command: string,
    args: string[],
    argv0: string | undefined,
    login: boolean,
    clearEnvironment: boolean,
  }): Promise<WeshShellExecutionResult>,
  persistFileDescriptors(): Promise<void>,
}

export interface WeshBuiltinCommandContext extends Pick<WeshCommandContext, 'args' | 'cwd' | 'env' | 'getFileDescriptor' | 'getWeshCommandMeta' | 'stdout' | 'text'> {
  readonly files: Pick<WeshCommandContext['files'], 'lstat' | 'readlink' | 'resolve' | 'stat'>,
}

export type WeshShellBuiltinFunction<Capability extends keyof WeshShellBuiltinContext = keyof WeshShellBuiltinContext> = ({ context, shell }: {
  context: WeshBuiltinCommandContext,
  shell: Pick<WeshShellBuiltinContext, Capability>,
}) => Promise<WeshShellExecutionResult>;

export interface WeshCommandImplementation {
  readonly fn: WeshCommandFunction,
}

export interface WeshCommandMeta {
  readonly name: string,
  readonly description: string,
  readonly usage: string,
}

export interface WeshCommandDefinition {
  readonly meta: WeshCommandMeta,
  readonly load: () => Promise<WeshCommandFunction>,
}

export interface WeshShellBuiltinDefinition {
  readonly meta: WeshCommandMeta,
  readonly loadShellBuiltin: () => Promise<WeshShellBuiltinFunction>,
}

export type WeshRegisteredCommandDefinition = WeshCommandDefinition | WeshShellBuiltinDefinition;

// --- AST Definitions ---

export interface WeshRedirection {
  fd: number,
  type: 'write' | 'append' | 'read' | 'read_write' | 'dup_output' | 'dup_input' | 'heredoc' | 'herestring',
  target: string | WeshProcessSubstitutionNode | undefined,
  targetFd?: number,
  closeTarget?: boolean,
  content?: string, // For here-docs
  contentExpansion?: 'literal' | 'variables',
}

export type WeshASTNode =
  | WeshCommandNode
  | WeshPipelineNode
  | WeshListNode
  | WeshIfNode
  | WeshForNode
  | WeshWhileNode
  | WeshUntilNode
  | WeshCaseNode
  | WeshFunctionDefinitionNode
  | WeshArithmeticCommandNode
  | WeshConditionalCommandNode
  | WeshRedirectedNode
  | WeshAssignmentNode
  | WeshSubshellNode;

export interface WeshProcessSubstitutionNode {
  kind: 'processSubstitution',
  type: 'input' | 'output', // <(..) vs >(..)
  list: WeshASTNode,
}

export interface WeshCommandNode {
  kind: 'command',
  assignments: { key: string, value: string }[],
  name: string,
  args: Array<string | WeshProcessSubstitutionNode>,
  redirections: WeshRedirection[],
}

export interface WeshPipelineNode {
  kind: 'pipeline',
  commands: WeshASTNode[],
}

export interface WeshListNode {
  kind: 'list',
  parts: {
    node: WeshASTNode,
    operator: ';' | '&&' | '||' | '&',
  }[],
}

export interface WeshIfNode {
  kind: 'if',
  condition: WeshASTNode,
  thenBody: WeshASTNode,
  elseBody?: WeshASTNode,
}

export interface WeshForNode {
  kind: 'for',
  variable: string,
  items: string[],
  body: WeshASTNode,
}

export interface WeshWhileNode {
  kind: 'while',
  condition: WeshASTNode,
  body: WeshASTNode,
}

export interface WeshUntilNode {
  kind: 'until',
  condition: WeshASTNode,
  body: WeshASTNode,
}

export interface WeshCaseClause {
  patterns: string[],
  body: WeshASTNode,
}

export interface WeshCaseNode {
  kind: 'case',
  word: string,
  clauses: WeshCaseClause[],
}

export interface WeshFunctionDefinitionNode {
  kind: 'functionDefinition',
  name: string,
  body: WeshASTNode,
}

export interface WeshArithmeticCommandNode {
  kind: 'arithmeticCommand',
  expression: string,
}

export interface WeshConditionalCommandNode {
  kind: 'conditionalCommand',
  expression: WeshConditionalExpression,
}

export type WeshConditionalUnaryOperator =
  | '-n' | '-z' | '-v'
  | '-b' | '-c' | '-d' | '-e' | '-f' | '-h' | '-L'
  | '-p' | '-r' | '-s' | '-S' | '-t' | '-w' | '-x';

export type WeshConditionalBinaryOperator =
  | '=' | '==' | '!=' | '=~' | '<' | '>'
  | '-eq' | '-ne' | '-lt' | '-le' | '-gt' | '-ge'
  | '-ef' | '-nt' | '-ot';

export type WeshConditionalOperand = string | WeshProcessSubstitutionNode;

export type WeshConditionalExpression =
  | { kind: 'and' | 'or', operands: WeshConditionalExpression[] }
  | { kind: 'not', operand: WeshConditionalExpression }
  | { kind: 'word', word: WeshConditionalOperand }
  | { kind: 'unary', operator: WeshConditionalUnaryOperator, word: WeshConditionalOperand }
  | { kind: 'binary', operator: WeshConditionalBinaryOperator, left: WeshConditionalOperand, right: WeshConditionalOperand };

export interface WeshRedirectedNode {
  kind: 'redirected',
  node: WeshASTNode,
  redirections: WeshRedirection[],
}

export interface WeshAssignmentNode {
  kind: 'assignment',
  assignments: { key: string, value: string }[],
}

export interface WeshSubshellNode {
  kind: 'subshell',
  list: WeshASTNode,
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
