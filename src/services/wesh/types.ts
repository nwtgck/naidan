export interface WeshCommandResult {
  /** 0 for success, non-zero for failure */
  exitCode: number;
  /** Structured output data for machine consumption */
  data: unknown | undefined;
  /** Human-readable error message */
  error: string | undefined;
}

export interface WeshIVirtualFileSystem {
  mount({ path, handle, readOnly }: { path: string; handle: FileSystemDirectoryHandle; readOnly: boolean }): void;
  unmount({ path }: { path: string }): void;
  resolve({ path }: { path: string }): Promise<{ handle: FileSystemHandle; readOnly: boolean; fullPath: string }>;
  readDir({ path }: { path: string }): Promise<Array<{ name: string; kind: 'file' | 'directory' }>>;
  readFile({ path }: { path: string }): Promise<ReadableStream<Uint8Array>>;
  writeFile({ path, stream }: { path: string; stream: ReadableStream<Uint8Array> }): Promise<void>;
  stat({ path }: { path: string }): Promise<{ size: number; kind: 'file' | 'directory'; readOnly: boolean }>;
  mkdir({ path, recursive }: { path: string; recursive: boolean }): Promise<void>;
  rm({ path, recursive }: { path: string; recursive: boolean }): Promise<void>;
  exists({ path }: { path: string }): Promise<boolean>;
}

export interface WeshCommandContext {
  /** All arguments including flags */
  args: string[];
  env: Record<string, string>;
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

export type WeshWeshCommandFunction = ({ context }: { context: WeshCommandContext }) => Promise<WeshCommandResult>;

/**
 * Metadata for internal shell documentation (help/man)
 */
export interface WeshWeshCommandMeta {
  name: string;
  description: string;
  usage: string;
}

export interface WeshWeshCommandDefinition {
  fn: WeshCommandFunction;
  meta: WeshCommandMeta;
}

// --- AST Definitions ---

export interface WeshRedirection {
  type: '>' | '>>' | '<' | '2>' | '2>&1';
  target: string | undefined;
}

export type WeshWeshASTNode =
  | WeshCommandNode
  | WeshPipelineNode
  | WeshListNode
  | WeshIfNode
  | WeshForNode
  | WeshAssignmentNode;

export interface WeshWeshCommandNode {
  kind: 'command';
  assignments: { key: string; value: string }[];
  name: string;
  args: string[];
  redirections: WeshRedirection[];
}

export interface WeshWeshPipelineNode {
  kind: 'pipeline';
  commands: WeshASTNode[];
}

export interface WeshWeshListNode {
  kind: 'list';
  parts: {
    node: WeshASTNode;
    operator: ';' | '&&' | '||' | '&';
  }[];
}

export interface WeshWeshIfNode {
  kind: 'if';
  condition: WeshASTNode;
  thenBody: WeshASTNode;
  elseBody?: WeshASTNode;
}

export interface WeshWeshForNode {
  kind: 'for';
  variable: string;
  items: string[];
  body: WeshASTNode;
}

export interface WeshWeshAssignmentNode {
  kind: 'assignment';
  assignments: { key: string; value: string }[];
}
