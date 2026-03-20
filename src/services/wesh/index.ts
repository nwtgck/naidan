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
import { createTextHelpers } from './utils/io';
import { normalizePath, resolvePath } from './path';

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
    ['failglob', false],
    ['globstar', false],
    ['nullglob', false],
  ]);
  private foregroundProcessGroupId: number | undefined;

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
    this.kernel = new WeshKernel({ vfs: this.vfs });

    this.env = new Map(Object.entries({
      HOME: '/',
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
    this.registerCommand({ definition: this.createAliasCommandDefinition() });
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
              text: `alias ${alias.name}='${alias.value.replaceAll("'", "'\\''")}'\n`,
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
            if (name.length === 0) {
              await context.text().error({ text: 'alias: invalid alias name\n' });
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
            text: `alias ${existing.name}='${existing.value.replaceAll("'", "'\\''")}'\n`,
          });
        }

        return { exitCode };
      },
    };
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
      const chunk = new Uint8Array(buffer.subarray(0, bytesRead));
      chunks.push(chunk);
      totalLength += chunk.length;
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
    depth,
  }: {
    node: WeshCommandNode;
    environment: WeshExecutionEnvironment;
    depth: number;
  }): WeshCommandNode {
    if (depth >= 20) {
      throw new Error(`alias: expansion loop for ${node.name}`);
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
      depth: depth + 1,
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

  private expandPartVariables({
    text,
    env,
  }: {
    text: string;
    env: Map<string, string>;
  }): string {
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
        const expansion = this.expandBracedParameter({
          text,
          startIndex: index,
          env,
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

  private expandBracedParameter({
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
    const endIndex = text.indexOf('}', startIndex + 2);
    if (endIndex === -1) {
      return {
        value: '$',
        endIndex: startIndex,
      };
    }

    const expression = text.slice(startIndex + 2, endIndex);
    const expansionValue = this.evaluateParameterExpansion({
      expression,
      env,
    });
    return {
      value: expansionValue,
      endIndex,
    };
  }

  private evaluateParameterExpansion({
    expression,
    env,
  }: {
    expression: string;
    env: Map<string, string>;
  }): string {
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
        pattern: this.expandPartVariables({
          text: pattern,
          env,
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
      });
    }

    return this.getParameterValue({
      name: expression,
      env,
    });
  }

  private evaluateParameterOperator({
    name,
    operator,
    operand,
    env,
  }: {
    name: string;
    operator: string;
    operand: string;
    env: Map<string, string>;
  }): string {
    const currentValue = env.get(name);
    const isSet = currentValue !== undefined;
    const isNull = currentValue === '';
    const requireNonNull = operator.startsWith(':');
    const shouldUseOperand = requireNonNull ? !isSet || isNull : !isSet;
    const expandedOperand = this.expandPartVariables({
      text: operand,
      env,
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
  }: {
    field: WeshExpandedField;
  }): boolean {
    return field.parts.some((part) => !part.quoted && /[[*?]/.test(part.text));
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
  }: {
    pattern: string;
  }): RegExp {
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
        source += '[^/]*';
        continue;
      }

      if (char === '?') {
        source += '[^/]';
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

  private isGlobPatternSegment({
    segment,
  }: {
    segment: string;
  }): boolean {
    return /(^|[^\\])[[*?]/.test(segment);
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
        const entries = await this.kernel.readDir({ path: base });
        for (const entry of entries) {
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

      return Array.from(new Set([...zeroDepthMatches, ...deepMatches]));
    }

    const nextBases: string[] = [];
    const segmentHasGlob = this.isGlobPatternSegment({ segment });
    const matcher = segmentHasGlob ? this.compileGlobComponent({ pattern: segment }) : undefined;
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

      const entries = await this.kernel.readDir({ path: base });
      for (const entry of entries) {
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
    if (!this.hasActiveGlob({ field })) {
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
  }: {
    raw: string;
    env: Map<string, string>;
    cwd: string;
    mode: WeshExpansionMode;
    shellOptions: Map<WeshShellOption, boolean>;
  }): Promise<string[]> {
    const parsedParts = this.parseWordParts({ raw });
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
    const expandedParts = tildeExpandedParts.map((part) => ({
      text: part.expandVariables ? this.expandPartVariables({ text: part.text, env }) : part.text,
      quoted: part.quoted,
    }));

    const fields = this.splitExpandedFields({ parts: expandedParts, mode });
    const expandedFields: string[] = [];

    for (const field of fields) {
      const globbed = await this.globField({ field, cwd, shellOptions });
      expandedFields.push(...globbed);
    }

    return expandedFields;
  }

  private async expandSingleWord({
    raw,
    env,
    cwd,
    mode,
    shellOptions,
  }: {
    raw: string;
    env: Map<string, string>;
    cwd: string;
    mode: Exclude<WeshExpansionMode, 'argv'>;
    shellOptions: Map<WeshShellOption, boolean>;
  }): Promise<string> {
    const expanded = await this.expandWord({
      raw,
      env,
      cwd,
      mode,
      shellOptions,
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
      [0, stdin],
      [1, stdout],
      [2, stderr],
    ]);

    for (const [fd, handle] of this.shellFds.entries()) {
      fds.set(fd, handle);
    }

    return fds;
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
  }: {
    redirection: WeshCommandNode['redirections'][number];
    environment: WeshExecutionEnvironment;
  }): Promise<WeshFileHandle | undefined> {
    const rawTarget = redirection.target ? await this.expandSingleWord({
      raw: redirection.target,
      env: environment.env,
      cwd: environment.cwd,
      mode: 'redirection',
      shellOptions: environment.shellOptions,
    }) : undefined;

    if (redirection.type === 'heredoc' || redirection.type === 'herestring') {
      if (redirection.content === undefined) {
        return undefined;
      }

      const { read, write } = await this.kernel.pipe();
      const encoder = new TextEncoder();
      const content = redirection.type === 'heredoc' && redirection.contentExpansion === 'variables'
        ? this.expandPartVariables({ text: redirection.content, env: environment.env })
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

      return duplicated;
    }

    if (rawTarget === undefined) {
      return undefined;
    }

    const fullTarget = rawTarget.startsWith('/') ? rawTarget : `${environment.cwd}/${rawTarget}`;

    switch (redirection.type) {
    case 'read':
      return this.kernel.open({
        path: fullTarget,
        flags: { access: 'read', creation: 'never', truncate: 'preserve', append: 'preserve' },
        mode: 0o644,
      });
    case 'write':
      return this.kernel.open({
        path: fullTarget,
        flags: { access: 'write', creation: 'if-needed', truncate: 'truncate', append: 'preserve' },
        mode: 0o644,
      });
    case 'append':
      return this.kernel.open({
        path: fullTarget,
        flags: { access: 'write', creation: 'if-needed', truncate: 'preserve', append: 'append' },
        mode: 0o644,
      });
    case 'read-write':
      return this.kernel.open({
        path: fullTarget,
        flags: { access: 'read-write', creation: 'if-needed', truncate: 'preserve', append: 'preserve' },
        mode: 0o644,
      });
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
  }: {
    redirections: WeshCommandNode['redirections'];
    environment: WeshExecutionEnvironment;
    fdTable: Map<number, WeshFileHandle>;
    trackOpenedHandle: ({ handle }: { handle: WeshFileHandle }) => void;
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

      const handle = await this.openRedirectionTarget({ redirection, environment });
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
    stderr: WeshFileHandle
  }): Promise<WeshCommandResult> {
    const { node, environment, stdin, stdout, stderr } = options;
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
            stdin, stdout, stderr
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
            stdin, stdout, stderr
          });
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
        fn: async () => this.executeCommand({ ...options, node: node as WeshCommandNode }),
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
        stdin, stdout, stderr
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
        environment, stdin, stdout, stderr
      });
      if (conditionResult.exitCode === 0) {
        result = await this.executeNode({
          node: node.thenBody,
          environment, stdin, stdout, stderr
        });
      } else if (node.elseBody) {
        result = await this.executeNode({
          node: node.elseBody,
          environment, stdin, stdout, stderr
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
        });
        expandedItems.push(...itemFields);
      }

      for (const item of expandedItems) {
        environment.env.set(node.variable, item);
        lastForRes = await this.executeNode({
          node: node.body,
          environment, stdin, stdout, stderr
        });
      }
      result = lastForRes;
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
    stderr: WeshFileHandle
  }): Promise<WeshCommandResult> {
    const { node, environment, stdin, stdout, stderr } = options;
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
  }): Promise<WeshCommandResult> {
    const {
      node,
      environment,
      stdin,
      stdout,
      stderr,
      ignoreAliases,
    } = options;
    const aliasExpandedNode = ignoreAliases === true
      ? node
      : this.expandAliasCommandNode({
        node,
        environment,
        depth: 0,
      });

    const expandedArgs: string[] = [];
    const procSubCleanups: Array<() => void> = [];
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
    });
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

    const currentEnv = new Map(environment.env);
    for (const assign of aliasExpandedNode.assignments) {
      currentEnv.set(assign.key, await this.expandSingleWord({
        raw: assign.value,
        env: environment.env,
        cwd: environment.cwd,
        mode: 'assignment',
        shellOptions: environment.shellOptions,
      }));
    }

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
    });

    const cmdStdin = cmdFds.get(0);
    const cmdStdout = cmdFds.get(1);
    const cmdStderr = cmdFds.get(2);

    if (cmdStdin === undefined || cmdStdout === undefined || cmdStderr === undefined) {
      throw new Error('Missing standard file descriptor after redirection');
    }

    const { pid, process: proc } = await this.kernel.spawn({
      image: resolvedCommand.resolved.invocationPath ?? cmdName,
      args: expandedArgs,
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
      text: () => createTextHelpers({ stdin: boundStdin, stdout: boundStdout, stderr: boundStderr }),
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
      for (const c of procSubCleanups) c();
    }
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
