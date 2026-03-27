// --- Kernel & Process Types ---

export type WeshFileType = 'file' | 'directory' | 'fifo' | 'chardev' | 'symlink';

export interface WeshStat {
  size: number;
  mode: number; // Unix-style mode (permissions + type)
  type: WeshFileType;
  mtime: number;
  ino: number;
  uid: number;
  gid: number;
}

export interface WeshIOResult {
  bytesRead: number;
}

export interface WeshWriteResult {
  bytesWritten: number;
}

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
  read(options: {
    buffer: Uint8Array;
    offset?: number; // Offset in the buffer to start writing at
    length?: number; // Maximum number of bytes to read
    position?: number; // File position (seek). If undefined, use current cursor.
  }): Promise<WeshIOResult>;

  /**
   * Write data from a buffer
   */
  write(options: {
    buffer: Uint8Array;
    offset?: number; // Offset in the buffer to start reading from
    length?: number; // Number of bytes to write
    position?: number; // File position (seek). If undefined, use current cursor.
  }): Promise<WeshWriteResult>;

  close(): Promise<void>;

  stat(): Promise<WeshStat>;

  truncate(options: { size: number }): Promise<void>;

  /**
   * Control device/handle specific operations (e.g. terminal size, blocking mode)
   */
  ioctl(options: { request: number; arg?: unknown }): Promise<{ ret: number }>;
}

export type WeshWaitStatus =
  | { kind: 'exited'; exitCode: number }
  | { kind: 'signaled'; signal: number }
  | { kind: 'stopped'; signal: number };

export type WeshProcessSignalDisposition = 'default' | 'ignore';

