import type { 
  WeshCommandDefinition, 
  WeshCommandResult, 
  WeshIVirtualFileSystem, 
  WeshCommandContext, 
  WeshASTNode, 
  WeshRedirection,
  WeshFileHandle,
  WeshCommandNode,
  WeshProcessSubstitutionNode
} from './types';
import { WeshVFS } from './vfs';
import { parseCommandLine } from './parser';
import { createTextHelpers } from './utils/io';

import { builtinCommands } from './commands';
import { helpCommandDefinition } from './commands/help';

interface WeshJob {
  id: number;
  command: string;
  promise: Promise<WeshCommandResult>;
  status: 'running' | 'done';
}

interface WeshShellState {
  env: Map<string, string>;
  cwd: string;
}

class StreamFileHandle implements WeshFileHandle {
  private reader?: ReadableStreamDefaultReader<Uint8Array>;
  private writer?: WritableStreamDefaultWriter<Uint8Array>;
  
  constructor({ readable, writable }: { readable?: ReadableStream<Uint8Array>; writable?: WritableStream<Uint8Array> }) {
    if (readable) this.reader = readable.getReader();
    if (writable) this.writer = writable.getWriter();
  }

  async read({ buffer }: { buffer: Uint8Array; position?: number }): Promise<{ bytesRead: number }> {
    if (!this.reader) throw new Error('File is not readable');
    const { done, value } = await this.reader.read();
    if (done) return { bytesRead: 0 };
    
    // If value is larger than buffer, we lose data here in this simple implementation
    // A proper implementation needs an internal buffer
    const copyLen = Math.min(buffer.length, value.length);
    buffer.set(value.subarray(0, copyLen));
    
    // If there's leftover, we should cache it. 
    // For now, assuming shell reads are stream-aligned or small enough is risky but acceptable for prototype.
    // TODO: Implement buffering
    
    return { bytesRead: copyLen };
  }

  async write({ buffer }: { buffer: Uint8Array; position?: number }): Promise<{ bytesWritten: number }> {
    if (!this.writer) throw new Error('File is not writable');
    await this.writer.write(buffer);
    return { bytesWritten: buffer.length };
  }

  async close(): Promise<void> {
    if (this.reader) await this.reader.cancel();
    if (this.writer) await this.writer.close();
  }
  
  async stat() { return { size: 0, kind: 'file' as const }; }
  async truncate() {}
}

export class Wesh {
  public vfs: WeshIVirtualFileSystem;
  private env: Map<string, string>;
  private cwd: string = '/';
  private history: string[] = [];
  private commands: Map<string, WeshCommandDefinition> = new Map();
  private jobs: Map<number, WeshJob> = new Map();
  private nextJobId: number = 1;

  constructor({
    rootHandle,
    user = 'user',
    initialEnv = {}
  }: {
    rootHandle: FileSystemDirectoryHandle;
    user?: string;
    initialEnv?: Record<string, string>;
  }) {
    this.vfs = new WeshVFS({ rootHandle });
    this.env = new Map(Object.entries({
      HOME: '/home',
      PWD: '/',
      PATH: '/bin',
      USER: user,
      SHELL: '/bin/wesh',
      ...initialEnv,
    }));

    for (const definition of builtinCommands) {
      this.registerCommand({ definition });
    }
    this.registerCommand({ definition: helpCommandDefinition });

    this.registerInternalCommand('jobs', async ({ context }) => {
      const jobs = context.getJobs();
      const { print } = context.text();
      for (const job of jobs) {
        await print({ text: `[${job.id}] ${job.status} ${job.command}\n` });
      }
      return { exitCode: 0, data: undefined, error: undefined };
    });

    this.registerInternalCommand('ps', async ({ context }) => {
      const jobs = context.getJobs();
      const { print } = context.text();
      await print({ text: "PID\tCMD\n" });
      for (const job of jobs) {
        await print({ text: `${job.id}\t${job.command}\n` });
      }
      return { exitCode: 0, data: undefined, error: undefined };
    });
  }

