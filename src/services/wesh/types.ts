export interface WeshCommandResult {
  /** 0 for success, non-zero for failure */
  exitCode: number;
  /** Structured output data for machine consumption */
  data: unknown | undefined;
  /** Human-readable error message */
  error: string | undefined;
}

export interface WeshFileHandle {
  read({ buffer, position }: { buffer: Uint8Array; position?: number }): Promise<{ bytesRead: number }>;
  write({ buffer, position }: { buffer: Uint8Array; position?: number }): Promise<{ bytesWritten: number }>;
  close(): Promise<void>;
  stat(): Promise<{ size: number; kind: 'file' | 'directory' }>;
  truncate({ size }: { size: number }): Promise<void>;
}

export interface WeshIVirtualFileSystem {
  mount({ path, handle, readOnly }: { path: string; handle: FileSystemDirectoryHandle; readOnly: boolean }): void;
  unmount({ path }: { path: string }): void;
  resolve({ path }: { path: string }): Promise<{ handle: FileSystemHandle; readOnly: boolean; fullPath: string }>;
  readDir({ path }: { path: string }): Promise<Array<{ name: string; kind: 'file' | 'directory' }>>;
  
  /** Low-level file open */
  open({ path, mode }: { path: string; mode: 'r' | 'w' | 'rw' | 'a' }): Promise<WeshFileHandle>;

  /** @deprecated use open() */
  readFile({ path }: { path: string }): Promise<ReadableStream<Uint8Array>>;
  /** @deprecated use open() */
  writeFile({ path, stream }: { path: string; stream: ReadableStream<Uint8Array> }): Promise<void>;
  
  stat({ path }: { path: string }): Promise<{ size: number; kind: 'file' | 'directory'; readOnly: boolean }>;
  mkdir({ path, recursive }: { path: string; recursive: boolean }): Promise<void>;
  rm({ path, recursive }: { path: string; recursive: boolean }): Promise<void>;
  exists({ path }: { path: string }): Promise<boolean>;

  registerSpecialFile({ path, handler }: { path: string; handler: () => WeshFileHandle }): void;
  unregisterSpecialFile({ path }: { path: string }): void;
}

export interface WeshCommandContext {
  /** All arguments including flags */
  args: string[];
  env: Map<string, string>;
  cwd: string;
  vfs: WeshIVirtualFileSystem;

  /** Standard I/O Streams */
  stdin: ReadableStream<Uint8Array>;
  stdout: WritableStream<Uint8Array>;
  stderr: WritableStream<Uint8Array>;

  /** Shell State Update */
  setCwd({ path }: { path: string }): void;
  setEnv({ key, value }: { key: string; value: string }): void;
  unsetEnv({ key }: { key: string }): void;
  getHistory(): string[];
  getWeshCommandMeta({ name }: { name: string }): WeshCommandMeta | undefined;
  getCommandNames(): string[];
  getJobs(): Array<{ id: number; command: string; status: 'running' | 'done' }>;

  /** Utilities for text-based commands */
  text(): {
    input: AsyncIterable<string>;
    print({ text }: { text: string }): Promise<void>;
    error({ text }: { text: string }): Promise<void>;
  };
}

export type WeshCommandFunction = ({ context }: { context: WeshCommandContext }) => Promise<WeshCommandResult>;

/**
 * Metadata for internal shell documentation (help/man)
 */
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
  list: WeshListNode; // The content of ( ... ) is effectively a list
}
