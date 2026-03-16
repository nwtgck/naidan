import type {
  WeshCommandDefinition,
  WeshCommandResult,
  WeshIVirtualFileSystem,
  WeshCommandContext,
  WeshASTNode,
  WeshRedirection,
  WeshFileHandle,
  WeshCommandNode,
  WeshProcessSubstitutionNode,
  WeshProcess,
  WeshKernel
} from './types';
import { WeshVFS } from './vfs';
import { Kernel } from './kernel';
import { parseCommandLine } from './parser';
import { createTextHelpers } from './utils/io';

import { builtinCommands } from './commands';
import { helpCommandDefinition } from './commands/help';

interface WeshJob {
  id: number;
  command: string;
  pid: number;
  status: 'running' | 'done';
}

interface WeshShellState {
  env: Map<string, string>;
  cwd: string;
}

export class Wesh {
  public vfs: WeshIVirtualFileSystem;
  public kernel: WeshKernel;

  private env: Map<string, string>;
  private cwd: string = '/';
  private history: string[] = [];
  private commands: Map<string, WeshCommandDefinition> = new Map();
  private jobs: Map<number, WeshJob> = new Map();
  private nextJobId: number = 1;

  private shellPid: number = 0;

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
    this.kernel = new Kernel({ vfs: this.vfs });

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
      return { exitCode: 0 };
    });
  }

  async init(): Promise<void> {
    const { pid } = await this.kernel.spawn({
      image: 'wesh',
      args: ['-l'],
      env: this.env,
      cwd: this.cwd
    });
    this.shellPid = pid;
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

  /**
   * Execute a shell script.
   * Low-level: All I/O goes to provided handles. Returns only exit status.
   */
  async execute(options: {
    script: string;
    stdin: WeshFileHandle;
    stdout: WeshFileHandle;
    stderr: WeshFileHandle;
  }): Promise<WeshCommandResult> {
    if (this.shellPid === 0) await this.init();

    const script = options.script.trim();
    if (!script) {
      return { exitCode: 0 };
    }

    this.history.push(script);

    try {
      const rootNode = parseCommandLine({ commandLine: script, env: this.env });
      const state: WeshShellState = { env: this.env, cwd: this.cwd };

      const result = await this.executeNode({
        node: rootNode,
        state,
        stdin: options.stdin,
        stdout: options.stdout,
        stderr: options.stderr
      });

      this.cwd = state.cwd;
      return result;
    } catch (e: unknown) {
      const message = e instanceof Error ? e.message : String(e);
      const encoder = new TextEncoder();
      await options.stderr.write({ buffer: encoder.encode(`wesh: ${message}\n`) });
      return { exitCode: 1 };
    }
  }

  private async executeNode(options: {
    node: WeshASTNode,
    state: WeshShellState,
    stdin: WeshFileHandle,
    stdout: WeshFileHandle,
    stderr: WeshFileHandle
  }): Promise<WeshCommandResult> {
    const { node, state, stdin, stdout, stderr } = options;

    switch (node.kind) {
    case 'list': {
      let lastResult: WeshCommandResult = { exitCode: 0 };
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
          const jobState = { env: new Map(state.env), cwd: state.cwd };

          const jobPromise = this.executeNode({
            node: part.node,
            state: jobState,
            stdin, stdout, stderr
          }).then(res => {
            const job = this.jobs.get(jobId);
            if (job) job.status = 'done';
            return res;
          });

          this.jobs.set(jobId, {
            id: jobId,
            command: cmdStr,
            pid: 0,
            status: 'running'
          });

          // Job notification to stderr (simulating bash)
          const encoder = new TextEncoder();
          await stderr.write({ buffer: encoder.encode(`[${jobId}] background\n`) });

          lastResult = { exitCode: 0 };
          previousOperator = '&';
        } else {
          lastResult = await this.executeNode({
            node: part.node,
            state,
            stdin, stdout, stderr
          });
          previousOperator = part.operator;
        }
      }
      return lastResult;
    }

    case 'pipeline':
      return this.executePipeline(options);

    case 'command':
      return this.executeCommand(options);

    case 'subshell': {
      const subshellState: WeshShellState = {
        env: new Map(state.env),
        cwd: state.cwd
      };
      return this.executeNode({
        node: node.list,
        state: subshellState,
        stdin, stdout, stderr
      });
    }

    case 'if': {
      const conditionResult = await this.executeNode({
        node: node.condition,
        state, stdin, stdout, stderr
      });
      if (conditionResult.exitCode === 0) {
        return this.executeNode({
          node: node.thenBody,
          state, stdin, stdout, stderr
        });
      } else if (node.elseBody) {
        return this.executeNode({
          node: node.elseBody,
          state, stdin, stdout, stderr
        });
      }
      return { exitCode: 0 };
    }

    case 'for': {
      let lastForRes: WeshCommandResult = { exitCode: 0 };
      const expandedItems: string[] = [];
      for (const item of node.items) {
        expandedItems.push(this.expandVariables(item, state.env));
      }

      for (const item of expandedItems) {
        state.env.set(node.variable, item);
        lastForRes = await this.executeNode({
          node: node.body,
          state, stdin, stdout, stderr
        });
      }
      return lastForRes;
    }

    case 'assignment':
      for (const assign of node.assignments) {
        state.env.set(assign.key, this.expandVariables(assign.value, state.env));
      }
      return { exitCode: 0 };
    }
  }

  private async executePipeline(options: {
    node: { commands: WeshASTNode[] },
    state: WeshShellState,
    stdin: WeshFileHandle,
    stdout: WeshFileHandle,
    stderr: WeshFileHandle
  }): Promise<WeshCommandResult> {
    const { node, state, stdin, stdout, stderr } = options;
    const commands = node.commands;
    if (commands.length === 0) return { exitCode: 0 };

    const pipes: Array<{ read: WeshFileHandle; write: WeshFileHandle }> = [];
    for (let i = 0; i < commands.length - 1; i++) {
      pipes.push(await this.kernel.pipe());
    }

    const promises: Promise<WeshCommandResult>[] = [];

    for (let i = 0; i < commands.length; i++) {
      const cmd = commands[i]!;
      const myStdin = i === 0 ? stdin : pipes[i-1]!.read;
      const myStdout = i === commands.length - 1 ? stdout : pipes[i]!.write;

      const pipelineState = { env: new Map(state.env), cwd: state.cwd };

      promises.push(
        this.executeNode({
          node: cmd,
          state: pipelineState,
          stdin: myStdin,
          stdout: myStdout,
          stderr: stderr
        }).then(async res => {
          if (i < commands.length - 1) {
            await pipes[i]!.write.close();
          }
          if (i > 0) {
            await pipes[i-1]!.read.close();
          }
          return res;
        })
      );
    }

    const results = await Promise.all(promises);
    const lastResult = results[results.length - 1]!;

    state.env.set('?', lastResult.exitCode.toString());

    return lastResult;
  }

  private async executeCommand(options: {
    node: WeshCommandNode,
    state: WeshShellState,
    stdin: WeshFileHandle,
    stdout: WeshFileHandle,
    stderr: WeshFileHandle
  }): Promise<WeshCommandResult> {
    const { node, state, stdin, stdout, stderr } = options;

    const expandedArgs: string[] = [];
    const procSubCleanups: Array<() => void> = [];
    const openHandles: WeshFileHandle[] = [];

    for (const arg of node.args) {
      if (typeof arg === 'string') {
        expandedArgs.push(this.expandVariables(arg, state.env));
      } else if (arg.kind === 'processSubstitution') {
        const { read, write } = await this.kernel.pipe();
        const id = Math.floor(Math.random() * 1000000);
        const path = `/dev/fd/${id}`;

        if (arg.type === 'input') {
          const subState = { env: new Map(state.env), cwd: state.cwd };
          this.executeNode({
            node: arg.list,
            state: subState,
            stdin, stdout: write, stderr
          }).then(() => write.close());

          this.vfs.registerSpecialFile({ path, handler: () => read });

          procSubCleanups.push(() => {
            this.vfs.unregisterSpecialFile({ path });
            read.close();
          });

        } else {
          const subState = { env: new Map(state.env), cwd: state.cwd };
          this.executeNode({
            node: arg.list,
            state: subState,
            stdin: read, stdout, stderr
          }).then(() => read.close());

          this.vfs.registerSpecialFile({ path, handler: () => write });
          procSubCleanups.push(() => {
            this.vfs.unregisterSpecialFile({ path });
            write.close();
          });
        }
        expandedArgs.push(path);
      }
    }

    const cmdName = this.expandVariables(node.name, state.env);
    const definition = this.commands.get(cmdName);

    if (!definition) {
      throw new Error(`Command not found: ${cmdName}`);
    }

    const currentEnv = new Map(state.env);
    for (const assign of node.assignments) {
      currentEnv.set(assign.key, this.expandVariables(assign.value, state.env));
    }

    let cmdStdin = stdin;
    let cmdStdout = stdout;
    let cmdStderr = stderr;

    for (const red of node.redirections) {
      const rawTarget = red.target ? this.expandVariables(red.target, state.env) : undefined;
      const fullTarget = rawTarget ? (rawTarget.startsWith('/') ? rawTarget : `${state.cwd}/${rawTarget}`) : undefined;

      switch (red.type) {
      case '<':
        if (fullTarget) {
          cmdStdin = await this.vfs.open({ path: fullTarget, flags: 0, mode: 0o644 });
          openHandles.push(cmdStdin);
        }
        break;
      case '<<':
      case '<<<':
        if (red.content !== undefined) {
          const { read, write } = await this.kernel.pipe();
          const encoder = new TextEncoder();
          const data = encoder.encode(red.content + '\n');
          await write.write({ buffer: data });
          await write.close();
          cmdStdin = read;
          openHandles.push(cmdStdin);
        }
        break;
      case '>':
        if (fullTarget) {
          cmdStdout = await this.vfs.open({ path: fullTarget, flags: 64 | 512, mode: 0o644 });
          openHandles.push(cmdStdout);
        }
        break;
      case '>>':
        if (fullTarget) {
          const h = await this.vfs.open({ path: fullTarget, flags: 64, mode: 0o644 });
          const stat = await h.stat();
          // We need a way to seek to end for O_APPEND.
          // Implementation of seek is missing in handle, but we can pass position to write if needed.
          // For now we assume cursor is at 0, which is incorrect for >>.
          cmdStdout = h;
          openHandles.push(cmdStdout);
        }
        break;
      case '2>':
        if (fullTarget) {
          cmdStderr = await this.vfs.open({ path: fullTarget, flags: 64 | 512, mode: 0o644 });
          openHandles.push(cmdStderr);
        }
        break;
      case '2>&1':
        cmdStderr = cmdStdout;
        break;
      }
    }

    const { pid, process: proc } = await this.kernel.spawn({
      image: cmdName,
      args: expandedArgs,
      env: currentEnv,
      cwd: state.cwd,
      fds: new Map([
        [0, cmdStdin],
        [1, cmdStdout],
        [2, cmdStderr]
      ])
    });

    const context: WeshCommandContext = {
      args: expandedArgs,
      env: currentEnv,
      cwd: state.cwd,
      pid: pid,
      kernel: this.kernel,
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
      proc.state = 'terminated';
      proc.exitCode = result.exitCode;
      return result;
    } finally {
      for (const h of openHandles) {
        await h.close();
      }
      for (const c of procSubCleanups) c();
    }
  }
}