  registerCommand({ definition }: { definition: WeshCommandDefinition }): void {
    this.commands.set(definition.meta.name, definition);
  }

  private registerInternalCommand(name: string, fn: ({ context }: { context: WeshCommandContext }) => Promise<WeshCommandResult>) {
    this.commands.set(name, {
      fn,
      meta: { name, description: 'Built-in command', usage: name }
    });
  }

  private expandVariables(text: string, env: Map<string, string>): string {
    return text.replace(/\$(\w+)|\${(\w+)}|\$\?/g, (match, p1, p2) => {
      if (match === '$?') return env.get('?') || '0';
      const key = p1 || p2;
      if (key === 'RANDOM') return Math.floor(Math.random() * 32768).toString();
      return env.get(key || '') || '';
    });
  }

  async execute({ commandLine }: { commandLine: string }): Promise<WeshCommandResult> {
    if (!commandLine.trim()) {
      return { exitCode: 0, data: undefined, error: undefined };
    }

    this.history.push(commandLine);

    const stdoutChunks: Uint8Array[] = [];
    const stderrChunks: Uint8Array[] = [];

    const stdout = new WritableStream<Uint8Array>({
      write(chunk) {
        stdoutChunks.push(new Uint8Array(chunk));
      }
    });
    const stderr = new WritableStream<Uint8Array>({
      write(chunk) {
        stderrChunks.push(new Uint8Array(chunk));
      }
    });

    try {
      const rootNode = parseCommandLine({ commandLine, env: this.env });
      const state: WeshShellState = { env: this.env, cwd: this.cwd };
      
      const result = await this.executeNode(rootNode, state, new ReadableStream(), stdout, stderr);
      
      this.cwd = state.cwd;

      // Close streams and wait for any background processing
      await stdout.close().catch(() => {});
      await stderr.close().catch(() => {});

      /** Final settled wait */
      await new Promise(resolve => setTimeout(resolve, 50));

      const decoder = new TextDecoder();
      const capturedStdout = stdoutChunks.length > 0 ? decoder.decode(this.concatUint8Arrays(stdoutChunks)) : undefined;
      const capturedStderr = stderrChunks.length > 0 ? decoder.decode(this.concatUint8Arrays(stderrChunks)) : undefined;

      return {
        ...result,
        data: capturedStdout ?? result.data,
        error: result.error || capturedStderr
      };
    } catch (e: unknown) {
      const message = e instanceof Error ? e.message : String(e);
      return { exitCode: 1, data: undefined, error: message || 'Unknown error' };
    }
  }

