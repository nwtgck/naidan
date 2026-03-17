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

export interface WeshProcess {
  pid: number;
  ppid: number;
  pgid: number; // Process Group ID
  state: 'running' | 'stopped' | 'zombie' | 'terminated';
  exitCode?: number;

  env: Map<string, string>;
  cwd: string;
  args: string[];

  /** File Descriptor Table: fd -> handle */
  fds: Map<number, WeshFileHandle>;
}

export interface WeshKernel {
  /**
   * Fork/Spawn a new process
   * @returns PID of the new process
   */
  spawn(options: {
    image: string; // Command/Executable name or path
    args: string[];
    env?: Map<string, string>;
    cwd?: string;
    fds?: Map<number, WeshFileHandle>; // Explicit FD inheritance/mapping
  }): Promise<{ pid: number; process: WeshProcess }>;

  /**
   * Wait for a process to change state (e.g. exit)
   */
  wait(options: { pid: number; flags?: number }): Promise<{ pid: number; exitCode: number }>;

  /**
   * Send a signal to a process
   */
  kill(options: { pid: number; signal: number }): Promise<void>;

  /**
   * Create a pipe (unnamed)
   */
  pipe(): Promise<{ read: WeshFileHandle; write: WeshFileHandle }>;

  /** Open a file (Virtual File System or Device) */
  open(options: { path: string; flags: number; mode?: number }): Promise<WeshFileHandle>;

  stat(options: { path: string }): Promise<WeshStat>;

  readDir(options: { path: string }): Promise<Array<{ name: string; type: WeshFileType }>>;

  mkdir(options: { path: string; mode?: number; recursive?: boolean }): Promise<void>;

  mknod(options: { path: string; type: WeshFileType; mode?: number }): Promise<void>;

  unlink(options: { path: string }): Promise<void>;

  rmdir(options: { path: string }): Promise<void>;

  getProcess(options: { pid: number }): WeshProcess | undefined;
}

// --- Virtual File System ---

export interface WeshIVirtualFileSystem {
  mount(options: { path: string; handle: FileSystemDirectoryHandle; readOnly?: boolean }): Promise<void>;
  unmount(options: { path: string }): Promise<void>;

  /**
   * Open a file by path.
   * Handles translation of VFS paths to handles.
   */
  open(options: { path: string; flags: number; mode?: number }): Promise<WeshFileHandle>;

  stat(options: { path: string }): Promise<WeshStat>;

  readDir(options: { path: string }): Promise<Array<{ name: string; type: WeshFileType }>>;

  mkdir(options: { path: string; mode?: number; recursive?: boolean }): Promise<void>;

  open(options: { path: string; flags: number; mode?: number }): Promise<WeshFileHandle>;
  stat(options: { path: string }): Promise<WeshStat>;
  readDir(options: { path: string }): Promise<Array<{ name: string; type: WeshFileType }>>;
  unlink(options: { path: string }): Promise<void>;
  rmdir(options: { path: string }): Promise<void>;
  mknod(options: { path: string; type: WeshFileType; mode?: number }): Promise<void>;
  rename(options: { oldPath: string; newPath: string }): Promise<void>;

  registerSpecialFile(options: { path: string; handler: () => WeshFileHandle }): void;
  unregisterSpecialFile(options: { path: string }): void;

  resolve(options: { path: string }): Promise<{ handle: FileSystemHandle; readOnly: boolean; fullPath: string }>;
}

// --- Shell / Command Execution Context ---

export interface WeshCommandResult {
  exitCode: number;
}

export interface WeshCommandContext {
  pid: number;
  args: string[];
  env: Map<string, string>;
  cwd: string;

  kernel: WeshKernel;
  vfs: WeshIVirtualFileSystem;

  // Standard Streams (FDs 0, 1, 2)
  stdin: WeshFileHandle;
  stdout: WeshFileHandle;
  stderr: WeshFileHandle;

  text(): {
    input: AsyncIterable<string>;
    print(options: { text: string }): Promise<void>;
    error(options: { text: string }): Promise<void>;
  };

  // State management (Built-in only)
  setCwd(options: { path: string }): void;
  setEnv(options: { key: string; value: string }): void;
  unsetEnv(options: { key: string }): void;
  getHistory(): string[];
  getWeshCommandMeta(options: { name: string }): WeshCommandMeta | undefined;
  getCommandNames(): string[];
  getJobs(): Array<{ id: number; command: string; status: 'running' | 'done' }>;
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
  type: '>' | '>>' | '<' | '2>' | '2>&1' | '<<' | '<<<';
  target: string | undefined;
  content?: string; // For here-docs
}

export type WeshASTNode =
  | WeshCommandNode
  | WeshPipelineNode
  | WeshListNode
  | WeshIfNode
  | WeshForNode
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

export interface WeshAssignmentNode {
  kind: 'assignment';
  assignments: { key: string; value: string }[];
}

export interface WeshSubshellNode {
  kind: 'subshell';
  list: WeshASTNode;
}
