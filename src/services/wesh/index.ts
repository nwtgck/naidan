import type { CommandDefinition, CommandResult, IVirtualFileSystem, CommandContext, ASTNode, Redirection } from './types';
import { VFS } from './vfs';
import { parseCommandLine } from './parser';
import { createTextHelpers } from './utils/io';

import { builtinCommands } from './commands';
import { help } from './commands/help';

interface Job {
  id: number;
  command: string;
  promise: Promise<CommandResult>;
  status: 'running' | 'done';
}

export class Wesh {
  public vfs: IVirtualFileSystem;
  private env: Record<string, string> = {};
  private cwd: string = '/';
  private history: string[] = [];
  private commands: Map<string, CommandDefinition> = new Map();
  private jobs: Map<number, Job> = new Map();
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

  registerCommand({ definition }: { definition: CommandDefinition }): void {
    this.commands.set(definition.meta.name, definition);
  }

  private registerInternalCommand(name: string, fn: ({ context }: { context: CommandContext }) => Promise<CommandResult>) {
      this.commands.set(name, {
          fn,
          meta: { name, description: 'Built-in command', usage: name }
      });
  }

  private expandVariables(text: string): string {
    return text.replace(/\$(\w+)|\${(\w+)}|\$\?/g, (match, p1, p2) => {
      if (match === '$?') return this.env['?'] || '0';
      const key = p1 || p2;
      if (key === 'RANDOM') return Math.floor(Math.random() * 32768).toString();
      return this.env[key || ''] || '';
    });
  }