export function weshWaitStatusToExitCode({
  waitStatus,
}: {
  waitStatus: WeshWaitStatus;
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
  pid: number;
  ppid: number;
  pgid: number; // Process Group ID
  state: 'running' | 'stopped' | 'zombie' | 'terminated';
  exitCode?: number;
  terminationSignal?: number;
  waitStatus?: WeshWaitStatus;
  pendingSignals?: number[];
  signalDispositions?: Map<number, WeshProcessSignalDisposition>;

  env: Map<string, string>;
  cwd: string;
  args: string[];

  /** File Descriptor Table: fd -> handle */
  fds: Map<number, WeshFileHandle>;
  ownedHandles?: Set<WeshFileHandle>;
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
  access: WeshOpenAccess;
  creation: WeshOpenCreation;
  truncate: WeshOpenTruncate;
  append: WeshOpenAppend;
}

export interface WeshEfficientFileWriter {
  write(options: { chunk: Uint8Array }): Promise<void>;
  close(): Promise<void>;
  abort(options: { reason: unknown }): Promise<void>;
}

export interface WeshIVirtualFileSystem {
  mount(options: { path: string; handle: FileSystemDirectoryHandle; readOnly?: boolean }): Promise<void>;
  unmount(options: { path: string }): Promise<void>;

  /**
   * Open a file by path.
   * Handles translation of VFS paths to handles.
   */
  open(options: { path: string; flags: WeshOpenFlags; mode?: number }): Promise<WeshFileHandle>;

  stat(options: { path: string }): Promise<WeshStat>;
  lstat(options: { path: string }): Promise<WeshStat>;
  readlink(options: { path: string }): Promise<string>;

  resolve(options: { path: string }): Promise<{ fullPath: string; stat: WeshStat }>;

  tryReadBlobEfficiently(options: { path: string }): Promise<WeshEfficientBlobReadResult>;
  tryCreateFileWriterEfficiently(options: {
    path: string;
    mode: 'truncate' | 'append';
  }): Promise<WeshEfficientFileWriteResult>;

  readDir(options: { path: string }): AsyncIterable<{ name: string; type: WeshFileType }>;

  mkdir(options: { path: string; mode?: number; recursive?: boolean }): Promise<void>;

  symlink(options: { path: string; targetPath: string; mode?: number }): Promise<void>;

  unlink(options: { path: string }): Promise<void>;
  rmdir(options: { path: string }): Promise<void>;
  mknod(options: { path: string; type: WeshFileType; mode?: number }): Promise<void>;
  rename(options: { oldPath: string; newPath: string }): Promise<void>;

  registerSpecialFile(options: { path: string; handler: () => WeshFileHandle }): void;
  unregisterSpecialFile(options: { path: string }): void;
}

export interface WeshMount {
  path: string;
  handle: FileSystemDirectoryHandle;
  readOnly: boolean;
}

export const WESH_EFFICIENT_BLOB_READ_FALLBACK_REQUIRED = Symbol('WESH_EFFICIENT_BLOB_READ_FALLBACK_REQUIRED');
export const WESH_EFFICIENT_FILE_WRITE_FALLBACK_REQUIRED = Symbol('WESH_EFFICIENT_FILE_WRITE_FALLBACK_REQUIRED');

export type WeshEfficientBlobReadResult =
  | { kind: 'blob'; blob: Blob }
  | { kind: 'fallback-required'; reason: typeof WESH_EFFICIENT_BLOB_READ_FALLBACK_REQUIRED };

export type WeshEfficientFileWriteResult =
  | { kind: 'writer'; writer: WeshEfficientFileWriter }
  | { kind: 'fallback-required'; reason: typeof WESH_EFFICIENT_FILE_WRITE_FALLBACK_REQUIRED };

// --- Shell / Command Execution Context ---

export interface WeshCommandResult {
  exitCode: number;
  waitStatus?: WeshWaitStatus;
  controlFlow?:
    | { kind: 'break'; levels: number }
    | { kind: 'continue'; levels: number }
    | { kind: 'return'; exitCode: number };
}

export type WeshTrapDisposition =
  | { kind: 'run'; action: string }
  | { kind: 'ignore' };

export type WeshShellOption = 'dotglob' | 'extglob' | 'failglob' | 'globstar' | 'nullglob';

export type WeshResolvedCommand =
  | {
      kind: 'builtin';
      name: string;
      meta: WeshCommandMeta;
      invocationPath: string | undefined;
      resolution: 'builtin-name' | 'path-lookup' | 'explicit-path';
    }
  | { kind: 'not-found'; name: string };

export interface WeshCommandContext {
  pid: number;
  args: string[];
  env: Map<string, string>;
  cwd: string;

  // Standard Streams (FDs 0, 1, 2)
  stdin: WeshFileHandle;
  stdout: WeshFileHandle;
  stderr: WeshFileHandle;

  text(): {
    input: AsyncIterable<string>;
    print(options: { text: string }): Promise<void>;
    error(options: { text: string }): Promise<void>;
  };

  // Commands depend on capability-scoped APIs instead of the raw kernel so they
  // cannot accidentally reach across process boundaries, bypass process-owned
  // resource tracking, or couple themselves to internal runtime details.

  // State management (Built-in only)
  setCwd(options: { path: string }): void;
  setEnv(options: { key: string; value: string }): void;
  unsetEnv(options: { key: string }): void;
  getHistory(): string[];
  getAliases(): Array<{ name: string; value: string }>;
  setAlias(options: { name: string; value: string }): void;
  unsetAlias(options: { name: string }): void;
  getWeshCommandMeta(options: { name: string }): WeshCommandMeta | undefined;
  getCommandNames(): string[];
  resolveCommand(options: { name: string }): WeshResolvedCommand;
  getJobs(): Array<{ id: number; command: string; status: 'running' | 'done' }>;
  getShellOption(options: { name: WeshShellOption }): boolean;
  setShellOption(options: { name: WeshShellOption; enabled: boolean }): void;
  getShellOptions(): Array<[WeshShellOption, boolean]>;
  executeCommand(options: {
    command: string;
    args: string[];
    stdin?: WeshFileHandle;
    stdout?: WeshFileHandle;
    stderr?: WeshFileHandle;
    ignoreAliases?: boolean;
  }): Promise<WeshCommandResult>;
  executeShell(options: {
    script: string;
    stdin?: WeshFileHandle;
    stdout?: WeshFileHandle;
    stderr?: WeshFileHandle;
  }): Promise<WeshCommandResult>;
  files: {
    open(options: {
      path: string;
      flags: WeshOpenFlags;
      mode?: number;
    }): Promise<WeshFileHandle>;
    stat(options: { path: string }): Promise<WeshStat>;
    lstat(options: { path: string }): Promise<WeshStat>;
    readDir(options: { path: string }): AsyncIterable<{ name: string; type: WeshFileType }>;
    readlink(options: { path: string }): Promise<string>;
    resolve(options: { path: string }): Promise<{ fullPath: string; stat: WeshStat }>;
    tryReadBlobEfficiently(options: { path: string }): Promise<WeshEfficientBlobReadResult>;
    tryCreateFileWriterEfficiently(options: {
      path: string;
      mode: 'truncate' | 'append';
    }): Promise<WeshEfficientFileWriteResult>;
    mkdir(options: { path: string; mode?: number; recursive?: boolean }): Promise<void>;
    symlink(options: { path: string; targetPath: string; mode?: number }): Promise<void>;
    mknod(options: { path: string; type: WeshFileType; mode?: number }): Promise<void>;
    unlink(options: { path: string }): Promise<void>;
    rmdir(options: { path: string }): Promise<void>;
    rename(options: { oldPath: string; newPath: string }): Promise<void>;
  };
  process: {
    getPid(): number;
    getGroupId(): number;
    getWaitStatus(): WeshWaitStatus | undefined;
    signalSelf(options: { signal: number }): Promise<void>;
    signalGroup(options: { signal: number }): Promise<void>;
    waitForSignalOrTimeout(options: {
      timeoutMs: number;
      pollIntervalMs?: number;
    }): Promise<WeshWaitStatus | undefined>;
  };
  getFileDescriptors(): Array<[number, WeshFileHandle]>;
  getFileDescriptor(options: { fd: number }): WeshFileHandle | undefined;
  setFileDescriptor(options: { fd: number; handle: WeshFileHandle; persist: boolean }): Promise<void>;
  closeFileDescriptor(options: { fd: number; persist: boolean }): Promise<void>;
  setTrap(options: { condition: string; disposition: WeshTrapDisposition | undefined }): void;
  getTrapAction(options: { condition: string }): WeshTrapDisposition | undefined;
  getTraps(): Array<[string, WeshTrapDisposition]>;
}

export type WeshCommandFunction = (options: { context: WeshCommandContext }) => Promise<WeshCommandResult>;

export interface WeshCommandMeta {
  name: string;
  description: string;
  usage: string;
}

export interface WeshCommandDefinition {
  fn: WeshCommandFunction;
  meta: WeshCommandMeta;
}

// --- AST Definitions ---

export interface WeshRedirection {
  fd: number;
  type: 'write' | 'append' | 'read' | 'read-write' | 'dup-output' | 'dup-input' | 'heredoc' | 'herestring';
  target: string | WeshProcessSubstitutionNode | undefined;
  targetFd?: number;
  closeTarget?: boolean;
  content?: string; // For here-docs
  contentExpansion?: 'literal' | 'variables';
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
  kind: 'processSubstitution';
  type: 'input' | 'output'; // <(..) vs >(..)
  list: WeshASTNode;
}

export interface WeshCommandNode {
  kind: 'command';
  assignments: { key: string; value: string }[];
  name: string;
  args: Array<string | WeshProcessSubstitutionNode>;
  redirections: WeshRedirection[];
}

export interface WeshPipelineNode {
  kind: 'pipeline';
  commands: WeshASTNode[];
}

export interface WeshListNode {
  kind: 'list';
  parts: {
    node: WeshASTNode;
    operator: ';' | '&&' | '||' | '&';
  }[];
}

export interface WeshIfNode {
  kind: 'if';
  condition: WeshASTNode;
  thenBody: WeshASTNode;
  elseBody?: WeshASTNode;
}

export interface WeshForNode {
  kind: 'for';
  variable: string;
  items: string[];
  body: WeshASTNode;
}

export interface WeshWhileNode {
  kind: 'while';
  condition: WeshASTNode;
  body: WeshASTNode;
}

export interface WeshUntilNode {
  kind: 'until';
  condition: WeshASTNode;
  body: WeshASTNode;
}

export interface WeshCaseClause {
  patterns: string[];
  body: WeshASTNode;
}

export interface WeshCaseNode {
  kind: 'case';
  word: string;
  clauses: WeshCaseClause[];
}

export interface WeshFunctionDefinitionNode {
  kind: 'functionDefinition';
  name: string;
  body: WeshASTNode;
}

export interface WeshArithmeticCommandNode {
  kind: 'arithmeticCommand';
  expression: string;
}

export interface WeshRedirectedNode {
  kind: 'redirected';
  node: WeshASTNode;
  redirections: WeshRedirection[];
}

export interface WeshAssignmentNode {
  kind: 'assignment';
  assignments: { key: string; value: string }[];
}

export interface WeshSubshellNode {
  kind: 'subshell';
  list: WeshASTNode;
}