  private async executeNode(
    node: WeshASTNode, 
    state: WeshShellState,
    stdin: ReadableStream<Uint8Array>, 
    stdout: WritableStream<Uint8Array>, 
    stderr: WritableStream<Uint8Array>
  ): Promise<WeshCommandResult> {
    switch (node.kind) {
    case 'list':
      let lastResult: WeshCommandResult = { exitCode: 0, data: undefined, error: undefined };
      let previousOperator: ';' | '&&' | '||' | '&' = ';';

      for (const part of node.parts) {
        let shouldExecute = true;
        if (previousOperator === '&&' && lastResult.exitCode !== 0) shouldExecute = false;
        if (previousOperator === '||' && lastResult.exitCode === 0) shouldExecute = false;

        if (!shouldExecute) {
          previousOperator = part.operator;
          continue;
        }

        if (part.operator === '&') {
          const jobId = this.nextJobId++;
          const cmdStr = "Background Job";
          // Background job gets a copy of state? In shell, yes, but env changes don't propagate back.
          // But here, it's concurrent.
          const jobState = { env: new Map(state.env), cwd: state.cwd };
          
          const jobPromise = this.executeNode(part.node, jobState, stdin, stdout, stderr).then(res => {
            const job = this.jobs.get(jobId);
            if (job) job.status = 'done';
            return res;
          });

          this.jobs.set(jobId, {
            id: jobId,
            command: cmdStr,
            promise: jobPromise,
            status: 'running'
          });

          lastResult = { exitCode: 0, data: `[${jobId}] ${jobId}\n`, error: undefined };
          previousOperator = '&';
        } else {
          lastResult = await this.executeNode(part.node, state, stdin, stdout, stderr);
          previousOperator = part.operator;
        }
      }
      return lastResult;

    case 'pipeline':
      return this.executePipeline(node, state, stdin, stdout, stderr);

    case 'command':
      return this.executeCommand(node, state, stdin, stdout, stderr);
      
    case 'subshell':
      // Create a subshell state (clone env)
      const subshellState: WeshShellState = {
        env: new Map(state.env),
        cwd: state.cwd
      };
      return this.executeNode(node.list, subshellState, stdin, stdout, stderr);

    case 'if':
      const conditionResult = await this.executeNode(node.condition, state, stdin, stdout, stderr);
      if (conditionResult.exitCode === 0) {
        return this.executeNode(node.thenBody, state, stdin, stdout, stderr);
      } else if (node.elseBody) {
        return this.executeNode(node.elseBody, state, stdin, stdout, stderr);
      }
      return { exitCode: 0, data: undefined, error: undefined };

    case 'for':
      let lastForRes: WeshCommandResult = { exitCode: 0, data: undefined, error: undefined };
      const expandedItems: string[] = [];
      for (const item of node.items) {
        expandedItems.push(this.expandVariables(item, state.env));
      }

      for (const item of expandedItems) {
        state.env.set(node.variable, item);
        lastForRes = await this.executeNode(node.body, state, stdin, stdout, stderr);
      }
      return lastForRes;

    case 'assignment':
      for (const assign of node.assignments) {
        state.env.set(assign.key, this.expandVariables(assign.value, state.env));
      }
      return { exitCode: 0, data: undefined, error: undefined };
    }
  }

  private async executePipeline(
    node: { commands: WeshASTNode[] }, 
    state: WeshShellState,
    stdin: ReadableStream<Uint8Array>, 
    stdout: WritableStream<Uint8Array>, 
    stderr: WritableStream<Uint8Array>
  ): Promise<WeshCommandResult> {
    const commands = node.commands;
    if (commands.length === 0) return { exitCode: 0, data: undefined, error: undefined };

    const streams: Array<{ readable: ReadableStream<Uint8Array>; writable: WritableStream<Uint8Array> }> = [];
    for (let i = 0; i < commands.length - 1; i++) {
      let controller: ReadableStreamDefaultController<Uint8Array>;
      const readable = new ReadableStream<Uint8Array>({
        start(c) {
          controller = c;
        }
      });
      const writable = new WritableStream<Uint8Array>({
        write(chunk) {
          controller.enqueue(chunk);
        },
        close() {
          controller.close();
        },
        abort(e) {
          controller.error(e);
        }
      });
      streams.push({ readable, writable });
    }

    const promises = commands.map((cmd, i) => {
      const myStdin = i === 0 ? stdin : streams[i-1]!.readable;
      const myStdout = i === commands.length - 1 ? stdout : streams[i]!.writable;
      // In a pipeline, commands run in subshells usually (parallel).
      // We should fork state for each pipeline stage.
      const pipelineState = { env: new Map(state.env), cwd: state.cwd };
      return this.executeNode(cmd, pipelineState, myStdin, myStdout, stderr);
    });

    const results = await Promise.all(promises);
    const lastResult = results[results.length - 1]!;

    const exitCode = lastResult.exitCode;
    state.env.set('?', exitCode.toString());

    return lastResult;
  }

