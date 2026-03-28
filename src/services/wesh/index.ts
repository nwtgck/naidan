import { ReadonlyDirectoryHandle } from './readonly-directory-handle';
import type {
  WeshCommandDefinition,
  WeshCommandResult,
  WeshIVirtualFileSystem,
  WeshCommandContext,
  WeshASTNode,
  WeshFileHandle,
  WeshCommandNode,
  WeshPipelineNode,
  WeshTrapDisposition,
  WeshWaitStatus,
  WeshProcessSignalDisposition,
  WeshShellOption,
} from './types';
import { weshWaitStatusToExitCode } from './types';
import { WeshVFS } from './vfs';
import { WeshKernel } from './kernel';
import { parseCommandLine } from './parser';
import { createTextIoHelpers } from './utils/io';
import { normalizePath, resolvePath } from './path';
import { createWriteHandleFromStream } from './utils/stream';

import { builtinCommands } from './commands';
import { helpCommandDefinition } from './commands/help';

interface WeshJob {
  id: number;
  command: string;
  pid: number;
  status: 'running' | 'done';
}

interface WeshExecutionEnvironment {
  shellPid: number;
  pgid: number;
  env: Map<string, string>;
  aliases: Map<string, string>;
  functions: Map<string, WeshASTNode>;
  cwd: string;
  fds: Map<number, WeshFileHandle>;
  traps: Map<string, WeshTrapDisposition>;
  shellOptions: Map<WeshShellOption, boolean>;
  positionalArgs: string[];
  lastBackgroundPid: number | undefined;
}

type WeshExpansionMode = 'argv' | 'assignment' | 'redirection';

interface WeshExpandedField {
  text: string;
  parts: Array<{
    text: string;
    quoted: boolean;
  }>;
}

const WESH_SHELL_SPECIAL_FILES = {
  sh: '/bin/sh',
  bash: '/bin/bash',
} as const;

const WESH_SHELL_SPECIAL_FILE_CONTENT = {
  sh: '#!/bin/wesh\n# virtual sh entrypoint provided by wesh\n',
  bash: '#!/bin/wesh\n# virtual bash entrypoint provided by wesh\n',
} as const;

function stripShebangLine({
  script,
}: {
  script: string;
}): string {
  if (!script.startsWith('#!')) {
    return script;
  }

  const newlineIndex = script.indexOf('\n');
  if (newlineIndex < 0) {
    return '';
  }
  return script.slice(newlineIndex + 1);
}

class StaticTextFileHandle implements WeshFileHandle {
  private readonly bytes: Uint8Array;
  private readonly mode: number;
  private position = 0;

  constructor({
    text,
    mode,
  }: {
    text: string;
    mode: number;
  }) {
    this.bytes = new TextEncoder().encode(text);
    this.mode = mode;
  }

  async read(options: {
    buffer: Uint8Array;
    offset?: number;
    length?: number;
    position?: number;
  }): Promise<{ bytesRead: number }> {
    const bufferOffset = options.offset ?? 0;
    const length = options.length ?? (options.buffer.length - bufferOffset);
    const start = options.position ?? this.position;
    if (start >= this.bytes.length) {
      return { bytesRead: 0 };
    }

    const end = Math.min(start + length, this.bytes.length);
    const slice = this.bytes.subarray(start, end);
    options.buffer.set(slice, bufferOffset);
    if (options.position === undefined) {
      this.position = end;
    }
    return { bytesRead: slice.length };
  }

  async write(): Promise<{ bytesWritten: number }> {
    throw new Error('File is read-only');
  }

  async close(): Promise<void> {}

  async stat() {
    return {
      size: this.bytes.length,
      mode: this.mode,
      type: 'file' as const,
      mtime: 0,
      ino: 0,
      uid: 0,
      gid: 0,
    };
  }

  async truncate(): Promise<void> {
    throw new Error('File is read-only');
  }

  async ioctl(): Promise<{ ret: number }> {
    return { ret: 0 };
  }
}

class SharedFileHandle implements WeshFileHandle {
  private readonly state: {
    handle: WeshFileHandle;
    refCount: number;
    closed: boolean;
  };
  private closed = false;

  constructor({
    state,
  }: {
    state: {
      handle: WeshFileHandle;
      refCount: number;
      closed: boolean;
    };
  }) {
    this.state = state;
  }

  cloneReference(): SharedFileHandle {
    this.state.refCount += 1;
    return new SharedFileHandle({
      state: this.state,
    });
  }

  async read(options: {
    buffer: Uint8Array;
    offset?: number;
    length?: number;
    position?: number;
  }): Promise<{ bytesRead: number }> {
    return this.state.handle.read(options);
  }

  async write(options: {
    buffer: Uint8Array;
    offset?: number;
    length?: number;
    position?: number;
  }): Promise<{ bytesWritten: number }> {
    return this.state.handle.write(options);
  }

  async close(): Promise<void> {
    if (this.closed) {
      return;
    }
    this.closed = true;
    this.state.refCount -= 1;
    if (this.state.refCount <= 0 && !this.state.closed) {
      this.state.closed = true;
      await this.state.handle.close();
    }
  }

  async stat() {
    return this.state.handle.stat();
  }

  async truncate(options: { size: number }): Promise<void> {
    await this.state.handle.truncate(options);
  }

  async ioctl(options: { request: number; arg?: unknown }): Promise<{ ret: number }> {
    return this.state.handle.ioctl(options);
  }
}

function weshSignalConditionNames({
  signal,
}: {
  signal: number;
}): string[] {
  switch (signal) {
  case 2:
    return ['INT', 'SIGINT', '2'];
  case 13:
    return ['PIPE', 'SIGPIPE', '13'];
  default:
    return [signal.toString()];
  }
}

function weshSignalNumbersForCondition({
  condition,
}: {
  condition: string;
}): number[] {
  switch (condition) {
  case 'INT':
  case 'SIGINT':
  case '2':
    return [2];
  case 'PIPE':
  case 'SIGPIPE':
  case '13':
    return [13];
  default:
    return [];
  }
}

export class Wesh {
  public vfs: WeshIVirtualFileSystem;
  public kernel: WeshKernel;

  private env: Map<string, string>;
  private aliases: Map<string, string> = new Map();
  private cwd: string = '/';
  private history: string[] = [];
  private commands: Map<string, WeshCommandDefinition> = new Map();
  private jobs: Map<number, WeshJob> = new Map();
  private nextJobId: number = 1;
  private shellFds: Map<number, WeshFileHandle> = new Map();
  private traps: Map<string, WeshTrapDisposition> = new Map();
  private shellOptions: Map<WeshShellOption, boolean> = new Map([
    ['dotglob', false],
    ['extglob', false],
    ['failglob', false],
    ['globstar', false],
    ['nullglob', false],
  ]);
  private foregroundProcessGroupId: number | undefined;

  private shellPid: number = 0;

