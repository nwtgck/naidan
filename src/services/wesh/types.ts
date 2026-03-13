export interface CommandResult {
  /** 0 for success, non-zero for failure */
  exitCode: number;
  /** Structured output data for machine consumption */
  data: unknown | undefined;
  /** Human-readable error message */
  error: string | undefined;
}

export interface IVirtualFileSystem {
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

export interface CommandContext {
  /** All arguments including flags */
  args: string[];
  env: Record<string, string>;
  cwd: string;
  vfs: IVirtualFileSystem;

  /** Standard I/O Streams */
  stdin: ReadableStream<Uint8Array>;
  stdout: WritableStream<Uint8Array>;
  stderr: WritableStream<Uint8Array>;

  /** Shell State Update */
  setCwd({ path }: { path: string }): void;
  setEnv({ key, value }: { key: string; value: string }): void;
  unsetEnv({ key }: { key: string }): void;
  getHistory(): string[];
  getCommandMeta({ name }: { name: string }): CommandMeta | undefined;
  getCommandNames(): string[];

  /** Utilities for text-based commands */
  text(): {
    input: AsyncIterable<string>;
    print({ text }: { text: string }): Promise<void>;
    error({ text }: { text: string }): Promise<void>;
  };
}

export type CommandFunction = ({ context }: { context: CommandContext }) => Promise<CommandResult>;

/**
 * Metadata for internal shell documentation (help/man)
 */
export interface CommandMeta {
  name: string;
  description: string;
  usage: string;
}

export interface CommandDefinition {
  fn: CommandFunction;
  meta: CommandMeta;
}
