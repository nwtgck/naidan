import type { ChatGroupId, ChatId } from '@/models/ids';

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
  | { kind: 'exited', exitCode: number }
  | { kind: 'signaled', signal: number }
  | { kind: 'stopped', signal: number };

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
  terminationSignal?: number,
  waitStatus?: WeshWaitStatus,
  pendingSignals?: number[],
  signalDispositions?: Map<number, WeshProcessSignalDisposition>,

  env: Map<string, string>,
  cwd: string,
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

export interface WeshIVirtualFileSystem {
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
  open({ path, flags, mode }: { path: string, flags: WeshOpenFlags, mode?: number }): Promise<WeshFileHandle>,

  stat({ path }: { path: string }): Promise<WeshStat>,
  lstat({ path }: { path: string }): Promise<WeshStat>,
  readlink({ path }: { path: string }): Promise<string>,

  resolve({ path }: { path: string }): Promise<{ fullPath: string, stat: WeshStat }>,

  tryReadBlobEfficiently({ path }: { path: string }): Promise<WeshEfficientBlobReadResult>,
  tryCreateFileWriterEfficiently({ path, mode }: {
    path: string,
    mode: 'truncate' | 'append',
  }): Promise<WeshEfficientFileWriteResult>,

  readDir({ path }: { path: string }): AsyncIterable<WeshDirEntry>,

  resolveEntry({
    path,
    finalSymlinkTreatment,
  }: {
    path: string,
    finalSymlinkTreatment: WeshFinalSymlinkTreatment,
  }): Promise<WeshEntryRef>,
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

  mkdir({ path, mode, recursive }: { path: string, mode?: number, recursive?: boolean }): Promise<void>,

  symlink({ path, targetPath, mode }: { path: string, targetPath: string, mode?: number }): Promise<void>,

  unlink({ path }: { path: string }): Promise<void>,
  rmdir({ path }: { path: string }): Promise<void>,
  mknod({ path, type, mode }: { path: string, type: WeshFileType, mode?: number }): Promise<void>,
  rename({ oldPath, newPath }: { oldPath: string, newPath: string }): Promise<void>,

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

/**
 * Scope of Naidan chat data that Wesh can access through /sys/fs/naidan.
 *
 * This is a persisted/user-facing access policy, not the low-level sysfs mount
 * implementation detail. Low-level binary object access is intentionally not
 * persisted in tool config because it is not currently user-selectable and
 * should remain an implementation default.
 *
 * `main_chats` intentionally avoids `all_chats`. "All" is too broad for
 * persisted semantics because future Naidan versions may add broader boundaries
 * or side collections such as trash, archives, profiles, workspaces, separate
 * chat spaces, or other chat-like records.
 *
 * `main_chats` means the main chat collection in the current Naidan space. It
 * does not promise to include every chat-like record that may exist in storage,
 * and it does not promise to cross future higher-level boundaries.
 */
export type NaidanSysfsVisibility =
  | 'current_chat_only'
  | 'current_chat_with_chat_group'
  | 'main_chats';

export type NaidanSysfsBinaryObjectAccess =
  | 'none'
  | 'metadata_only'
  | 'data';

export type NaidanSysfsAccessScope =
  | NaidanSysfsVisibility
  | 'none';

export const NAIDAN_SYSFS_MOUNT_PATH = '/sys/fs/naidan' as const;

export interface WeshDirectoryMount {
  type: 'directory',
  path: string,
  handle: FileSystemDirectoryHandle,
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

export type WeshMount = WeshDirectoryMount | WeshNaidanSysfsMount;

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
  controlFlow?:
    | { kind: 'break', levels: number }
    | { kind: 'continue', levels: number }
    | { kind: 'return', exitCode: number },
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
  env: Map<string, string>,
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