  constructor({
    rootHandle,
    user = 'user',
    initialEnv = {},
    initialCwd,
  }: {
    rootHandle: FileSystemDirectoryHandle | ReadonlyDirectoryHandle;
    user?: string;
    initialEnv?: Record<string, string>;
    initialCwd?: string;
  }) {
    this.vfs = new WeshVFS({ rootHandle });
    this.kernel = new WeshKernel({ vfs: this.vfs });

    const resolvedCwd = initialCwd ?? '/';
    this.cwd = resolvedCwd;

    this.env = new Map(Object.entries({
      HOME: '/',
      PWD: resolvedCwd,
      PATH: '/bin',
      USER: user,
      SHELL: '/bin/wesh',
      ...initialEnv,
    }));

    for (const definition of builtinCommands) {
      this.registerCommand({ definition });
    }
    this.registerCommand({ definition: helpCommandDefinition });
    this.registerCommand({ definition: this.createAliasCommandDefinition() });
    this.registerCommand({ definition: this.createUnaliasCommandDefinition() });
    this.registerCommand({ definition: this.createShellAliasCommandDefinition({ name: 'sh' }) });
    this.registerCommand({ definition: this.createShellAliasCommandDefinition({ name: 'bash' }) });
    this.vfs.registerSpecialFile({
      path: WESH_SHELL_SPECIAL_FILES.sh,
      handler: () => new StaticTextFileHandle({
        text: WESH_SHELL_SPECIAL_FILE_CONTENT.sh,
        mode: 0o555,
      }),
    });
    this.vfs.registerSpecialFile({
      path: WESH_SHELL_SPECIAL_FILES.bash,
      handler: () => new StaticTextFileHandle({
        text: WESH_SHELL_SPECIAL_FILE_CONTENT.bash,
        mode: 0o555,
      }),
    });

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
      cwd: this.cwd,
    });
    this.shellPid = pid;
  }

  registerCommand({ definition }: { definition: WeshCommandDefinition }): void {
    this.commands.set(definition.meta.name, definition);
  }

  async signalForegroundProcessGroup(options: { signal: number }): Promise<boolean> {
    if (this.foregroundProcessGroupId === undefined) {
      return false;
    }

    await this.kernel.killProcessGroup({
      pgid: this.foregroundProcessGroupId,
      signal: options.signal,
      excludedPids: [this.shellPid],
    });
    return true;
  }

  private registerInternalCommand(name: string, fn: ({ context }: { context: WeshCommandContext }) => Promise<WeshCommandResult>) {
    this.commands.set(name, {
      fn,
      meta: { name, description: 'Built-in command', usage: name }
    });
  }

  private createShellAliasCommandDefinition({
    name,
  }: {
    name: 'sh' | 'bash';
  }): WeshCommandDefinition {
    return {
      meta: {
        name,
        description: `Run commands using the ${name} shell compatibility entrypoint`,
        usage: `${name} [-c command] [file [argument...]]`,
      },
      fn: async ({ context }: { context: WeshCommandContext }): Promise<WeshCommandResult> => {
        if (context.args.length === 1 && context.args[0] === '--help') {
          await context.text().print({
            text: `\
${name}: ${name} shell compatibility entrypoint
usage: ${name} [-c command] [file [argument...]]
`,
          });
          return { exitCode: 0 };
        }

        if (context.args[0] === '-c') {
          const script = context.args[1];
          if (script === undefined) {
            await context.text().error({
              text: `${name}: option requires an argument -- 'c'\n`,
            });
            return { exitCode: 2 };
          }
          return context.executeShell({
            script,
            stdin: context.stdin,
            stdout: context.stdout,
            stderr: context.stderr,
          });
        }

        const scriptPath = context.args[0];
        if (scriptPath === undefined) {
          const scriptBytes = await this.readHandleToBytes({ handle: context.stdin });
          return context.executeShell({
            script: new TextDecoder().decode(scriptBytes),
            stdin: context.stdin,
            stdout: context.stdout,
            stderr: context.stderr,
          });
        }

        try {
          const path = resolvePath({
            cwd: context.cwd,
            path: scriptPath,
          });
          const bytes = await this.kernel.open({
            path,
            flags: {
              access: 'read',
              creation: 'never',
              truncate: 'preserve',
              append: 'preserve',
            },
          }).then(async (handle) => {
            try {
              return await this.readHandleToBytes({ handle });
            } finally {
              await handle.close();
            }
          });
          const childEnvironment = await this.spawnChildExecutionEnvironment({
            parentEnvironment: this.createExecutionEnvironment({
              shellPid: context.pid,
              pgid: context.process.getGroupId(),
              env: new Map(context.env),
              aliases: new Map(context.getAliases().map(({ name: aliasName, value }) => [aliasName, value])),
              functions: new Map(),
              cwd: context.cwd,
              fds: new Map(),
              traps: new Map(),
              shellOptions: new Map(context.getShellOptions()),
              positionalArgs: context.args.slice(1),
              lastBackgroundPid: undefined,
            }),
            pgid: context.process.getGroupId(),
          });
          childEnvironment.positionalArgs = context.args.slice(1);
          childEnvironment.env.set('0', scriptPath);
          this.syncSpecialParameters({ environment: childEnvironment });
          return this.executeShellInState({
            script: stripShebangLine({
              script: new TextDecoder().decode(bytes),
            }),
            environment: childEnvironment,
            stdin: context.stdin,
            stdout: context.stdout,
            stderr: context.stderr,
          });
        } catch (error: unknown) {
          const message = error instanceof Error ? error.message : String(error);
          await context.text().error({ text: `${name}: ${scriptPath}: ${message}\n` });
          return { exitCode: 1 };
        }
      },
    };
  }

  private createAliasCommandDefinition(): WeshCommandDefinition {
    return {
      meta: {
        name: 'alias',
        description: 'Define or display shell aliases',
        usage: 'alias [name[=value] ...]',
      },
      fn: async ({ context }: { context: WeshCommandContext }): Promise<WeshCommandResult> => {
        if (context.args.length === 1 && context.args[0] === '--help') {
          await context.text().print({
            text: `\
alias: define or display shell aliases
usage: alias [name[=value] ...]
`,
          });
          return { exitCode: 0 };
        }

        if (context.args.length === 0) {
          for (const alias of context.getAliases()) {
            await context.text().print({
              text: this.formatAliasDefinition({
                name: alias.name,
                value: alias.value,
              }),
            });
          }
          return { exitCode: 0 };
        }

        let exitCode = 0;
        for (const arg of context.args) {
          const equalsIndex = arg.indexOf('=');
          if (equalsIndex >= 0) {
            const name = arg.slice(0, equalsIndex);
            const value = arg.slice(equalsIndex + 1);
            if (!this.isValidAliasName({ name })) {
              await context.text().error({ text: `alias: ${name}: invalid alias name\n` });
              exitCode = 1;
              continue;
            }
            context.setAlias({ name, value });
            continue;
          }

          const existing = context.getAliases().find((entry) => entry.name === arg);
          if (existing === undefined) {
            await context.text().error({ text: `alias: ${arg}: not found\n` });
            exitCode = 1;
            continue;
          }
          await context.text().print({
            text: this.formatAliasDefinition({
              name: existing.name,
              value: existing.value,
            }),
          });
        }

        return { exitCode };
      },
    };
  }

  private createUnaliasCommandDefinition(): WeshCommandDefinition {
    return {
      meta: {
        name: 'unalias',
        description: 'Remove shell aliases',
        usage: 'unalias [-a] name [name ...]',
      },
      fn: async ({ context }: { context: WeshCommandContext }): Promise<WeshCommandResult> => {
        if (context.args.length === 1 && context.args[0] === '--help') {
          await context.text().print({
            text: `\
unalias: remove shell aliases
usage: unalias [-a] name [name ...]
`,
          });
          return { exitCode: 0 };
        }

        if (context.args.length === 1 && context.args[0] === '-a') {
          for (const alias of context.getAliases()) {
            context.unsetAlias({ name: alias.name });
          }
          return { exitCode: 0 };
        }

        if (context.args.length === 0) {
          await context.text().error({ text: 'unalias: usage: unalias [-a] name [name ...]\n' });
          return { exitCode: 1 };
        }

        let exitCode = 0;
        for (const arg of context.args) {
          if (arg.startsWith('-')) {
            await context.text().error({ text: `unalias: ${arg}: invalid option\n` });
            exitCode = 2;
            continue;
          }

          const existing = context.getAliases().find((entry) => entry.name === arg);
          if (existing === undefined) {
            await context.text().error({ text: `unalias: ${arg}: not found\n` });
            exitCode = 1;
            continue;
          }

          context.unsetAlias({ name: arg });
        }

        return { exitCode };
      },
    };
  }

  private isValidAliasName({
    name,
  }: {
    name: string;
  }): boolean {
    return name.length > 0
      && !name.startsWith('-')
      && !name.includes('/')
      && !/\s/u.test(name)
      && !name.includes('=');
  }

  private formatAliasDefinition({
    name,
    value,
  }: {
    name: string;
    value: string;
  }): string {
    return `alias ${name}='${value.replaceAll("'", "'\\''")}'\n`;
  }

  private resolveBuiltinCommand({
    name,
    cwd,
    env,
  }: {
    name: string;
    cwd: string;
    env: Map<string, string>;
  }): {
    definition: WeshCommandDefinition;
    resolved: {
      kind: 'builtin';
      name: string;
      meta: WeshCommandDefinition['meta'];
      invocationPath: string | undefined;
      resolution: 'builtin-name' | 'path-lookup' | 'explicit-path';
    };
  } | undefined {
    const direct = this.commands.get(name);
    if (direct !== undefined) {
      const shellAliasPath = (() => {
        switch (name) {
        case 'sh':
          return WESH_SHELL_SPECIAL_FILES.sh;
        case 'bash':
          return WESH_SHELL_SPECIAL_FILES.bash;
        default:
          return undefined;
        }
      })();
      return {
        definition: direct,
        resolved: {
          kind: 'builtin',
          name,
          meta: direct.meta,
          invocationPath: shellAliasPath,
          resolution: shellAliasPath === undefined ? 'builtin-name' : 'path-lookup',
        },
      };
    }

    if (name.includes('/')) {
      const normalizedPath = normalizePath({
        cwd,
        path: name,
      });
      const basename = normalizedPath.slice(normalizedPath.lastIndexOf('/') + 1);
      const definition = this.commands.get(basename);
      if (definition !== undefined) {
        return {
          definition,
          resolved: {
            kind: 'builtin',
            name: basename,
            meta: definition.meta,
            invocationPath: normalizedPath,
            resolution: 'explicit-path',
          },
        };
      }

      return undefined;
    }

    const pathValue = env.get('PATH') ?? '';
    const pathEntries = pathValue.split(':').filter((entry) => entry.length > 0);
    for (const entry of pathEntries) {
      const candidate = resolvePath({
        cwd,
        path: entry === '' ? '.' : entry,
      });
      const invocationPath = candidate === '/'
        ? `/${name}`
        : `${candidate}/${name}`;
      const definition = this.commands.get(name);
      if (definition !== undefined) {
        return {
          definition,
          resolved: {
            kind: 'builtin',
            name,
            meta: definition.meta,
            invocationPath,
            resolution: 'path-lookup',
          },
        };
      }
    }

    return undefined;
  }

  private async readHandleToBytes({
    handle,
  }: {
    handle: WeshFileHandle;
  }): Promise<Uint8Array> {
    const chunks: Uint8Array[] = [];
    let totalLength = 0;

    while (true) {
      const buffer = new Uint8Array(64 * 1024);
      const { bytesRead } = await handle.read({ buffer });
      if (bytesRead === 0) {
        break;
      }
      chunks.push(buffer.subarray(0, bytesRead));
      totalLength += bytesRead;
    }

    if (chunks.length === 1) {
      return new Uint8Array(chunks[0]!);
    }

    const result = new Uint8Array(totalLength);
    let offset = 0;
    for (const chunk of chunks) {
      result.set(chunk, offset);
      offset += chunk.length;
    }
    return result;
  }

  private async resolveShebangScript({
    name,
    cwd,
    env,
  }: {
    name: string;
    cwd: string;
    env: Map<string, string>;
  }): Promise<{ scriptPath: string; interpreter: string; interpreterArgs: string[] } | undefined> {
    const candidatePaths = (() => {
      if (name.includes('/')) {
        return [resolvePath({ cwd, path: name })];
      }

      const pathValue = env.get('PATH') ?? '';
      const pathEntries = pathValue.split(':').filter((entry) => entry.length > 0);
      return pathEntries.map((entry) => {
        const base = resolvePath({
          cwd,
          path: entry,
        });
        return base === '/' ? `/${name}` : `${base}/${name}`;
      });
    })();

    for (const candidatePath of candidatePaths) {
      try {
        const handle = await this.kernel.open({
          path: candidatePath,
          flags: {
            access: 'read',
            creation: 'never',
            truncate: 'preserve',
            append: 'preserve',
          },
        });
        const bytes = await this.readHandleToBytes({ handle });
        await handle.close();
        const text = new TextDecoder().decode(bytes);
        const firstLine = text.split('\n', 1)[0] ?? '';
        if (!firstLine.startsWith('#!')) {
          continue;
        }
        const shebang = firstLine.slice(2).trim();
        if (shebang.length === 0) {
          continue;
        }
        const parts = shebang.split(/\s+/u);
        const interpreter = parts[0];
        if (interpreter === undefined) {
          continue;
        }
        const interpreterArgs = parts.slice(1);
        if (interpreter === '/usr/bin/env') {
          const envInterpreter = interpreterArgs[0];
          if (envInterpreter === undefined) {
            continue;
          }
          return {
            scriptPath: candidatePath,
            interpreter: envInterpreter,
            interpreterArgs: interpreterArgs.slice(1),
          };
        }
        return {
          scriptPath: candidatePath,
          interpreter,
          interpreterArgs,
        };
      } catch {
        continue;
      }
    }

    return undefined;
  }

  private expandAliasCommandNode({
    node,
    environment,
    expandedAliases,
  }: {
    node: WeshCommandNode;
    environment: WeshExecutionEnvironment;
    expandedAliases: Set<string>;
  }): WeshCommandNode {
    if (expandedAliases.has(node.name)) {
      return node;
    }
    const aliasValue = environment.aliases.get(node.name);
    if (aliasValue === undefined) {
      return node;
    }

    const parsed = parseCommandLine({
      commandLine: aliasValue,
      env: environment.env,
    });
    switch (parsed.kind) {
    case 'command':
      break;
    case 'assignment':
    case 'for':
    case 'if':
    case 'list':
    case 'pipeline':
    case 'while':
    case 'until':
    case 'case':
    case 'functionDefinition':
    case 'arithmeticCommand':
    case 'redirected':
    case 'subshell':
      return node;
    default: {
      const _ex: never = parsed;
      throw new Error(`Unhandled alias expansion node: ${JSON.stringify(_ex)}`);
    }
    }

    return this.expandAliasCommandNode({
      node: {
        kind: 'command',
        assignments: [
          ...node.assignments,
          ...parsed.assignments,
        ],
        name: parsed.name,
        args: [
          ...parsed.args,
          ...node.args,
        ],
        redirections: [
          ...parsed.redirections,
          ...node.redirections,
        ],
      },
      environment,
      expandedAliases: new Set([
        ...expandedAliases,
        node.name,
      ]),
    });
  }

  private parseWordParts({
    raw,
  }: {
    raw: string;
  }): Array<{
    text: string;
    quoted: boolean;
    expandVariables: boolean;
  }> {
    const parts: Array<{
      text: string;
      quoted: boolean;
      expandVariables: boolean;
    }> = [];

    let mode: 'unquoted' | 'single' | 'double' = 'unquoted';
    let current = '';

    const toPartMeta = ({
      currentMode,
    }: {
      currentMode: 'unquoted' | 'single' | 'double';
    }): {
      quoted: boolean;
      expandVariables: boolean;
    } => {
      switch (currentMode) {
      case 'unquoted':
        return {
          quoted: false,
          expandVariables: true,
        };
      case 'single':
        return {
          quoted: true,
          expandVariables: false,
        };
      case 'double':
        return {
          quoted: true,
          expandVariables: true,
        };
      default: {
        const _ex: never = currentMode;
        throw new Error(`Unhandled mode: ${_ex}`);
      }
      }
    };

    const pushCurrent = ({
      nextMode,
    }: {
      nextMode: 'unquoted' | 'single' | 'double';
    }) => {
      if (current.length === 0 && mode === nextMode) {
        return;
      }

      const meta = toPartMeta({ currentMode: mode });
      parts.push({
        text: current,
        quoted: meta.quoted,
        expandVariables: meta.expandVariables,
      });
      current = '';
      mode = nextMode;
    };

    for (let index = 0; index < raw.length; index++) {
      const char = raw[index];
      if (char === undefined) {
        continue;
      }

      const currentMode: string = mode;
      switch (currentMode) {
      case 'single':
        if (char === "'") {
          pushCurrent({ nextMode: 'unquoted' });
        } else {
          current += char;
        }
        continue;
      case 'double':
        if (char === '"') {
          pushCurrent({ nextMode: 'unquoted' });
          continue;
        }

        if (char === '\\') {
          const nextChar = raw[index + 1];
          if (nextChar !== undefined && ['\\', '"', '$'].includes(nextChar)) {
            current += nextChar;
            index += 1;
            continue;
          }
        }

        current += char;
        continue;
      case 'unquoted':
        break;
      default:
        throw new Error(`Unhandled mode: ${currentMode}`);
      }

      if (char === "'") {
        pushCurrent({ nextMode: 'single' });
        continue;
      }

      if (char === '"') {
        pushCurrent({ nextMode: 'double' });
        continue;
      }

      if (char === '\\') {
        const nextChar = raw[index + 1];
        if (nextChar !== undefined) {
          current += nextChar;
          index += 1;
          continue;
        }
      }

      current += char;
    }

    const meta = toPartMeta({ currentMode: mode });
    parts.push({
      text: current,
      quoted: meta.quoted,
      expandVariables: meta.expandVariables,
    });

    return parts;
  }

  private findBraceExpansion({
    raw,
  }: {
    raw: string;
  }): { start: number; end: number; parts: string[] } | undefined {
    let mode: 'unquoted' | 'single' | 'double' = 'unquoted';

    for (let index = 0; index < raw.length; index += 1) {
      const char = raw[index];
      if (char === undefined) {
        continue;
      }

      switch (mode) {
      case 'single':
        if (char === "'") {
          mode = 'unquoted';
        }
        continue;
      case 'double':
        if (char === '"') {
          mode = 'unquoted';
          continue;
        }
        if (char === '\\') {
          index += 1;
        }
        continue;
      case 'unquoted':
        break;
      default: {
        const _ex: never = mode;
        throw new Error(`Unhandled mode: ${_ex}`);
      }
      }

      if (char === '\\') {
        index += 1;
        continue;
      }

      if (char === "'") {
        mode = 'single';
        continue;
      }

      if (char === '"') {
        mode = 'double';
        continue;
      }

      if (char !== '{') {
        continue;
      }

      const expansion = this.findBraceExpansionEnding({
        raw,
        startIndex: index,
      });
      if (expansion !== undefined) {
        return expansion;
      }
    }

    return undefined;
  }

  private findBraceExpansionEnding({
    raw,
    startIndex,
  }: {
    raw: string;
    startIndex: number;
  }): { start: number; end: number; parts: string[] } | undefined {
    let mode: 'unquoted' | 'single' | 'double' = 'unquoted';
    let depth = 0;
    let currentPart = '';
    const parts: string[] = [];
    let sawComma = false;

    for (let index = startIndex; index < raw.length; index += 1) {
      const char = raw[index];
      if (char === undefined) {
        continue;
      }

      if (index === startIndex) {
        depth = 1;
        continue;
      }

      switch (mode) {
      case 'single':
        if (char === "'") {
          mode = 'unquoted';
        }
        currentPart += char;
        continue;
      case 'double':
        if (char === '"') {
          mode = 'unquoted';
          currentPart += char;
          continue;
        }
        if (char === '\\') {
          const nextChar = raw[index + 1];
          currentPart += char;
          if (nextChar !== undefined) {
            currentPart += nextChar;
            index += 1;
          }
          continue;
        }
        currentPart += char;
        continue;
      case 'unquoted':
        break;
      default: {
        const _ex: never = mode;
        throw new Error(`Unhandled mode: ${_ex}`);
      }
      }

      if (char === '\\') {
        const nextChar = raw[index + 1];
        currentPart += char;
        if (nextChar !== undefined) {
          currentPart += nextChar;
          index += 1;
        }
        continue;
      }

      if (char === "'") {
        mode = 'single';
        currentPart += char;
        continue;
      }

      if (char === '"') {
        mode = 'double';
        currentPart += char;
        continue;
      }

      if (char === '{') {
        depth += 1;
        currentPart += char;
        continue;
      }

      if (char === '}') {
        depth -= 1;
        if (depth === 0) {
          if (!sawComma) {
            const rangeParts = this.expandBraceRange({
              content: currentPart,
            });
            if (rangeParts === undefined) {
              return undefined;
            }
            return {
              start: startIndex,
              end: index,
              parts: rangeParts,
            };
          }
          parts.push(currentPart);
          return {
            start: startIndex,
            end: index,
            parts,
          };
        }
        currentPart += char;
        continue;
      }

      if (char === ',' && depth === 1) {
        sawComma = true;
        parts.push(currentPart);
        currentPart = '';
        continue;
      }

      currentPart += char;
    }

    return undefined;
  }

  private expandBraceRange({
    content,
  }: {
    content: string;
  }): string[] | undefined {
    const parts = content.split('..');
    if (parts.length !== 2 && parts.length !== 3) {
      return undefined;
    }

    const [startRaw, endRaw, stepRaw] = parts;

    if (startRaw === undefined || endRaw === undefined) {
      return undefined;
    }

    const numericRange = this.expandNumericBraceRange({
      startRaw,
      endRaw,
      stepRaw,
    });
    if (numericRange !== undefined) {
      return numericRange;
    }

    return this.expandCharacterBraceRange({
      startRaw,
      endRaw,
      stepRaw,
    });
  }

  private expandNumericBraceRange({
    startRaw,
    endRaw,
    stepRaw,
  }: {
    startRaw: string;
    endRaw: string;
    stepRaw: string | undefined;
  }): string[] | undefined {
    if (!/^-?\d+$/u.test(startRaw) || !/^-?\d+$/u.test(endRaw)) {
      return undefined;
    }

    const start = Number.parseInt(startRaw, 10);
    const end = Number.parseInt(endRaw, 10);
    const stepMagnitude = stepRaw === undefined
      ? 1
      : Math.abs(Number.parseInt(stepRaw, 10));

    if (!Number.isInteger(stepMagnitude) || stepMagnitude === 0) {
      return undefined;
    }

    const step = start <= end ? stepMagnitude : -stepMagnitude;

    const width = Math.max(startRaw.replace(/^-/, '').length, endRaw.replace(/^-/, '').length);
    const pad = /^-?0\d/u.test(startRaw) || /^-?0\d/u.test(endRaw);
    const values: string[] = [];

    if (step > 0) {
      for (let value = start; value <= end; value += step) {
        values.push(this.formatBraceNumericValue({ value, width, pad }));
      }
      return values;
    }

    for (let value = start; value >= end; value += step) {
      values.push(this.formatBraceNumericValue({ value, width, pad }));
    }
    return values;
  }

  private formatBraceNumericValue({
    value,
    width,
    pad,
  }: {
    value: number;
    width: number;
    pad: boolean;
  }): string {
    if (!pad) {
      return value.toString();
    }

    const sign = value < 0 ? '-' : '';
    const digits = Math.abs(value).toString().padStart(width, '0');
    return `${sign}${digits}`;
  }

  private expandCharacterBraceRange({
    startRaw,
    endRaw,
    stepRaw,
  }: {
    startRaw: string;
    endRaw: string;
    stepRaw: string | undefined;
  }): string[] | undefined {
    if (startRaw.length !== 1 || endRaw.length !== 1) {
      return undefined;
    }

    const start = startRaw.codePointAt(0);
    const end = endRaw.codePointAt(0);
    if (start === undefined || end === undefined) {
      return undefined;
    }

    const stepMagnitude = stepRaw === undefined
      ? 1
      : Math.abs(Number.parseInt(stepRaw, 10));

    if (!Number.isInteger(stepMagnitude) || stepMagnitude === 0) {
      return undefined;
    }

    const step = start <= end ? stepMagnitude : -stepMagnitude;

    const values: string[] = [];
    if (step > 0) {
      for (let value = start; value <= end; value += step) {
        values.push(String.fromCodePoint(value));
      }
      return values;
    }

    for (let value = start; value >= end; value += step) {
      values.push(String.fromCodePoint(value));
    }
    return values;
  }

  private expandBraceExpressions({
    raw,
  }: {
    raw: string;
  }): string[] {
    const expansion = this.findBraceExpansion({ raw });
    if (expansion === undefined) {
      return [raw];
    }

    const prefix = raw.slice(0, expansion.start);
    const suffix = raw.slice(expansion.end + 1);
    const expanded: string[] = [];

    for (const part of expansion.parts) {
      const combined = `${prefix}${part}${suffix}`;
      expanded.push(...this.expandBraceExpressions({ raw: combined }));
    }

    return expanded;
  }

  private async expandPartVariables({
    text,
    env,
    environment,
  }: {
    text: string;
    env: Map<string, string>;
    environment: WeshExecutionEnvironment;
  }): Promise<string> {
    let result = '';

    for (let index = 0; index < text.length; index++) {
      const char = text[index];
      if (char !== '$') {
        result += char ?? '';
        continue;
      }

      const nextChar = text[index + 1];
      if (nextChar === '?') {
        result += env.get('?') ?? '0';
        index += 1;
        continue;
      }

      if (nextChar === '$') {
        result += env.get('$$') ?? '';
        index += 1;
        continue;
      }

      if (nextChar === '#') {
        result += env.get('#') ?? '0';
        index += 1;
        continue;
      }

      if (nextChar === '!') {
        result += env.get('!') ?? '';
        index += 1;
        continue;
      }

      if (nextChar === '0') {
        result += env.get('0') ?? '';
        index += 1;
        continue;
      }

      if (nextChar !== undefined && /[1-9]/.test(nextChar)) {
        result += env.get(nextChar) ?? '';
        index += 1;
        continue;
      }

      if (nextChar === '{') {
        const expansion = await this.expandBracedParameter({
          text,
          startIndex: index,
          env,
          environment,
        });
        result += expansion.value;
        index = expansion.endIndex;
        continue;
      }

      if (nextChar === '(') {
        const thirdChar = text[index + 2];
        if (thirdChar === '(') {
          const expansion = this.expandArithmeticExpansion({
            text,
            startIndex: index,
            env,
          });
          result += expansion.value;
          index = expansion.endIndex;
          continue;
        }
        const expansion = await this.expandCommandSubstitution({
          text,
          startIndex: index,
          environment,
        });
        result += expansion.value;
        index = expansion.endIndex;
        continue;
      }

      if (nextChar !== undefined && /[A-Za-z_]/.test(nextChar)) {
        let endIndex = index + 2;
        while (endIndex < text.length && /[A-Za-z0-9_]/.test(text[endIndex] ?? '')) {
          endIndex += 1;
        }

        const key = text.slice(index + 1, endIndex);
        if (key === 'RANDOM') {
          result += Math.floor(Math.random() * 32768).toString();
        } else {
          result += env.get(key) ?? '';
        }
        index = endIndex - 1;
        continue;
      }

      result += '$';
    }

    return result;
  }

  private async expandInlineSubstitutions({
    text,
    environment,
  }: {
    text: string;
    environment: WeshExecutionEnvironment;
  }): Promise<string> {
    let result = '';
    let mode: 'unquoted' | 'single' | 'double' = 'unquoted';

    for (let index = 0; index < text.length; index += 1) {
      const char = text[index];
      if (char === undefined) {
        continue;
      }

      switch (mode) {
      case 'single':
        result += char;
        if (char === "'") {
          mode = 'unquoted';
        }
        continue;
      case 'double':
        if (char === '"') {
          mode = 'unquoted';
          result += char;
          continue;
        }
        break;
      case 'unquoted':
        if (char === "'") {
          mode = 'single';
          result += char;
          continue;
        }
        if (char === '"') {
          mode = 'double';
          result += char;
          continue;
        }
        break;
      default: {
        const _ex: never = mode;
        throw new Error(`Unhandled mode: ${_ex}`);
      }
      }

      if (char === '\\') {
        result += char;
        const nextChar = text[index + 1];
        if (nextChar !== undefined) {
          result += nextChar;
          index += 1;
        }
        continue;
      }

      if (char === '$' && text[index + 1] === '(') {
        if (text[index + 2] === '(') {
          const expansion = this.expandArithmeticExpansion({
            text,
            startIndex: index,
            env: environment.env,
          });
          result += expansion.value;
          index = expansion.endIndex;
          continue;
        }
        const expansion = await this.expandCommandSubstitution({
          text,
          startIndex: index,
          environment,
        });
        result += expansion.value;
        index = expansion.endIndex;
        continue;
      }

      result += char;
    }

    return result;
  }

  private async expandBracedParameter({
    text,
    startIndex,
    env,
    environment,
  }: {
    text: string;
    startIndex: number;
    env: Map<string, string>;
    environment: WeshExecutionEnvironment;
  }): Promise<{
    value: string;
    endIndex: number;
  }> {
    const endIndex = text.indexOf('}', startIndex + 2);
    if (endIndex === -1) {
      return {
        value: '$',
        endIndex: startIndex,
      };
    }

    const expression = text.slice(startIndex + 2, endIndex);
    const expansionValue = await this.evaluateParameterExpansion({
      expression,
      env,
      environment,
    });
    return {
      value: expansionValue,
      endIndex,
    };
  }

  private async expandCommandSubstitution({
    text,
    startIndex,
    environment,
  }: {
    text: string;
    startIndex: number;
    environment: WeshExecutionEnvironment;
  }): Promise<{
    value: string;
    endIndex: number;
  }> {
    const parsed = this.findBalancedParenthesizedExpression({
      text,
      startIndex: startIndex + 1,
    });
    if (parsed === undefined) {
      return {
        value: '$',
        endIndex: startIndex,
      };
    }

    const chunks: Uint8Array[] = [];
    const captureHandle = createWriteHandleFromStream({
      target: new WritableStream<Uint8Array>({
        write: async (chunk) => {
          chunks.push(new Uint8Array(chunk));
        },
      }),
    });
    const childEnvironment = await this.spawnChildExecutionEnvironment({
      parentEnvironment: environment,
      pgid: environment.pgid,
    });
    const stdin = environment.fds.get(0);
    const stderr = environment.fds.get(2);
    if (stdin === undefined || stderr === undefined) {
      throw new Error('Missing standard file descriptors for command substitution');
    }
    const rawResult = await this.executeShellInState({
      script: parsed.content,
      environment: childEnvironment,
      stdin,
      stdout: captureHandle,
      stderr,
    });
    const result = await this.runExitTrapIfNeeded({
      result: rawResult,
      environment: childEnvironment,
      stdin,
      stdout: captureHandle,
      stderr,
    });
    if (result.exitCode !== 0) {
      environment.env.set('?', result.exitCode.toString());
    }

    let totalLength = 0;
    for (const chunk of chunks) {
      totalLength += chunk.length;
    }
    const bytes = new Uint8Array(totalLength);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.length;
    }
    const value = new TextDecoder().decode(bytes).replace(/\n+$/u, '');
    return {
      value,
      endIndex: parsed.endIndex,
    };
  }

  private expandArithmeticExpansion({
    text,
    startIndex,
    env,
  }: {
    text: string;
    startIndex: number;
    env: Map<string, string>;
  }): {
    value: string;
    endIndex: number;
  } {
    const parsed = this.findBalancedArithmeticExpression({
      text,
      startIndex,
    });
    if (parsed === undefined) {
      return {
        value: '$',
        endIndex: startIndex,
      };
    }
    const value = this.evaluateArithmeticExpression({
      expression: parsed.content,
      env,
    });
    return {
      value: value.toString(),
      endIndex: parsed.endIndex,
    };
  }

  private findBalancedParenthesizedExpression({
    text,
    startIndex,
  }: {
    text: string;
    startIndex: number;
  }): {
    content: string;
    endIndex: number;
  } | undefined {
    if (text[startIndex] !== '(') {
      return undefined;
    }
    let depth = 0;
    let mode: 'unquoted' | 'single' | 'double' = 'unquoted';
    for (let index = startIndex; index < text.length; index += 1) {
      const char = text[index];
      if (char === undefined) {
        continue;
      }
      switch (mode) {
      case 'single':
        if (char === "'") {
          mode = 'unquoted';
        }
        continue;
      case 'double':
        if (char === '"') {
          mode = 'unquoted';
          continue;
        }
        if (char === '\\') {
          index += 1;
        }
        continue;
      case 'unquoted':
        break;
      default: {
        const _ex: never = mode;
        throw new Error(`Unhandled mode: ${_ex}`);
      }
      }
      if (char === "'") {
        mode = 'single';
        continue;
      }
      if (char === '"') {
        mode = 'double';
        continue;
      }
      if (char === '\\') {
        index += 1;
        continue;
      }
      if (char === '(') {
        depth += 1;
        continue;
      }
      if (char === ')') {
        depth -= 1;
        if (depth === 0) {
          return {
            content: text.slice(startIndex + 1, index),
            endIndex: index,
          };
        }
      }
    }
    return undefined;
  }

  private findBalancedArithmeticExpression({
    text,
    startIndex,
  }: {
    text: string;
    startIndex: number;
  }): {
    content: string;
    endIndex: number;
  } | undefined {
    if (text.slice(startIndex, startIndex + 3) !== '$((') {
      return undefined;
    }
    let depth = 1;
    let mode: 'unquoted' | 'single' | 'double' = 'unquoted';
    for (let index = startIndex + 3; index < text.length; index += 1) {
      const char = text[index];
      const nextChar = text[index + 1];
      if (char === undefined) {
        continue;
      }
      switch (mode) {
      case 'single':
        if (char === "'") {
          mode = 'unquoted';
        }
        continue;
      case 'double':
        if (char === '"') {
          mode = 'unquoted';
          continue;
        }
        if (char === '\\') {
          index += 1;
        }
        continue;
      case 'unquoted':
        break;
      default: {
        const _ex: never = mode;
        throw new Error(`Unhandled mode: ${_ex}`);
      }
      }
      if (char === "'") {
        mode = 'single';
        continue;
      }
      if (char === '"') {
        mode = 'double';
        continue;
      }
      if (char === '\\') {
        index += 1;
        continue;
      }
      if (char === '(') {
        depth += 1;
        continue;
      }
      if (char === ')' && nextChar === ')') {
        depth -= 1;
        if (depth === 0) {
          return {
            content: text.slice(startIndex + 3, index),
            endIndex: index + 1,
          };
        }
        index += 1;
      }
    }
    return undefined;
  }

  private async evaluateParameterExpansion({
    expression,
    env,
    environment,
  }: {
    expression: string;
    env: Map<string, string>;
    environment: WeshExecutionEnvironment;
  }): Promise<string> {
    if (expression.length === 0) {
      return '';
    }

    if (expression.startsWith('#')) {
      const name = expression.slice(1);
      return this.getParameterValue({
        name,
        env,
      }).length.toString();
    }

    const patternOperatorMatch = expression.match(/^([A-Za-z_][A-Za-z0-9_]*)(##|#|%%|%)(.*)$/);
    if (patternOperatorMatch !== null) {
      const name = patternOperatorMatch[1]!;
      const operator = patternOperatorMatch[2] as '##' | '#' | '%%' | '%';
      const pattern = patternOperatorMatch[3] ?? '';
      return this.applyParameterPatternOperator({
        value: this.getParameterValue({
          name,
          env,
        }),
        operator,
        pattern: await this.expandPartVariables({
          text: pattern,
          env,
          environment,
        }),
      });
    }

    const operatorMatch = expression.match(/^([A-Za-z_][A-Za-z0-9_]*)(:?[-=?+])(.*)$/);
    if (operatorMatch !== null) {
      const name = operatorMatch[1]!;
      const operator = operatorMatch[2]!;
      const operand = operatorMatch[3] ?? '';
      return this.evaluateParameterOperator({
        name,
        operator,
        operand,
        env,
        environment,
      });
    }

    return this.getParameterValue({
      name: expression,
      env,
    });
  }

  private evaluateArithmeticExpression({
    expression,
    env,
  }: {
    expression: string;
    env: Map<string, string>;
  }): number {
    type ArithmeticToken =
      | { kind: 'number'; value: number }
      | { kind: 'identifier'; value: string }
      | { kind: 'operator'; value: string };
    type ArithmeticValue = {
      value: number;
      targetName: string | undefined;
    };

    const tokens: ArithmeticToken[] = [];
    for (let index = 0; index < expression.length;) {
      const char = expression[index];
      if (char === undefined) {
        break;
      }
      if (/\s/u.test(char)) {
        index += 1;
        continue;
      }
      const multiCharacterOperator = [
        '++', '--', '+=', '-=', '*=', '/=', '%=',
        '==', '!=', '<=', '>=', '&&', '||',
      ].find((candidate) => expression.startsWith(candidate, index));
      if (multiCharacterOperator !== undefined) {
        tokens.push({ kind: 'operator', value: multiCharacterOperator });
        index += multiCharacterOperator.length;
        continue;
      }
      if ('()+-*/%!<=>'.includes(char)) {
        tokens.push({ kind: 'operator', value: char });
        index += 1;
        continue;
      }
      if (/\d/u.test(char)) {
        let endIndex = index + 1;
        while (endIndex < expression.length && /\d/u.test(expression[endIndex] ?? '')) {
          endIndex += 1;
        }
        tokens.push({
          kind: 'number',
          value: Number.parseInt(expression.slice(index, endIndex), 10),
        });
        index = endIndex;
        continue;
      }
      if (/[A-Za-z_]/u.test(char)) {
        let endIndex = index + 1;
        while (endIndex < expression.length && /[A-Za-z0-9_]/u.test(expression[endIndex] ?? '')) {
          endIndex += 1;
        }
        tokens.push({
          kind: 'identifier',
          value: expression.slice(index, endIndex),
        });
        index = endIndex;
        continue;
      }
      throw new Error(`Unsupported arithmetic token: ${char}`);
    }

    let position = 0;
    const peek = (): ArithmeticToken | undefined => tokens[position];
    const consume = (): ArithmeticToken => {
      const token = tokens[position];
      if (token === undefined) {
        throw new Error('Unexpected end of arithmetic expression');
      }
      position += 1;
      return token;
    };
    const readVariable = ({
      name,
    }: {
      name: string;
    }): number => {
      const raw = env.get(name);
      if (raw === undefined || raw.length === 0) {
        return 0;
      }
      const parsed = Number.parseInt(raw, 10);
      return Number.isNaN(parsed) ? 0 : parsed;
    };
    const writeVariable = ({
      name,
      value,
    }: {
      name: string;
      value: number;
    }): number => {
      env.set(name, value.toString());
      return value;
    };
    const requireTarget = ({
      value,
    }: {
      value: ArithmeticValue;
    }): string => {
      if (value.targetName === undefined) {
        throw new Error('Arithmetic assignment requires a variable');
      }
      return value.targetName;
    };
    const toPlain = ({
      value,
    }: {
      value: number;
    }): ArithmeticValue => ({
      value,
      targetName: undefined,
    });

    const parsePrimary = (): ArithmeticValue => {
      const token = consume();
      switch (token.kind) {
      case 'number':
        return {
          value: token.value,
          targetName: undefined,
        };
      case 'identifier':
        return {
          value: readVariable({ name: token.value }),
          targetName: token.value,
        };
      case 'operator':
        if (token.value === '(') {
          const value = parseAssignment();
          const endToken = consume();
          if (endToken.kind !== 'operator' || endToken.value !== ')') {
            throw new Error("Expected ')' in arithmetic expression");
          }
          return {
            value: value.value,
            targetName: undefined,
          };
        }
        throw new Error(`Unexpected arithmetic operator: ${token.value}`);
      default: {
        const _ex: never = token;
        throw new Error(`Unhandled arithmetic token: ${JSON.stringify(_ex)}`);
      }
      }
    };

    const parsePostfix = (): ArithmeticValue => {
      const value = parsePrimary();
      const token = peek();
      switch (token?.kind) {
      case 'operator':
        switch (token.value) {
        case '++':
        case '--': {
          consume();
          const targetName = requireTarget({ value });
          const previous = readVariable({ name: targetName });
          const nextValue = (() => {
            switch (token.value) {
            case '++':
              return previous + 1;
            case '--':
              return previous - 1;
            default: {
              const _ex: never = token.value;
              throw new Error(`Unhandled arithmetic postfix operator: ${_ex}`);
            }
            }
          })();
          writeVariable({ name: targetName, value: nextValue });
          return toPlain({ value: previous });
        }
        case '+':
        case '-':
        case '*':
        case '/':
        case '%':
        case '==':
        case '!=':
        case '<':
        case '<=':
        case '>':
        case '>=':
        case '&&':
        case '||':
        case '=':
        case '+=':
        case '-=':
        case '*=':
        case '/=':
        case '%=':
        case '!':
        case '(':
        case ')':
          break;
        default: {
          throw new Error(`Unhandled arithmetic operator: ${token.value}`);
        }
        }
        break;
      case 'number':
      case 'identifier':
      case undefined:
        break;
      default: {
        const _ex: never = token;
        throw new Error(`Unhandled arithmetic token: ${JSON.stringify(_ex)}`);
      }
      }
      return value;
    };

    const parseUnary = (): ArithmeticValue => {
      const token = peek();
      if (token?.kind === 'operator' && ['+', '-', '!', '++', '--'].includes(token.value)) {
        consume();
        const operand = parseUnary();
        switch (token.value) {
        case '+':
          return toPlain({ value: operand.value });
        case '-':
          return toPlain({ value: -operand.value });
        case '!':
          return toPlain({ value: operand.value === 0 ? 1 : 0 });
        case '++': {
          const targetName = requireTarget({ value: operand });
          const nextValue = readVariable({ name: targetName }) + 1;
          return toPlain({ value: writeVariable({ name: targetName, value: nextValue }) });
        }
        case '--': {
          const targetName = requireTarget({ value: operand });
          const nextValue = readVariable({ name: targetName }) - 1;
          return toPlain({ value: writeVariable({ name: targetName, value: nextValue }) });
        }
        default: {
          throw new Error(`Unhandled arithmetic unary operator: ${token.value}`);
        }
        }
      }
      return parsePostfix();
    };

    const parseMultiplicative = (): ArithmeticValue => {
      let left = parseUnary();
      while (true) {
        const token = peek();
        if (token?.kind !== 'operator' || !['*', '/', '%'].includes(token.value)) {
          return left;
        }
        consume();
        const right = parseUnary();
        switch (token.value) {
        case '*':
          left = toPlain({ value: left.value * right.value });
          break;
        case '/':
          left = toPlain({ value: right.value === 0 ? 0 : Math.trunc(left.value / right.value) });
          break;
        case '%':
          left = toPlain({ value: right.value === 0 ? 0 : left.value % right.value });
          break;
        default: {
          throw new Error(`Unhandled arithmetic operator: ${token.value}`);
        }
        }
      }
    };

    const parseAdditive = (): ArithmeticValue => {
      let left = parseMultiplicative();
      while (true) {
        const token = peek();
        if (token?.kind !== 'operator' || !['+', '-'].includes(token.value)) {
          return left;
        }
        consume();
        const right = parseMultiplicative();
        left = toPlain({
          value: token.value === '+'
            ? left.value + right.value
            : left.value - right.value,
        });
      }
    };

    const parseComparison = (): ArithmeticValue => {
      let left = parseAdditive();
      while (true) {
        const token = peek();
        if (token?.kind !== 'operator' || !['<', '<=', '>', '>='].includes(token.value)) {
          return left;
        }
        consume();
        const right = parseAdditive();
        switch (token.value) {
        case '<':
          left = toPlain({ value: left.value < right.value ? 1 : 0 });
          break;
        case '<=':
          left = toPlain({ value: left.value <= right.value ? 1 : 0 });
          break;
        case '>':
          left = toPlain({ value: left.value > right.value ? 1 : 0 });
          break;
        case '>=':
          left = toPlain({ value: left.value >= right.value ? 1 : 0 });
          break;
        default: {
          throw new Error(`Unhandled arithmetic comparison operator: ${token.value}`);
        }
        }
      }
    };

    const parseEquality = (): ArithmeticValue => {
      let left = parseComparison();
      while (true) {
        const token = peek();
        if (token?.kind !== 'operator' || !['==', '!='].includes(token.value)) {
          return left;
        }
        consume();
        const right = parseComparison();
        left = toPlain({
          value: token.value === '=='
            ? (left.value === right.value ? 1 : 0)
            : (left.value !== right.value ? 1 : 0),
        });
      }
    };

    const parseLogicalAnd = (): ArithmeticValue => {
      let left = parseEquality();
      while (peek()?.kind === 'operator' && peek()?.value === '&&') {
        consume();
        const right = parseEquality();
        left = toPlain({
          value: left.value !== 0 && right.value !== 0 ? 1 : 0,
        });
      }
      return left;
    };

    const parseLogicalOr = (): ArithmeticValue => {
      let left = parseLogicalAnd();
      while (peek()?.kind === 'operator' && peek()?.value === '||') {
        consume();
        const right = parseLogicalAnd();
        left = toPlain({
          value: left.value !== 0 || right.value !== 0 ? 1 : 0,
        });
      }
      return left;
    };

    const parseAssignment = (): ArithmeticValue => {
      const left = parseLogicalOr();
      const token = peek();
      if (token?.kind !== 'operator' || !['=', '+=', '-=', '*=', '/=', '%='].includes(token.value)) {
        return left;
      }
      consume();
      const right = parseAssignment();
      const targetName = requireTarget({ value: left });
      const current = readVariable({ name: targetName });
      switch (token.value) {
      case '=':
        return toPlain({ value: writeVariable({ name: targetName, value: right.value }) });
      case '+=':
        return toPlain({ value: writeVariable({ name: targetName, value: current + right.value }) });
      case '-=':
        return toPlain({ value: writeVariable({ name: targetName, value: current - right.value }) });
      case '*=':
        return toPlain({ value: writeVariable({ name: targetName, value: current * right.value }) });
      case '/=':
        return toPlain({ value: writeVariable({ name: targetName, value: right.value === 0 ? 0 : Math.trunc(current / right.value) }) });
      case '%=':
        return toPlain({ value: writeVariable({ name: targetName, value: right.value === 0 ? 0 : current % right.value }) });
      default: {
        throw new Error(`Unhandled arithmetic assignment operator: ${token.value}`);
      }
      }
    };

    const result = parseAssignment();
    if (position !== tokens.length) {
      throw new Error('Unexpected trailing arithmetic tokens');
    }
    return result.value;
  }

  private async evaluateParameterOperator({
    name,
    operator,
    operand,
    env,
    environment,
  }: {
    name: string;
    operator: string;
    operand: string;
    env: Map<string, string>;
    environment: WeshExecutionEnvironment;
  }): Promise<string> {
    const currentValue = env.get(name);
    const isSet = currentValue !== undefined;
    const isNull = currentValue === '';
    const requireNonNull = operator.startsWith(':');
    const shouldUseOperand = requireNonNull ? !isSet || isNull : !isSet;
    const expandedOperand = await this.expandPartVariables({
      text: operand,
      env,
      environment,
    });

    switch (operator) {
    case ':-':
    case '-':
      return shouldUseOperand ? expandedOperand : currentValue ?? '';
    case ':=':
    case '=':
      if (shouldUseOperand) {
        env.set(name, expandedOperand);
        return expandedOperand;
      }
      return currentValue ?? '';
    case ':+':
    case '+':
      return shouldUseOperand ? '' : expandedOperand;
    case ':?':
    case '?':
      if (shouldUseOperand) {
        throw new Error(expandedOperand.length > 0 ? `${name}: ${expandedOperand}` : `${name}: parameter null or not set`);
      }
      return currentValue ?? '';
    default:
      return currentValue ?? '';
    }
  }

  private applyParameterPatternOperator({
    value,
    operator,
    pattern,
  }: {
    value: string;
    operator: '##' | '#' | '%%' | '%';
    pattern: string;
  }): string {
    const compileParameterPattern = ({
      pattern,
    }: {
      pattern: string;
    }): RegExp => {
      let source = '^';

      for (let index = 0; index < pattern.length; index++) {
        const char = pattern[index];
        if (char === undefined) {
          continue;
        }

        if (char === '\\') {
          const nextChar = pattern[index + 1];
          if (nextChar !== undefined) {
            source += nextChar.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            index += 1;
            continue;
          }
          source += '\\\\';
          continue;
        }

        if (char === '*') {
          source += '.*';
          continue;
        }

        if (char === '?') {
          source += '.';
          continue;
        }

        if (char === '[') {
          const endIndex = pattern.indexOf(']', index + 1);
          if (endIndex !== -1) {
            let classContent = pattern.slice(index + 1, endIndex);
            if (classContent.startsWith('!')) {
              classContent = '^' + classContent.slice(1);
            }
            source += `[${classContent}]`;
            index = endIndex;
            continue;
          }
        }

        source += char.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      }

      source += '$';
      return new RegExp(source);
    };

    const matcher = compileParameterPattern({ pattern });
    const matchesPattern = ({
      text,
    }: {
      text: string;
    }): boolean => {
      return matcher.test(text);
    };

    switch (operator) {
    case '#': {
      for (let prefixLength = 0; prefixLength <= value.length; prefixLength++) {
        const prefix = value.slice(0, prefixLength);
        if (matchesPattern({ text: prefix })) {
          return value.slice(prefixLength);
        }
      }
      return value;
    }
    case '##': {
      for (let prefixLength = value.length; prefixLength >= 0; prefixLength--) {
        const prefix = value.slice(0, prefixLength);
        if (matchesPattern({ text: prefix })) {
          return value.slice(prefixLength);
        }
      }
      return value;
    }
    case '%': {
      for (let suffixStart = value.length; suffixStart >= 0; suffixStart--) {
        const suffix = value.slice(suffixStart);
        if (matchesPattern({ text: suffix })) {
          return value.slice(0, suffixStart);
        }
      }
      return value;
    }
    case '%%': {
      for (let suffixStart = 0; suffixStart <= value.length; suffixStart++) {
        const suffix = value.slice(suffixStart);
        if (matchesPattern({ text: suffix })) {
          return value.slice(0, suffixStart);
        }
      }
      return value;
    }
    default: {
      const _ex: never = operator;
      throw new Error(`Unhandled parameter pattern operator: ${_ex}`);
    }
    }
  }

  private getParameterValue({
    name,
    env,
  }: {
    name: string;
    env: Map<string, string>;
  }): string {
    if (name === 'RANDOM') {
      return Math.floor(Math.random() * 32768).toString();
    }
    return env.get(name) ?? '';
  }

  private splitExpandedFields({
    parts,
    mode,
  }: {
    parts: Array<{
      text: string;
      quoted: boolean;
    }>;
    mode: WeshExpansionMode;
  }): WeshExpandedField[] {
    switch (mode) {
    case 'assignment':
    case 'redirection':
      return [{
        text: parts.map((part) => part.text).join(''),
        parts,
      }];
    case 'argv':
      break;
    default: {
      const _ex: never = mode;
      throw new Error(`Unhandled expansion mode: ${_ex}`);
    }
    }

    const fields: WeshExpandedField[] = [];
    let currentText = '';
    let currentParts: Array<{ text: string; quoted: boolean }> = [];
    let hasContent = false;

    const flush = () => {
      if (!hasContent) {
        return;
      }

      fields.push({
        text: currentText,
        parts: currentParts,
      });
      currentText = '';
      currentParts = [];
      hasContent = false;
    };

    for (const part of parts) {
      if (part.quoted) {
        currentText += part.text;
        currentParts.push(part);
        hasContent = true;
        continue;
      }

      let chunk = '';
      for (const char of part.text) {
        if (/\s/.test(char)) {
          if (chunk.length > 0) {
            currentText += chunk;
            currentParts.push({ text: chunk, quoted: false });
            hasContent = true;
            chunk = '';
          }
          flush();
          continue;
        }
        chunk += char;
      }

      if (chunk.length > 0) {
        currentText += chunk;
        currentParts.push({ text: chunk, quoted: false });
        hasContent = true;
      }
    }

    flush();
    return fields;
  }

  private escapeGlobLiteral({
    text,
  }: {
    text: string;
  }): string {
    let result = '';
    for (const char of text) {
      if (char === '\\' || char === '*' || char === '?' || char === '[' || char === ']') {
        result += '\\';
      }
      result += char;
    }
    return result;
  }

  private hasActiveGlob({
    field,
    shellOptions,
  }: {
    field: WeshExpandedField;
    shellOptions: Map<WeshShellOption, boolean>;
  }): boolean {
    return field.parts.some((part) => {
      if (part.quoted) {
        return false;
      }

      if (/[[*?]/.test(part.text)) {
        return true;
      }

      if (shellOptions.get('extglob') === true) {
        return /(^|[^\\])[?*@!+]\(/.test(part.text);
      }

      return false;
    });
  }

  private buildGlobPattern({
    field,
  }: {
    field: WeshExpandedField;
  }): string {
    return field.parts
      .map((part) => part.quoted ? this.escapeGlobLiteral({ text: part.text }) : part.text)
      .join('');
  }

  private compileGlobComponent({
    pattern,
    shellOptions,
  }: {
    pattern: string;
    shellOptions: Map<WeshShellOption, boolean>;
  }): RegExp {
    const parsePattern = ({
      text,
      stopAtPipeOrParen,
    }: {
      text: string;
      stopAtPipeOrParen: boolean;
    }): { source: string; nextIndex: number } => {
      let source = '';
      let index = 0;

      while (index < text.length) {
        const char = text[index];
        if (char === undefined) {
          index += 1;
          continue;
        }

        if (stopAtPipeOrParen && (char === '|' || char === ')')) {
          break;
        }

        if (char === '\\') {
          const nextChar = text[index + 1];
          if (nextChar !== undefined) {
            source += nextChar.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            index += 2;
            continue;
          }
          source += '\\\\';
          index += 1;
          continue;
        }

        if (
          shellOptions.get('extglob') === true &&
          ['?', '*', '+', '@', '!'].includes(char) &&
          text[index + 1] === '('
        ) {
          const operator = char as '?' | '*' | '+' | '@' | '!';
          const parsedExtglob = this.parseExtglobPattern({
            text,
            startIndex: index + 2,
            shellOptions,
          });
          if (parsedExtglob !== undefined) {
            switch (operator) {
            case '@':
              source += `(?:${parsedExtglob.source})`;
              break;
            case '?':
              source += `(?:${parsedExtglob.source})?`;
              break;
            case '*':
              source += `(?:${parsedExtglob.source})*`;
              break;
            case '+':
              source += `(?:${parsedExtglob.source})+`;
              break;
            case '!':
              source += `(?:(?!^(?:${parsedExtglob.source})$)[^/]+)`;
              break;
            default: {
              const _ex: never = operator;
              throw new Error(`Unhandled extglob operator: ${_ex}`);
            }
            }
            index = parsedExtglob.nextIndex;
            continue;
          }
        }

        if (char === '*') {
          source += '[^/]*';
          index += 1;
          continue;
        }

        if (char === '?') {
          source += '[^/]';
          index += 1;
          continue;
        }

        if (char === '[') {
          const endIndex = text.indexOf(']', index + 1);
          if (endIndex !== -1) {
            let classContent = text.slice(index + 1, endIndex);
            if (classContent.startsWith('!')) {
              classContent = '^' + classContent.slice(1);
            }
            source += `[${classContent}]`;
            index = endIndex + 1;
            continue;
          }
        }

        source += char.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        index += 1;
      }

      return {
        source,
        nextIndex: index,
      };
    };

    const parsed = parsePattern({
      text: pattern,
      stopAtPipeOrParen: false,
    });

    let source = '^';
    source += parsed.source;
    source += '$';
    return new RegExp(source);
  }

  private parseExtglobPattern({
    text,
    startIndex,
    shellOptions,
  }: {
    text: string;
    startIndex: number;
    shellOptions: Map<WeshShellOption, boolean>;
  }): { source: string; nextIndex: number } | undefined {
    const branches: string[] = [];
    let branch = '';
    let index = startIndex;

    while (index < text.length) {
      const char = text[index];
      if (char === undefined) {
        return undefined;
      }

      if (char === '\\') {
        const nextChar = text[index + 1];
        branch += char;
        if (nextChar !== undefined) {
          branch += nextChar;
          index += 2;
          continue;
        }
        index += 1;
        continue;
      }

      if (
        ['?', '*', '+', '@', '!'].includes(char) &&
        text[index + 1] === '('
      ) {
        const nested = this.parseExtglobPattern({
          text,
          startIndex: index + 2,
          shellOptions,
        });
        if (nested === undefined) {
          return undefined;
        }
        branch += `${char}(${text.slice(index + 2, nested.nextIndex - 1)})`;
        index = nested.nextIndex;
        continue;
      }

      if (char === '|') {
        branches.push(branch);
        branch = '';
        index += 1;
        continue;
      }

      if (char === ')') {
        branches.push(branch);
        const compiledBranches = branches.map((value) => this.compileGlobComponent({
          pattern: value,
          shellOptions,
        }).source.slice(1, -1));
        return {
          source: compiledBranches.join('|'),
          nextIndex: index + 1,
        };
      }

      branch += char;
      index += 1;
    }

    return undefined;
  }

  private isGlobPatternSegment({
    segment,
    shellOptions,
  }: {
    segment: string;
    shellOptions: Map<WeshShellOption, boolean>;
  }): boolean {
    if (/(^|[^\\])[[*?]/.test(segment)) {
      return true;
    }

    return shellOptions.get('extglob') === true && /(^|[^\\])[?*@!+]\(/.test(segment);
  }

  private isGlobStarSegment({
    segment,
    shellOptions,
  }: {
    segment: string;
    shellOptions: Map<WeshShellOption, boolean>;
  }): boolean {
    return segment === '**' && shellOptions.get('globstar') === true;
  }

  private shouldIncludeHiddenGlobEntry({
    patternSegment,
    shellOptions,
  }: {
    patternSegment: string;
    shellOptions: Map<WeshShellOption, boolean>;
  }): boolean {
    return patternSegment.startsWith('.') || shellOptions.get('dotglob') === true;
  }

  private async expandGlobSegments({
    bases,
    segments,
    segmentIndex,
    shellOptions,
  }: {
    bases: string[];
    segments: string[];
    segmentIndex: number;
    shellOptions: Map<WeshShellOption, boolean>;
  }): Promise<string[]> {
    if (segmentIndex >= segments.length) {
      return bases;
    }

    const segment = segments[segmentIndex];
    if (segment === undefined || segment.length === 0) {
      return this.expandGlobSegments({
        bases,
        segments,
        segmentIndex: segmentIndex + 1,
        shellOptions,
      });
    }

    if (this.isGlobStarSegment({ segment, shellOptions })) {
      const zeroDepthMatches = await this.expandGlobSegments({
        bases,
        segments,
        segmentIndex: segmentIndex + 1,
        shellOptions,
      });
      const nestedBases = new Set<string>();
      const includeHiddenEntries = this.shouldIncludeHiddenGlobEntry({
        patternSegment: segment,
        shellOptions,
      });

      for (const base of bases) {
        for await (const entry of this.kernel.readDir({ path: base })) {
          switch (entry.type) {
          case 'directory':
            break;
          case 'file':
          case 'fifo':
          case 'chardev':
          case 'symlink':
            continue;
          default: {
            const _ex: never = entry.type;
            throw new Error(`Unhandled file type: ${_ex}`);
          }
          }
          if (entry.name === '.' || entry.name === '..') {
            continue;
          }
          if (!includeHiddenEntries && entry.name.startsWith('.')) {
            continue;
          }
          nestedBases.add(resolvePath({ cwd: base, path: entry.name }));
        }
      }

      if (nestedBases.size === 0) {
        return zeroDepthMatches;
      }

      const deepMatches = await this.expandGlobSegments({
        bases: Array.from(nestedBases),
        segments,
        segmentIndex,
        shellOptions,
      });

      const deduplicated = new Set(zeroDepthMatches);
      for (const m of deepMatches) deduplicated.add(m);
      return Array.from(deduplicated);
    }

    const nextBases: string[] = [];
    const segmentHasGlob = this.isGlobPatternSegment({ segment, shellOptions });
    const matcher = segmentHasGlob ? this.compileGlobComponent({ pattern: segment, shellOptions }) : undefined;
    const includeHiddenEntries = this.shouldIncludeHiddenGlobEntry({
      patternSegment: segment,
      shellOptions,
    });

    for (const base of bases) {
      if (!segmentHasGlob) {
        const candidate = resolvePath({ cwd: base, path: segment });
        try {
          await this.kernel.stat({ path: candidate });
          nextBases.push(candidate);
        } catch {
          continue;
        }
        continue;
      }

      for await (const entry of this.kernel.readDir({ path: base })) {
        if (!includeHiddenEntries && entry.name.startsWith('.')) {
          continue;
        }
        if (!matcher?.test(entry.name)) {
          continue;
        }
        nextBases.push(resolvePath({ cwd: base, path: entry.name }));
      }
    }

    if (nextBases.length === 0) {
      return [];
    }

    if (segmentIndex === segments.length - 1) {
      return nextBases;
    }

    const directoryBases: string[] = [];
    for (const candidate of nextBases) {
      const stat = await this.kernel.stat({ path: candidate });
      switch (stat.type) {
      case 'directory':
        directoryBases.push(candidate);
        break;
      case 'file':
      case 'fifo':
      case 'chardev':
      case 'symlink':
        break;
      default: {
        const _ex: never = stat.type;
        throw new Error(`Unhandled stat type: ${_ex}`);
      }
      }
    }

    if (directoryBases.length === 0) {
      return [];
    }

    return this.expandGlobSegments({
      bases: directoryBases,
      segments,
      segmentIndex: segmentIndex + 1,
      shellOptions,
    });
  }

  private relativizeGlobMatch({
    cwd,
    absolutePath,
  }: {
    cwd: string;
    absolutePath: string;
  }): string {
    if (cwd === absolutePath) {
      return '.';
    }

    if (cwd === '/') {
      return absolutePath.slice(1);
    }

    const cwdSegments = cwd.split('/').filter((segment) => segment.length > 0);
    const pathSegments = absolutePath.split('/').filter((segment) => segment.length > 0);
    let sharedLength = 0;

    while (
      sharedLength < cwdSegments.length &&
      sharedLength < pathSegments.length &&
      cwdSegments[sharedLength] === pathSegments[sharedLength]
    ) {
      sharedLength += 1;
    }

    const relativeSegments = [
      ...Array.from({ length: cwdSegments.length - sharedLength }, () => '..'),
      ...pathSegments.slice(sharedLength),
    ];

    return relativeSegments.length === 0 ? '.' : relativeSegments.join('/');
  }

  private async globField({
    field,
    cwd,
    shellOptions,
  }: {
    field: WeshExpandedField;
    cwd: string;
    shellOptions: Map<WeshShellOption, boolean>;
  }): Promise<string[]> {
    if (!this.hasActiveGlob({ field, shellOptions })) {
      return [field.text];
    }

    const pattern = this.buildGlobPattern({ field });
    const isAbsolute = pattern.startsWith('/');
    const rawSegments = pattern.split('/').filter((segment) => segment.length > 0);
    const initialBase = isAbsolute ? '/' : cwd;
    const candidates = await this.expandGlobSegments({
      bases: [initialBase],
      segments: rawSegments,
      segmentIndex: 0,
      shellOptions,
    });

    if (candidates.length === 0) {
      if (shellOptions.get('failglob') === true) {
        throw new Error(`no match: ${pattern}`);
      }
      if (shellOptions.get('nullglob') === true) {
        return [];
      }
      return [field.text];
    }

    return candidates.map((candidate) => {
      if (isAbsolute) {
        return candidate;
      }
      return this.relativizeGlobMatch({
        cwd,
        absolutePath: candidate,
      });
    });
  }

  private async expandWord({
    raw,
    env,
    cwd,
    mode,
    shellOptions,
    environment,
  }: {
    raw: string;
    env: Map<string, string>;
    cwd: string;
    mode: WeshExpansionMode;
    shellOptions: Map<WeshShellOption, boolean>;
    environment: WeshExecutionEnvironment;
  }): Promise<string[]> {
    const expandedFields: string[] = [];

    for (const braceExpandedRaw of this.expandBraceExpressions({ raw })) {
      const substitutionExpandedRaw = await this.expandInlineSubstitutions({
        text: braceExpandedRaw,
        environment,
      });
      const parsedParts = this.parseWordParts({ raw: substitutionExpandedRaw });
      const homeDirectory = env.get('HOME') ?? '/home';
      const tildeExpandedParts = parsedParts.map((part, index) => {
        if (
          index === 0 &&
          !part.quoted &&
          part.text.startsWith('~') &&
          (part.text.length === 1 || part.text[1] === '/')
        ) {
          const suffix = part.text.slice(1);
          return {
            ...part,
            text: homeDirectory === '/' ? `/${suffix.replace(/^\/+/, '')}` : `${homeDirectory}${suffix}`,
          };
        }

        return part;
      });
      const expandedParts: Array<{ text: string; quoted: boolean }> = [];
      for (const part of tildeExpandedParts) {
        expandedParts.push({
          text: part.expandVariables
            ? await this.expandPartVariables({
              text: part.text,
              env,
              environment,
            })
            : part.text,
          quoted: part.quoted,
        });
      }

      const fields = this.splitExpandedFields({ parts: expandedParts, mode });
      for (const field of fields) {
        const globbed = await this.globField({ field, cwd, shellOptions });
        expandedFields.push(...globbed);
      }
    }

    return expandedFields;
  }

  private async expandSingleWord({
    raw,
    env,
    cwd,
    mode,
    shellOptions,
    environment,
  }: {
    raw: string;
    env: Map<string, string>;
    cwd: string;
    mode: Exclude<WeshExpansionMode, 'argv'>;
    shellOptions: Map<WeshShellOption, boolean>;
    environment: WeshExecutionEnvironment;
  }): Promise<string> {
    const expanded = await this.expandWord({
      raw,
      env,
      cwd,
      mode,
      shellOptions,
      environment,
    });
    return expanded[0] ?? '';
  }

  private createShellFdTable({
    stdin,
    stdout,
    stderr,
  }: {
    stdin: WeshFileHandle;
    stdout: WeshFileHandle;
    stderr: WeshFileHandle;
  }): Map<number, WeshFileHandle> {
    const fds = new Map<number, WeshFileHandle>([
      [0, this.createSharedFileHandle({ handle: stdin })],
      [1, this.createSharedFileHandle({ handle: stdout })],
      [2, this.createSharedFileHandle({ handle: stderr })],
    ]);

    for (const [fd, handle] of this.shellFds.entries()) {
      fds.set(fd, this.duplicateSharedFileHandle({ handle }));
    }

    return fds;
  }

  private createSharedFileHandle({
    handle,
  }: {
    handle: WeshFileHandle;
  }): SharedFileHandle {
    if (handle instanceof SharedFileHandle) {
      return handle;
    }
    return new SharedFileHandle({
      state: {
        handle,
        refCount: 1,
        closed: false,
      },
    });
  }

  private duplicateSharedFileHandle({
    handle,
  }: {
    handle: WeshFileHandle;
  }): SharedFileHandle {
    const sharedHandle = this.createSharedFileHandle({ handle });
    return sharedHandle.cloneReference();
  }

  private async setPersistentFd({
    fd,
    handle,
  }: {
    fd: number;
    handle: WeshFileHandle;
  }): Promise<void> {
    const previous = this.shellFds.get(fd);
    if (previous !== undefined && previous !== handle) {
      await previous.close();
    }
    this.shellFds.set(fd, handle);
  }

  private async closePersistentFd({
    fd,
  }: {
    fd: number;
  }): Promise<void> {
    const previous = this.shellFds.get(fd);
    if (previous !== undefined) {
      await previous.close();
    }
    this.shellFds.delete(fd);
  }

  private async openRedirectionTarget({
    redirection,
    environment,
    trackBackgroundTask,
  }: {
    redirection: WeshCommandNode['redirections'][number];
    environment: WeshExecutionEnvironment;
    trackBackgroundTask: ({ task }: { task: Promise<unknown> }) => void;
  }): Promise<WeshFileHandle | undefined> {
    if (redirection.type === 'heredoc' || redirection.type === 'herestring') {
      if (redirection.content === undefined) {
        return undefined;
      }

      const { read, write } = await this.kernel.pipe();
      const encoder = new TextEncoder();
      const content = redirection.type === 'heredoc' && redirection.contentExpansion === 'variables'
        ? await this.expandPartVariables({
          text: redirection.content,
          env: environment.env,
          environment,
        })
        : redirection.content;
      await write.write({ buffer: encoder.encode(content + '\n') });
      await write.close();
      return read;
    }

    if (redirection.type === 'dup-output' || redirection.type === 'dup-input') {
      if (redirection.closeTarget) {
        return undefined;
      }

      if (redirection.targetFd === undefined) {
        throw new Error(`Missing target fd for redirection ${redirection.type}`);
      }

      const duplicated = environment.fds.get(redirection.targetFd);
      if (duplicated === undefined) {
        throw new Error(`${redirection.targetFd}: bad file descriptor`);
      }

      return this.duplicateSharedFileHandle({ handle: duplicated });
    }

    if (redirection.target !== undefined && typeof redirection.target !== 'string') {
      const redirectedStdin = environment.fds.get(0);
      const redirectedStdout = environment.fds.get(1);
      const redirectedStderr = environment.fds.get(2);
      if (redirectedStdin === undefined || redirectedStdout === undefined || redirectedStderr === undefined) {
        throw new Error('Missing standard file descriptor after redirection');
      }

      const { read, write } = await this.kernel.pipe();
      const subEnvironment = await this.spawnChildExecutionEnvironment({
        parentEnvironment: environment,
        pgid: environment.pgid,
      });

      switch (redirection.target.type) {
      case 'input':
        trackBackgroundTask({
          task: this.executeNode({
            node: redirection.target.list,
            environment: subEnvironment,
            stdin: redirectedStdin,
            stdout: write,
            stderr: redirectedStderr,
          }).finally(() => write.close()),
        });
        return this.createSharedFileHandle({ handle: read });
      case 'output':
        trackBackgroundTask({
          task: this.executeNode({
            node: redirection.target.list,
            environment: subEnvironment,
            stdin: read,
            stdout: redirectedStdout,
            stderr: redirectedStderr,
          }).finally(() => read.close()),
        });
        return this.createSharedFileHandle({ handle: write });
      default: {
        const _ex: never = redirection.target.type;
        throw new Error(`Unhandled redirection process substitution type: ${_ex}`);
      }
      }
    }

    const rawTarget = redirection.target ? await this.expandSingleWord({
      raw: redirection.target,
      env: environment.env,
      cwd: environment.cwd,
      mode: 'redirection',
      shellOptions: environment.shellOptions,
      environment,
    }) : undefined;

    if (rawTarget === undefined) {
      return undefined;
    }

    const fullTarget = rawTarget.startsWith('/') ? rawTarget : `${environment.cwd}/${rawTarget}`;

    switch (redirection.type) {
    case 'read':
      return this.createSharedFileHandle({ handle: await this.kernel.open({
        path: fullTarget,
        flags: { access: 'read', creation: 'never', truncate: 'preserve', append: 'preserve' },
        mode: 0o644,
      }) });
    case 'write':
      return this.createSharedFileHandle({ handle: await this.kernel.open({
        path: fullTarget,
        flags: { access: 'write', creation: 'if-needed', truncate: 'truncate', append: 'preserve' },
        mode: 0o644,
      }) });
    case 'append':
      return this.createSharedFileHandle({ handle: await this.kernel.open({
        path: fullTarget,
        flags: { access: 'write', creation: 'if-needed', truncate: 'preserve', append: 'append' },
        mode: 0o644,
      }) });
    case 'read-write':
      return this.createSharedFileHandle({ handle: await this.kernel.open({
        path: fullTarget,
        flags: { access: 'read-write', creation: 'if-needed', truncate: 'preserve', append: 'preserve' },
        mode: 0o644,
      }) });
    default: {
      const _ex: never = redirection.type;
      throw new Error(`Unhandled redirection type: ${_ex}`);
    }
    }
  }

  private async applyRedirectionsToFdTable({
    redirections,
    environment,
    fdTable,
    trackOpenedHandle,
    trackBackgroundTask,
  }: {
    redirections: WeshCommandNode['redirections'];
    environment: WeshExecutionEnvironment;
    fdTable: Map<number, WeshFileHandle>;
    trackOpenedHandle: ({ handle }: { handle: WeshFileHandle }) => void;
    trackBackgroundTask: ({ task }: { task: Promise<unknown> }) => void;
  }): Promise<void> {
    for (const redirection of redirections) {
      if (redirection.closeTarget) {
        const current = fdTable.get(redirection.fd);
        if (current !== undefined) {
          await current.close();
        }
        fdTable.delete(redirection.fd);
        continue;
      }

      const handle = await this.openRedirectionTarget({
        redirection,
        environment,
        trackBackgroundTask,
      });
      if (handle === undefined) {
        continue;
      }

      if (
        redirection.type !== 'dup-output' &&
        redirection.type !== 'dup-input'
      ) {
        trackOpenedHandle({ handle });
      }

      fdTable.set(redirection.fd, handle);
    }
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
      const environment = this.createExecutionEnvironment({
        shellPid: this.shellPid,
        pgid: this.shellPid,
        env: this.env,
        aliases: this.aliases,
        functions: new Map(),
        cwd: this.cwd,
        fds: this.createShellFdTable({
          stdin: options.stdin,
          stdout: options.stdout,
          stderr: options.stderr,
        }),
        traps: this.traps,
        shellOptions: this.shellOptions,
        positionalArgs: [],
        lastBackgroundPid: undefined,
      });

      const result = await this.executeNode({
        node: rootNode,
        environment,
        stdin: options.stdin,
        stdout: options.stdout,
        stderr: options.stderr
      });

      this.cwd = environment.cwd;
      this.aliases = environment.aliases;
      this.shellOptions = environment.shellOptions;
      return await this.runExitTrapIfNeeded({
        result,
        environment,
        stdin: options.stdin,
        stdout: options.stdout,
        stderr: options.stderr,
      });
    } catch (e: unknown) {
      const message = e instanceof Error ? e.message : String(e);
      const encoder = new TextEncoder();
      await options.stderr.write({ buffer: encoder.encode(`wesh: ${message}\n`) });
      return { exitCode: 1 };
    }
  }

  private async executeNode(options: {
    node: WeshASTNode,
    environment: WeshExecutionEnvironment,
    stdin: WeshFileHandle,
    stdout: WeshFileHandle,
    stderr: WeshFileHandle,
    loopDepth?: number,
    functionDepth?: number,
  }): Promise<WeshCommandResult> {
    const {
      node,
      environment,
      stdin,
      stdout,
      stderr,
      loopDepth = 0,
      functionDepth = 0,
    } = options;
    let result: WeshCommandResult;

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

        switch (part.operator) {
        case '&': {
          const jobId = this.nextJobId++;
          const cmdStr = "Background Job";
          const jobEnvironment = await this.spawnChildExecutionEnvironment({
            parentEnvironment: environment,
            pgid: undefined,
          });

          this.executeNode({
            node: part.node,
            environment: jobEnvironment,
            stdin, stdout, stderr,
            loopDepth,
            functionDepth,
          }).then(res => {
            const job = this.jobs.get(jobId);
            if (job) job.status = 'done';
            return res;
          });

          this.jobs.set(jobId, {
            id: jobId,
            command: cmdStr,
            pid: jobEnvironment.shellPid,
            status: 'running'
          });
          environment.lastBackgroundPid = jobEnvironment.shellPid;
          this.syncSpecialParameters({
            environment,
          });

          // Job notification to stderr (simulating bash)
          const encoder = new TextEncoder();
          await stderr.write({ buffer: encoder.encode(`[${jobId}] background\n`) });

          lastResult = { exitCode: 0 };
          previousOperator = '&';
          break;
        }
        case ';':
        case '&&':
        case '||': {
          lastResult = await this.executeNode({
            node: part.node,
            environment,
            stdin, stdout, stderr,
            loopDepth,
            functionDepth,
          });
          if (lastResult.controlFlow !== undefined) {
            result = lastResult;
            environment.env.set('?', result.exitCode.toString());
            return result;
          }
          previousOperator = part.operator;
          break;
        }
        default: {
          const _ex: never = part.operator;
          throw new Error(`Unhandled operator: ${_ex}`);
        }
        }

      }
      result = lastResult;
      break;
    }

    case 'pipeline': {
      result = await this.executePipeline({ ...options, node: node as WeshPipelineNode });
      break;
    }

    case 'command': {
      result = await this.runWithForegroundProcessGroup({
        pgid: environment.pgid,
        fn: async () => this.executeCommand({
          ...options,
          node: node as WeshCommandNode,
          loopDepth,
          functionDepth,
        }),
      });
      break;
    }

    case 'subshell': {
      const subshellEnvironment = await this.spawnChildExecutionEnvironment({
        parentEnvironment: environment,
        pgid: undefined,
      });
      result = await this.executeNode({
        node: node.list,
        environment: subshellEnvironment,
        stdin, stdout, stderr,
        loopDepth,
        functionDepth,
      });
      result = await this.runExitTrapIfNeeded({
        result,
        environment: subshellEnvironment,
        stdin,
        stdout,
        stderr,
      });
      break;
    }

    case 'if': {
      const conditionResult = await this.executeNode({
        node: node.condition,
        environment, stdin, stdout, stderr,
        loopDepth,
        functionDepth,
      });
      if (conditionResult.exitCode === 0) {
        result = await this.executeNode({
          node: node.thenBody,
          environment, stdin, stdout, stderr,
          loopDepth,
          functionDepth,
        });
      } else if (node.elseBody) {
        result = await this.executeNode({
          node: node.elseBody,
          environment, stdin, stdout, stderr,
          loopDepth,
          functionDepth,
        });
      } else {
        result = { exitCode: 0 };
      }
      break;
    }

    case 'for': {
      let lastForRes: WeshCommandResult = { exitCode: 0 };
      const expandedItems: string[] = [];
      for (const item of node.items) {
        const itemFields = await this.expandWord({
          raw: item,
          env: environment.env,
          cwd: environment.cwd,
          mode: 'argv',
          shellOptions: environment.shellOptions,
          environment,
        });
        expandedItems.push(...itemFields);
      }

      for (const item of expandedItems) {
        environment.env.set(node.variable, item);
        lastForRes = await this.executeNode({
          node: node.body,
          environment, stdin, stdout, stderr,
          loopDepth: loopDepth + 1,
          functionDepth,
        });
        const controlFlow = lastForRes.controlFlow;
        if (controlFlow !== undefined) {
          switch (controlFlow.kind) {
          case 'continue':
            if (controlFlow.levels > 1) {
              result = {
                exitCode: lastForRes.exitCode,
                controlFlow: {
                  kind: 'continue',
                  levels: controlFlow.levels - 1,
                },
              };
              environment.env.set('?', result.exitCode.toString());
              return result;
            }
            continue;
          case 'break':
            if (controlFlow.levels > 1) {
              result = {
                exitCode: lastForRes.exitCode,
                controlFlow: {
                  kind: 'break',
                  levels: controlFlow.levels - 1,
                },
              };
              environment.env.set('?', result.exitCode.toString());
              return result;
            }
            result = { exitCode: lastForRes.exitCode };
            environment.env.set('?', result.exitCode.toString());
            return result;
          case 'return':
            environment.env.set('?', lastForRes.exitCode.toString());
            return lastForRes;
          default: {
            const _ex: never = controlFlow;
            throw new Error(`Unhandled control flow: ${JSON.stringify(_ex)}`);
          }
          }
        }
      }
      result = lastForRes;
      break;
    }

    case 'while':
    case 'until': {
      const loopKind = node.kind;
      let lastLoopResult: WeshCommandResult = { exitCode: 0 };
      while (true) {
        const conditionResult = await this.executeNode({
          node: node.condition,
          environment,
          stdin,
          stdout,
          stderr,
          loopDepth,
          functionDepth,
        });
        if (conditionResult.controlFlow !== undefined) {
          result = conditionResult;
          break;
        }
        const shouldRun = (() => {
          switch (loopKind) {
          case 'while':
            return conditionResult.exitCode === 0;
          case 'until':
            return conditionResult.exitCode !== 0;
          default: {
            const _ex: never = loopKind;
            throw new Error(`Unhandled loop kind: ${_ex}`);
          }
          }
        })();
        if (!shouldRun) {
          result = lastLoopResult;
          break;
        }
        lastLoopResult = await this.executeNode({
          node: node.body,
          environment,
          stdin,
          stdout,
          stderr,
          loopDepth: loopDepth + 1,
          functionDepth,
        });
        const controlFlow = lastLoopResult.controlFlow;
        if (controlFlow !== undefined) {
          switch (controlFlow.kind) {
          case 'continue':
            if (controlFlow.levels > 1) {
              result = {
                exitCode: lastLoopResult.exitCode,
                controlFlow: {
                  kind: 'continue',
                  levels: controlFlow.levels - 1,
                },
              };
              break;
            }
            continue;
          case 'break':
            if (controlFlow.levels > 1) {
              result = {
                exitCode: lastLoopResult.exitCode,
                controlFlow: {
                  kind: 'break',
                  levels: controlFlow.levels - 1,
                },
              };
              break;
            }
            result = { exitCode: lastLoopResult.exitCode };
            break;
          case 'return':
            result = lastLoopResult;
            break;
          default: {
            const _ex: never = controlFlow;
            throw new Error(`Unhandled control flow: ${JSON.stringify(_ex)}`);
          }
          }
          if (result !== undefined) {
            break;
          }
        }
      }
      break;
    }

    case 'case': {
      const expandedWord = await this.expandSingleWord({
        raw: node.word,
        env: environment.env,
        cwd: environment.cwd,
        mode: 'assignment',
        shellOptions: environment.shellOptions,
        environment,
      });
      let caseResult: WeshCommandResult = { exitCode: 0 };
      let matched = false;
      for (const clause of node.clauses) {
        const clauseMatched = await this.caseClauseMatches({
          patterns: clause.patterns,
          value: expandedWord,
          environment,
        });
        if (!clauseMatched) {
          continue;
        }
        matched = true;
        caseResult = await this.executeNode({
          node: clause.body,
          environment,
          stdin,
          stdout,
          stderr,
          loopDepth,
          functionDepth,
        });
        break;
      }
      result = matched ? caseResult : { exitCode: 0 };
      break;
    }

    case 'functionDefinition':
      environment.functions.set(node.name, node.body);
      result = { exitCode: 0 };
      break;

    case 'arithmeticCommand':
      result = this.executeArithmeticCommand({
        expression: node.expression,
        environment,
      });
      break;

    case 'redirected': {
      const redirectedFds = new Map(environment.fds);
      const openHandles: WeshFileHandle[] = [];
      const backgroundTasks: Promise<unknown>[] = [];
      await this.applyRedirectionsToFdTable({
        redirections: node.redirections,
        environment,
        fdTable: redirectedFds,
        trackOpenedHandle: ({ handle }) => {
          openHandles.push(handle);
        },
        trackBackgroundTask: ({ task }) => {
          backgroundTasks.push(task);
        },
      });
      const redirectedStdin = redirectedFds.get(0);
      const redirectedStdout = redirectedFds.get(1);
      const redirectedStderr = redirectedFds.get(2);
      if (redirectedStdin === undefined || redirectedStdout === undefined || redirectedStderr === undefined) {
        throw new Error('Missing standard file descriptor after redirection');
      }
      try {
        result = await this.executeNode({
          node: node.node,
          environment,
          stdin: redirectedStdin,
          stdout: redirectedStdout,
          stderr: redirectedStderr,
          loopDepth,
          functionDepth,
        });
      } finally {
        for (const handle of openHandles) {
          await handle.close();
        }
        await Promise.allSettled(backgroundTasks);
      }
      break;
    }

    case 'assignment':
      for (const assign of node.assignments) {
        environment.env.set(assign.key, await this.expandSingleWord({
          raw: assign.value,
          env: environment.env,
          cwd: environment.cwd,
          mode: 'assignment',
          shellOptions: environment.shellOptions,
          environment,
        }));
      }
      result = { exitCode: 0 };
      break;
    default: {
      const _ex: never = node;
      throw new Error(`Unhandled AST node kind: ${JSON.stringify(_ex)}`);
    }
    }

    environment.env.set('?', result.exitCode.toString());
    return result;
  }

  private async executePipeline(options: {
    node: { commands: WeshASTNode[] },
    environment: WeshExecutionEnvironment,
    stdin: WeshFileHandle,
    stdout: WeshFileHandle,
    stderr: WeshFileHandle,
    loopDepth?: number,
    functionDepth?: number,
  }): Promise<WeshCommandResult> {
    const {
      node,
      environment,
      stdin,
      stdout,
      stderr,
      loopDepth = 0,
      functionDepth = 0,
    } = options;
    const commands = node.commands;
    if (commands.length === 0) return { exitCode: 0 };

    const pipes: Array<{ read: WeshFileHandle; write: WeshFileHandle }> = [];
    for (let i = 0; i < commands.length - 1; i++) {
      pipes.push(await this.kernel.pipe());
    }

    const promises: Promise<WeshCommandResult>[] = [];
    let pipelinePgid: number | undefined;

    for (let i = 0; i < commands.length; i++) {
      const cmd = commands[i]!;
      const myStdin = i === 0 ? stdin : pipes[i-1]!.read;
      const myStdout = i === commands.length - 1 ? stdout : pipes[i]!.write;

      const pipelineEnvironment = await this.spawnChildExecutionEnvironment({
        parentEnvironment: environment,
        pgid: pipelinePgid,
      });
      pipelinePgid = pipelineEnvironment.pgid;

      promises.push(
        this.executeNode({
          node: cmd,
          environment: pipelineEnvironment,
          stdin: myStdin,
          stdout: myStdout,
          stderr: stderr,
          loopDepth,
          functionDepth,
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

    const results = await this.runWithForegroundProcessGroup({
      pgid: pipelinePgid ?? environment.pgid,
      fn: async () => Promise.all(promises),
    });
    return results[results.length - 1]!;
  }

  private async executeCommand(options: {
    node: WeshCommandNode,
    environment: WeshExecutionEnvironment,
    stdin: WeshFileHandle,
    stdout: WeshFileHandle,
    stderr: WeshFileHandle;
    ignoreAliases?: boolean;
    loopDepth?: number;
    functionDepth?: number;
  }): Promise<WeshCommandResult> {
    const {
      node,
      environment,
      stdin,
      stdout,
      stderr,
      ignoreAliases,
      loopDepth = 0,
      functionDepth = 0,
    } = options;
    const aliasExpandedNode = ignoreAliases === true
      ? node
      : this.expandAliasCommandNode({
        node,
        environment,
        expandedAliases: new Set(),
      });

    const expandedArgs: string[] = [];
    const procSubCleanups: Array<() => void> = [];
    const procSubTasks: Promise<unknown>[] = [];
    const openHandles: WeshFileHandle[] = [];
    const cmdFds = new Map(environment.fds);

    for (const arg of aliasExpandedNode.args) {
      if (typeof arg === 'string') {
        const fields = await this.expandWord({
          raw: arg,
          env: environment.env,
          cwd: environment.cwd,
          mode: 'argv',
          shellOptions: environment.shellOptions,
          environment,
        });
        expandedArgs.push(...fields);
      } else if (arg.kind === 'processSubstitution') {
        const { read, write } = await this.kernel.pipe();
        const id = Math.floor(Math.random() * 1000000);
        const path = `/dev/fd/${id}`;

        switch (arg.type) {
        case 'input': {
          const subEnvironment = await this.spawnChildExecutionEnvironment({
            parentEnvironment: environment,
            pgid: environment.pgid,
          });
          this.executeNode({
            node: arg.list,
            environment: subEnvironment,
            stdin, stdout: write, stderr
          }).then(() => write.close());

          this.vfs.registerSpecialFile({ path, handler: () => read });

          procSubCleanups.push(() => {
            this.vfs.unregisterSpecialFile({ path });
            read.close();
          });
          break;
        }
        case 'output': {
          const subEnvironment = await this.spawnChildExecutionEnvironment({
            parentEnvironment: environment,
            pgid: environment.pgid,
          });
          this.executeNode({
            node: arg.list,
            environment: subEnvironment,
            stdin: read, stdout, stderr
          }).then(() => read.close());

          this.vfs.registerSpecialFile({ path, handler: () => write });
          procSubCleanups.push(() => {
            this.vfs.unregisterSpecialFile({ path });
            write.close();
          });
          break;
        }
        default: {
          const _ex: never = arg.type;
          throw new Error(`Unhandled process substitution type: ${_ex}`);
        }
        }
        expandedArgs.push(path);
      }
    }

    const cmdName = await this.expandSingleWord({
      raw: aliasExpandedNode.name,
      env: environment.env,
      cwd: environment.cwd,
      mode: 'assignment',
      shellOptions: environment.shellOptions,
      environment,
    });

    const controlFlowResult = await this.tryExecuteShellControlCommand({
      commandName: cmdName,
      args: expandedArgs,
      stderr,
      loopDepth,
      functionDepth,
      environment,
    });
    if (controlFlowResult !== undefined) {
      return controlFlowResult;
    }

    if (cmdName === '[[') {
      return this.executeExtendedTestCommand({
        args: expandedArgs,
      });
    }

    const currentEnv = new Map(environment.env);
    for (const assign of aliasExpandedNode.assignments) {
      currentEnv.set(assign.key, await this.expandSingleWord({
        raw: assign.value,
        env: environment.env,
        cwd: environment.cwd,
        mode: 'assignment',
        shellOptions: environment.shellOptions,
        environment,
      }));
    }

    const shellFunctionBody = environment.functions.get(cmdName);
    if (shellFunctionBody !== undefined) {
      return this.executeShellFunction({
        name: cmdName,
        body: shellFunctionBody,
        args: expandedArgs,
        environment,
        stdin,
        stdout,
        stderr,
        loopDepth,
        functionDepth,
      });
    }

    const resolvedCommand = this.resolveBuiltinCommand({
      name: cmdName,
      cwd: environment.cwd,
      env: environment.env,
    });

    if (resolvedCommand === undefined) {
      const shebangScript = await this.resolveShebangScript({
        name: cmdName,
        cwd: environment.cwd,
        env: environment.env,
      });
      if (shebangScript !== undefined) {
        return this.executeArgv({
          command: shebangScript.interpreter,
          args: [
            ...shebangScript.interpreterArgs,
            shebangScript.scriptPath,
            ...expandedArgs,
          ],
          environment,
          stdin,
          stdout,
          stderr,
        });
      }
      throw new Error(`Command not found: ${cmdName}`);
    }
    const definition = resolvedCommand.definition;

    cmdFds.set(0, stdin);
    cmdFds.set(1, stdout);
    cmdFds.set(2, stderr);

    await this.applyRedirectionsToFdTable({
      redirections: aliasExpandedNode.redirections,
      environment,
      fdTable: cmdFds,
      trackOpenedHandle: ({ handle }) => {
        openHandles.push(handle);
      },
      trackBackgroundTask: ({ task }) => {
        procSubTasks.push(task);
      },
    });

    const cmdStdin = cmdFds.get(0);
    const cmdStdout = cmdFds.get(1);
    const cmdStderr = cmdFds.get(2);

    if (cmdStdin === undefined || cmdStdout === undefined || cmdStderr === undefined) {
      throw new Error('Missing standard file descriptor after redirection');
    }

    const { pid, process: proc } = await this.kernel.spawn({
      image: resolvedCommand.resolved.invocationPath ?? cmdName,
      args: [cmdName, ...expandedArgs],
      env: currentEnv,
      cwd: environment.cwd,
      fds: cmdFds,
      ppid: environment.shellPid,
      pgid: environment.pgid,
      signalDispositions: this.buildProcessSignalDispositions({
        environment,
      }),
    });

    proc.fds = this.kernel.bindFdTable({
      pid,
      fdTable: proc.fds,
    });

    const boundStdin = proc.fds.get(0);
    const boundStdout = proc.fds.get(1);
    const boundStderr = proc.fds.get(2);

    if (boundStdin === undefined || boundStdout === undefined || boundStderr === undefined) {
      throw new Error('Missing standard file descriptor after process binding');
    }

    const context: WeshCommandContext = {
      args: expandedArgs,
      env: currentEnv,
      cwd: environment.cwd,
      pid: pid,
      stdin: boundStdin,
      stdout: boundStdout,
      stderr: boundStderr,
      setCwd: ({ path }: { path: string }) => {
        environment.env.set('OLDPWD', environment.cwd);
        environment.cwd = path;
        environment.env.set('PWD', path);
      },
      setEnv: ({ key, value }: { key: string; value: string }) => {
        environment.env.set(key, value);
      },
      unsetEnv: ({ key }: { key: string }) => {
        environment.env.delete(key);
      },
      getHistory: () => [...this.history],
      getAliases: () => Array.from(environment.aliases.entries())
        .sort(([leftName], [rightName]) => leftName.localeCompare(rightName))
        .map(([name, value]) => ({ name, value })),
      setAlias: ({ name, value }: { name: string; value: string }) => {
        environment.aliases.set(name, value);
      },
      unsetAlias: ({ name }: { name: string }) => {
        environment.aliases.delete(name);
      },
      getWeshCommandMeta: ({ name }: { name: string }) => this.commands.get(name)?.meta,
      getCommandNames: () => Array.from(this.commands.keys()),
      resolveCommand: ({ name }) => {
        const resolved = this.resolveBuiltinCommand({
          name,
          cwd: environment.cwd,
          env: environment.env,
        });
        if (resolved !== undefined) {
          return resolved.resolved;
        }

        return {
          kind: 'not-found',
          name,
        };
      },
      getJobs: () => Array.from(this.jobs.values()).map(j => ({ id: j.id, command: j.command, status: j.status })),
      getProcesses: () => this.kernel.getProcesses().map((process) => ({
        pid: process.pid,
        ppid: process.ppid,
        pgid: process.pgid,
        state: process.state,
        user: process.env.get('USER') ?? 'unknown',
        argv0: process.env.get('0') ?? 'wesh',
        args: [...process.args],
        cwd: process.cwd,
      })),
      getShellOption: ({ name }) => environment.shellOptions.get(name) === true,
      setShellOption: ({ name, enabled }) => {
        environment.shellOptions.set(name, enabled);
      },
      getShellOptions: () => Array.from(environment.shellOptions.entries())
        .sort(([leftName], [rightName]) => leftName.localeCompare(rightName)),
      executeCommand: ({ command, args, stdin: nextStdin, stdout: nextStdout, stderr: nextStderr, ignoreAliases: nextIgnoreAliases }) => this.executeArgv({
        command,
        args,
        environment,
        stdin: nextStdin ?? boundStdin,
        stdout: nextStdout ?? boundStdout,
        stderr: nextStderr ?? boundStderr,
        ignoreAliases: nextIgnoreAliases,
      }),
      executeShell: ({ script, stdin: nextStdin, stdout: nextStdout, stderr: nextStderr }) => this.executeShellInState({
        script,
        environment,
        stdin: nextStdin ?? boundStdin,
        stdout: nextStdout ?? boundStdout,
        stderr: nextStderr ?? boundStderr,
      }),
      files: {
        open: async ({ path, flags, mode }) => {
          const handle = await this.kernel.open({
            path,
            flags,
            mode,
          });
          return this.kernel.bindFileHandle({
            pid,
            handle,
            trackOwnership: true,
          });
        },
        stat: ({ path }) => this.kernel.stat({ path }),
        lstat: ({ path }) => this.kernel.lstat({ path }),
        readDir: ({ path }) => this.kernel.readDir({ path }),
        readlink: ({ path }) => this.kernel.readlink({ path }),
        resolve: ({ path }) => this.kernel.resolve({ path }),
        tryReadBlobEfficiently: ({ path }) => this.kernel.tryReadBlobEfficiently({ path }),
        tryCreateFileWriterEfficiently: ({ path, mode }) => this.kernel.tryCreateFileWriterEfficiently({ path, mode }),
        mkdir: ({ path, mode, recursive }) => this.kernel.mkdir({ path, mode, recursive }),
        symlink: ({ path, targetPath, mode }) => this.kernel.symlink({ path, targetPath, mode }),
        mknod: ({ path, type, mode }) => this.kernel.mknod({ path, type, mode }),
        unlink: ({ path }) => this.kernel.unlink({ path }),
        rmdir: ({ path }) => this.kernel.rmdir({ path }),
        rename: ({ oldPath, newPath }) => this.kernel.rename({ oldPath, newPath }),
      },
      process: {
        getPid: () => pid,
        getGroupId: () => proc.pgid,
        getWaitStatus: () => this.kernel.getWaitStatus({ pid }),
        signalSelf: ({ signal }) => this.kernel.kill({ pid, signal }),
        signalGroup: ({ signal }) => this.kernel.killProcessGroup({ pgid: proc.pgid, signal }),
        waitForSignalOrTimeout: ({ timeoutMs, pollIntervalMs }) => this.kernel.waitForSignalOrTimeout({
          pid,
          timeoutMs,
          pollIntervalMs,
        }),
      },
      getFileDescriptors: () => Array.from(proc.fds.entries()),
      getFileDescriptor: ({ fd }) => proc.fds.get(fd),
      setFileDescriptor: async ({ fd, handle, persist }) => {
        const boundHandle = this.kernel.bindFileHandle({
          pid,
          handle,
          trackOwnership: false,
        });
        proc.fds.set(fd, boundHandle);
        environment.fds.set(fd, boundHandle);
        if (persist) {
          await this.setPersistentFd({ fd, handle: boundHandle });
        }
      },
      closeFileDescriptor: async ({ fd, persist }) => {
        const current = proc.fds.get(fd);
        if (current !== undefined) {
          await current.close();
        }
        proc.fds.delete(fd);
        environment.fds.delete(fd);
        if (persist) {
          await this.closePersistentFd({ fd });
        }
      },
      setTrap: ({ condition, disposition }) => {
        if (disposition === undefined) {
          environment.traps.delete(condition);
          return;
        }
        environment.traps.set(condition, disposition);
      },
      getTrapAction: ({ condition }) => {
        return environment.traps.get(condition);
      },
      getTraps: () => {
        return Array.from(environment.traps.entries())
          .sort(([leftCondition], [rightCondition]) => leftCondition.localeCompare(rightCondition));
      },
      text: () => createTextIoHelpers({ stdin: boundStdin, stdout: boundStdout, stderr: boundStderr }),
    };

    try {
      const result = await definition.fn({ context });
      const signalResult = await this.buildSignalCommandResultIfAny({
        pid,
        environment,
        stdin: boundStdin,
        stdout: boundStdout,
        stderr: boundStderr,
      });
      if (signalResult !== undefined) {
        return signalResult;
      }

      proc.state = 'terminated';
      proc.waitStatus = result.waitStatus ?? {
        kind: 'exited',
        exitCode: result.exitCode,
      };
      proc.exitCode = result.exitCode;

      switch (proc.waitStatus.kind) {
      case 'signaled':
        await this.runSignalTrapIfNeeded({
          signal: proc.waitStatus.signal,
          environment,
          stdin: boundStdin,
          stdout: boundStdout,
          stderr: boundStderr,
        });
        break;
      case 'exited':
      case 'stopped':
        break;
      default: {
        const _ex: never = proc.waitStatus;
        throw new Error(`Unhandled wait status: ${JSON.stringify(_ex)}`);
      }
      }

      return {
        ...result,
        exitCode: weshWaitStatusToExitCode({
          waitStatus: proc.waitStatus,
        }),
        waitStatus: proc.waitStatus,
      };
    } catch (error: unknown) {
      const signalResult = await this.buildSignalCommandResultIfAny({
        pid,
        environment,
        stdin: boundStdin,
        stdout: boundStdout,
        stderr: boundStderr,
      });
      if (signalResult !== undefined) {
        return signalResult;
      }
      throw error;
    } finally {
      for (const h of openHandles) {
        await h.close();
      }
      await Promise.allSettled(procSubTasks);
      for (const c of procSubCleanups) c();
    }
  }

  private async writeErrorText({
    stderr,
    text,
  }: {
    stderr: WeshFileHandle;
    text: string;
  }): Promise<void> {
    await stderr.write({
      buffer: new TextEncoder().encode(text),
    });
  }

  private async tryExecuteShellControlCommand({
    commandName,
    args,
    stderr,
    loopDepth,
    functionDepth,
    environment,
  }: {
    commandName: string;
    args: string[];
    stderr: WeshFileHandle;
    loopDepth: number;
    functionDepth: number;
    environment: WeshExecutionEnvironment;
  }): Promise<WeshCommandResult | undefined> {
    switch (commandName) {
    case 'break':
      return this.buildLoopControlCommandResult({
        commandName,
        args,
        stderr,
        loopDepth,
      });
    case 'continue':
      return this.buildLoopControlCommandResult({
        commandName,
        args,
        stderr,
        loopDepth,
      });
    case 'return': {
      if (functionDepth <= 0) {
        await this.writeErrorText({
          stderr,
          text: 'wesh: return: can only `return\' from a function or sourced script\n',
        });
        return { exitCode: 1 };
      }
      const parsedExitCode = await this.parseNumericExitStatus({
        commandName,
        args,
        stderr,
      });
      switch (parsedExitCode.kind) {
      case 'error':
        return { exitCode: 2 };
      case 'ok':
        break;
      default: {
        const _ex: never = parsedExitCode;
        throw new Error(`Unhandled parsed exit code: ${JSON.stringify(_ex)}`);
      }
      }
      const exitCode = parsedExitCode.value ?? Number.parseInt(environment.env.get('?') ?? '0', 10);
      return {
        exitCode,
        controlFlow: {
          kind: 'return',
          exitCode,
        },
      };
    }
    default:
      return undefined;
    }
  }

  private async buildLoopControlCommandResult({
    commandName,
    args,
    stderr,
    loopDepth,
  }: {
    commandName: 'break' | 'continue';
    args: string[];
    stderr: WeshFileHandle;
    loopDepth: number;
  }): Promise<WeshCommandResult> {
    if (loopDepth <= 0) {
      await this.writeErrorText({
        stderr,
        text: `wesh: ${commandName}: only meaningful in a \`for', \`while', or \`until' loop\n`,
      });
      return { exitCode: 1 };
    }

    const levels = await this.parseNumericExitStatus({
      commandName,
      args,
      stderr,
    });
    switch (levels.kind) {
    case 'error':
      return { exitCode: 2 };
    case 'ok':
      break;
    default: {
      const _ex: never = levels;
      throw new Error(`Unhandled numeric exit status: ${JSON.stringify(_ex)}`);
    }
    }
    const normalizedLevels = levels.value ?? 1;
    return {
      exitCode: 0,
      controlFlow: {
        kind: commandName,
        levels: normalizedLevels,
      },
    };
  }

  private async parseNumericExitStatus({
    commandName,
    args,
    stderr,
  }: {
    commandName: 'break' | 'continue' | 'return';
    args: string[];
    stderr: WeshFileHandle;
  }): Promise<{
    kind: 'ok';
    value: number | undefined;
  } | {
    kind: 'error';
  }> {
    if (args.length === 0) {
      return {
        kind: 'ok',
        value: undefined,
      };
    }
    const raw = args[0];
    if (raw === undefined) {
      return {
        kind: 'ok',
        value: undefined,
      };
    }
    if (!/^\d+$/u.test(raw)) {
      await this.writeErrorText({
        stderr,
        text: `wesh: ${commandName}: ${raw}: numeric argument required\n`,
      });
      return {
        kind: 'error',
      };
    }
    return {
      kind: 'ok',
      value: Number.parseInt(raw, 10),
    };
  }

  private async executeShellFunction({
    name,
    body,
    args,
    environment,
    stdin,
    stdout,
    stderr,
    loopDepth,
    functionDepth,
  }: {
    name: string;
    body: WeshASTNode;
    args: string[];
    environment: WeshExecutionEnvironment;
    stdin: WeshFileHandle;
    stdout: WeshFileHandle;
    stderr: WeshFileHandle;
    loopDepth: number;
    functionDepth: number;
  }): Promise<WeshCommandResult> {
    const previousArgs = [...environment.positionalArgs];
    const previousZero = environment.env.get('0');
    environment.positionalArgs = [...args];
    environment.env.set('0', name);
    this.syncSpecialParameters({ environment });
    try {
      const result = await this.executeNode({
        node: body,
        environment,
        stdin,
        stdout,
        stderr,
        loopDepth,
        functionDepth: functionDepth + 1,
      });
      if (result.controlFlow !== undefined) {
        switch (result.controlFlow.kind) {
        case 'return':
          return { exitCode: result.controlFlow.exitCode };
        case 'break':
        case 'continue':
          return result;
        default: {
          const _ex: never = result.controlFlow;
          throw new Error(`Unhandled control flow: ${JSON.stringify(_ex)}`);
        }
        }
      }
      return result;
    } finally {
      environment.positionalArgs = previousArgs;
      if (previousZero === undefined) {
        environment.env.delete('0');
      } else {
        environment.env.set('0', previousZero);
      }
      this.syncSpecialParameters({ environment });
    }
  }

  private compileStringPattern({
    pattern,
  }: {
    pattern: string;
  }): RegExp {
    let source = '^';
    for (let index = 0; index < pattern.length; index += 1) {
      const char = pattern[index];
      if (char === undefined) {
        continue;
      }
      if (char === '\\') {
        const nextChar = pattern[index + 1];
        if (nextChar !== undefined) {
          source += nextChar.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
          index += 1;
          continue;
        }
        source += '\\\\';
        continue;
      }
      if (char === '*') {
        source += '.*';
        continue;
      }
      if (char === '?') {
        source += '.';
        continue;
      }
      if (char === '[') {
        const endIndex = pattern.indexOf(']', index + 1);
        if (endIndex !== -1) {
          let classContent = pattern.slice(index + 1, endIndex);
          if (classContent.startsWith('!')) {
            classContent = '^' + classContent.slice(1);
          }
          source += `[${classContent}]`;
          index = endIndex;
          continue;
        }
      }
      source += char.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    }
    source += '$';
    return new RegExp(source);
  }

  private async caseClauseMatches({
    patterns,
    value,
    environment,
  }: {
    patterns: string[];
    value: string;
    environment: WeshExecutionEnvironment;
  }): Promise<boolean> {
    for (const rawPattern of patterns) {
      const expandedPattern = await this.expandPatternWord({
        raw: rawPattern,
        environment,
      });
      if (this.compileStringPattern({ pattern: expandedPattern }).test(value)) {
        return true;
      }
    }
    return false;
  }

  private async expandPatternWord({
    raw,
    environment,
  }: {
    raw: string;
    environment: WeshExecutionEnvironment;
  }): Promise<string> {
    const substitutionExpandedRaw = await this.expandInlineSubstitutions({
      text: raw,
      environment,
    });
    const parsedParts = this.parseWordParts({ raw: substitutionExpandedRaw });
    let text = '';
    for (const part of parsedParts) {
      text += part.expandVariables
        ? await this.expandPartVariables({
          text: part.text,
          env: environment.env,
          environment,
        })
        : part.text;
    }
    return text;
  }

  private executeArithmeticCommand({
    expression,
    environment,
  }: {
    expression: string;
    environment: WeshExecutionEnvironment;
  }): WeshCommandResult {
    const value = this.evaluateArithmeticExpression({
      expression,
      env: environment.env,
    });
    return {
      exitCode: value === 0 ? 1 : 0,
    };
  }

  private executeExtendedTestCommand({
    args,
  }: {
    args: string[];
  }): WeshCommandResult {
    const tokens = args[args.length - 1] === ']]'
      ? args.slice(0, -1)
      : [...args];
    let position = 0;
    const peek = (): string | undefined => tokens[position];
    const consume = (): string => {
      const token = tokens[position];
      if (token === undefined) {
        throw new Error('Unexpected end of [[ expression');
      }
      position += 1;
      return token;
    };
    const parsePrimary = (): boolean => {
      const token = peek();
      if (token === undefined) {
        return false;
      }
      if (token === '!') {
        consume();
        return !parsePrimary();
      }
      if (token === '(') {
        consume();
        const value = parseOr();
        if (consume() !== ')') {
          throw new Error("Expected ')' in [[ expression");
        }
        return value;
      }
      if (token === '-n') {
        consume();
        return (consume() ?? '').length > 0;
      }
      if (token === '-z') {
        consume();
        return (consume() ?? '').length === 0;
      }

      const left = consume();
      const operator = peek();
      if (operator === undefined || ['&&', '||', ')'].includes(operator)) {
        return left.length > 0;
      }
      if (operator === '==' || operator === '=') {
        consume();
        const right = consume();
        return this.compileStringPattern({ pattern: right }).test(left);
      }
      if (operator === '!=') {
        consume();
        const right = consume();
        return !this.compileStringPattern({ pattern: right }).test(left);
      }
      if (operator === '<') {
        consume();
        return left < consume();
      }
      if (operator === '>') {
        consume();
        return left > consume();
      }
      return left.length > 0;
    };
    const parseAnd = (): boolean => {
      let value = parsePrimary();
      while (peek() === '&&') {
        consume();
        const right = parsePrimary();
        value = value && right;
      }
      return value;
    };
    const parseOr = (): boolean => {
      let value = parseAnd();
      while (peek() === '||') {
        consume();
        const right = parseAnd();
        value = value || right;
      }
      return value;
    };
    const result = parseOr();
    return {
      exitCode: result ? 0 : 1,
    };
  }

  private async executeArgv(options: {
    command: string;
    args: string[];
    environment: WeshExecutionEnvironment;
    stdin: WeshFileHandle;
    stdout: WeshFileHandle;
    stderr: WeshFileHandle;
    ignoreAliases?: boolean;
  }): Promise<WeshCommandResult> {
    const isolatedEnvironment = await this.spawnChildExecutionEnvironment({
      parentEnvironment: options.environment,
      pgid: options.environment.pgid,
    });

    return this.executeCommand({
      node: {
        kind: 'command',
        assignments: [],
        name: options.command,
        args: options.args,
        redirections: [],
      },
      environment: isolatedEnvironment,
      stdin: options.stdin,
      stdout: options.stdout,
      stderr: options.stderr,
      ignoreAliases: options.ignoreAliases,
    });
  }

  private createExecutionEnvironment({
    shellPid,
    pgid,
    env,
    aliases,
    functions,
    cwd,
    fds,
    traps,
    shellOptions,
    positionalArgs,
    lastBackgroundPid,
  }: {
    shellPid: number;
    pgid: number;
    env: Map<string, string>;
    aliases: Map<string, string>;
    functions: Map<string, WeshASTNode>;
    cwd: string;
    fds: Map<number, WeshFileHandle>;
    traps: Map<string, WeshTrapDisposition>;
    shellOptions: Map<WeshShellOption, boolean>;
    positionalArgs: string[];
    lastBackgroundPid: number | undefined;
  }): WeshExecutionEnvironment {
    const environment: WeshExecutionEnvironment = {
      shellPid,
      pgid,
      env,
      aliases,
      functions,
      cwd,
      fds,
      traps,
      shellOptions,
      positionalArgs,
      lastBackgroundPid,
    };
    this.syncSpecialParameters({
      environment,
    });
    return environment;
  }

  private cloneExecutionEnvironment({
    environment,
    shellPid,
    pgid,
  }: {
    environment: WeshExecutionEnvironment;
    shellPid: number | undefined;
    pgid: number | undefined;
  }): WeshExecutionEnvironment {
    return this.createExecutionEnvironment({
      shellPid: shellPid ?? environment.shellPid,
      pgid: pgid ?? environment.pgid,
      env: new Map(environment.env),
      aliases: new Map(environment.aliases),
      functions: new Map(environment.functions),
      cwd: environment.cwd,
      fds: new Map(environment.fds),
      traps: new Map(environment.traps),
      shellOptions: new Map(environment.shellOptions),
      positionalArgs: [...environment.positionalArgs],
      lastBackgroundPid: environment.lastBackgroundPid,
    });
  }

  private async spawnChildExecutionEnvironment({
    parentEnvironment,
    pgid,
  }: {
    parentEnvironment: WeshExecutionEnvironment;
    pgid: number | undefined;
  }): Promise<WeshExecutionEnvironment> {
    const childEnvironment = this.cloneExecutionEnvironment({
      environment: parentEnvironment,
      shellPid: undefined,
      pgid,
    });

    const { pid } = await this.kernel.spawn({
      image: 'wesh',
      args: ['-c'],
      env: childEnvironment.env,
      cwd: childEnvironment.cwd,
      fds: new Map(childEnvironment.fds),
      ppid: parentEnvironment.shellPid,
      pgid: pgid,
      signalDispositions: this.buildProcessSignalDispositions({
        environment: childEnvironment,
      }),
    });

    childEnvironment.shellPid = pid;
    childEnvironment.pgid = pgid ?? pid;
    return childEnvironment;
  }

  private async runExitTrapIfNeeded(options: {
    result: WeshCommandResult;
    environment: WeshExecutionEnvironment;
    stdin: WeshFileHandle;
    stdout: WeshFileHandle;
    stderr: WeshFileHandle;
  }): Promise<WeshCommandResult> {
    const exitTrap = options.environment.traps.get('EXIT');
    if (exitTrap === undefined || exitTrap.kind !== 'run') {
      return options.result;
    }

    await this.runTrapScript({
      script: exitTrap.action,
      trapStatus: options.result.waitStatus ?? {
        kind: 'exited',
        exitCode: options.result.exitCode,
      },
      environment: options.environment,
      stdin: options.stdin,
      stdout: options.stdout,
      stderr: options.stderr,
    });
    return options.result;
  }

  private async runSignalTrapIfNeeded(options: {
    signal: number;
    environment: WeshExecutionEnvironment;
    stdin: WeshFileHandle;
    stdout: WeshFileHandle;
    stderr: WeshFileHandle;
  }): Promise<void> {
    for (const condition of weshSignalConditionNames({ signal: options.signal })) {
      const trapDisposition = options.environment.traps.get(condition);
      if (trapDisposition === undefined) {
        continue;
      }

      switch (trapDisposition.kind) {
      case 'ignore':
        return;
      case 'run':
        await this.runTrapScript({
          script: trapDisposition.action,
          trapStatus: {
            kind: 'signaled',
            signal: options.signal,
          },
          environment: options.environment,
          stdin: options.stdin,
          stdout: options.stdout,
          stderr: options.stderr,
        });
        return;
      default: {
        const _ex: never = trapDisposition;
        throw new Error(`Unhandled trap disposition: ${JSON.stringify(_ex)}`);
      }
      }
    }
  }

  private async runTrapScript(options: {
    script: string;
    trapStatus: WeshWaitStatus;
    environment: WeshExecutionEnvironment;
    stdin: WeshFileHandle;
    stdout: WeshFileHandle;
    stderr: WeshFileHandle;
  }): Promise<void> {
    const previousQuestionMark = options.environment.env.get('?');
    options.environment.env.set(
      '?',
      weshWaitStatusToExitCode({
        waitStatus: options.trapStatus,
      }).toString(),
    );
    try {
      await this.executeShellInState({
        script: options.script,
        environment: options.environment,
        stdin: options.stdin,
        stdout: options.stdout,
        stderr: options.stderr,
      });
    } finally {
      if (previousQuestionMark === undefined) {
        options.environment.env.delete('?');
      } else {
        options.environment.env.set('?', previousQuestionMark);
      }
    }
  }

  private async buildSignalCommandResultIfAny(options: {
    pid: number;
    environment: WeshExecutionEnvironment;
    stdin: WeshFileHandle;
    stdout: WeshFileHandle;
    stderr: WeshFileHandle;
  }): Promise<WeshCommandResult | undefined> {
    const signalWaitStatus = this.kernel.getWaitStatus({ pid: options.pid });
    if (signalWaitStatus === undefined) {
      return undefined;
    }

    switch (signalWaitStatus.kind) {
    case 'signaled':
      this.kernel.consumePendingSignals({ pid: options.pid });
      await this.runSignalTrapIfNeeded({
        signal: signalWaitStatus.signal,
        environment: options.environment,
        stdin: options.stdin,
        stdout: options.stdout,
        stderr: options.stderr,
      });
      return {
        exitCode: weshWaitStatusToExitCode({
          waitStatus: signalWaitStatus,
        }),
        waitStatus: signalWaitStatus,
      };
    case 'stopped':
      this.kernel.consumePendingSignals({ pid: options.pid });
      return {
        exitCode: weshWaitStatusToExitCode({
          waitStatus: signalWaitStatus,
        }),
        waitStatus: signalWaitStatus,
      };
    case 'exited':
      return undefined;
    default: {
      const _ex: never = signalWaitStatus;
      throw new Error(`Unhandled wait status: ${JSON.stringify(_ex)}`);
    }
    }
  }

  private async runWithForegroundProcessGroup<T>(options: {
    pgid: number;
    fn: () => Promise<T>;
  }): Promise<T> {
    const previousForegroundProcessGroupId = this.foregroundProcessGroupId;
    this.foregroundProcessGroupId = options.pgid;
    try {
      return await options.fn();
    } finally {
      this.foregroundProcessGroupId = previousForegroundProcessGroupId;
    }
  }

  private buildProcessSignalDispositions(options: {
    environment: WeshExecutionEnvironment;
  }): Map<number, WeshProcessSignalDisposition> {
    const signalDispositions = new Map<number, WeshProcessSignalDisposition>();

    for (const [condition, disposition] of options.environment.traps.entries()) {
      switch (disposition.kind) {
      case 'ignore':
        for (const signal of weshSignalNumbersForCondition({ condition })) {
          signalDispositions.set(signal, 'ignore');
        }
        break;
      case 'run':
        break;
      default: {
        const _ex: never = disposition;
        throw new Error(`Unhandled trap disposition: ${JSON.stringify(_ex)}`);
      }
      }
    }

    return signalDispositions;
  }

  private syncSpecialParameters(options: {
    environment: WeshExecutionEnvironment;
  }): void {
    const { environment } = options;
    environment.env.set('$$', environment.shellPid.toString());
    environment.env.set('#', environment.positionalArgs.length.toString());
    environment.env.set('0', environment.env.get('SHELL') ?? 'wesh');

    for (let index = 1; index <= 9; index++) {
      const value = environment.positionalArgs[index - 1];
      if (value === undefined) {
        environment.env.delete(index.toString());
      } else {
        environment.env.set(index.toString(), value);
      }
    }

    if (environment.lastBackgroundPid === undefined) {
      environment.env.delete('!');
    } else {
      environment.env.set('!', environment.lastBackgroundPid.toString());
    }
  }

  private async executeShellInState(options: {
    script: string;
    environment: WeshExecutionEnvironment;
    stdin: WeshFileHandle;
    stdout: WeshFileHandle;
    stderr: WeshFileHandle;
  }): Promise<WeshCommandResult> {
    const rootNode = parseCommandLine({
      commandLine: options.script,
      env: options.environment.env,
    });

    return this.executeNode({
      node: rootNode,
      environment: options.environment,
      stdin: options.stdin,
      stdout: options.stdout,
      stderr: options.stderr,
    });
  }
}