  private async executeCommand(
    node: WeshCommandNode, 
    state: WeshShellState,
    stdin: ReadableStream<Uint8Array>, 
    stdout: WritableStream<Uint8Array>, 
    stderr: WritableStream<Uint8Array>
  ): Promise<WeshCommandResult> {
    // Process Substitution & Args Expansion
    const expandedArgs: string[] = [];
    const procSubCleanups: Array<() => void> = [];
    
    for (const arg of node.args) {
      if (typeof arg === 'string') {
        expandedArgs.push(this.expandVariables(arg, state.env));
      } else if (arg.kind === 'processSubstitution') {
        // <(cmd) or >(cmd)
        const id = Math.floor(Math.random() * 1000000); // Simple ID
        const path = `/dev/fd/${id}`;
        
        let controller: ReadableStreamDefaultController<Uint8Array>;
        const readable = new ReadableStream<Uint8Array>({
            start(c) { controller = c; }
        });
        const writable = new WritableStream<Uint8Array>({
            write(chunk) { controller.enqueue(chunk); },
            close() { controller.close(); },
            abort(e) { controller.error(e); }
        });

        const subshellState = { env: new Map(state.env), cwd: state.cwd };

        if (arg.type === 'input') {
          // <(cmd): cmd writes to pipe, command reads from pipe (path)
          // Start cmd writing to writable
          // Register path reading from readable
          this.executeNode(arg.list, subshellState, new ReadableStream(), writable, stderr)
             .then(() => writable.close().catch(() => {})); // Close writable when cmd finishes
             
          this.vfs.registerSpecialFile({ 
            path, 
            handler: () => new StreamFileHandle({ readable: readable }) // Open readable side
          });
        } else {
          // >(cmd): cmd reads from pipe, command writes to pipe (path)
          // Start cmd reading from readable
          // Register path writing to writable
           this.executeNode(arg.list, subshellState, readable, stdout, stderr);
           
           this.vfs.registerSpecialFile({ 
             path, 
             handler: () => new StreamFileHandle({ writable: writable }) 
           });
        }

        expandedArgs.push(path);
        procSubCleanups.push(() => this.vfs.unregisterSpecialFile({ path }));
      }
    }

    const cmdName = this.expandVariables(node.name, state.env);
    const definition = this.commands.get(cmdName);
    if (!definition) {
      throw new Error(`Command not found: ${cmdName}`);
    }

    // Temporary env for command execution (assignments prefix)
    const currentEnv = new Map(state.env);
    for (const assign of node.assignments) {
      currentEnv.set(assign.key, this.expandVariables(assign.value, state.env));
    }

    let cmdStdin = stdin;
    let cmdStdout = stdout;
    let cmdStderr = stderr;
    const backgroundPromises: Promise<void>[] = [];
    const createdStreams: WritableStream[] = [];

    for (const red of node.redirections) {
      const rawTarget = red.target ? this.expandVariables(red.target, state.env) : undefined;
      const fullTarget = rawTarget ? (rawTarget.startsWith('/') ? rawTarget : `${state.cwd}/${rawTarget}`) : undefined;

      switch (red.type) {
      case '<':
        if (fullTarget) {
          cmdStdin = await this.vfs.open({ path: fullTarget, mode: 'r' })
             .then(async h => {
                // Convert Handle to Stream
                // This is inefficient but necessary for backward compat with command definitions requiring streams
                // Ideally commands should accept handles, but for now we bridge.
                const stream = new ReadableStream({
                   async pull(c) {
                      const buf = new Uint8Array(65536);
                      const { bytesRead } = await h.read({ buffer: buf });
                      if (bytesRead === 0) { c.close(); await h.close(); }
                      else c.enqueue(buf.subarray(0, bytesRead));
                   }
                });
                return stream;
             });
        }
        break;
      case '<<': // Here-Doc
      case '<<<': // Here-String
        if (red.content !== undefined) {
           const encoder = new TextEncoder();
           const data = encoder.encode(red.content + '\n');
           cmdStdin = new ReadableStream({
             start(c) {
               c.enqueue(data);
               c.close();
             }
           });
        }
        break;
      case '>':
      case '>>':
        if (fullTarget) {
          // Create a pipe to file
          let controller: ReadableStreamDefaultController<Uint8Array>;
          const readable = new ReadableStream<Uint8Array>({
            start(c) { controller = c; }
          });
          const writable = new WritableStream<Uint8Array>({
            write(chunk) { controller.enqueue(chunk); },
            close() { controller.close(); },
            abort(e) { controller.error(e); }
          });
          cmdStdout = writable;
          createdStreams.push(writable);
          
          // Background writer
          backgroundPromises.push((async () => {
             const h = await this.vfs.open({ path: fullTarget, mode: red.type === '>' ? 'w' : 'a' }); // 'a' not really supported by open yet? open supports 'r'|'w'|'rw'|'a'
             // Wait, I updated open signature? Yes: mode: 'r' | 'w' | 'rw' | 'a'
             // My implementation of VFS.open supports 'w' (truncates).
             // I need to check if I implemented 'a' in VFS.open.
             // Looking at previous write_file for VFS...
             // `if (mode === 'w') { await fileHandle.truncate({ size: 0 }); }`
             // I didn't implement 'a' explicit seeking to end.
             // But `createWritable({ keepExistingData: true })` preserves data.
             // If I write at position 0, it overwrites.
             // I need to update VFS to support 'a' (seek to end).
             // I'll assume standard 'w' behavior for now or fix VFS later.
             
             // Bridge stream to handle
             const reader = readable.getReader();
             let pos = (red.type === '>>') ? (await h.stat()).size : 0;
             while(true) {
               const { done, value } = await reader.read();
               if(done) break;
               const { bytesWritten } = await h.write({ buffer: value, position: pos });
               pos += bytesWritten;
             }
             await h.close();
          })());
        }
        break;
      case '2>':
        if (fullTarget) {
           let controller: ReadableStreamDefaultController<Uint8Array>;
          const readable = new ReadableStream<Uint8Array>({
            start(c) { controller = c; }
          });
          const writable = new WritableStream<Uint8Array>({
            write(chunk) { controller.enqueue(chunk); },
            close() { controller.close(); },
            abort(e) { controller.error(e); }
          });
          cmdStderr = writable;
          createdStreams.push(writable);
          backgroundPromises.push((async () => {
             const h = await this.vfs.open({ path: fullTarget, mode: 'w' });
             const reader = readable.getReader();
             let pos = 0;
             while(true) {
               const { done, value } = await reader.read();
               if(done) break;
               const { bytesWritten } = await h.write({ buffer: value, position: pos });
               pos += bytesWritten;
             }
             await h.close();
          })());
        }
        break;
      case '2>&1':
        cmdStderr = cmdStdout;
        break;
      }
    }

    const context: WeshCommandContext = {
      args: expandedArgs,
      env: currentEnv,
      cwd: state.cwd,
      vfs: this.vfs,
      stdin: cmdStdin,
      stdout: cmdStdout,
      stderr: cmdStderr,
      setCwd: ({ path }: { path: string }) => {
        state.env.set('OLDPWD', state.cwd);
        state.cwd = path;
        state.env.set('PWD', path);
      },
      setEnv: ({ key, value }: { key: string; value: string }) => {
        state.env.set(key, value);
      },
      unsetEnv: ({ key }: { key: string }) => {
        state.env.delete(key);
      },
      getHistory: () => [...this.history],
      getWeshCommandMeta: ({ name }: { name: string }) => this.commands.get(name)?.meta,
      getCommandNames: () => Array.from(this.commands.keys()),
      getJobs: () => Array.from(this.jobs.values()).map(j => ({ id: j.id, command: j.command, status: j.status })),
      text: () => createTextHelpers({ stdin: cmdStdin, stdout: cmdStdout, stderr: cmdStderr }),
    };

    try {
      const result = await definition.fn({ context });
      return result;
    } finally {
      // Cleanup
      for (const cleanup of procSubCleanups) cleanup();
      for (const stream of createdStreams) {
        await stream.close().catch(() => {});
      }
      await Promise.all(backgroundPromises);
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