  // State management (Built-in only)
  setCwd({ path }: { path: string }): void,
  setEnv({ key, value }: { key: string, value: string }): void,
  unsetEnv({ key }: { key: string }): void,
  getHistory(): string[],
  getArgumentEntryRef({ index }: { index: number }): WeshEntryRef | undefined,
  getAliases(): Array<{ name: string, value: string }>,
  setAlias({ name, value }: { name: string, value: string }): void,
  unsetAlias({ name }: { name: string }): void,
  getWeshCommandMeta({ name }: { name: string }): WeshCommandMeta | undefined,
  getCommandNames(): string[],
  resolveCommand({ name }: { name: string }): WeshResolvedCommand,
  getJobs(): Array<{ id: number, command: string, status: 'running' | 'done' }>,
  getProcesses(): WeshProcessSnapshot[],
  getShellOption({ name }: { name: WeshShellOption }): boolean,
  setShellOption({ name, enabled }: { name: WeshShellOption, enabled: boolean }): void,
  getShellOptions(): Array<[WeshShellOption, boolean]>,
  executeCommand({ command, args, argumentEntryRefs, stdin, stdout, stderr, ignoreAliases }: {
    command: string,
    args: string[],
    argumentEntryRefs?: readonly (WeshEntryRef | undefined)[],
    stdin?: WeshFileHandle,
    stdout?: WeshFileHandle,
    stderr?: WeshFileHandle,
    ignoreAliases?: boolean,
  }): Promise<WeshCommandResult>,
  executeShell({ script, stdin, stdout, stderr }: {
    script: string,
    stdin?: WeshFileHandle,
    stdout?: WeshFileHandle,
    stderr?: WeshFileHandle,
  }): Promise<WeshCommandResult>,
  files: {
    open({ path, flags, mode }: {
      path: string,
      flags: WeshOpenFlags,
      mode?: number,
    }): Promise<WeshFileHandle>,
    stat({ path }: { path: string }): Promise<WeshStat>,
    lstat({ path }: { path: string }): Promise<WeshStat>,
    readDir({ path }: { path: string }): AsyncIterable<WeshDirEntry>,
    readlink({ path }: { path: string }): Promise<string>,
    resolve({ path }: { path: string }): Promise<{ fullPath: string, stat: WeshStat }>,
    resolveEntry({
      path,
      finalSymlinkTreatment,
    }: {
      path: string,
      finalSymlinkTreatment: WeshFinalSymlinkTreatment,
    }): Promise<WeshEntryRef>,
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
    tryReadBlobEfficiently({ path }: { path: string }): Promise<WeshEfficientBlobReadResult>,
    tryCreateFileWriterEfficiently({ path, mode }: {
      path: string,
      mode: 'truncate' | 'append',
    }): Promise<WeshEfficientFileWriteResult>,
    mkdir({ path, mode, recursive }: { path: string, mode?: number, recursive?: boolean }): Promise<void>,
    symlink({ path, targetPath, mode }: { path: string, targetPath: string, mode?: number }): Promise<void>,
    mknod({ path, type, mode }: { path: string, type: WeshFileType, mode?: number }): Promise<void>,
    unlink({ path }: { path: string }): Promise<void>,
    rmdir({ path }: { path: string }): Promise<void>,
    rename({ oldPath, newPath }: { oldPath: string, newPath: string }): Promise<void>,
  },
  process: {
    getPid(): number,
    getGroupId(): number,
    getWaitStatus(): WeshWaitStatus | undefined,
    signalSelf({ signal }: { signal: number }): Promise<void>,
    signalGroup({ signal }: { signal: number }): Promise<void>,
    waitForSignalOrTimeout({ timeoutMs, pollIntervalMs }: {
      timeoutMs: number,
      pollIntervalMs?: number,
    }): Promise<WeshWaitStatus | undefined>,
  },
  getFileDescriptors(): Array<[number, WeshFileHandle]>,
  getFileDescriptor({ fd }: { fd: number }): WeshFileHandle | undefined,
  setFileDescriptor({ fd, handle, persist }: { fd: number, handle: WeshFileHandle, persist: boolean }): Promise<void>,
  closeFileDescriptor({ fd, persist }: { fd: number, persist: boolean }): Promise<void>,
  setTrap({ condition, disposition }: { condition: string, disposition: WeshTrapDisposition | undefined }): void,
  getTrapAction({ condition }: { condition: string }): WeshTrapDisposition | undefined,
  getTraps(): Array<[string, WeshTrapDisposition]>,
}

export type WeshCommandFunction = ({ context }: { context: WeshCommandContext }) => Promise<WeshCommandResult>;

export interface WeshCommandMeta {
  name: string,
  description: string,
  usage: string,
}

export interface WeshCommandDefinition {
  fn: WeshCommandFunction,
  meta: WeshCommandMeta,
}

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
