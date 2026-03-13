import type { CommandDefinition, CommandResult, IVirtualFileSystem, CommandContext } from './types';
import { VFS } from './vfs';
import { parseCommandLine } from './parser';
import { createTextHelpers } from './utils/io';

import { builtinCommands } from './commands';
import { help } from './commands/help';

export class Wesh {
  public vfs: IVirtualFileSystem;
  private env: Record<string, string> = {};
  private cwd: string = '/';
  private history: string[] = [];
  private commands: Map<string, CommandDefinition> = new Map();

  constructor({ 
    rootHandle, 
    user = 'user', 
    initialEnv = {} 
  }: { 
    rootHandle: FileSystemDirectoryHandle;
    user?: string;
    initialEnv?: Record<string, string>;
  }) {
    this.vfs = new VFS({ rootHandle });
    this.env = {
      HOME: '/home',
      PWD: '/',
      PATH: '/bin',
      USER: user,
      SHELL: '/bin/wesh',
      ...initialEnv,
    };

    for (const definition of builtinCommands) {
      this.registerCommand({ definition });
    }
    this.registerCommand({ definition: help });
  }

  registerCommand({ definition }: { definition: CommandDefinition }): void {
    this.commands.set(definition.meta.name, definition);
  }

  async execute({ commandLine }: { commandLine: string }): Promise<CommandResult> {
    this.history.push(commandLine);
    const pipeline = parseCommandLine({ commandLine, env: this.env });

    if (pipeline.commands.length === 0) {
      return { exitCode: 0, data: undefined, error: undefined };
    }

    const streams: Array<{ readable: ReadableStream<Uint8Array>; writable: WritableStream<Uint8Array> }> = [];
    for (let i = 0; i < pipeline.commands.length - 1; i++) {
      const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
      streams.push({ readable, writable });
    }

    const finalStdout = new TransformStream<Uint8Array, Uint8Array>();
    const finalStderr = new TransformStream<Uint8Array, Uint8Array>();

    const commandPromises = pipeline.commands.map(async (cmd, i) => {
      let stdin = i === 0 ? new ReadableStream<Uint8Array>() : (streams[i - 1]?.readable ?? new ReadableStream());
      let stdout = i === pipeline.commands.length - 1 ? finalStdout.writable : (streams[i]?.writable ?? finalStdout.writable);
      let stderr = finalStderr.writable;

      for (const red of cmd.redirections) {
        const fullTarget = red.target ? (red.target.startsWith('/') ? red.target : `${this.cwd}/${red.target}`) : undefined;
        
        if (red.type === '<' && fullTarget) {
          stdin = await this.vfs.readFile({ path: fullTarget });
        } else if ((red.type === '>' || red.type === '>>') && fullTarget) {
          const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
          stdout = writable;
          this.vfs.writeFile({ path: fullTarget, stream: readable }).catch(console.error);
        } else if (red.type === '2>' && fullTarget) {
          const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
          stderr = writable;
          this.vfs.writeFile({ path: fullTarget, stream: readable }).catch(console.error);
        } else if (red.type === '2>&1') {
          stderr = stdout;
        }
      }

      const definition = this.commands.get(cmd.command);
      if (!definition) throw new Error(`Command not found: ${cmd.command}`);

      const context: CommandContext = {
        args: cmd.args,
        env: { ...this.env },
        cwd: this.cwd,
        vfs: this.vfs,
        stdin,
        stdout,
        stderr,
        setCwd: ({ path }: { path: string }) => {
          this.env.OLDPWD = this.cwd;
          this.cwd = path;
          this.env.PWD = path;
        },
        setEnv: ({ key, value }: { key: string; value: string }) => {
          this.env[key] = value;
        },
        unsetEnv: ({ key }: { key: string }) => {
          delete this.env[key];
        },
        getHistory: () => [...this.history],
        getCommandMeta: ({ name }: { name: string }) => this.commands.get(name)?.meta,
        getCommandNames: () => Array.from(this.commands.keys()),
        text: () => createTextHelpers({ stdin, stdout, stderr }),
      };

      return definition.fn({ context });
    });

    const stdoutChunks: Uint8Array[] = [];
    const stderrChunks: Uint8Array[] = [];
    const stdoutReader = finalStdout.readable.getReader();
    const stderrReader = finalStderr.readable.getReader();

    const readStdout = (async () => {
      while (true) {
        const { done, value } = await stdoutReader.read();
        if (done) break;
        stdoutChunks.push(value);
      }
    })();

    const readStderr = (async () => {
      while (true) {
        const { done, value } = await stderrReader.read();
        if (done) break;
        stderrChunks.push(value);
      }
    })();

    try {
      const results = await Promise.all(commandPromises);
      const lastResult = results[results.length - 1];

      await finalStdout.writable.close();
      await finalStderr.writable.close();
      await Promise.all([readStdout, readStderr]);

      const decoder = new TextDecoder();
      const output = decoder.decode(this.concatUint8Arrays(stdoutChunks));
      const errorOutput = decoder.decode(this.concatUint8Arrays(stderrChunks));

      const exitCode = lastResult?.exitCode ?? 0;
      this.env['?'] = exitCode.toString();

      return {
        exitCode,
        data: output,
        error: lastResult?.error || errorOutput || undefined,
      };
    } catch (e: any) {
      return { exitCode: 1, data: undefined, error: e.message || 'Unknown error' };
    }
  }

  private concatUint8Arrays(arrays: Uint8Array[]): Uint8Array {
    const totalLength = arrays.reduce((acc, arr) => acc + arr.length, 0);
    const result = new Uint8Array(totalLength);
    let offset = 0;
    for (const arr of arrays) {
      result.set(arr, offset);
      offset += arr.length;
    }
    return result;
  }
}