  async execute({ commandLine }: { commandLine: string }): Promise<CommandResult> {
    if (!commandLine.trim()) {
      return { exitCode: 0, data: undefined, error: undefined };
    }

    this.history.push(commandLine);
    
    const stdoutChunks: Uint8Array[] = [];
    const stderrChunks: Uint8Array[] = [];

    const stdout = new WritableStream<Uint8Array>({
      write(chunk) { 
        stdoutChunks.push(chunk); 
      }
    });
    const stderr = new WritableStream<Uint8Array>({
      write(chunk) { stderrChunks.push(chunk); }
    });

    try {
      const rootNode = parseCommandLine({ commandLine, env: this.env });
      const result = await this.executeNode(rootNode, new ReadableStream(), stdout, stderr);
      
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

  private async executeNode(node: ASTNode, stdin: ReadableStream<Uint8Array>, stdout: WritableStream<Uint8Array>, stderr: WritableStream<Uint8Array>): Promise<CommandResult> {
    switch (node.kind) {
      case 'list':
        let lastResult: CommandResult = { exitCode: 0, data: undefined, error: undefined };
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
            const jobPromise = this.executeNode(part.node, stdin, stdout, stderr).then(res => {
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
             lastResult = await this.executeNode(part.node, stdin, stdout, stderr);
             previousOperator = part.operator;
          }
        }
        return lastResult;

      case 'pipeline':
        return this.executePipeline(node, stdin, stdout, stderr);

      case 'command':
        return this.executeCommand(node, stdin, stdout, stderr);

      case 'if':
        const conditionResult = await this.executeNode(node.condition, stdin, stdout, stderr);
        if (conditionResult.exitCode === 0) {
            return this.executeNode(node.thenBody, stdin, stdout, stderr);
        } else if (node.elseBody) {
            return this.executeNode(node.elseBody, stdin, stdout, stderr);
        }
        return { exitCode: 0, data: undefined, error: undefined };

      case 'for':
        let lastForRes: CommandResult = { exitCode: 0, data: undefined, error: undefined };
        const expandedItems: string[] = [];
        for (const item of node.items) {
            expandedItems.push(this.expandVariables(item));
        }

        for (const item of expandedItems) {
            this.env[node.variable] = item;
            lastForRes = await this.executeNode(node.body, stdin, stdout, stderr);
        }
        return lastForRes;

      case 'assignment':
        for (const assign of node.assignments) {
            this.env[assign.key] = this.expandVariables(assign.value);
        }
        return { exitCode: 0, data: undefined, error: undefined };
    }
  }

  private async executePipeline(node: { commands: ASTNode[] }, stdin: ReadableStream<Uint8Array>, stdout: WritableStream<Uint8Array>, stderr: WritableStream<Uint8Array>): Promise<CommandResult> {
      const commands = node.commands;
      if (commands.length === 0) return { exitCode: 0, data: undefined, error: undefined };

      const streams: Array<{ readable: ReadableStream<Uint8Array>; writable: WritableStream<Uint8Array> }> = [];
      for (let i = 0; i < commands.length - 1; i++) {
        let controller: ReadableStreamDefaultController<Uint8Array>;
        const readable = new ReadableStream<Uint8Array>({
            start(c) { controller = c; }
        });
        const writable = new WritableStream<Uint8Array>({
            write(chunk) { controller.enqueue(chunk); },
            close() { controller.close(); },
            abort(e) { controller.error(e); }
        });
        streams.push({ readable, writable });
      }

      const promises = commands.map((cmd, i) => {
          const myStdin = i === 0 ? stdin : streams[i-1]!.readable;
          const myStdout = i === commands.length - 1 ? stdout : streams[i]!.writable;
          return this.executeNode(cmd, myStdin, myStdout, stderr);
      });

      const results = await Promise.all(promises);
      const lastResult = results[results.length - 1]!;

      const exitCode = lastResult.exitCode;
      this.env['?'] = exitCode.toString();

      return lastResult;
  }

  private async executeCommand(node: { name: string; args: string[]; assignments: {key:string; value:string}[]; redirections: Redirection[] }, stdin: ReadableStream<Uint8Array>, stdout: WritableStream<Uint8Array>, stderr: WritableStream<Uint8Array>): Promise<CommandResult> {
    const cmdName = this.expandVariables(node.name);
    const definition = this.commands.get(cmdName);
    if (!definition) {
        throw new Error(`Command not found: ${cmdName}`);
    }

    const currentEnv = { ...this.env };
    for (const assign of node.assignments) {
        currentEnv[assign.key] = this.expandVariables(assign.value);
    }

    let cmdStdin = stdin;
    let cmdStdout = stdout;
    let cmdStderr = stderr;
    let backgroundPromises: Promise<void>[] = [];
    let createdStreams: WritableStream[] = [];

    for (const red of node.redirections) {
        const rawTarget = red.target ? this.expandVariables(red.target) : undefined;
        const fullTarget = rawTarget ? (rawTarget.startsWith('/') ? rawTarget : `${this.cwd}/${rawTarget}`) : undefined;

        switch (red.type) {
            case '<':
                if (fullTarget) {
                    cmdStdin = await this.vfs.readFile({ path: fullTarget });
                }
                break;
            case '>':
            case '>>':
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
                    cmdStdout = writable;
                    createdStreams.push(writable);
                    backgroundPromises.push(this.vfs.writeFile({ path: fullTarget, stream: readable }));
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
                    backgroundPromises.push(this.vfs.writeFile({ path: fullTarget, stream: readable }));
                }
                break;
            case '2>&1':
                cmdStderr = cmdStdout;
                break;
        }
    }

    const context: CommandContext = {
        args: node.args.map(a => this.expandVariables(a)),
        env: currentEnv,
        cwd: this.cwd,
        vfs: this.vfs,
        stdin: cmdStdin,
        stdout: cmdStdout,
        stderr: cmdStderr,
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
        getJobs: () => Array.from(this.jobs.values()).map(j => ({ id: j.id, command: j.command, status: j.status })),
        text: () => createTextHelpers({ stdin: cmdStdin, stdout: cmdStdout, stderr: cmdStderr }),
    };

    const result = await definition.fn({ context });

    for (const stream of createdStreams) {
        await stream.close().catch(() => {});
    }
    await Promise.all(backgroundPromises);

    return result;
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
