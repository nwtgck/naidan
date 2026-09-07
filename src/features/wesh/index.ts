import { ReadonlyDirectoryHandle } from './readonly-directory-handle';
import type {
  WeshCommandDefinition,
  WeshCommandFunction,
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
  WeshFileHandleCloseSemantics,
  WeshShellStateSnapshot,
  WeshCommandListEntry,
  WeshDirEntry,
  WeshEntryRef,
} from './types';
import { weshWaitStatusToExitCode } from './types';
import { WeshVFS } from './vfs';
import { WeshKernel } from './kernel';
import { parseCommandLine, parseNextShellUnit } from './parser';
import { createHandleShellSource, createShebangStrippedShellSource, createShellSourceReader, createTextShellSource, readShellSourceToText } from './shell/source';
import type { ShellSource } from './shell/source';
import {
  isAsciiDecimalDigit,
  isAsciiShellIdentifierPart,
  isAsciiShellIdentifierStart,
  isShellWhitespaceCharacter,
} from './shell/ascii';
import { parseShellShebangLine, splitEnvShebangArguments } from './shell/shebang';
import { parseDoubleQuotedParameterOperandParts, parseShellWordParts } from './shell/word';
import { decodeShellBytesToText, encodeShellTextToBytes } from './shell/byte-text';
import { createShellTextIoHelpers } from './shell/io';
import {
  compileShellPattern,
  containsShellPatternMeta,
  escapeShellPatternLiteral,
  matchesCompiledShellPattern,
  matchesShellPattern,
  type WeshCompiledShellPattern,
} from './shell/pattern';
import { parseParameterExpression } from './shell/parameter-expression';
import {
  splitExpandedFields,
  type WeshExpandedField,
  type WeshExpansionContext,
} from './shell/field-split';
import {
  findBackquoteSubstitution,
  findBalancedArithmeticExpression,
  findBalancedParenthesizedExpression,
  findBracedParameterEnd,
  nextShellCharacterIndex,
  previousShellCharacterIndex,
} from './shell/scan';
import { normalizePath, resolvePath } from './path';
import { createWriteHandleFromStream } from './utils/stream';
import { WeshOverlayMap } from './utils/overlay-map';

import { builtinCommands } from './commands';
import { helpCommandDefinition } from './commands/help/definition';

interface WeshJob {
  id: number,
  command: string,
  pid: number,
  status: 'running' | 'done',
}

type WeshShellControlFlow =
  | { kind: 'break', levels: number }
  | { kind: 'continue', levels: number }
  | { kind: 'return', exitCode: number }
  | { kind: 'exit', exitCode: number };

type WeshShellExecutionResult = Omit<WeshCommandResult, 'controlFlow'> & {
  controlFlow?: WeshShellControlFlow,
};

type WeshExecutionOptions = {
  errexit: boolean,
  nounset: boolean,
  pipefail: boolean,
};

type WeshExpandedWordPart = {
  text: string,
  quoted: boolean,
  fieldSplitEligible: boolean,
};

function toWeshCommandResult({ result }: {
  result: WeshShellExecutionResult,
}): WeshCommandResult {
  const controlFlow = result.controlFlow;
  if (controlFlow === undefined) {
    return {
      exitCode: result.exitCode,
      waitStatus: result.waitStatus,
    };
  }
  switch (controlFlow.kind) {
  case 'break':
  case 'continue':
  case 'return':
    return {
      exitCode: result.exitCode,
      waitStatus: result.waitStatus,
      controlFlow,
    };
  case 'exit':
    return {
      exitCode: result.exitCode,
      waitStatus: result.waitStatus,
    };
  default: {
    const _ex: never = controlFlow;
    throw new Error(`Unhandled shell control flow conversion: ${JSON.stringify(_ex)}`);
  }
  }
}

class WeshShellExecutionError extends Error {
  readonly exitCode: number;
  readonly disposition: 'continue' | 'abort-shell';

  constructor({ message, exitCode, disposition }: {
    message: string,
    exitCode: number,
    disposition: 'continue' | 'abort-shell',
  }) {
    super(message);
    this.name = 'WeshShellExecutionError';
    this.exitCode = exitCode;
    this.disposition = disposition;
  }
}

type WeshStdinReferenceOwnership = 'borrowed' | 'command-local';

interface WeshExecutionEnvironment {
  shellPid: number,
  shellRootPid: number,
  pgid: number,
  env: Map<string, string>,
  aliases: Map<string, string>,
  functions: Map<string, WeshASTNode>,
  cwd: string,
  fds: Map<number, WeshFileHandle>,
  traps: Map<string, WeshTrapDisposition>,
  shellOptions: Map<WeshShellOption, boolean>,
  executionOptions: WeshExecutionOptions,
  positionalArgs: string[],
  getoptsState: {
    argumentSignature: string,
    optind: number,
    characterOffset: number,
  } | undefined,
  lastBackgroundPid: number | undefined,
  waitableChildren: Map<number, Promise<WeshCommandResult>>,
  commandSubstitutionSequence: number,
  lastCommandSubstitutionExitCode: number,
  localVariableScopes: Array<Map<string,
    | { kind: 'unset' }
    | { kind: 'value', value: string }
  >>,
  ownedPersistentFds: Set<number>,
}

type WeshGlobComponentMatcher =
  | {
    kind: 'shell-pattern',
    pattern: WeshCompiledShellPattern,
  }
  | {
    kind: 'extglob-regexp',
    pattern: RegExp,
  };

const WESH_SHELL_SPECIAL_FILES = {
  sh: '/bin/sh',
  bash: '/bin/bash',
} as const;

const WESH_SHELL_SPECIAL_FILE_CONTENT = {
  sh: `\
#!/bin/wesh
# virtual sh entrypoint provided by wesh
`,
  bash: `\
#!/bin/wesh
# virtual bash entrypoint provided by wesh
`,
} as const;

class StaticTextFileHandle implements WeshFileHandle {
  private readonly bytes: Uint8Array;
  private readonly mode: number;
  private position = 0;

  constructor({
    text,
    mode,
  }: {
    text: string,
    mode: number,
  }) {
    this.bytes = new TextEncoder().encode(text);
    this.mode = mode;
  }

  async read({ buffer, offset, length: requestedLength, position }: {
    buffer: Uint8Array,
    offset?: number,
    length?: number,
    position?: number,
  }): Promise<{ bytesRead: number }> {
    const bufferOffset = offset ?? 0;
    const length = requestedLength ?? (buffer.length - bufferOffset);
    const start = position ?? this.position;
    if (start >= this.bytes.length) {
      return { bytesRead: 0 };
    }

    const end = Math.min(start + length, this.bytes.length);
    const slice = this.bytes.subarray(start, end);
    buffer.set(slice, bufferOffset);
    if (position === undefined) {
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

function createShellSourceConsumerHandle({
  handle,
  readRetainedBytes,
}: {
  handle: WeshFileHandle,
  readRetainedBytes: ({ buffer, offset, length }: {
    buffer: Uint8Array,
    offset: number,
    length: number,
  }) => number,
}): WeshFileHandle {
  const baseHandle: WeshFileHandle = {
    async read({ buffer, offset, length: requestedLength, position }) {
      const bufferOffset = offset ?? 0;
      const length = requestedLength ?? (buffer.length - bufferOffset);
      if (position !== undefined || length <= 0) {
        return handle.read({ buffer, offset, length, position });
      }

      const retainedBytesRead = readRetainedBytes({
        buffer,
        offset: bufferOffset,
        length,
      });
      if (retainedBytesRead > 0) {
        return { bytesRead: retainedBytesRead };
      }
      return handle.read({
        buffer,
        offset: bufferOffset,
        length,
        position: undefined,
      });
    },
    write: ({ buffer, offset, length, position }) => handle.write({
      buffer,
      offset,
      length,
      position,
    }),
    close: () => handle.close(),
    stat: () => handle.stat(),
    truncate: ({ size }) => handle.truncate({ size }),
    ioctl: ({ request, arg }) => handle.ioctl({ request, arg }),
  };

  const cloneReference = handle.cloneReference;
  if (cloneReference === undefined) {
    return baseHandle;
  }

  return {
    ...baseHandle,
    cloneReference: () => createShellSourceConsumerHandle({
      handle: cloneReference.call(handle),
      readRetainedBytes,
    }),
    getCloseSemantics: handle.getCloseSemantics === undefined
      ? undefined
      : () => handle.getCloseSemantics?.() ?? 'hard',
  };
}

class SharedFileHandle implements WeshFileHandle {
  private readonly state: {
    handle: WeshFileHandle,
    refCount: number,
    closed: boolean,
  };
  private closed = false;

  constructor({
    state,
  }: {
    state: {
      handle: WeshFileHandle,
      refCount: number,
      closed: boolean,
    },
  }) {
    this.state = state;
  }

  cloneReference(): SharedFileHandle {
    this.state.refCount += 1;
    return new SharedFileHandle({
      state: this.state,
    });
  }

  async read({ buffer, offset, length, position }: {
    buffer: Uint8Array,
    offset?: number,
    length?: number,
    position?: number,
  }): Promise<{ bytesRead: number }> {
    const options = { buffer, offset, length, position };
    return this.state.handle.read(options);
  }

  async write({ buffer, offset, length, position }: {
    buffer: Uint8Array,
    offset?: number,
    length?: number,
    position?: number,
  }): Promise<{ bytesWritten: number }> {
    const options = { buffer, offset, length, position };
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

  async truncate({ size }: { size: number }): Promise<void> {
    const options = { size };
    await this.state.handle.truncate(options);
  }

  async ioctl({ request, arg }: { request: number, arg?: unknown }): Promise<{ ret: number }> {
    const options = { request, arg };
    return this.state.handle.ioctl(options);
  }

  getCloseSemantics(): WeshFileHandleCloseSemantics {
    return 'soft';
  }
}

function weshSignalConditionNames({
  signal,
}: {
  signal: number,
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
  condition: string,
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
  private readonly commandLoads = new WeakMap<WeshCommandDefinition, Promise<WeshCommandFunction>>();
  private readonly builtinCommandPreloadQueue: readonly WeshCommandDefinition[] = [
    ...builtinCommands,
    helpCommandDefinition,
  ];
  private builtinCommandPreloadIndex = 0;
  private jobs: Map<number, WeshJob> = new Map();
  private nextJobId: number = 1;
  private shellFds: Map<number, WeshFileHandle> = new Map();
  private traps: Map<string, WeshTrapDisposition> = new Map();
  private readonly activeErrTrapEnvironments = new WeakSet<WeshExecutionEnvironment>();
  private shellOptions: Map<WeshShellOption, boolean> = new Map([
    ['dotglob', false],
    ['extglob', false],
    ['failglob', false],
    ['globstar', false],
    ['nullglob', false],
  ]);
  private executionOptions: WeshExecutionOptions = {
    errexit: false,
    nounset: false,
    pipefail: false,
  };
  private readonly foregroundProcessGroupScopes: Array<{
    id: number,
    pgid: number,
  }> = [];
  private nextForegroundProcessGroupScopeId = 1;

  private shellPid: number = 0;

  constructor({
    rootHandle,
    user = 'user',
    initialEnv = {},
    initialCwd,
  }: {
    rootHandle: FileSystemDirectoryHandle | ReadonlyDirectoryHandle,
    user?: string,
    initialEnv?: Record<string, string>,
    initialCwd?: string,
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
    this.registerCommand({ definition: this.createShellAliasCommandDefinition({ name: 'sh' }) });
    this.registerCommand({ definition: this.createShellAliasCommandDefinition({ name: 'bash' }) });
    this.vfs.registerSpecialFile({
      path: WESH_SHELL_SPECIAL_FILES.sh,
      type: 'file',
      handler: () => new StaticTextFileHandle({
        text: WESH_SHELL_SPECIAL_FILE_CONTENT.sh,
        mode: 0o555,
      }),
    });
    this.vfs.registerSpecialFile({
      path: WESH_SHELL_SPECIAL_FILES.bash,
      type: 'file',
      handler: () => new StaticTextFileHandle({
        text: WESH_SHELL_SPECIAL_FILE_CONTENT.bash,
        mode: 0o555,
      }),
    });

    this.registerInternalCommand({ name: 'jobs', fn: async ({ context }) => {
      const jobs = context.getJobs();
      const { print } = context.text();
      for (const job of jobs) {
        await print({ text: `[${job.id}] ${job.status} ${job.command}\n` });
      }
      return { exitCode: 0 };
    } });
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

  private loadCommandDefinition({ definition }: {
    definition: WeshCommandDefinition,
  }): Promise<WeshCommandFunction> {
    const existing = this.commandLoads.get(definition);
    if (existing !== undefined) {
      return existing;
    }

    const loading = definition.load();
    this.commandLoads.set(definition, loading);
    return loading;
  }

  async preloadNextBuiltinCommand(): Promise<{ hasMore: boolean }> {
    while (this.builtinCommandPreloadIndex < this.builtinCommandPreloadQueue.length) {
      const definition = this.builtinCommandPreloadQueue[this.builtinCommandPreloadIndex];
      this.builtinCommandPreloadIndex += 1;
      if (definition === undefined) {
        break;
      }
      if (this.commands.get(definition.meta.name) !== definition) {
        continue;
      }
      if (this.commandLoads.has(definition)) {
        continue;
      }

      try {
        await this.loadCommandDefinition({ definition });
      } catch (error: unknown) {
        console.error(`Failed to preload Wesh command: ${definition.meta.name}`, error);
      }
      return {
        hasMore: this.builtinCommandPreloadIndex < this.builtinCommandPreloadQueue.length,
      };
    }

    return { hasMore: false };
  }

  getShellState(): WeshShellStateSnapshot {
    return {
      cwd: this.cwd,
      env: Object.fromEntries(this.env.entries()),
    };
  }

  listCommands(): WeshCommandListEntry[] {
    return [
      ...Array.from(this.commands.values()).map((definition): WeshCommandListEntry => ({
        name: definition.meta.name,
        kind: 'builtin',
        description: definition.meta.description,
        usage: definition.meta.usage,
      })),
      ...Array.from(this.aliases.entries()).map(([name, value]): WeshCommandListEntry => ({
        name,
        kind: 'alias',
        description: `Alias for ${value}`,
        usage: value,
      })),
    ].sort((left, right) => left.name.localeCompare(right.name) || left.kind.localeCompare(right.kind));
  }

  async listDirectory({ path }: { path: string }): Promise<WeshDirEntry[]> {
    const resolvedPath = resolvePath({ cwd: this.cwd, path });
    const entries: WeshDirEntry[] = [];
    for await (const entry of this.vfs.readDir({ path: resolvedPath })) {
      entries.push(entry);
    }
    return entries.sort((left, right) => left.name.localeCompare(right.name));
  }

  async signalForegroundProcessGroup({ signal }: { signal: number }): Promise<boolean> {
    const foregroundProcessGroupId = this.foregroundProcessGroupScopes.at(-1)?.pgid;
    if (foregroundProcessGroupId === undefined) {
      return false;
    }

    await this.kernel.killProcessGroup({
      pgid: foregroundProcessGroupId,
      signal: signal,
      excludedPids: [this.shellPid],
    });
    return true;
  }

  private registerInternalCommand({ name, fn }: { name: string, fn: ({ context }: { context: WeshCommandContext }) => Promise<WeshCommandResult> }) {
    this.commands.set(name, {
      meta: { name, description: 'Built-in command', usage: name },
      load: async () => fn,
    });
  }

  private createShellAliasCommandDefinition({
    name,
  }: {
    name: 'sh' | 'bash',
  }): WeshCommandDefinition {
    return {
      meta: {
        name,
        description: `Run commands using the ${name} shell compatibility entrypoint`,
        usage: `${name} [-c command] [file [argument...]]`,
      },
      load: async () => async ({ context }: { context: WeshCommandContext }): Promise<WeshCommandResult> => {
        if (context.args.length === 1 && context.args[0] === '--help') {
          await context.text().print({
            text: `\
${name}: ${name} shell compatibility entrypoint
usage: ${name} [-c command] [file [argument...]]
`,
          });
          return { exitCode: 0 };
        }

        let argumentIndex = 0;
        let noExec = false;
        let stdinMode = false;
        const executionOptions: WeshExecutionOptions = {
          errexit: false,
          nounset: false,
          pipefail: false,
        };
        while (argumentIndex < context.args.length) {
          const argument = context.args[argumentIndex];
          if (argument === '-e' || argument === '+e') {
            executionOptions.errexit = argument === '-e';
            argumentIndex += 1;
            continue;
          }
          if (argument === '-u' || argument === '+u') {
            executionOptions.nounset = argument === '-u';
            argumentIndex += 1;
            continue;
          }
          if ((argument === '-o' || argument === '+o') && context.args[argumentIndex + 1] === 'pipefail') {
            executionOptions.pipefail = argument === '-o';
            argumentIndex += 2;
            continue;
          }
          if (argument === '-n') {
            noExec = true;
            argumentIndex += 1;
            continue;
          }
          if (argument === '-s') {
            stdinMode = true;
            argumentIndex += 1;
            break;
          }
          if (name === 'bash' && (argument === '--noprofile' || argument === '--norc')) {
            argumentIndex += 1;
            continue;
          }
          break;
        }

        if (context.args[argumentIndex] === '-c') {
          const script = context.args[argumentIndex + 1];
          if (script === undefined) {
            await context.text().error({
              text: `${name}: option requires an argument -- 'c'\n`,
            });
            return { exitCode: 2 };
          }
          const zero = context.args[argumentIndex + 2] ?? name;
          return this.executeShellAliasSource({
            name,
            context,
            source: createTextShellSource({ text: script }),
            zero,
            positionalArgs: context.args.slice(argumentIndex + 3),
            noExec,
            executionOptions,
          });
        }

        if (stdinMode) {
          return this.executeShellAliasSource({
            name,
            context,
            source: createHandleShellSource({ handle: context.stdin }),
            zero: name,
            positionalArgs: context.args.slice(argumentIndex),
            noExec,
            executionOptions,
          });
        }

        const scriptPath = context.args[argumentIndex];
        if (scriptPath === undefined) {
          return this.executeShellAliasSource({
            name,
            context,
            source: createHandleShellSource({ handle: context.stdin }),
            zero: name,
            positionalArgs: [],
            noExec,
            executionOptions,
          });
        }

        try {
          const path = resolvePath({
            cwd: context.cwd,
            path: scriptPath,
          });
          const handle = await this.kernel.open({
            path,
            flags: {
              access: 'read',
              creation: 'never',
              truncate: 'preserve',
              append: 'preserve',
            },
          });
          try {
            return await this.executeShellAliasSource({
              name,
              context,
              source: createShebangStrippedShellSource({
                source: createHandleShellSource({ handle }),
              }),
              zero: scriptPath,
              positionalArgs: context.args.slice(argumentIndex + 1),
              noExec,
              executionOptions,
            });
          } finally {
            await handle.close();
          }
        } catch (error: unknown) {
          const message = error instanceof Error ? error.message : String(error);
          await context.text().error({ text: `${name}: ${scriptPath}: ${message}\n` });
          return { exitCode: 1 };
        }
      },
    };
  }

  private async executeShellAliasSource({
    name,
    context,
    source,
    zero,
    positionalArgs,
    noExec,
    executionOptions,
  }: {
    name: 'sh' | 'bash',
    context: WeshCommandContext,
    source: ShellSource,
    zero: string,
    positionalArgs: string[],
    noExec: boolean,
    executionOptions: WeshExecutionOptions,
  }): Promise<WeshCommandResult> {
    if (noExec) {
      try {
        const script = await readShellSourceToText({ source });
        parseCommandLine({
          commandLine: script,
          env: new Map(context.env),
        });
        return { exitCode: 0 };
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        await context.text().error({ text: `${name}: ${message}\n` });
        return { exitCode: 2 };
      }
    }

    const childEnvironment = await this.spawnChildExecutionEnvironment({
      parentEnvironment: this.createExecutionEnvironment({
        shellPid: context.pid,
        pgid: context.process.getGroupId(),
        env: new Map(context.env),
        aliases: new Map(context.getAliases().map(({ name: aliasName, value }) => [aliasName, value])),
        functions: new Map(),
        cwd: context.cwd,
        fds: new Map([
          [0, context.stdin],
          [1, context.stdout],
          [2, context.stderr],
        ]),
        traps: new Map(),
        shellOptions: new Map(context.getShellOptions()),
        executionOptions: { ...executionOptions },
        positionalArgs: [],
        lastBackgroundPid: undefined,
        waitableChildren: new Map(),
      }),
      pgid: context.process.getGroupId(),
    });
    childEnvironment.shellRootPid = childEnvironment.shellPid;
    childEnvironment.positionalArgs = [...positionalArgs];
    this.syncSpecialParameters({ environment: childEnvironment });
    childEnvironment.env.set('0', zero);
    return this.runChildExecutionEnvironment({
      environment: childEnvironment,
      execute: () => this.executeShellInState({
        source,
        environment: childEnvironment,
        stdin: context.stdin,
        stdout: context.stdout,
        stderr: context.stderr,
        history: 'ignore',
        allowReturn: false,
      }),
    });
  }

  private resolveBuiltinCommand({
    name,
    cwd,
    env,
  }: {
    name: string,
    cwd: string,
    env: Map<string, string>,
  }): {
    definition: WeshCommandDefinition,
    resolved: {
      kind: 'builtin',
      name: string,
      meta: WeshCommandDefinition['meta'],
      invocationPath: string | undefined,
      resolution: 'builtin-name' | 'path-lookup' | 'explicit-path',
    },
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
    handle: WeshFileHandle,
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
    name: string,
    cwd: string,
    env: Map<string, string>,
  }): Promise<{ scriptPath: string, interpreter: string, interpreterArgs: string[] } | undefined> {
    const candidatePaths: Array<{
      openPath: string,
      invocationPath: string,
    }> = (() => {
      if (name.includes('/')) {
        return [{
          openPath: resolvePath({ cwd, path: name }),
          invocationPath: name,
        }];
      }

      const pathValue = env.get('PATH') ?? '';
      const pathEntries = pathValue.split(':').filter((entry) => entry.length > 0);
      return pathEntries.map((entry) => {
        const base = resolvePath({
          cwd,
          path: entry,
        });
        return {
          openPath: base === '/' ? `/${name}` : `${base}/${name}`,
          invocationPath: entry === '/' ? `/${name}` : `${entry}/${name}`,
        };
      });
    })();

    for (const candidate of candidatePaths) {
      try {
        const handle = await this.kernel.open({
          path: candidate.openPath,
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
          return {
            scriptPath: candidate.invocationPath,
            interpreter: 'bash',
            interpreterArgs: [],
          };
        }
        const shebang = parseShellShebangLine({ firstLine });
        if (shebang === undefined) {
          return {
            scriptPath: candidate.invocationPath,
            interpreter: 'bash',
            interpreterArgs: [],
          };
        }
        const { interpreter, optionalArgument } = shebang;
        if (!interpreter.startsWith('/')) {
          continue;
        }
        if (interpreter === '/usr/bin/env') {
          if (optionalArgument === undefined || optionalArgument.length === 0) {
            continue;
          }
          const envArguments = splitEnvShebangArguments({ optionalArgument });
          if (envArguments === undefined) {
            continue;
          }
          const envInterpreter = envArguments[0];
          if (envInterpreter === undefined || envInterpreter.length === 0) {
            continue;
          }
          return {
            scriptPath: candidate.invocationPath,
            interpreter: envInterpreter,
            interpreterArgs: envArguments.slice(1),
          };
        }
        return {
          scriptPath: candidate.invocationPath,
          interpreter,
          interpreterArgs: optionalArgument === undefined ? [] : [optionalArgument],
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
    node: WeshCommandNode,
    environment: WeshExecutionEnvironment,
    expandedAliases: Set<string>,
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

  private findBraceExpansion({
    raw,
  }: {
    raw: string,
  }): { start: number, end: number, parts: string[] } | undefined {
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

      if (raw[index - 1] === '$') {
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
    raw: string,
    startIndex: number,
  }): { start: number, end: number, parts: string[] } | undefined {
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
    content: string,
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
    startRaw: string,
    endRaw: string,
    stepRaw: string | undefined,
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
    value: number,
    width: number,
    pad: boolean,
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
    startRaw: string,
    endRaw: string,
    stepRaw: string | undefined,
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
    raw: string,
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
    text: string,
    env: Map<string, string>,
    environment: WeshExecutionEnvironment,
  }): Promise<string> {
    let result = '';

    for (let index = 0; index < text.length; index++) {
      const char = text[index];
      if (char === '`') {
        const expansion = await this.expandBackquoteCommandSubstitution({
          text,
          startIndex: index,
          environment,
        });
        result += expansion.value;
        index = expansion.endIndex;
        continue;
      }
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

      if (nextChar !== undefined && nextChar !== '0' && isAsciiDecimalDigit({ value: nextChar })) {
        result += this.getParameterValue({
          name: nextChar,
          env,
          nounset: environment.executionOptions.nounset,
        });
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

      if (isAsciiShellIdentifierStart({ value: nextChar })) {
        let endIndex = index + 2;
        while (endIndex < text.length && isAsciiShellIdentifierPart({ value: text[endIndex] })) {
          endIndex += 1;
        }

        const key = text.slice(index + 1, endIndex);
        if (key === 'RANDOM') {
          result += Math.floor(Math.random() * 32768).toString();
        } else {
          result += this.getParameterValue({
            name: key,
            env,
            nounset: environment.executionOptions.nounset,
          });
        }
        index = endIndex - 1;
        continue;
      }

      result += '$';
    }

    return result;
  }

  private async expandPartVariablesToParts({
    text,
    env,
    environment,
    quoted,
    literalFieldSplitEligible,
  }: {
    text: string,
    env: Map<string, string>,
    environment: WeshExecutionEnvironment,
    quoted: boolean,
    literalFieldSplitEligible: boolean,
  }): Promise<WeshExpandedWordPart[]> {
    const parts: WeshExpandedWordPart[] = [];
    let literal = '';

    const flushLiteral = (): void => {
      if (literal.length === 0) return;
      parts.push({
        text: literal,
        quoted,
        fieldSplitEligible: !quoted && literalFieldSplitEligible,
      });
      literal = '';
    };
    const appendExpansion = ({ value }: { value: string }): void => {
      flushLiteral();
      parts.push({
        text: value,
        quoted,
        fieldSplitEligible: !quoted,
      });
    };

    for (let index = 0; index < text.length; index += 1) {
      const char = text[index];
      if (char === '`') {
        const expansion = await this.expandBackquoteCommandSubstitution({
          text,
          startIndex: index,
          environment,
        });
        appendExpansion({ value: expansion.value });
        index = expansion.endIndex;
        continue;
      }
      if (char !== '$') {
        literal += char ?? '';
        continue;
      }

      const nextChar = text[index + 1];
      if (nextChar === '?') {
        appendExpansion({ value: env.get('?') ?? '0' });
        index += 1;
        continue;
      }

      if (nextChar === '$') {
        appendExpansion({ value: env.get('$$') ?? '' });
        index += 1;
        continue;
      }

      if (nextChar === '#') {
        appendExpansion({ value: env.get('#') ?? '0' });
        index += 1;
        continue;
      }

      if (nextChar === '!') {
        appendExpansion({ value: env.get('!') ?? '' });
        index += 1;
        continue;
      }

      if (nextChar === '0') {
        appendExpansion({ value: env.get('0') ?? '' });
        index += 1;
        continue;
      }

      if (nextChar !== undefined && nextChar !== '0' && isAsciiDecimalDigit({ value: nextChar })) {
        appendExpansion({
          value: this.getParameterValue({
            name: nextChar,
            env,
            nounset: environment.executionOptions.nounset,
          }),
        });
        index += 1;
        continue;
      }

      if (nextChar === '{') {
        const endIndex = findBracedParameterEnd({
          text,
          startIndex: index,
        });
        if (endIndex === -1) {
          literal += '$';
          continue;
        }

        const expression = text.slice(index + 2, endIndex);
        const parsedExpression = parseParameterExpression({ expression });
        if (parsedExpression !== undefined) {
          switch (parsedExpression.kind) {
          case 'value-operator':
            flushLiteral();
            parts.push(...await this.evaluateParameterOperatorParts({
              name: parsedExpression.name,
              operator: parsedExpression.operator,
              operand: parsedExpression.operand,
              env,
              environment,
              quoted,
            }));
            index = endIndex;
            continue;
          case 'indirect':
          case 'substring':
          case 'pattern-operator':
          case 'case-operator':
          case 'substitution':
            break;
          default: {
            const exhaustiveCheck = parsedExpression satisfies never;
            throw new Error(`Unhandled parameter expression: ${String(exhaustiveCheck)}`);
          }
          }
        }

        appendExpansion({
          value: await this.evaluateParameterExpansion({
            expression,
            env,
            environment,
          }),
        });
        index = endIndex;
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
          appendExpansion({ value: expansion.value });
          index = expansion.endIndex;
          continue;
        }
        const expansion = await this.expandCommandSubstitution({
          text,
          startIndex: index,
          environment,
        });
        appendExpansion({ value: expansion.value });
        index = expansion.endIndex;
        continue;
      }

      if (isAsciiShellIdentifierStart({ value: nextChar })) {
        let endIndex = index + 2;
        while (endIndex < text.length && isAsciiShellIdentifierPart({ value: text[endIndex] })) {
          endIndex += 1;
        }

        const key = text.slice(index + 1, endIndex);
        appendExpansion({
          value: key === 'RANDOM'
            ? Math.floor(Math.random() * 32768).toString()
            : this.getParameterValue({
              name: key,
              env,
              nounset: environment.executionOptions.nounset,
            }),
        });
        index = endIndex - 1;
        continue;
      }

      literal += '$';
    }

    flushLiteral();
    if (parts.length === 0 && quoted) {
      parts.push({
        text: '',
        quoted: true,
        fieldSplitEligible: false,
      });
    }
    return parts;
  }

  private async expandParameterOperandParts({
    operand,
    env,
    environment,
    quoted,
  }: {
    operand: string,
    env: Map<string, string>,
    environment: WeshExecutionEnvironment,
    quoted: boolean,
  }): Promise<WeshExpandedWordPart[]> {
    const parsedParts = quoted
      ? parseDoubleQuotedParameterOperandParts({ raw: operand })
      : parseShellWordParts({ raw: operand });
    const tildeExpandedParts = parsedParts.flatMap((part, index) => {
      if (
        quoted ||
        index !== 0 ||
        part.quoted ||
        !part.text.startsWith('~') ||
        (part.text.length !== 1 && part.text[1] !== '/')
      ) {
        return [part];
      }

      const tilde = this.splitTildePrefix({
        text: part.text,
        env,
      });
      if (tilde === undefined) {
        throw new Error('Expected leading parameter-operand tilde expansion');
      }
      return [
        {
          text: tilde.prefix,
          quoted: true,
          expandVariables: false,
        },
        {
          ...part,
          text: tilde.suffix,
        },
      ];
    });

    const expanded: WeshExpandedWordPart[] = [];
    for (const part of tildeExpandedParts) {
      if (part.expandVariables) {
        expanded.push(...await this.expandPartVariablesToParts({
          text: part.text,
          env,
          environment,
          quoted: quoted || part.quoted,
          literalFieldSplitEligible: !quoted && !part.quoted,
        }));
      } else {
        expanded.push({
          text: part.text,
          quoted: quoted || part.quoted,
          fieldSplitEligible: false,
        });
      }
    }
    return expanded;
  }

  private async evaluateParameterOperatorParts({
    name,
    operator,
    operand,
    env,
    environment,
    quoted,
  }: {
    name: string,
    operator: string,
    operand: string,
    env: Map<string, string>,
    environment: WeshExecutionEnvironment,
    quoted: boolean,
  }): Promise<WeshExpandedWordPart[]> {
    const currentValue = env.get(name);
    const isSet = currentValue !== undefined;
    const isNull = currentValue === '';
    const requireNonNull = operator.startsWith(':');
    const shouldUseOperand = requireNonNull ? !isSet || isNull : !isSet;
    const currentParts = (): WeshExpandedWordPart[] => [{
      text: currentValue ?? '',
      quoted,
      fieldSplitEligible: !quoted,
    }];
    const expandOperand = () => this.expandParameterOperandParts({
      operand,
      env,
      environment,
      quoted,
    });

    switch (operator) {
    case ':-':
    case '-':
      return shouldUseOperand ? expandOperand() : currentParts();
    case ':=':
    case '=':
      if (shouldUseOperand) {
        const expandedOperand = await expandOperand();
        env.set(name, expandedOperand.map((part) => part.text).join(''));
        return expandedOperand;
      }
      return currentParts();
    case ':+':
    case '+':
      return shouldUseOperand ? [] : expandOperand();
    case ':?':
    case '?':
      if (shouldUseOperand) {
        const expandedOperand = await expandOperand();
        const message = expandedOperand.map((part) => part.text).join('');
        throw new WeshShellExecutionError({
          message: message.length > 0
            ? `${name}: ${message}`
            : `${name}: parameter null or not set`,
          exitCode: 127,
          disposition: 'abort-shell',
        });
      }
      return currentParts();
    default:
      return currentParts();
    }
  }

  private async expandBracedParameter({
    text,
    startIndex,
    env,
    environment,
  }: {
    text: string,
    startIndex: number,
    env: Map<string, string>,
    environment: WeshExecutionEnvironment,
  }): Promise<{
    value: string,
    endIndex: number,
  }> {
    const endIndex = findBracedParameterEnd({
      text,
      startIndex,
    });
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
    text: string,
    startIndex: number,
    environment: WeshExecutionEnvironment,
  }): Promise<{
    value: string,
    endIndex: number,
  }> {
    const parsed = findBalancedParenthesizedExpression({
      text,
      startIndex: startIndex + 1,
    });
    if (parsed === undefined) {
      return {
        value: '$',
        endIndex: startIndex,
      };
    }

    return {
      value: await this.executeCommandSubstitutionScript({
        script: parsed.content,
        environment,
      }),
      endIndex: parsed.endIndex,
    };
  }

  private async expandBackquoteCommandSubstitution({
    text,
    startIndex,
    environment,
  }: {
    text: string,
    startIndex: number,
    environment: WeshExecutionEnvironment,
  }): Promise<{
    value: string,
    endIndex: number,
  }> {
    const parsed = findBackquoteSubstitution({ text, startIndex });
    if (parsed === undefined) {
      return {
        value: '`',
        endIndex: startIndex,
      };
    }

    let script = '';
    for (let index = 0; index < parsed.content.length; index += 1) {
      const character = parsed.content[index];
      if (character !== '\\') {
        script += character ?? '';
        continue;
      }
      const nextCharacter = parsed.content[index + 1];
      if (nextCharacter === '$' || nextCharacter === '`' || nextCharacter === '\\') {
        script += nextCharacter;
        index += 1;
        continue;
      }
      if (nextCharacter === '\n') {
        index += 1;
        continue;
      }
      script += '\\';
    }

    return {
      value: await this.executeCommandSubstitutionScript({ script, environment }),
      endIndex: parsed.endIndex,
    };
  }

  private async executeCommandSubstitutionScript({
    script,
    environment,
  }: {
    script: string,
    environment: WeshExecutionEnvironment,
  }): Promise<string> {
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
    const result = await this.runChildExecutionEnvironment({
      environment: childEnvironment,
      execute: async () => {
        const rawResult = await this.executeShellInState({
          source: createTextShellSource({ text: script }),
          environment: childEnvironment,
          stdin,
          stdout: captureHandle,
          stderr,
          history: 'ignore',
          allowReturn: false,
        });
        return this.runExitTrapIfNeeded({
          result: rawResult,
          environment: childEnvironment,
          stdin,
          stdout: captureHandle,
          stderr,
        });
      },
    });
    environment.commandSubstitutionSequence += 1;
    environment.lastCommandSubstitutionExitCode = result.exitCode;

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
    return decodeShellBytesToText({ bytes }).replace(/\n+$/u, '');
  }

  private expandArithmeticExpansion({
    text,
    startIndex,
    env,
  }: {
    text: string,
    startIndex: number,
    env: Map<string, string>,
  }): {
    value: string,
    endIndex: number,
  } {
    const parsed = findBalancedArithmeticExpression({
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

  private async evaluateParameterExpansion({
    expression,
    env,
    environment,
  }: {
    expression: string,
    env: Map<string, string>,
    environment: WeshExecutionEnvironment,
  }): Promise<string> {
    if (expression.length === 0) {
      return '';
    }

    if (expression.startsWith('#')) {
      const name = expression.slice(1);
      if (name === '@' || name === '*') {
        return environment.positionalArgs.length.toString();
      }
      return Array.from(this.getParameterValue({
        name,
        env,
        nounset: environment.executionOptions.nounset,
      })).length.toString();
    }

    const parsedExpression = parseParameterExpression({ expression });
    if (parsedExpression === undefined) {
      return this.getParameterValue({
        name: expression,
        env,
        nounset: environment.executionOptions.nounset,
      });
    }

    switch (parsedExpression.kind) {
    case 'indirect': {
      const targetName = this.getParameterValue({
        name: parsedExpression.name,
        env,
        nounset: environment.executionOptions.nounset,
      });
      return this.getParameterValue({
        name: targetName,
        env,
        nounset: environment.executionOptions.nounset,
      });
    }
    case 'value-operator':
      return this.evaluateParameterOperator({
        name: parsedExpression.name,
        operator: parsedExpression.operator,
        operand: parsedExpression.operand,
        env,
        environment,
      });
    case 'substring': {
      const value = this.getParameterValue({
        name: parsedExpression.name,
        env,
        nounset: environment.executionOptions.nounset,
      });
      const characters = Array.from(value);
      const offset = this.evaluateArithmeticExpression({
        expression: parsedExpression.offsetExpression,
        env,
      });
      const start = offset < 0
        ? Math.max(characters.length + offset, 0)
        : Math.min(offset, characters.length);
      if (parsedExpression.lengthExpression === undefined) {
        return characters.slice(start).join('');
      }
      const length = this.evaluateArithmeticExpression({
        expression: parsedExpression.lengthExpression,
        env,
      });
      if (length < 0) {
        const end = characters.length + length;
        if (end < start) {
          throw new WeshShellExecutionError({
            message: `${length}: substring expression < 0`,
            exitCode: 1,
            disposition: 'continue',
          });
        }
        return characters.slice(start, end).join('');
      }
      return characters.slice(start, start + length).join('');
    }
    case 'case-operator': {
      const value = this.getParameterValue({
        name: parsedExpression.name,
        env,
        nounset: environment.executionOptions.nounset,
      });
      const operator = parsedExpression.operator;
      switch (operator) {
      case '^^':
        return value.toUpperCase();
      case ',,':
        return value.toLowerCase();
      case '^': {
        const [first = '', ...rest] = Array.from(value);
        return first.toUpperCase() + rest.join('');
      }
      case ',': {
        const [first = '', ...rest] = Array.from(value);
        return first.toLowerCase() + rest.join('');
      }
      default: {
        const _ex: never = operator;
        throw new Error(`Unhandled parameter case operator: ${_ex}`);
      }
      }
    }
    case 'substitution': {
      const pattern = await this.expandPartVariables({
        text: parsedExpression.pattern,
        env,
        environment,
      });
      const replacement = await this.expandPartVariables({
        text: parsedExpression.replacement,
        env,
        environment,
      });
      return this.applyParameterSubstitution({
        value: this.getParameterValue({
          name: parsedExpression.name,
          env,
          nounset: environment.executionOptions.nounset,
        }),
        operator: parsedExpression.operator,
        pattern,
        replacement,
      });
    }
    case 'pattern-operator':
      return this.applyParameterPatternOperator({
        value: this.getParameterValue({
          name: parsedExpression.name,
          env,
          nounset: environment.executionOptions.nounset,
        }),
        operator: parsedExpression.operator,
        pattern: await (() => {
          const tilde = this.splitTildePrefix({
            text: parsedExpression.pattern,
            env,
          });
          return this.expandPartVariables({
            text: tilde === undefined
              ? parsedExpression.pattern
              : this.escapeGlobLiteral({ text: tilde.prefix }) + tilde.suffix,
            env,
            environment,
          });
        })(),
      });
    default: {
      const _ex: never = parsedExpression;
      throw new Error(`Unhandled parsed parameter expression: ${String(_ex)}`);
    }
    }
  }

  private evaluateArithmeticExpression({
    expression,
    env,
  }: {
    expression: string,
    env: Map<string, string>,
  }): number {
    return this.evaluateArithmeticExpressionInternal({
      expression,
      env,
      resolvingVariableNames: new Set(),
    });
  }

  private evaluateArithmeticExpressionInternal({
    expression,
    env,
    resolvingVariableNames,
  }: {
    expression: string,
    env: Map<string, string>,
    resolvingVariableNames: Set<string>,
  }): number {
    type ArithmeticToken =
      | { kind: 'number', value: number }
      | { kind: 'identifier', value: string }
      | { kind: 'operator', value: string };
    type ArithmeticValue = {
      value: number,
      targetName: string | undefined,
    };

    const tokens: ArithmeticToken[] = [];
    for (let index = 0; index < expression.length;) {
      const char = expression[index];
      if (char === undefined) {
        break;
      }
      if (isShellWhitespaceCharacter({ value: char })) {
        index += 1;
        continue;
      }
      const multiCharacterOperator = [
        '++', '--', '**', '+=', '-=', '*=', '/=', '%=',
        '==', '!=', '<=', '>=', '<<', '>>', '&&', '||',
      ].find((candidate) => expression.startsWith(candidate, index));
      if (multiCharacterOperator !== undefined) {
        tokens.push({ kind: 'operator', value: multiCharacterOperator });
        index += multiCharacterOperator.length;
        continue;
      }
      if ('()+-*/%!<=>,'.includes(char)) {
        tokens.push({ kind: 'operator', value: char });
        index += 1;
        continue;
      }
      if (isAsciiDecimalDigit({ value: char })) {
        let endIndex = index + 1;
        while (endIndex < expression.length && isAsciiDecimalDigit({ value: expression[endIndex] })) {
          endIndex += 1;
        }
        const radixText = expression.slice(index, endIndex);
        if (expression[endIndex] === '#') {
          const radix = Number.parseInt(radixText, 10);
          if (!Number.isSafeInteger(radix) || radix < 2 || radix > 64) {
            throw new Error(`Invalid arithmetic base: ${radixText}`);
          }
          const digitsStart = endIndex + 1;
          endIndex = digitsStart;
          while (endIndex < expression.length && /[0-9A-Za-z@_]/u.test(expression[endIndex] ?? '')) {
            endIndex += 1;
          }
          const digits = expression.slice(digitsStart, endIndex);
          if (digits.length === 0) {
            throw new Error(`Missing digits for arithmetic base ${radix}`);
          }
          const digitValue = ({ digit }: { digit: string }): number => {
            if (digit >= '0' && digit <= '9') return digit.codePointAt(0)! - '0'.codePointAt(0)!;
            if (digit >= 'a' && digit <= 'z') return digit.codePointAt(0)! - 'a'.codePointAt(0)! + 10;
            if (digit >= 'A' && digit <= 'Z') {
              const upperValue = digit.codePointAt(0)! - 'A'.codePointAt(0)! + 10;
              return radix <= 36 ? upperValue : upperValue + 26;
            }
            if (digit === '@') return 62;
            if (digit === '_') return 63;
            throw new Error(`Invalid arithmetic digit: ${digit}`);
          };
          let value = 0;
          for (const digit of digits) {
            const numericDigit = digitValue({ digit });
            if (numericDigit >= radix) {
              throw new Error(`Invalid digit '${digit}' for arithmetic base ${radix}`);
            }
            value = value * radix + numericDigit;
          }
          tokens.push({ kind: 'number', value });
          index = endIndex;
          continue;
        }
        const numberText = radixText;
        const hasOctalPrefix = numberText.length > 1 && numberText.startsWith('0');
        if (hasOctalPrefix && [...numberText].some((digit) => digit === '8' || digit === '9')) {
          throw new Error(`Invalid octal arithmetic literal: ${numberText}`);
        }
        tokens.push({
          kind: 'number',
          value: Number.parseInt(numberText, hasOctalPrefix ? 8 : 10),
        });
        index = endIndex;
        continue;
      }
      if (isAsciiShellIdentifierStart({ value: char })) {
        let endIndex = index + 1;
        while (endIndex < expression.length && isAsciiShellIdentifierPart({ value: expression[endIndex] })) {
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
      name: string,
    }): number => {
      const raw = env.get(name);
      if (raw === undefined || raw.length === 0) {
        return 0;
      }
      if (resolvingVariableNames.has(name)) {
        throw new Error(`Recursive arithmetic variable reference: ${name}`);
      }
      resolvingVariableNames.add(name);
      try {
        return this.evaluateArithmeticExpressionInternal({
          expression: raw,
          env,
          resolvingVariableNames,
        });
      } finally {
        resolvingVariableNames.delete(name);
      }
    };
    const writeVariable = ({
      name,
      value,
    }: {
      name: string,
      value: number,
    }): number => {
      env.set(name, value.toString());
      return value;
    };
    const requireTarget = ({
      value,
    }: {
      value: ArithmeticValue,
    }): string => {
      if (value.targetName === undefined) {
        throw new Error('Arithmetic assignment requires a variable');
      }
      return value.targetName;
    };
    const toPlain = ({
      value,
    }: {
      value: number,
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
          const value = parseComma();
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
        case '**':
        case '/':
        case '%':
        case '==':
        case '!=':
        case '<':
        case '<=':
        case '>':
        case '>=':
        case '<<':
        case '>>':
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
        case ',':
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
      return parsePower();
    };

    const parsePower = (): ArithmeticValue => {
      const left = parsePostfix();
      const token = peek();
      if (token?.kind !== 'operator' || token.value !== '**') {
        return left;
      }
      consume();
      const right = parseUnary();
      return toPlain({ value: left.value ** right.value });
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

    const parseShift = (): ArithmeticValue => {
      let left = parseAdditive();
      while (true) {
        const token = peek();
        if (token?.kind !== 'operator' || !['<<', '>>'].includes(token.value)) {
          return left;
        }
        consume();
        const right = parseAdditive();
        const shiftCount = Math.trunc(right.value);
        if (!Number.isSafeInteger(shiftCount) || shiftCount < 0 || shiftCount > 52) {
          throw new Error(`Arithmetic shift count is outside the safe integer range: ${right.value}`);
        }
        const integerValue = Math.trunc(left.value);
        const factor = 2 ** shiftCount;
        left = toPlain({
          value: token.value === '<<'
            ? integerValue * factor
            : Math.floor(integerValue / factor),
        });
      }
    };

    const parseComparison = (): ArithmeticValue => {
      let left = parseShift();
      while (true) {
        const token = peek();
        if (token?.kind !== 'operator' || !['<', '<=', '>', '>='].includes(token.value)) {
          return left;
        }
        consume();
        const right = parseShift();
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

    const parseComma = (): ArithmeticValue => {
      let value = parseAssignment();
      while (peek()?.kind === 'operator' && peek()?.value === ',') {
        consume();
        value = parseAssignment();
      }
      return value;
    };

    const result = parseComma();
    if (position !== tokens.length) {
      throw new Error('Unexpected trailing arithmetic tokens');
    }
    return result.value;
  }

  private splitTildePrefix({ text, env }: {
    text: string,
    env: Map<string, string>,
  }): {
    prefix: string,
    suffix: string,
  } | undefined {
    if (!text.startsWith('~') || (text.length !== 1 && text[1] !== '/')) {
      return undefined;
    }

    const prefix = env.get('HOME') ?? '/home';
    const rawSuffix = text.slice(1);
    if (prefix !== '/') {
      return { prefix, suffix: rawSuffix };
    }

    let suffixStart = 0;
    while (rawSuffix[suffixStart] === '/') {
      suffixStart += 1;
    }
    return { prefix, suffix: rawSuffix.slice(suffixStart) };
  }

  private async evaluateParameterOperator({
    name,
    operator,
    operand,
    env,
    environment,
  }: {
    name: string,
    operator: string,
    operand: string,
    env: Map<string, string>,
    environment: WeshExecutionEnvironment,
  }): Promise<string> {
    const currentValue = env.get(name);
    const isSet = currentValue !== undefined;
    const isNull = currentValue === '';
    const requireNonNull = operator.startsWith(':');
    const shouldUseOperand = requireNonNull ? !isSet || isNull : !isSet;
    const expandOperand = () => this.expandPartVariables({
      text: operand,
      env,
      environment,
    });

    switch (operator) {
    case ':-':
    case '-':
      return shouldUseOperand ? await expandOperand() : currentValue ?? '';
    case ':=':
    case '=':
      if (shouldUseOperand) {
        const expandedOperand = await expandOperand();
        env.set(name, expandedOperand);
        return expandedOperand;
      }
      return currentValue ?? '';
    case ':+':
    case '+':
      return shouldUseOperand ? '' : await expandOperand();
    case ':?':
    case '?':
      if (shouldUseOperand) {
        const expandedOperand = await expandOperand();
        throw new WeshShellExecutionError({
          message: expandedOperand.length > 0
            ? `${name}: ${expandedOperand}`
            : `${name}: parameter null or not set`,
          exitCode: 127,
          disposition: 'abort-shell',
        });
      }
      return currentValue ?? '';
    default:
      return currentValue ?? '';
    }
  }


  private applyParameterSubstitution({
    value,
    operator,
    pattern,
    replacement,
  }: {
    value: string,
    operator: 'first' | 'all' | 'prefix' | 'suffix',
    pattern: string,
    replacement: string,
  }): string {
    if (pattern.length === 0 && (operator === 'first' || operator === 'all')) return value;

    const compiledPattern = compileShellPattern({ pattern });
    const matchesRange = ({ start, end }: { start: number, end: number }): boolean =>
      matchesCompiledShellPattern({
        compiledPattern,
        text: value.slice(start, end),
      });

    const longestMatchFrom = ({ start }: { start: number }): number | undefined => {
      for (let end = value.length;;) {
        if (end >= start && matchesRange({ start, end })) return end;
        if (end <= start) break;
        end = previousShellCharacterIndex({ text: value, index: end });
      }
      return undefined;
    };

    switch (operator) {
    case 'prefix': {
      const end = longestMatchFrom({ start: 0 });
      return end === undefined ? value : replacement + value.slice(end);
    }
    case 'suffix': {
      for (let start = 0;;) {
        if (matchesRange({ start, end: value.length })) {
          return value.slice(0, start) + replacement;
        }
        if (start === value.length) break;
        start = nextShellCharacterIndex({ text: value, index: start });
      }
      return value;
    }
    case 'first': {
      for (let start = 0;;) {
        const end = longestMatchFrom({ start });
        if (end !== undefined) {
          return value.slice(0, start) + replacement + value.slice(end);
        }
        if (start === value.length) break;
        start = nextShellCharacterIndex({ text: value, index: start });
      }
      return value;
    }
    case 'all': {
      let result = '';
      let cursor = 0;
      while (cursor <= value.length) {
        let matched = false;
        for (let start = cursor;;) {
          const end = longestMatchFrom({ start });
          if (end !== undefined) {
            result += value.slice(cursor, start) + replacement;
            if (end === start) {
              if (start === value.length) return result;
              const next = nextShellCharacterIndex({ text: value, index: start });
              result += value.slice(start, next);
              cursor = next;
            } else {
              cursor = end;
            }
            matched = true;
            break;
          }
          if (start === value.length) break;
          start = nextShellCharacterIndex({ text: value, index: start });
        }
        if (!matched) {
          result += value.slice(cursor);
          break;
        }
      }
      return result;
    }
    default: {
      const _ex: never = operator;
      throw new Error(`Unhandled parameter substitution operator: ${_ex}`);
    }
    }
  }

  private applyParameterPatternOperator({
    value,
    operator,
    pattern,
  }: {
    value: string,
    operator: '##' | '#' | '%%' | '%',
    pattern: string,
  }): string {
    const compiledPattern = compileShellPattern({ pattern });
    const matchesPattern = ({
      text,
    }: {
      text: string,
    }): boolean => {
      return matchesCompiledShellPattern({ compiledPattern, text });
    };

    switch (operator) {
    case '#': {
      for (let prefixEnd = 0;;) {
        const prefix = value.slice(0, prefixEnd);
        if (matchesPattern({ text: prefix })) {
          return value.slice(prefixEnd);
        }
        if (prefixEnd === value.length) {
          break;
        }
        prefixEnd = nextShellCharacterIndex({
          text: value,
          index: prefixEnd,
        });
      }
      return value;
    }
    case '##': {
      for (let prefixEnd = value.length;;) {
        const prefix = value.slice(0, prefixEnd);
        if (matchesPattern({ text: prefix })) {
          return value.slice(prefixEnd);
        }
        if (prefixEnd === 0) {
          break;
        }
        prefixEnd = previousShellCharacterIndex({
          text: value,
          index: prefixEnd,
        });
      }
      return value;
    }
    case '%': {
      for (let suffixStart = value.length;;) {
        const suffix = value.slice(suffixStart);
        if (matchesPattern({ text: suffix })) {
          return value.slice(0, suffixStart);
        }
        if (suffixStart === 0) {
          break;
        }
        suffixStart = previousShellCharacterIndex({
          text: value,
          index: suffixStart,
        });
      }
      return value;
    }
    case '%%': {
      for (let suffixStart = 0;;) {
        const suffix = value.slice(suffixStart);
        if (matchesPattern({ text: suffix })) {
          return value.slice(0, suffixStart);
        }
        if (suffixStart === value.length) {
          break;
        }
        suffixStart = nextShellCharacterIndex({
          text: value,
          index: suffixStart,
        });
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
    nounset = false,
  }: {
    name: string,
    env: Map<string, string>,
    nounset?: boolean,
  }): string {
    if (name === 'RANDOM') {
      return Math.floor(Math.random() * 32768).toString();
    }
    const value = env.get(name);
    if (value === undefined && nounset) {
      throw new WeshShellExecutionError({
        message: `${name}: unbound variable`,
        exitCode: 127,
        disposition: 'abort-shell',
      });
    }
    return value ?? '';
  }

  private escapeGlobLiteral({
    text,
  }: {
    text: string,
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
    field: WeshExpandedField,
    shellOptions: Map<WeshShellOption, boolean>,
  }): boolean {
    const extglob = shellOptions.get('extglob') === true ? 'enabled' : 'disabled';
    return field.parts.some((part) => {
      if (part.quoted) {
        return false;
      }

      return containsShellPatternMeta({
        pattern: part.text,
        extglob,
      });
    });
  }

  private buildGlobPattern({
    field,
  }: {
    field: WeshExpandedField,
  }): string {
    return field.parts
      .map((part) => part.quoted ? this.escapeGlobLiteral({ text: part.text }) : part.text)
      .join('');
  }

  private createGlobComponentMatcher({
    pattern,
    shellOptions,
  }: {
    pattern: string,
    shellOptions: Map<WeshShellOption, boolean>,
  }): WeshGlobComponentMatcher {
    if (shellOptions.get('extglob') === true) {
      return {
        kind: 'extglob-regexp',
        pattern: this.compileGlobComponent({ pattern, shellOptions }),
      };
    }

    return {
      kind: 'shell-pattern',
      pattern: compileShellPattern({ pattern }),
    };
  }

  private globComponentMatches({
    matcher,
    text,
  }: {
    matcher: WeshGlobComponentMatcher,
    text: string,
  }): boolean {
    switch (matcher.kind) {
    case 'shell-pattern':
      return matchesCompiledShellPattern({
        compiledPattern: matcher.pattern,
        text,
      });
    case 'extglob-regexp':
      return matcher.pattern.test(text);
    default: {
      const _ex: never = matcher;
      throw new Error(`Unhandled glob component matcher: ${String(_ex)}`);
    }
    }
  }

  private compileGlobComponent({
    pattern,
    shellOptions,
  }: {
    pattern: string,
    shellOptions: Map<WeshShellOption, boolean>,
  }): RegExp {
    const parsePattern = ({
      text,
      stopAtPipeOrParen,
    }: {
      text: string,
      stopAtPipeOrParen: boolean,
    }): { source: string, nextIndex: number } => {
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
    text: string,
    startIndex: number,
    shellOptions: Map<WeshShellOption, boolean>,
  }): { source: string, nextIndex: number } | undefined {
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
    segment: string,
    shellOptions: Map<WeshShellOption, boolean>,
  }): boolean {
    return containsShellPatternMeta({
      pattern: segment,
      extglob: shellOptions.get('extglob') === true ? 'enabled' : 'disabled',
    });
  }

  private isGlobStarSegment({
    segment,
    shellOptions,
  }: {
    segment: string,
    shellOptions: Map<WeshShellOption, boolean>,
  }): boolean {
    return segment === '**' && shellOptions.get('globstar') === true;
  }

  private shouldIncludeHiddenGlobEntry({
    patternSegment,
    shellOptions,
  }: {
    patternSegment: string,
    shellOptions: Map<WeshShellOption, boolean>,
  }): boolean {
    return patternSegment.startsWith('.') || shellOptions.get('dotglob') === true;
  }

  private async readSortedGlobDirectoryEntries({
    path,
  }: {
    path: string,
  }): Promise<WeshDirEntry[]> {
    const entries: WeshDirEntry[] = [];
    for await (const entry of this.kernel.readDir({ path })) {
      entries.push(entry);
    }
    entries.sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0);
    return entries;
  }

  private async expandGlobSegments({
    bases,
    segments,
    segmentIndex,
    shellOptions,
  }: {
    bases: string[],
    segments: string[],
    segmentIndex: number,
    shellOptions: Map<WeshShellOption, boolean>,
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
        for (const entry of await this.readSortedGlobDirectoryEntries({ path: base })) {
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
          nestedBases.add(entry.fullPath);
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
    const matcher = segmentHasGlob
      ? this.createGlobComponentMatcher({ pattern: segment, shellOptions })
      : undefined;
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

      for (const entry of await this.readSortedGlobDirectoryEntries({ path: base })) {
        if (!includeHiddenEntries && entry.name.startsWith('.')) {
          continue;
        }
        if (matcher === undefined || !this.globComponentMatches({ matcher, text: entry.name })) {
          continue;
        }
        nextBases.push(entry.fullPath);
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
    cwd: string,
    absolutePath: string,
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
    field: WeshExpandedField,
    cwd: string,
    shellOptions: Map<WeshShellOption, boolean>,
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
    context,
    shellOptions,
    environment,
  }: {
    raw: string,
    env: Map<string, string>,
    cwd: string,
    context: WeshExpansionContext,
    shellOptions: Map<WeshShellOption, boolean>,
    environment: WeshExecutionEnvironment,
  }): Promise<string[]> {
    const aggregatePositionals = await this.expandAggregatePositionalWord({
      raw,
      context,
      cwd,
      shellOptions,
      environment,
    });
    if (aggregatePositionals !== undefined) {
      return aggregatePositionals;
    }

    const expandedFields: string[] = [];

    for (const braceExpandedRaw of this.expandBraceExpressions({ raw })) {
      const parsedParts = parseShellWordParts({ raw: braceExpandedRaw });
      const tildeExpandedParts = parsedParts.flatMap((part, index) => {
        if (
          index !== 0 ||
          part.quoted ||
          !part.text.startsWith('~') ||
          (part.text.length !== 1 && part.text[1] !== '/')
        ) {
          return [part];
        }

        const tilde = this.splitTildePrefix({
          text: part.text,
          env,
        });
        if (tilde === undefined) {
          throw new Error('Expected leading tilde expansion');
        }
        return [
          {
            text: tilde.prefix,
            quoted: true,
            expandVariables: false,
          },
          {
            ...part,
            text: tilde.suffix,
          },
        ];
      });
      const expandedParts: WeshExpandedWordPart[] = [];
      for (const part of tildeExpandedParts) {
        if (part.expandVariables) {
          expandedParts.push(...await this.expandPartVariablesToParts({
            text: part.text,
            env,
            environment,
            quoted: part.quoted,
            literalFieldSplitEligible: false,
          }));
          continue;
        }
        expandedParts.push({
          text: part.text,
          quoted: part.quoted,
          fieldSplitEligible: false,
        });
      }

      const fields = splitExpandedFields({
        parts: expandedParts,
        context,
        ifs: environment.env.get('IFS'),
      });
      for (const field of fields) {
        switch (context) {
        case 'assignment':
          expandedFields.push(field.text);
          continue;
        case 'argv':
        case 'redirection':
          break;
        default: {
          const _ex: never = context;
          throw new Error(`Unhandled expansion context: ${_ex}`);
        }
        }
        const globbed = await this.globField({ field, cwd, shellOptions });
        expandedFields.push(...globbed);
      }
    }

    return expandedFields;
  }

  private async expandAggregatePositionalWord({
    raw,
    context,
    cwd,
    shellOptions,
    environment,
  }: {
    raw: string,
    context: WeshExpansionContext,
    cwd: string,
    shellOptions: Map<WeshShellOption, boolean>,
    environment: WeshExecutionEnvironment,
  }): Promise<string[] | undefined> {
    switch (context) {
    case 'argv':
      break;
    case 'assignment':
    case 'redirection':
      return undefined;
    default: {
      const _ex: never = context;
      throw new Error(`Unhandled expansion context: ${_ex}`);
    }
    }

    const aggregate = this.parseAggregatePositionalWord({ raw });
    if (aggregate === undefined) {
      return undefined;
    }

    const { prefix, suffix, form, quoting } = aggregate;
    prefix satisfies string;
    suffix satisfies string;

    switch (quoting) {
    case 'quoted': {
      switch (form) {
      case 'at': {
        if (environment.positionalArgs.length === 0) {
          if (prefix.length === 0 && suffix.length === 0) {
            return [];
          }
          return [`${prefix}${suffix}`];
        }
        const values = [...environment.positionalArgs];
        values[0] = `${prefix}${values[0] ?? ''}`;
        const lastIndex = values.length - 1;
        values[lastIndex] = `${values[lastIndex] ?? ''}${suffix}`;
        return values;
      }
      case 'star': {
        const ifs = environment.env.get('IFS');
        const separator = ifs === undefined ? ' ' : (ifs[0] ?? '');
        return [`${prefix}${environment.positionalArgs.join(separator)}${suffix}`];
      }
      default: {
        const _ex: never = form;
        throw new Error(`Unhandled quoted aggregate positional form: ${_ex}`);
      }
      }
    }
    case 'unquoted':
      break;
    default: {
      const _ex: never = quoting;
      throw new Error(`Unhandled aggregate positional quoting: ${_ex}`);
    }
    }

    const sourceValues = (() => {
      switch (form) {
      case 'at': {
        if (environment.positionalArgs.length === 0) {
          return [`${prefix}${suffix}`];
        }
        const values = [...environment.positionalArgs];
        values[0] = `${prefix}${values[0] ?? ''}`;
        const lastIndex = values.length - 1;
        values[lastIndex] = `${values[lastIndex] ?? ''}${suffix}`;
        return values;
      }
      case 'star': {
        const separator = environment.env.get('IFS')?.[0] ?? ' ';
        return [`${prefix}${environment.positionalArgs.join(separator)}${suffix}`];
      }
      default: {
        const _ex: never = form;
        throw new Error(`Unhandled unquoted aggregate positional form: ${_ex}`);
      }
      }
    })();
    const expanded: string[] = [];
    for (const value of sourceValues) {
      const fields = splitExpandedFields({
        parts: [{
          text: value,
          quoted: false,
          fieldSplitEligible: true,
        }],
        context: 'argv',
        ifs: environment.env.get('IFS'),
      });
      for (const field of fields) {
        expanded.push(...await this.globField({
          field,
          cwd,
          shellOptions,
        }));
      }
    }
    return expanded;
  }

  private parseAggregatePositionalWord({ raw }: {
    raw: string,
  }): {
    prefix: string,
    suffix: string,
    form: 'at' | 'star',
    quoting: 'quoted' | 'unquoted',
  } | undefined {
    const candidates = [
      { marker: '"${@}"', form: 'at', quoting: 'quoted' },
      { marker: '"${*}"', form: 'star', quoting: 'quoted' },
      { marker: '"$@"', form: 'at', quoting: 'quoted' },
      { marker: '"$*"', form: 'star', quoting: 'quoted' },
      { marker: '${@}', form: 'at', quoting: 'unquoted' },
      { marker: '${*}', form: 'star', quoting: 'unquoted' },
      { marker: '$@', form: 'at', quoting: 'unquoted' },
      { marker: '$*', form: 'star', quoting: 'unquoted' },
    ] as const;

    for (const candidate of candidates) {
      const markerIndex = raw.indexOf(candidate.marker);
      if (markerIndex < 0) {
        continue;
      }
      if (raw.indexOf(candidate.marker, markerIndex + candidate.marker.length) >= 0) {
        return undefined;
      }
      return {
        prefix: raw.slice(0, markerIndex),
        suffix: raw.slice(markerIndex + candidate.marker.length),
        form: candidate.form,
        quoting: candidate.quoting,
      };
    }

    return undefined;
  }

  private async expandSingleWord({
    raw,
    env,
    cwd,
    context,
    shellOptions,
    environment,
  }: {
    raw: string,
    env: Map<string, string>,
    cwd: string,
    context: Exclude<WeshExpansionContext, 'argv'>,
    shellOptions: Map<WeshShellOption, boolean>,
    environment: WeshExecutionEnvironment,
  }): Promise<string> {
    const expanded = await this.expandWord({
      raw,
      env,
      cwd,
      context,
      shellOptions,
      environment,
    });
    if (context === 'redirection' && expanded.length !== 1) {
      throw new Error(`${raw}: ambiguous redirect`);
    }
    return expanded[0] ?? '';
  }

  private createShellFdTable({
    stdin,
    stdout,
    stderr,
  }: {
    stdin: WeshFileHandle,
    stdout: WeshFileHandle,
    stderr: WeshFileHandle,
  }): Map<number, WeshFileHandle> {
    const fds = new Map<number, WeshFileHandle>([
      [0, this.createPrimaryFileHandleReference({ handle: stdin })],
      [1, this.createPrimaryFileHandleReference({ handle: stdout })],
      [2, this.createPrimaryFileHandleReference({ handle: stderr })],
    ]);

    for (const [fd, handle] of this.shellFds.entries()) {
      fds.set(fd, this.cloneFileHandleReference({ handle }));
    }

    return fds;
  }

  private createPrimaryFileHandleReference({
    handle,
  }: {
    handle: WeshFileHandle,
  }): WeshFileHandle {
    if (typeof handle.cloneReference === 'function') {
      return handle;
    }
    return this.createSharedFileHandle({ handle });
  }

  private createSharedFileHandle({
    handle,
  }: {
    handle: WeshFileHandle,
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

  private cloneFileHandleReference({
    handle,
  }: {
    handle: WeshFileHandle,
  }): WeshFileHandle {
    const cloneReference = (handle as WeshFileHandle & {
      cloneReference?: () => WeshFileHandle,
    }).cloneReference;
    if (typeof cloneReference === 'function') {
      return cloneReference.call(handle);
    }
    return handle;
  }

  private isFileHandleReferenceCloneable({
    handle,
  }: {
    handle: WeshFileHandle,
  }): boolean {
    return typeof (handle as WeshFileHandle & {
      cloneReference?: () => WeshFileHandle,
    }).cloneReference === 'function';
  }

  private cloneFileDescriptorTable({
    fdTable,
  }: {
    fdTable: Map<number, WeshFileHandle>,
  }): Map<number, WeshFileHandle> {
    return new Map(
      Array.from(fdTable.entries()).map(([fd, handle]) => [
        fd,
        this.cloneFileHandleReference({ handle }),
      ]),
    );
  }

  private async setPersistentFd({
    fd,
    handle,
  }: {
    fd: number,
    handle: WeshFileHandle,
  }): Promise<void> {
    const persistentHandle = this.cloneFileHandleReference({ handle });
    const previous = this.shellFds.get(fd);
    if (previous !== undefined) {
      await previous.close();
    }
    this.shellFds.set(fd, persistentHandle);
  }

  private async closePersistentFd({
    fd,
  }: {
    fd: number,
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
    fdTable,
    trackBackgroundTask,
  }: {
    redirection: WeshCommandNode['redirections'][number],
    environment: WeshExecutionEnvironment,
    fdTable: Map<number, WeshFileHandle>,
    trackBackgroundTask: ({ task }: { task: Promise<unknown> }) => void,
  }): Promise<WeshFileHandle | undefined> {
    if (redirection.type === 'heredoc' || redirection.type === 'herestring') {
      if (redirection.content === undefined) {
        return undefined;
      }

      const { read, write } = await this.kernel.pipe();
      let content: string;
      switch (redirection.type) {
      case 'herestring':
        content = await this.expandSingleWord({
          raw: redirection.content,
          env: environment.env,
          cwd: environment.cwd,
          context: 'assignment',
          shellOptions: environment.shellOptions,
          environment,
        });
        break;
      case 'heredoc':
        switch (redirection.contentExpansion) {
        case 'variables':
          content = await this.expandPartVariables({
            text: redirection.content,
            env: environment.env,
            environment,
          });
          break;
        case 'literal':
        case undefined:
          content = redirection.content;
          break;
        default: {
          const _ex: never = redirection.contentExpansion;
          throw new Error(`Unhandled heredoc expansion mode: ${_ex}`);
        }
        }
        break;
      default:
        throw new Error(`Unhandled inline redirection: ${redirection.type}`);
      }
      await write.write({ buffer: encodeShellTextToBytes({ text: content + '\n' }) });
      await write.close();
      return read;
    }

    if (redirection.type === 'dup_output' || redirection.type === 'dup_input') {
      if (redirection.closeTarget) {
        return undefined;
      }

      if (redirection.targetFd === undefined) {
        throw new Error(`Missing target fd for redirection ${redirection.type}`);
      }

      const duplicated = fdTable.get(redirection.targetFd);
      if (duplicated === undefined) {
        throw new Error(`${redirection.targetFd}: bad file descriptor`);
      }

      return this.cloneFileHandleReference({ handle: duplicated });
    }

    if (redirection.target !== undefined && typeof redirection.target !== 'string') {
      const processSubstitution = redirection.target;
      const redirectedStdin = fdTable.get(0);
      const redirectedStdout = fdTable.get(1);
      const redirectedStderr = fdTable.get(2);
      if (redirectedStdin === undefined || redirectedStdout === undefined || redirectedStderr === undefined) {
        throw new Error('Missing standard file descriptor after redirection');
      }

      const { read, write } = await this.kernel.pipe();
      const subEnvironment = await this.spawnChildExecutionEnvironment({
        parentEnvironment: environment,
        pgid: environment.pgid,
      });
      this.publishLastBackgroundPid({
        environment,
        pid: subEnvironment.shellPid,
      });

      switch (redirection.target.type) {
      case 'input': {
        const task = this.runChildExecutionEnvironment({
          environment: subEnvironment,
          execute: () => this.executeNode({
            node: processSubstitution.list,
            environment: subEnvironment,
            stdin: redirectedStdin,
            stdout: write,
            stderr: redirectedStderr,
          }),
        }).finally(() => write.close());
        environment.waitableChildren.set(subEnvironment.shellPid, task);
        trackBackgroundTask({ task });
        return this.createPrimaryFileHandleReference({ handle: read });
      }
      case 'output': {
        const task = this.runChildExecutionEnvironment({
          environment: subEnvironment,
          execute: () => this.executeNode({
            node: processSubstitution.list,
            environment: subEnvironment,
            stdin: read,
            stdout: redirectedStdout,
            stderr: redirectedStderr,
          }),
        }).finally(() => read.close());
        environment.waitableChildren.set(subEnvironment.shellPid, task);
        trackBackgroundTask({ task });
        return this.createPrimaryFileHandleReference({ handle: write });
      }
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
      context: 'redirection',
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
    case 'read_write':
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
    releaseOpenedHandle,
    trackBackgroundTask,
  }: {
    redirections: WeshCommandNode['redirections'],
    environment: WeshExecutionEnvironment,
    fdTable: Map<number, WeshFileHandle>,
    trackOpenedHandle: ({ handle }: { handle: WeshFileHandle }) => void,
    releaseOpenedHandle: ({ handle }: { handle: WeshFileHandle }) => Promise<void>,
    trackBackgroundTask: ({ task }: { task: Promise<unknown> }) => void,
  }): Promise<void> {
    const ownedFds = new Set<number>();
    for (const redirection of redirections) {
      if (redirection.closeTarget) {
        const current = fdTable.get(redirection.fd);
        if (current !== undefined && ownedFds.has(redirection.fd)) {
          await releaseOpenedHandle({ handle: current });
          ownedFds.delete(redirection.fd);
        }
        fdTable.delete(redirection.fd);
        continue;
      }

      const handle = await this.openRedirectionTarget({
        redirection,
        environment,
        fdTable,
        trackBackgroundTask,
      });
      if (handle === undefined) {
        continue;
      }

      if (redirection.type === 'dup_output' || redirection.type === 'dup_input') {
        const sourceHandle = redirection.targetFd === undefined
          ? undefined
          : fdTable.get(redirection.targetFd);
        if (sourceHandle !== handle) {
          trackOpenedHandle({ handle });
        }
      } else {
        trackOpenedHandle({ handle });
      }

      const previous = fdTable.get(redirection.fd);
      if (previous !== undefined && ownedFds.has(redirection.fd)) {
        await releaseOpenedHandle({ handle: previous });
      }
      fdTable.set(redirection.fd, handle);
      ownedFds.add(redirection.fd);
    }
  }

  /**
   * Execute shell source.
   * Low-level: All I/O goes to provided handles. Returns only exit status.
   */
  async execute({
    source,
    stdin,
    stdout,
    stderr,
  }: {
    source: ShellSource,
    stdin: WeshFileHandle,
    stdout: WeshFileHandle,
    stderr: WeshFileHandle,
  }): Promise<WeshCommandResult> {
    if (this.shellPid === 0) await this.init();

    try {
      const environment = this.createExecutionEnvironment({
        shellPid: this.shellPid,
        pgid: this.shellPid,
        env: this.env,
        aliases: this.aliases,
        functions: new Map(),
        cwd: this.cwd,
        fds: this.createShellFdTable({
          stdin,
          stdout,
          stderr,
        }),
        traps: this.traps,
        shellOptions: this.shellOptions,
        executionOptions: { ...this.executionOptions },
        positionalArgs: [],
        lastBackgroundPid: undefined,
        waitableChildren: new Map(),
      });
      const shellStdin = environment.fds.get(0);
      const shellStdout = environment.fds.get(1);
      const shellStderr = environment.fds.get(2);
      if (shellStdin === undefined || shellStdout === undefined || shellStderr === undefined) {
        throw new Error('Missing shell standard file descriptors');
      }

      const result = await this.executeShellInState({
        source,
        environment,
        stdin: shellStdin,
        stdout: shellStdout,
        stderr: shellStderr,
        history: 'record',
        allowReturn: false,
      });

      this.cwd = environment.cwd;
      this.aliases = environment.aliases;
      this.shellOptions = environment.shellOptions;
      this.executionOptions = { ...environment.executionOptions };
      const trappedResult = await this.runExitTrapIfNeeded({
        result,
        environment,
        stdin: shellStdin,
        stdout: shellStdout,
        stderr: shellStderr,
      });
      const controlFlow = trappedResult.controlFlow;
      if (controlFlow === undefined) {
        return {
          exitCode: trappedResult.exitCode,
          waitStatus: trappedResult.waitStatus,
        };
      }
      switch (controlFlow.kind) {
      case 'exit':
        return {
          exitCode: trappedResult.exitCode,
          waitStatus: trappedResult.waitStatus,
        };
      case 'break':
      case 'continue':
      case 'return':
        return {
          exitCode: trappedResult.exitCode,
          waitStatus: trappedResult.waitStatus,
          controlFlow,
        };
      default: {
        const _ex: never = controlFlow;
        throw new Error(`Unhandled top-level control flow: ${JSON.stringify(_ex)}`);
      }
      }
    } catch (e: unknown) {
      const message = e instanceof Error ? e.message : String(e);
      const encoder = new TextEncoder();
      await stderr.write({ buffer: encoder.encode(`wesh: ${message}\n`) });
      return { exitCode: 1 };
    }
  }

  private async executeNode({
    node,
    environment,
    stdin,
    stdout,
    stderr,
    loopDepth = 0,
    functionDepth = 0,
    errexitSuppressed = false,
    stdinReferenceOwnership = 'borrowed',
  }: {
    node: WeshASTNode,
    environment: WeshExecutionEnvironment,
    stdin: WeshFileHandle,
    stdout: WeshFileHandle,
    stderr: WeshFileHandle,
    loopDepth?: number,
    functionDepth?: number,
    errexitSuppressed?: boolean,
    stdinReferenceOwnership?: WeshStdinReferenceOwnership,
  }): Promise<WeshShellExecutionResult> {
    const options = {
      node,
      environment,
      stdin,
      stdout,
      stderr,
      loopDepth,
      functionDepth,
      errexitSuppressed,
      stdinReferenceOwnership,
    };
    let result: WeshShellExecutionResult;
    let suppressErrexitForResult = errexitSuppressed;

    switch (node.kind) {
    case 'list': {
      let lastResult: WeshShellExecutionResult = { exitCode: 0 };
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

          const jobTask = this.runChildExecutionEnvironment({
            environment: jobEnvironment,
            execute: () => this.executeNode({
              node: part.node,
              environment: jobEnvironment,
              stdin,
              stdout,
              stderr,
              loopDepth,
              functionDepth,
            }),
          });
          environment.waitableChildren.set(jobEnvironment.shellPid, jobTask);
          void jobTask.then(res => {
            const job = this.jobs.get(jobId);
            if (job) job.status = 'done';
            return res;
          });

          this.jobs.set(jobId, {
            id: jobId,
            command: cmdStr,
            pid: jobEnvironment.shellPid,
            status: 'running',
          });
          this.publishLastBackgroundPid({
            environment,
            pid: jobEnvironment.shellPid,
          });

          lastResult = { exitCode: 0 };
          previousOperator = '&';
          break;
        }
        case ';':
        case '&&':
        case '||': {
          const suppressForPart = errexitSuppressed || part.operator === '&&' || part.operator === '||';
          try {
            lastResult = await this.executeNode({
              node: part.node,
              environment,
              stdin, stdout, stderr,
              loopDepth,
              functionDepth,
              errexitSuppressed: suppressForPart,
            });
          } catch (error: unknown) {
            const message = error instanceof Error ? error.message : String(error);
            await this.writeErrorText({
              stderr,
              text: `wesh: ${message}\n`,
            });
            lastResult = { exitCode: 1 };
          }
          if (lastResult.controlFlow !== undefined) {
            result = lastResult;
            environment.env.set('?', result.exitCode.toString());
            return result;
          }
          environment.env.set('?', lastResult.exitCode.toString());
          suppressErrexitForResult = suppressForPart;
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
      result = await this.runChildExecutionEnvironment({
        environment: subshellEnvironment,
        execute: async () => {
          const subshellResult = await this.executeNode({
            node: node.list,
            environment: subshellEnvironment,
            stdin,
            stdout,
            stderr,
            loopDepth,
            functionDepth,
          });
          return this.runExitTrapIfNeeded({
            result: subshellResult,
            environment: subshellEnvironment,
            stdin,
            stdout,
            stderr,
          });
        },
      });
      break;
    }

    case 'if': {
      const conditionResult = await this.executeNode({
        node: node.condition,
        environment, stdin, stdout, stderr,
        loopDepth,
        functionDepth,
        errexitSuppressed: true,
      });
      if (conditionResult.controlFlow !== undefined) {
        result = conditionResult;
      } else if (conditionResult.exitCode === 0) {
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
      let lastForRes: WeshShellExecutionResult = { exitCode: 0 };
      const expandedItems: string[] = [];
      for (const item of node.items) {
        const itemFields = await this.expandWord({
          raw: item,
          env: environment.env,
          cwd: environment.cwd,
          context: 'argv',
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
            lastForRes = { exitCode: lastForRes.exitCode };
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
          case 'exit':
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
      let lastLoopResult: WeshShellExecutionResult = { exitCode: 0 };
      while (true) {
        const conditionResult = await this.executeNode({
          node: node.condition,
          environment,
          stdin,
          stdout,
          stderr,
          loopDepth,
          functionDepth,
          errexitSuppressed: true,
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
            lastLoopResult = { exitCode: lastLoopResult.exitCode };
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
          case 'exit':
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
        context: 'assignment',
        shellOptions: environment.shellOptions,
        environment,
      });
      let caseResult: WeshShellExecutionResult = { exitCode: 0 };
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
      const cleanupRedirectedResources = async (): Promise<void> => {
        for (const handle of openHandles) {
          await handle.close();
        }
        openHandles.length = 0;
        await Promise.allSettled(backgroundTasks);
      };
      try {
        await this.applyRedirectionsToFdTable({
          redirections: node.redirections,
          environment,
          fdTable: redirectedFds,
          trackOpenedHandle: ({ handle }) => {
            openHandles.push(handle);
          },
          releaseOpenedHandle: async ({ handle }) => {
            const handleIndex = openHandles.lastIndexOf(handle);
            if (handleIndex >= 0) {
              openHandles.splice(handleIndex, 1);
            }
            await handle.close();
          },
          trackBackgroundTask: ({ task }) => {
            backgroundTasks.push(task);
          },
        });
      } catch (error: unknown) {
        await cleanupRedirectedResources();
        throw error;
      }
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
          errexitSuppressed,
        });
      } finally {
        await cleanupRedirectedResources();
      }
      break;
    }

    case 'assignment': {
      const commandSubstitutionSequenceBefore = environment.commandSubstitutionSequence;
      for (const assign of node.assignments) {
        environment.env.set(assign.key, await this.expandSingleWord({
          raw: assign.value,
          env: environment.env,
          cwd: environment.cwd,
          context: 'assignment',
          shellOptions: environment.shellOptions,
          environment,
        }));
      }
      result = {
        exitCode: environment.commandSubstitutionSequence === commandSubstitutionSequenceBefore
          ? 0
          : environment.lastCommandSubstitutionExitCode,
      };
      break;
    }
    default: {
      const _ex: never = node;
      throw new Error(`Unhandled AST node kind: ${JSON.stringify(_ex)}`);
    }
    }

    if (
      result.controlFlow === undefined
      && !suppressErrexitForResult
      && result.exitCode !== 0
    ) {
      await this.runErrTrapIfNeeded({
        result,
        environment,
        stdin,
        stdout,
        stderr,
      });
    }

    if (
      result.controlFlow === undefined
      && environment.executionOptions.errexit
      && !suppressErrexitForResult
      && result.exitCode !== 0
    ) {
      result = {
        ...result,
        controlFlow: {
          kind: 'exit',
          exitCode: result.exitCode,
        },
      };
    }
    environment.env.set('?', result.exitCode.toString());
    return result;
  }

  private async executePipeline({
    node,
    environment,
    stdin,
    stdout,
    stderr,
    loopDepth = 0,
    functionDepth = 0,
    stdinReferenceOwnership = 'borrowed',
  }: {
    node: { commands: WeshASTNode[] },
    environment: WeshExecutionEnvironment,
    stdin: WeshFileHandle,
    stdout: WeshFileHandle,
    stderr: WeshFileHandle,
    loopDepth?: number,
    functionDepth?: number,
    stdinReferenceOwnership: WeshStdinReferenceOwnership,
  }): Promise<WeshCommandResult> {
    const commands = node.commands;
    if (commands.length === 0) return { exitCode: 0 };

    const pipes: Array<{ read: WeshFileHandle, write: WeshFileHandle }> = [];
    for (let i = 0; i < commands.length - 1; i++) {
      pipes.push(await this.kernel.pipe());
    }

    const promises: Promise<WeshCommandResult>[] = [];
    let pipelinePgid: number | undefined;

    for (let i = 0; i < commands.length; i++) {
      const cmd = commands[i]!;
      const myStdin = i === 0
        ? stdin
        : this.cloneFileHandleReference({ handle: pipes[i - 1]!.read });
      const myStdout = i === commands.length - 1
        ? stdout
        : this.cloneFileHandleReference({ handle: pipes[i]!.write });

      const pipelineEnvironment = await this.spawnChildExecutionEnvironment({
        parentEnvironment: environment,
        pgid: pipelinePgid,
      });
      pipelinePgid = pipelineEnvironment.pgid;

      promises.push(
        this.runChildExecutionEnvironment({
          environment: pipelineEnvironment,
          execute: () => this.executeNode({
            node: cmd,
            environment: pipelineEnvironment,
            stdin: myStdin,
            stdout: myStdout,
            stderr: stderr,
            loopDepth,
            functionDepth,
            stdinReferenceOwnership: i > 0 && cmd.kind === 'command'
              ? 'command-local'
              : stdinReferenceOwnership,
          }),
        }).then(async res => {
          if (i < commands.length - 1) {
            await myStdout.close();
          }
          if (i > 0) {
            await myStdin.close();
          }
          return res;
        }),
      );

      if (i < commands.length - 1) {
        await pipes[i]!.write.close();
      }
      if (i > 0) {
        await pipes[i - 1]!.read.close();
      }
    }

    const results = await this.runWithForegroundProcessGroup({
      pgid: pipelinePgid ?? environment.pgid,
      fn: async () => Promise.all(promises),
    });
    if (environment.executionOptions.pipefail) {
      for (let index = results.length - 1; index >= 0; index -= 1) {
        const result = results[index];
        if (result !== undefined && result.exitCode !== 0) {
          return result;
        }
      }
    }
    return results[results.length - 1]!;
  }

  private async executeCommand({
    node,
    environment,
    stdin,
    stdout,
    stderr,
    ignoreAliases,
    directInvocation,
    loopDepth = 0,
    functionDepth = 0,
    stdinReferenceOwnership,
  }: {
    node: WeshCommandNode,
    environment: WeshExecutionEnvironment,
    stdin: WeshFileHandle,
    stdout: WeshFileHandle,
    stderr: WeshFileHandle,
    ignoreAliases?: boolean,
    directInvocation?: {
      command: string,
      args: string[],
      argumentEntryRefs: readonly (WeshEntryRef | undefined)[] | undefined,
      functionLookup: 'allow' | 'bypass',
    },
    loopDepth?: number,
    functionDepth?: number,
    stdinReferenceOwnership?: WeshStdinReferenceOwnership,
  }): Promise<WeshShellExecutionResult> {
    const aliasExpandedNode = directInvocation !== undefined || ignoreAliases === true
      ? node
      : this.expandAliasCommandNode({
        node,
        environment,
        expandedAliases: new Set(),
      });

    const expandedArgs: string[] = directInvocation === undefined
      ? []
      : [...directInvocation.args];
    const procSubPreTaskCleanups: Array<() => void> = [];
    const procSubPostTaskCleanups: Array<() => void> = [];
    const procSubTasks: Promise<unknown>[] = [];
    const openHandles: WeshFileHandle[] = [];
    const cmdFds = new Map(environment.fds);

    if (directInvocation === undefined) {
      for (const [argumentIndex, arg] of aliasExpandedNode.args.entries()) {
        if (typeof arg === 'string') {
          if (aliasExpandedNode.name === '[[') {
            const previousArgument = aliasExpandedNode.args[argumentIndex - 1];
            const isPatternOperand = typeof previousArgument === 'string'
              && (previousArgument === '==' || previousArgument === '=' || previousArgument === '!=');
            const isRegexOperand = previousArgument === '=~';
            expandedArgs.push(isPatternOperand
              ? await this.expandPatternWord({
                raw: arg,
                environment,
              })
              : isRegexOperand
                ? await this.expandRegexWord({
                  raw: arg,
                  environment,
                })
                : await this.expandSingleWord({
                  raw: arg,
                  env: environment.env,
                  cwd: environment.cwd,
                  context: 'assignment',
                  shellOptions: environment.shellOptions,
                  environment,
                }));
            continue;
          }
          const fields = await this.expandWord({
            raw: arg,
            env: environment.env,
            cwd: environment.cwd,
            context: 'argv',
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
            this.publishLastBackgroundPid({
              environment,
              pid: subEnvironment.shellPid,
            });
            const task = this.runChildExecutionEnvironment({
              environment: subEnvironment,
              execute: () => this.executeNode({
                node: arg.list,
                environment: subEnvironment,
                stdin,
                stdout: write,
                stderr,
              }),
            }).finally(() => write.close());
            environment.waitableChildren.set(subEnvironment.shellPid, task);
            procSubTasks.push(task);

            this.vfs.registerSpecialFile({
              path,
              type: 'fifo',
              handler: () => this.cloneFileHandleReference({ handle: read }),
            });

            procSubPostTaskCleanups.push(() => {
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
            this.publishLastBackgroundPid({
              environment,
              pid: subEnvironment.shellPid,
            });
            const task = this.runChildExecutionEnvironment({
              environment: subEnvironment,
              execute: () => this.executeNode({
                node: arg.list,
                environment: subEnvironment,
                stdin: read,
                stdout,
                stderr,
              }),
            }).finally(() => read.close());
            environment.waitableChildren.set(subEnvironment.shellPid, task);
            procSubTasks.push(task);

            this.vfs.registerSpecialFile({
              path,
              type: 'fifo',
              handler: () => this.cloneFileHandleReference({ handle: write }),
            });
            procSubPreTaskCleanups.push(() => {
              write.close();
            });
            procSubPostTaskCleanups.push(() => {
              this.vfs.unregisterSpecialFile({ path });
              read.close();
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
    }

    const cmdName = directInvocation?.command ?? await this.expandSingleWord({
      raw: aliasExpandedNode.name,
      env: environment.env,
      cwd: environment.cwd,
      context: 'assignment',
      shellOptions: environment.shellOptions,
      environment,
    });

    const currentEnv = new WeshOverlayMap({ source: environment.env });
    const temporaryShellAssignments = new Map<string, string>();
    for (const assign of aliasExpandedNode.assignments) {
      const value = await this.expandSingleWord({
        raw: assign.value,
        env: currentEnv,
        cwd: environment.cwd,
        context: 'assignment',
        shellOptions: environment.shellOptions,
        environment,
      });
      currentEnv.set(assign.key, value);
      temporaryShellAssignments.set(assign.key, value);
    }

    const executeWithTemporaryShellAssignments = async <T>({ execute }: {
      execute: () => Promise<T>,
    }): Promise<T> => {
      if (temporaryShellAssignments.size === 0) {
        return execute();
      }
      const previousValues = new Map<string,
        | { kind: 'unset' }
        | { kind: 'value', value: string }
      >();
      for (const [key, value] of temporaryShellAssignments) {
        const previousValue = environment.env.get(key);
        previousValues.set(key, previousValue === undefined
          ? { kind: 'unset' }
          : { kind: 'value', value: previousValue });
        environment.env.set(key, value);
      }
      try {
        return await execute();
      } finally {
        for (const [key, previousValue] of previousValues) {
          switch (previousValue.kind) {
          case 'unset':
            environment.env.delete(key);
            break;
          case 'value':
            environment.env.set(key, previousValue.value);
            break;
          default: {
            previousValue satisfies never;
          }
          }
        }
      }
    };

    const cleanupCommandResources = async (): Promise<void> => {
      for (const handle of openHandles) {
        await handle.close();
      }
      for (const cleanup of procSubPreTaskCleanups) {
        cleanup();
      }
      await Promise.allSettled(procSubTasks);
      for (const cleanup of procSubPostTaskCleanups) {
        cleanup();
      }
    };

    cmdFds.set(0, stdin);
    cmdFds.set(1, stdout);
    cmdFds.set(2, stderr);
    try {
      await this.applyRedirectionsToFdTable({
        redirections: aliasExpandedNode.redirections,
        environment,
        fdTable: cmdFds,
        trackOpenedHandle: ({ handle }) => {
          openHandles.push(handle);
        },
        releaseOpenedHandle: async ({ handle }) => {
          const handleIndex = openHandles.lastIndexOf(handle);
          if (handleIndex >= 0) {
            openHandles.splice(handleIndex, 1);
          }
          await handle.close();
        },
        trackBackgroundTask: ({ task }) => {
          procSubTasks.push(task);
        },
      });
    } catch (error: unknown) {
      await cleanupCommandResources();
      throw error;
    }

    const cmdStdin = cmdFds.get(0);
    const cmdStdout = cmdFds.get(1);
    const cmdStderr = cmdFds.get(2);
    if (cmdStdin === undefined || cmdStdout === undefined || cmdStderr === undefined) {
      await cleanupCommandResources();
      throw new Error('Missing standard file descriptor after redirection');
    }

    let controlFlowResult: WeshShellExecutionResult | undefined;
    try {
      controlFlowResult = await executeWithTemporaryShellAssignments({
        execute: () => this.tryExecuteShellBuiltin({
          commandName: cmdName,
          args: expandedArgs,
          stdin: cmdStdin,
          stdout: cmdStdout,
          stderr: cmdStderr,
          loopDepth,
          functionDepth,
          environment,
        }),
      });
    } catch (error: unknown) {
      await cleanupCommandResources();
      throw error;
    }
    if (controlFlowResult !== undefined) {
      await cleanupCommandResources();
      return controlFlowResult;
    }

    if (cmdName === '[[') {
      try {
        return this.executeExtendedTestCommand({
          args: expandedArgs,
          environment,
        });
      } finally {
        await cleanupCommandResources();
      }
    }

    const shellFunctionBody = (() => {
      if (directInvocation === undefined) {
        return environment.functions.get(cmdName);
      }
      switch (directInvocation.functionLookup) {
      case 'allow':
        return environment.functions.get(cmdName);
      case 'bypass':
        return undefined;
      default: {
        const _ex: never = directInvocation.functionLookup;
        throw new Error(`Unhandled function lookup mode: ${_ex}`);
      }
      }
    })();
    if (shellFunctionBody !== undefined) {
      try {
        return await executeWithTemporaryShellAssignments({
          execute: () => this.executeShellFunction({
            name: cmdName,
            body: shellFunctionBody,
            args: expandedArgs,
            environment,
            stdin: cmdStdin,
            stdout: cmdStdout,
            stderr: cmdStderr,
            loopDepth,
            functionDepth,
          }),
        });
      } finally {
        await cleanupCommandResources();
      }
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
        try {
          return await this.executeArgv({
            command: shebangScript.interpreter,
            args: [
              ...shebangScript.interpreterArgs,
              shebangScript.scriptPath,
              ...expandedArgs,
            ],
            environment,
            stdin: cmdStdin,
            stdout: cmdStdout,
            stderr: cmdStderr,
            argumentEntryRefs: directInvocation === undefined
              ? undefined
              : [
                ...new Array<WeshEntryRef | undefined>(
                  shebangScript.interpreterArgs.length + 1,
                ).fill(undefined),
                ...(directInvocation.argumentEntryRefs ?? []),
              ],
            functionLookup: 'allow',
          });
        } finally {
          await cleanupCommandResources();
        }
      }
      await cleanupCommandResources();
      throw new WeshShellExecutionError({
        message: `Command not found: ${cmdName}`,
        exitCode: 127,
        disposition: 'continue',
      });
    }
    const definition = resolvedCommand.definition;

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

    if (
      cmdStdin !== undefined
      && (cmdStdin !== stdin || stdinReferenceOwnership === 'command-local')
      && this.isFileHandleReferenceCloneable({ handle: cmdStdin })
    ) {
      await cmdStdin.close();
    }

    let fileDescriptorSnapshotRequested = false;
    let replacementCommandExecuted = false;

    const context: WeshCommandContext & {
      hasFunction({ name }: { name: string }): boolean,
    } = {
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
      setEnv: ({ key, value }: { key: string, value: string }) => {
        environment.env.set(key, value);
      },
      unsetEnv: ({ key }: { key: string }) => {
        environment.env.delete(key);
      },
      getHistory: () => [...this.history],
      getArgumentEntryRef: ({ index }) => directInvocation?.argumentEntryRefs?.[index],
      getAliases: () => Array.from(environment.aliases.entries())
        .sort(([leftName], [rightName]) => leftName.localeCompare(rightName))
        .map(([name, value]) => ({ name, value })),
      setAlias: ({ name, value }: { name: string, value: string }) => {
        environment.aliases.set(name, value);
      },
      unsetAlias: ({ name }: { name: string }) => {
        environment.aliases.delete(name);
      },
      getWeshCommandMeta: ({ name }: { name: string }) => this.commands.get(name)?.meta,
      getCommandNames: () => Array.from(this.commands.keys()),
      hasFunction: ({ name }: { name: string }) => environment.functions.has(name),
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
          kind: 'not_found',
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
      executeCommand: async ({ command, args, argumentEntryRefs, stdin: nextStdin, stdout: nextStdout, stderr: nextStderr, ignoreAliases: nextIgnoreAliases }) => {
        if (definition.meta.name === 'exec') {
          replacementCommandExecuted = true;
        }
        return toWeshCommandResult({
          result: await this.executeArgv({
            command,
            args,
            argumentEntryRefs,
            environment,
            stdin: nextStdin ?? boundStdin,
            stdout: nextStdout ?? boundStdout,
            stderr: nextStderr ?? boundStderr,
            ignoreAliases: nextIgnoreAliases,
            functionLookup: definition.meta.name === 'command' ? 'bypass' : 'allow',
          }),
        });
      },
      executeShell: async ({ script, stdin: nextStdin, stdout: nextStdout, stderr: nextStderr }) => {
        const result = await this.executeShellInState({
          source: createTextShellSource({ text: script }),
          environment,
          stdin: nextStdin ?? boundStdin,
          stdout: nextStdout ?? boundStdout,
          stderr: nextStderr ?? boundStderr,
          history: 'ignore',
          allowReturn: functionDepth > 0,
        });
        const controlFlow = result.controlFlow;
        if (controlFlow === undefined) {
          return {
            exitCode: result.exitCode,
            waitStatus: result.waitStatus,
          };
        }
        switch (controlFlow.kind) {
        case 'break':
        case 'continue':
        case 'return':
          return {
            exitCode: result.exitCode,
            waitStatus: result.waitStatus,
            controlFlow,
          };
        case 'exit':
          return {
            exitCode: result.exitCode,
            waitStatus: result.waitStatus,
          };
        default: {
          const _ex: never = controlFlow;
          throw new Error(`Unhandled command-context shell control flow: ${JSON.stringify(_ex)}`);
        }
        }
      },
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
        resolveEntry: ({ path, finalSymlinkTreatment }) => this.kernel.resolveEntry({
          path,
          finalSymlinkTreatment,
        }),
        readDirEntry: ({ entry }) => this.kernel.readDirEntry({ entry }),
        statEntry: ({ entry }) => this.kernel.statEntry({ entry }),
        openEntry: async ({ entry, flags, mode }) => {
          const handle = await this.kernel.openEntry({ entry, flags, mode });
          return this.kernel.bindFileHandle({
            pid,
            handle,
            trackOwnership: true,
          });
        },
        readlinkEntry: ({ entry }) => this.kernel.readlinkEntry({ entry }),
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
      getFileDescriptors: () => {
        fileDescriptorSnapshotRequested = true;
        return Array.from(proc.fds.entries());
      },
      getFileDescriptor: ({ fd }) => proc.fds.get(fd),
      setFileDescriptor: async ({ fd, handle, persist }) => {
        const boundHandle = this.kernel.bindFileHandle({
          pid,
          handle,
          trackOwnership: false,
        });
        const previousProcessHandle = proc.fds.get(fd);
        proc.fds.set(fd, boundHandle);
        if (previousProcessHandle !== undefined) {
          await previousProcessHandle.close();
        }
        if (persist && environment.shellPid !== environment.shellRootPid) {
          const environmentHandle = this.cloneFileHandleReference({ handle: boundHandle });
          const previousEnvironmentHandle = environment.fds.get(fd);
          if (previousEnvironmentHandle !== undefined && environment.ownedPersistentFds.has(fd)) {
            await previousEnvironmentHandle.close();
          }
          environment.fds.set(fd, environmentHandle);
          environment.ownedPersistentFds.add(fd);
        } else {
          environment.fds.set(fd, boundHandle);
        }
        if (persist && environment.shellPid === environment.shellRootPid) {
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
      text: () => createShellTextIoHelpers({ stdin: boundStdin, stdout: boundStdout, stderr: boundStderr }),
    };

    try {
      const commandFunction = await this.loadCommandDefinition({ definition });
      const preExecutionSignalResult = await this.buildSignalCommandResultIfAny({
        pid,
        environment,
        stdin: cmdStdin,
        stdout: cmdStdout,
        stderr: cmdStderr,
      });
      if (preExecutionSignalResult !== undefined) {
        return preExecutionSignalResult;
      }

      const result = await commandFunction({ context });
      if (fileDescriptorSnapshotRequested) {
        const activeFds = new Set(proc.fds.keys());
        for (const fd of Array.from(environment.fds.keys())) {
          if (!activeFds.has(fd)) {
            const handle = environment.fds.get(fd);
            if (handle !== undefined && environment.ownedPersistentFds.has(fd)) {
              await handle.close();
              environment.ownedPersistentFds.delete(fd);
            }
            environment.fds.delete(fd);
          }
        }
        if (environment.shellPid === environment.shellRootPid) {
          for (const fd of Array.from(this.shellFds.keys())) {
            if (!activeFds.has(fd)) {
              await this.closePersistentFd({ fd });
            }
          }
        }
      }
      const signalResult = await this.buildSignalCommandResultIfAny({
        pid,
        environment,
        stdin: cmdStdin,
        stdout: cmdStdout,
        stderr: cmdStderr,
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
          stdin: cmdStdin,
          stdout: cmdStdout,
          stderr: cmdStderr,
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

      const exitCode = weshWaitStatusToExitCode({
        waitStatus: proc.waitStatus,
      });
      if (cmdName === 'exec' && replacementCommandExecuted) {
        return {
          ...result,
          exitCode,
          waitStatus: proc.waitStatus,
          controlFlow: {
            kind: 'exit',
            exitCode,
          },
        };
      }
      return {
        ...result,
        exitCode,
        waitStatus: proc.waitStatus,
      };
    } catch (error: unknown) {
      const signalResult = await this.buildSignalCommandResultIfAny({
        pid,
        environment,
        stdin: cmdStdin,
        stdout: cmdStdout,
        stderr: cmdStderr,
      });
      if (signalResult !== undefined) {
        return signalResult;
      }
      proc.state = 'terminated';
      proc.waitStatus = {
        kind: 'exited',
        exitCode: 1,
      };
      proc.exitCode = 1;
      throw error;
    } finally {
      await this.kernel.closeProcessResources({ pid });
      this.kernel.reapProcess({ pid });
      await cleanupCommandResources();
    }
  }

  private async writeErrorText({
    stderr,
    text,
  }: {
    stderr: WeshFileHandle,
    text: string,
  }): Promise<void> {
    await stderr.write({
      buffer: new TextEncoder().encode(text),
    });
  }

  private async tryExecuteShellBuiltin({
    commandName,
    args,
    stdin,
    stdout,
    stderr,
    loopDepth,
    functionDepth,
    environment,
  }: {
    commandName: string,
    args: string[],
    stdin: WeshFileHandle,
    stdout: WeshFileHandle,
    stderr: WeshFileHandle,
    loopDepth: number,
    functionDepth: number,
    environment: WeshExecutionEnvironment,
  }): Promise<WeshShellExecutionResult | undefined> {
    switch (commandName) {
    case 'builtin':
      return this.executeBuiltinBuiltin({
        args,
        stdin,
        stdout,
        stderr,
        loopDepth,
        functionDepth,
        environment,
      });
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
    case 'exec': {
      const firstArgument = args[0];
      if (
        firstArgument === undefined
        || firstArgument === '--help'
        || (firstArgument !== '--' && firstArgument.startsWith('-'))
      ) {
        return undefined;
      }

      const replacementCommand = firstArgument === '--' ? args[1] : firstArgument;
      if (replacementCommand === undefined) {
        return undefined;
      }
      const replacementArgs = firstArgument === '--' ? args.slice(2) : args.slice(1);

      try {
        const result = await this.executeArgv({
          command: replacementCommand,
          args: replacementArgs,
          argumentEntryRefs: undefined,
          environment,
          stdin,
          stdout,
          stderr,
          functionLookup: 'allow',
        });
        return {
          ...result,
          controlFlow: {
            kind: 'exit',
            exitCode: result.exitCode,
          },
        };
      } catch (error: unknown) {
        if (error instanceof WeshShellExecutionError) {
          throw new WeshShellExecutionError({
            message: error.message,
            exitCode: error.exitCode,
            disposition: 'abort-shell',
          });
        }
        throw error;
      }
    }
    case 'eval': {
      const firstArgument = args[0];
      if (
        firstArgument === '--help'
        || (
          firstArgument !== undefined
          && firstArgument !== '-'
          && firstArgument !== '--'
          && firstArgument.startsWith('-')
        )
      ) {
        return undefined;
      }
      return this.executeShellInState({
        source: createTextShellSource({
          text: (firstArgument === '--' ? args.slice(1) : args).join(' '),
        }),
        environment,
        stdin,
        stdout,
        stderr,
        history: 'ignore',
        allowReturn: functionDepth > 0,
      });
    }
    case 'getopts':
      return this.executeGetoptsBuiltin({ args, stderr, environment });
    case 'set':
      return this.executeSetBuiltin({ args, stderr, environment });
    case 'shift':
      return this.executeShiftBuiltin({
        args,
        stderr,
        environment,
      });
    case 'local':
      return this.executeLocalBuiltin({
        args,
        stderr,
        functionDepth,
        environment,
      });
    case 'let':
      return this.executeLetBuiltin({ args, environment });
    case 'unset':
      if (!this.shouldExecuteUnsetAsShellIntrinsic({ args })) {
        return undefined;
      }
      return this.executeUnsetBuiltin({
        args,
        stderr,
        environment,
      });
    case 'source':
    case '.':
      return this.executeSourceCommand({
        commandName,
        args,
        environment,
        stdin,
        stdout,
        stderr,
      });
    case 'wait':
      return this.executeWaitCommand({
        args,
        stderr,
        environment,
      });
    case 'exit': {
      if (args.length > 1) {
        await this.writeErrorText({
          stderr,
          text: 'wesh: exit: too many arguments\n',
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
        return {
          exitCode: 2,
          controlFlow: {
            kind: 'exit',
            exitCode: 2,
          },
        };
      case 'ok':
        break;
      default: {
        const _ex: never = parsedExitCode;
        throw new Error(`Unhandled parsed exit code: ${JSON.stringify(_ex)}`);
      }
      }
      const rawExitCode = parsedExitCode.value ?? Number.parseInt(environment.env.get('?') ?? '0', 10);
      const exitCode = ((rawExitCode % 256) + 256) % 256;
      return {
        exitCode,
        controlFlow: {
          kind: 'exit',
          exitCode,
        },
      };
    }
    case 'return': {
      if (functionDepth <= 0) {
        await this.writeErrorText({
          stderr,
          text: 'wesh: return: can only `return\' from a function or sourced script\n',
        });
        return { exitCode: 2 };
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

  private async executeBuiltinBuiltin({
    args,
    stdin,
    stdout,
    stderr,
    loopDepth,
    functionDepth,
    environment,
  }: {
    args: string[],
    stdin: WeshFileHandle,
    stdout: WeshFileHandle,
    stderr: WeshFileHandle,
    loopDepth: number,
    functionDepth: number,
    environment: WeshExecutionEnvironment,
  }): Promise<WeshShellExecutionResult> {
    const commandName = args[0];
    if (commandName === undefined) {
      return { exitCode: 0 };
    }
    if (!this.isWeshBuiltinName({ name: commandName })) {
      await this.writeErrorText({
        stderr,
        text: `wesh: builtin: ${commandName}: not a shell builtin\n`,
      });
      return { exitCode: 1 };
    }

    return this.executeCommand({
      node: {
        kind: 'command',
        assignments: [],
        name: commandName,
        args: args.slice(1),
        redirections: [],
      },
      environment,
      stdin,
      stdout,
      stderr,
      loopDepth,
      functionDepth,
      ignoreAliases: true,
      directInvocation: {
        command: commandName,
        args: args.slice(1),
        argumentEntryRefs: undefined,
        functionLookup: 'bypass',
      },
    });
  }

  private async executeGetoptsBuiltin({ args, stderr, environment }: {
    args: string[],
    stderr: WeshFileHandle,
    environment: WeshExecutionEnvironment,
  }): Promise<WeshCommandResult> {
    const optstring = args[0];
    const variableName = args[1];
    if (optstring === undefined || variableName === undefined) {
      await this.writeErrorText({
        stderr,
        text: 'wesh: getopts: usage: getopts optstring name [arg ...]\n',
      });
      return { exitCode: 2 };
    }
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(variableName)) {
      await this.writeErrorText({
        stderr,
        text: `wesh: getopts: ${variableName}: not a valid identifier\n`,
      });
      return { exitCode: 2 };
    }

    const optionArguments = args.length > 2 ? args.slice(2) : environment.positionalArgs;
    const silentErrors = optstring.startsWith(':');
    const optionSpec = silentErrors ? optstring.slice(1) : optstring;
    const argumentSignature = JSON.stringify([optstring, ...optionArguments]);
    const parsedOptind = Number.parseInt(environment.env.get('OPTIND') ?? '1', 10);
    let optind = Number.isSafeInteger(parsedOptind) && parsedOptind >= 1 ? parsedOptind : 1;
    let characterOffset = 1;

    if (
      environment.getoptsState !== undefined
      && environment.getoptsState.argumentSignature === argumentSignature
      && environment.getoptsState.optind === optind
    ) {
      characterOffset = environment.getoptsState.characterOffset;
    }

    const finish = ({ nextOptind, nextCharacterOffset }: {
      nextOptind: number,
      nextCharacterOffset: number,
    }): void => {
      environment.env.set('OPTIND', nextOptind.toString());
      environment.getoptsState = {
        argumentSignature,
        optind: nextOptind,
        characterOffset: nextCharacterOffset,
      };
    };

    while (true) {
      const current = optionArguments[optind - 1];
      if (current === undefined || current === '-' || !current.startsWith('-')) {
        finish({ nextOptind: optind, nextCharacterOffset: 1 });
        environment.env.delete('OPTARG');
        return { exitCode: 1 };
      }
      if (current === '--') {
        finish({ nextOptind: optind + 1, nextCharacterOffset: 1 });
        environment.env.delete('OPTARG');
        return { exitCode: 1 };
      }

      const option = current[characterOffset];
      if (option === undefined) {
        optind += 1;
        characterOffset = 1;
        continue;
      }

      const specIndex = optionSpec.indexOf(option);
      const requiresArgument = specIndex >= 0 && optionSpec[specIndex + 1] === ':';
      let nextOptind = optind;
      let nextCharacterOffset = characterOffset + 1;
      if (nextCharacterOffset >= current.length) {
        nextOptind += 1;
        nextCharacterOffset = 1;
      }

      if (specIndex < 0 || option === ':') {
        environment.env.set(variableName, '?');
        if (silentErrors) {
          environment.env.set('OPTARG', option);
        } else {
          environment.env.delete('OPTARG');
          await this.writeErrorText({
            stderr,
            text: `wesh: getopts: illegal option -- ${option}\n`,
          });
        }
        finish({ nextOptind, nextCharacterOffset });
        return { exitCode: 0 };
      }

      if (requiresArgument) {
        const attached = current.slice(characterOffset + 1);
        if (attached.length > 0) {
          environment.env.set('OPTARG', attached);
          nextOptind = optind + 1;
          nextCharacterOffset = 1;
        } else {
          const value = optionArguments[optind];
          if (value === undefined) {
            environment.env.set(variableName, silentErrors ? ':' : '?');
            if (silentErrors) {
              environment.env.set('OPTARG', option);
            } else {
              environment.env.delete('OPTARG');
              await this.writeErrorText({
                stderr,
                text: `wesh: getopts: option requires an argument -- ${option}\n`,
              });
            }
            finish({ nextOptind: optind + 1, nextCharacterOffset: 1 });
            return { exitCode: 0 };
          }
          environment.env.set('OPTARG', value);
          nextOptind = optind + 2;
          nextCharacterOffset = 1;
        }
      } else {
        environment.env.delete('OPTARG');
      }

      environment.env.set(variableName, option);
      finish({ nextOptind, nextCharacterOffset });
      return { exitCode: 0 };
    }
  }

  private executeLetBuiltin({ args, environment }: {
    args: string[],
    environment: WeshExecutionEnvironment,
  }): WeshCommandResult {
    if (args.length === 0) {
      return { exitCode: 1 };
    }
    let value = 0;
    for (const expression of args) {
      value = this.evaluateArithmeticExpression({
        expression,
        env: environment.env,
      });
    }
    return { exitCode: value === 0 ? 1 : 0 };
  }

  private async executeSetBuiltin({ args, stderr: _stderr, environment }: {
    args: string[],
    stderr: WeshFileHandle,
    environment: WeshExecutionEnvironment,
  }): Promise<WeshShellExecutionResult | undefined> {
    if (args.length === 0) {
      return undefined;
    }

    const executionOptions = { ...environment.executionOptions };
    let positionalStart: number | undefined;

    for (let index = 0; index < args.length; index += 1) {
      const arg = args[index]!;
      if (arg === '--') {
        positionalStart = index + 1;
        break;
      }
      if (arg.length < 2 || (arg[0] !== '-' && arg[0] !== '+')) {
        positionalStart = index;
        break;
      }

      const enabled = arg[0] === '-';
      const flags = arg.slice(1);
      for (let flagIndex = 0; flagIndex < flags.length; flagIndex += 1) {
        const flag = flags[flagIndex]!;
        switch (flag) {
        case 'e':
          executionOptions.errexit = enabled;
          break;
        case 'u':
          executionOptions.nounset = enabled;
          break;
        case 'o': {
          if (flagIndex !== flags.length - 1) {
            return undefined;
          }
          const optionName = args[index + 1];
          if (optionName !== 'pipefail') {
            return undefined;
          }
          executionOptions.pipefail = enabled;
          index += 1;
          break;
        }
        default:
          return undefined;
        }
      }
    }

    environment.executionOptions = executionOptions;
    if (positionalStart !== undefined) {
      environment.positionalArgs = args.slice(positionalStart);
      this.syncSpecialParameters({ environment });
    }
    return { exitCode: 0 };
  }

  private async executeLocalBuiltin({ args, stderr, functionDepth, environment }: {
    args: string[],
    stderr: WeshFileHandle,
    functionDepth: number,
    environment: WeshExecutionEnvironment,
  }): Promise<WeshCommandResult> {
    if (functionDepth <= 0) {
      await this.writeErrorText({
        stderr,
        text: 'wesh: local: can only be used in a function\n',
      });
      return { exitCode: 1 };
    }

    const scope = environment.localVariableScopes.at(-1);
    if (scope === undefined) {
      throw new Error('Missing shell local-variable scope inside function');
    }

    for (const argument of args) {
      if (argument.startsWith('-') && argument !== '-') {
        await this.writeErrorText({
          stderr,
          text: `wesh: local: ${argument}: unsupported option\n`,
        });
        return { exitCode: 2 };
      }
      const equalsIndex = argument.indexOf('=');
      const name = equalsIndex < 0 ? argument : argument.slice(0, equalsIndex);
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(name)) {
        await this.writeErrorText({
          stderr,
          text: `wesh: local: ${argument}: not a valid identifier\n`,
        });
        return { exitCode: 1 };
      }
      if (!scope.has(name)) {
        const previousValue = environment.env.get(name);
        scope.set(name, previousValue === undefined
          ? { kind: 'unset' }
          : { kind: 'value', value: previousValue });
      }
      if (equalsIndex >= 0) {
        environment.env.set(name, argument.slice(equalsIndex + 1));
      }
    }

    return { exitCode: 0 };
  }

  private shouldExecuteUnsetAsShellIntrinsic({ args }: { args: string[] }): boolean {
    return args[0] === '-v' || args[0] === '-f';
  }

  private async executeUnsetBuiltin({ args, stderr, environment }: {
    args: string[],
    stderr: WeshFileHandle,
    environment: WeshExecutionEnvironment,
  }): Promise<WeshCommandResult> {
    let mode: 'variable' | 'function' = 'variable';
    let parseOptions = true;

    for (const argument of args) {
      if (parseOptions) {
        switch (argument) {
        case '--':
          parseOptions = false;
          continue;
        case '-v':
          mode = 'variable';
          continue;
        case '-f':
          mode = 'function';
          continue;
        default:
          if (argument.startsWith('-') && argument !== '-') {
            await this.writeErrorText({
              stderr,
              text: `wesh: unset: ${argument}: invalid option\n`,
            });
            return { exitCode: 2 };
          }
          parseOptions = false;
          break;
        }
      }

      switch (mode) {
      case 'variable':
        environment.env.delete(argument);
        break;
      case 'function':
        environment.functions.delete(argument);
        break;
      default: {
        const _ex: never = mode;
        throw new Error(`Unhandled unset mode: ${_ex}`);
      }
      }
    }

    return { exitCode: 0 };
  }

  private async executeShiftBuiltin({ args, stderr, environment }: {
    args: string[],
    stderr: WeshFileHandle,
    environment: WeshExecutionEnvironment,
  }): Promise<WeshCommandResult> {
    if (args.length > 1 || (args[0] !== undefined && !/^\d+$/u.test(args[0]))) {
      await this.writeErrorText({
        stderr,
        text: 'wesh: shift: numeric argument required\n',
      });
      return { exitCode: 2 };
    }

    const count = args[0] === undefined ? 1 : Number.parseInt(args[0], 10);
    if (!Number.isSafeInteger(count) || count > environment.positionalArgs.length) {
      await this.writeErrorText({
        stderr,
        text: 'wesh: shift: shift count out of range\n',
      });
      return { exitCode: 1 };
    }

    environment.positionalArgs = environment.positionalArgs.slice(count);
    this.syncSpecialParameters({ environment });
    return { exitCode: 0 };
  }

  private isWeshBuiltinName({ name }: { name: string }): boolean {
    if (this.commands.has(name)) {
      return true;
    }
    switch (name) {
    case 'builtin':
    case 'break':
    case 'continue':
    case 'getopts':
    case 'exit':
    case 'return':
    case 'set':
    case 'shift':
    case 'local':
    case 'let':
    case 'source':
    case '.':
    case 'wait':
      return true;
    default:
      return false;
    }
  }

  private async executeSourceCommand({
    commandName,
    args,
    environment,
    stdin,
    stdout,
    stderr,
  }: {
    commandName: 'source' | '.',
    args: string[],
    environment: WeshExecutionEnvironment,
    stdin: WeshFileHandle,
    stdout: WeshFileHandle,
    stderr: WeshFileHandle,
  }): Promise<WeshShellExecutionResult> {
    const path = args[0];
    if (path === undefined) {
      await this.writeErrorText({
        stderr,
        text: `wesh: ${commandName}: filename argument required\n`,
      });
      return { exitCode: 2 };
    }

    const resolvedPath = resolvePath({ cwd: environment.cwd, path });
    let handle: WeshFileHandle;
    try {
      handle = await this.kernel.open({
        path: resolvedPath,
        flags: {
          access: 'read',
          creation: 'never',
          truncate: 'preserve',
          append: 'preserve',
        },
        mode: 0o644,
      });
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      await this.writeErrorText({
        stderr,
        text: `wesh: ${path}: ${message}\n`,
      });
      return { exitCode: 1 };
    }

    const previousPositionalArgs = environment.positionalArgs;
    if (args.length > 1) {
      environment.positionalArgs = args.slice(1);
      this.syncSpecialParameters({ environment });
    }
    try {
      const result = await this.executeShellInState({
        source: createHandleShellSource({ handle }),
        environment,
        stdin,
        stdout,
        stderr,
        history: 'ignore',
        allowReturn: true,
      });
      const controlFlow = result.controlFlow;
      if (controlFlow === undefined) {
        return result;
      }
      switch (controlFlow.kind) {
      case 'return':
        return { exitCode: controlFlow.exitCode };
      case 'break':
      case 'continue':
      case 'exit':
        return result;
      default: {
        const _ex: never = controlFlow;
        throw new Error(`Unhandled sourced-shell control flow: ${JSON.stringify(_ex)}`);
      }
      }
    } finally {
      await handle.close();
      if (args.length > 1) {
        environment.positionalArgs = previousPositionalArgs;
        this.syncSpecialParameters({ environment });
      }
    }
  }

  private async executeWaitCommand({ args, stderr, environment }: {
    args: string[],
    stderr: WeshFileHandle,
    environment: WeshExecutionEnvironment,
  }): Promise<WeshCommandResult> {
    const rawPids = args.length === 0
      ? Array.from(environment.waitableChildren.keys(), pid => pid.toString())
      : args;

    if (rawPids.length === 0) {
      return { exitCode: 0 };
    }

    let lastExitCode = 0;
    for (const rawPid of rawPids) {
      if (!/^\d+$/u.test(rawPid)) {
        await this.writeErrorText({
          stderr,
          text: `wesh: wait: ${rawPid}: not a pid or valid job spec\n`,
        });
        lastExitCode = 127;
        continue;
      }
      const pid = Number.parseInt(rawPid, 10);
      if (!Number.isSafeInteger(pid) || pid <= 0) {
        await this.writeErrorText({
          stderr,
          text: `wesh: wait: ${rawPid}: not a pid or valid job spec\n`,
        });
        lastExitCode = 127;
        continue;
      }

      const task = environment.waitableChildren.get(pid);
      if (task === undefined) {
        await this.writeErrorText({
          stderr,
          text: `wesh: wait: ${pid}: pid is not a child of this shell\n`,
        });
        lastExitCode = 127;
        continue;
      }

      const childResult = await task;
      environment.waitableChildren.delete(pid);
      lastExitCode = childResult.exitCode;
    }

    return { exitCode: lastExitCode };
  }

  private async buildLoopControlCommandResult({
    commandName,
    args,
    stderr,
    loopDepth,
  }: {
    commandName: 'break' | 'continue',
    args: string[],
    stderr: WeshFileHandle,
    loopDepth: number,
  }): Promise<WeshShellExecutionResult> {
    if (loopDepth <= 0) {
      await this.writeErrorText({
        stderr,
        text: `wesh: ${commandName}: only meaningful in a \`for', \`while', or \`until' loop\n`,
      });
      return { exitCode: 0 };
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
    commandName: 'break' | 'continue' | 'exit' | 'return',
    args: string[],
    stderr: WeshFileHandle,
  }): Promise<{
    kind: 'ok',
    value: number | undefined,
  } | {
    kind: 'error',
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
    name: string,
    body: WeshASTNode,
    args: string[],
    environment: WeshExecutionEnvironment,
    stdin: WeshFileHandle,
    stdout: WeshFileHandle,
    stderr: WeshFileHandle,
    loopDepth: number,
    functionDepth: number,
  }): Promise<WeshShellExecutionResult> {
    const previousArgs = [...environment.positionalArgs];
    const previousZero = environment.env.get('0');
    const localVariableScope = new Map<string,
      | { kind: 'unset' }
      | { kind: 'value', value: string }
    >();
    environment.localVariableScopes.push(localVariableScope);
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
        case 'exit':
          return result;
        default: {
          const _ex: never = result.controlFlow;
          throw new Error(`Unhandled control flow: ${JSON.stringify(_ex)}`);
        }
        }
      }
      return result;
    } finally {
      environment.localVariableScopes.pop();
      for (const [variableName, previousValue] of localVariableScope) {
        switch (previousValue.kind) {
        case 'unset':
          environment.env.delete(variableName);
          break;
        case 'value':
          environment.env.set(variableName, previousValue.value);
          break;
        default: {
          previousValue satisfies never;
        }
        }
      }
      environment.positionalArgs = previousArgs;
      if (previousZero === undefined) {
        environment.env.delete('0');
      } else {
        environment.env.set('0', previousZero);
      }
      this.syncSpecialParameters({ environment });
    }
  }

  private async caseClauseMatches({
    patterns,
    value,
    environment,
  }: {
    patterns: string[],
    value: string,
    environment: WeshExecutionEnvironment,
  }): Promise<boolean> {
    for (const rawPattern of patterns) {
      const expandedPattern = await this.expandPatternWord({
        raw: rawPattern,
        environment,
      });
      if (matchesShellPattern({ pattern: expandedPattern, text: value })) {
        return true;
      }
    }
    return false;
  }

  private async expandPatternWord({
    raw,
    environment,
  }: {
    raw: string,
    environment: WeshExecutionEnvironment,
  }): Promise<string> {
    const parsedParts = parseShellWordParts({ raw });
    let text = '';
    for (const part of parsedParts) {
      const expandedPart = part.expandVariables
        ? await this.expandPartVariables({
          text: part.text,
          env: environment.env,
          environment,
        })
        : part.text;
      text += part.quoted
        ? escapeShellPatternLiteral({ text: expandedPart })
        : expandedPart;
    }
    return text;
  }

  private async expandRegexWord({
    raw,
    environment,
  }: {
    raw: string,
    environment: WeshExecutionEnvironment,
  }): Promise<string> {
    const parsedParts = parseShellWordParts({ raw });
    let text = '';
    for (const part of parsedParts) {
      const expandedPart = part.expandVariables
        ? await this.expandPartVariables({
          text: part.text,
          env: environment.env,
          environment,
        })
        : part.text;
      text += part.quoted
        ? expandedPart.replace(/[\\^$.*+?()[\]{}|]/g, '\\$&')
        : expandedPart;
    }
    return text;
  }

  private executeArithmeticCommand({
    expression,
    environment,
  }: {
    expression: string,
    environment: WeshExecutionEnvironment,
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
    environment,
  }: {
    args: string[],
    environment: WeshExecutionEnvironment,
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
      if (token === '-v') {
        consume();
        return environment.env.has(consume());
      }

      const left = consume();
      const operator = peek();
      if (operator === undefined || ['&&', '||', ')'].includes(operator)) {
        return left.length > 0;
      }
      if (operator === '==' || operator === '=') {
        consume();
        const right = consume();
        return matchesShellPattern({ pattern: right, text: left });
      }
      if (operator === '!=') {
        consume();
        const right = consume();
        return !matchesShellPattern({ pattern: right, text: left });
      }
      if (operator === '=~') {
        consume();
        const right = consume();
        try {
          return new RegExp(right).test(left);
        } catch {
          return false;
        }
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

  private async executeArgv({ command, args, argumentEntryRefs, environment, stdin, stdout, stderr, ignoreAliases, functionLookup }: {
    command: string,
    args: string[],
    argumentEntryRefs?: readonly (WeshEntryRef | undefined)[],
    environment: WeshExecutionEnvironment,
    stdin: WeshFileHandle,
    stdout: WeshFileHandle,
    stderr: WeshFileHandle,
    ignoreAliases?: boolean,
    functionLookup: 'allow' | 'bypass',
  }): Promise<WeshShellExecutionResult> {
    // argv is already separated, so an intermediate shell process would only
    // duplicate state and leave another process to reap. Keep command-local
    // mutations isolated with a cloned environment while parenting the actual
    // command process directly to the current shell.
    const isolatedEnvironment = this.cloneExecutionEnvironment({
      environment,
      shellPid: environment.shellPid,
      pgid: environment.pgid,
      mapStrategy: 'synchronous_overlay',
    });

    return this.executeCommand({
      node: {
        kind: 'command',
        assignments: [],
        name: command,
        args: args,
        redirections: [],
      },
      environment: isolatedEnvironment,
      stdin: stdin,
      stdout: stdout,
      stderr: stderr,
      ignoreAliases: ignoreAliases,
      directInvocation: {
        command,
        args,
        argumentEntryRefs,
        functionLookup,
      },
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
    executionOptions,
    positionalArgs,
    lastBackgroundPid,
    waitableChildren,
  }: {
    shellPid: number,
    pgid: number,
    env: Map<string, string>,
    aliases: Map<string, string>,
    functions: Map<string, WeshASTNode>,
    cwd: string,
    fds: Map<number, WeshFileHandle>,
    traps: Map<string, WeshTrapDisposition>,
    shellOptions: Map<WeshShellOption, boolean>,
    executionOptions: WeshExecutionOptions,
    positionalArgs: string[],
    lastBackgroundPid: number | undefined,
    waitableChildren: Map<number, Promise<WeshCommandResult>>,
  }): WeshExecutionEnvironment {
    const environment: WeshExecutionEnvironment = {
      shellPid,
      shellRootPid: shellPid,
      pgid,
      env,
      aliases,
      functions,
      cwd,
      fds,
      traps,
      shellOptions,
      executionOptions,
      positionalArgs,
      getoptsState: undefined,
      lastBackgroundPid,
      waitableChildren,
      commandSubstitutionSequence: 0,
      lastCommandSubstitutionExitCode: 0,
      localVariableScopes: [],
      ownedPersistentFds: new Set(),
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
    mapStrategy,
  }: {
    environment: WeshExecutionEnvironment,
    shellPid: number | undefined,
    pgid: number | undefined,
    mapStrategy: 'snapshot_copy' | 'synchronous_overlay',
  }): WeshExecutionEnvironment {
    const cloneMap = <K, V>({ source }: { source: ReadonlyMap<K, V> }): Map<K, V> => {
      switch (mapStrategy) {
      case 'snapshot_copy':
        return new Map(source);
      case 'synchronous_overlay':
        return new WeshOverlayMap({ source });
      default: {
        const _ex: never = mapStrategy;
        throw new Error(`Unhandled environment map strategy: ${_ex}`);
      }
      }
    };

    return {
      shellPid: shellPid ?? environment.shellPid,
      shellRootPid: environment.shellRootPid,
      pgid: pgid ?? environment.pgid,
      env: cloneMap({ source: environment.env }),
      aliases: cloneMap({ source: environment.aliases }),
      functions: cloneMap({ source: environment.functions }),
      cwd: environment.cwd,
      fds: new Map(environment.fds),
      traps: cloneMap({ source: environment.traps }),
      shellOptions: cloneMap({ source: environment.shellOptions }),
      executionOptions: { ...environment.executionOptions },
      positionalArgs: [...environment.positionalArgs],
      getoptsState: environment.getoptsState === undefined ? undefined : { ...environment.getoptsState },
      lastBackgroundPid: environment.lastBackgroundPid,
      commandSubstitutionSequence: environment.commandSubstitutionSequence,
      lastCommandSubstitutionExitCode: environment.lastCommandSubstitutionExitCode,
      localVariableScopes: [],
      ownedPersistentFds: new Set(),
      waitableChildren: (() => {
        switch (mapStrategy) {
        case 'snapshot_copy':
          return new Map();
        case 'synchronous_overlay':
          return environment.waitableChildren;
        default: {
          const _ex: never = mapStrategy;
          throw new Error(`Unhandled waitable-child map strategy: ${_ex}`);
        }
        }
      })(),
    };
  }

  private async runChildExecutionEnvironment({
    environment,
    execute,
  }: {
    environment: WeshExecutionEnvironment,
    execute: () => Promise<WeshShellExecutionResult>,
  }): Promise<WeshCommandResult> {
    let result: WeshCommandResult | undefined;
    try {
      const childResult = await execute();
      const commandResult: WeshCommandResult = {
        exitCode: childResult.exitCode,
        waitStatus: childResult.waitStatus,
      };
      result = commandResult;
      return commandResult;
    } finally {
      await this.finishChildExecutionEnvironment({
        environment,
        result,
      });
    }
  }

  private async finishChildExecutionEnvironment({
    environment,
    result,
  }: {
    environment: WeshExecutionEnvironment,
    result: WeshCommandResult | undefined,
  }): Promise<void> {
    const process = this.kernel.getProcess({ pid: environment.shellPid });
    if (process === undefined) {
      return;
    }

    const waitStatus = process.waitStatus ?? result?.waitStatus ?? {
      kind: 'exited',
      exitCode: result?.exitCode ?? 1,
    } satisfies WeshWaitStatus;

    switch (waitStatus.kind) {
    case 'stopped':
      process.state = 'stopped';
      process.waitStatus = waitStatus;
      process.exitCode = weshWaitStatusToExitCode({ waitStatus });
      return;
    case 'exited':
    case 'signaled':
      process.state = 'terminated';
      process.waitStatus = waitStatus;
      process.exitCode = weshWaitStatusToExitCode({ waitStatus });
      for (const fd of environment.ownedPersistentFds) {
        const handle = environment.fds.get(fd);
        if (handle !== undefined) {
          await handle.close();
        }
      }
      environment.ownedPersistentFds.clear();
      await this.kernel.closeProcessResources({ pid: process.pid });
      this.kernel.reapProcess({ pid: process.pid });
      return;
    default: {
      const _ex: never = waitStatus;
      throw new Error(`Unhandled child shell wait status: ${JSON.stringify(_ex)}`);
    }
    }
  }

  private async spawnChildExecutionEnvironment({
    parentEnvironment,
    pgid,
  }: {
    parentEnvironment: WeshExecutionEnvironment,
    pgid: number | undefined,
  }): Promise<WeshExecutionEnvironment> {
    const childEnvironment = this.cloneExecutionEnvironment({
      environment: parentEnvironment,
      shellPid: undefined,
      pgid,
      mapStrategy: 'snapshot_copy',
    });

    const { pid } = await this.kernel.spawn({
      image: 'wesh',
      args: ['-c'],
      env: childEnvironment.env,
      cwd: childEnvironment.cwd,
      fds: this.cloneFileDescriptorTable({
        fdTable: childEnvironment.fds,
      }),
      ppid: parentEnvironment.shellPid,
      pgid: pgid,
      signalDispositions: this.buildProcessSignalDispositions({
        environment: childEnvironment,
      }),
    });

    childEnvironment.shellPid = pid;
    childEnvironment.pgid = pgid ?? pid;
    this.syncSpecialParameters({ environment: childEnvironment });
    return childEnvironment;
  }

  private async runErrTrapIfNeeded({ result, environment, stdin, stdout, stderr }: {
    result: WeshShellExecutionResult,
    environment: WeshExecutionEnvironment,
    stdin: WeshFileHandle,
    stdout: WeshFileHandle,
    stderr: WeshFileHandle,
  }): Promise<void> {
    const errTrap = environment.traps.get('ERR');
    if (
      errTrap === undefined
      || errTrap.kind !== 'run'
      || this.activeErrTrapEnvironments.has(environment)
    ) {
      return;
    }

    this.activeErrTrapEnvironments.add(environment);
    try {
      await this.runTrapScript({
        script: errTrap.action,
        trapStatus: result.waitStatus ?? {
          kind: 'exited',
          exitCode: result.exitCode,
        },
        environment,
        stdin,
        stdout,
        stderr,
      });
    } finally {
      this.activeErrTrapEnvironments.delete(environment);
    }
  }

  private async runExitTrapIfNeeded({ result, environment, stdin, stdout, stderr }: {
    result: WeshShellExecutionResult,
    environment: WeshExecutionEnvironment,
    stdin: WeshFileHandle,
    stdout: WeshFileHandle,
    stderr: WeshFileHandle,
  }): Promise<WeshShellExecutionResult> {
    const exitTrap = environment.traps.get('EXIT');
    if (exitTrap === undefined || exitTrap.kind !== 'run') {
      return result;
    }

    await this.runTrapScript({
      script: exitTrap.action,
      trapStatus: result.waitStatus ?? {
        kind: 'exited',
        exitCode: result.exitCode,
      },
      environment: environment,
      stdin: stdin,
      stdout: stdout,
      stderr: stderr,
    });
    return result;
  }

  private async runSignalTrapIfNeeded({ signal, environment, stdin, stdout, stderr }: {
    signal: number,
    environment: WeshExecutionEnvironment,
    stdin: WeshFileHandle,
    stdout: WeshFileHandle,
    stderr: WeshFileHandle,
  }): Promise<void> {
    for (const condition of weshSignalConditionNames({ signal: signal })) {
      const trapDisposition = environment.traps.get(condition);
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
            signal: signal,
          },
          environment: environment,
          stdin: stdin,
          stdout: stdout,
          stderr: stderr,
        });
        return;
      default: {
        const _ex: never = trapDisposition;
        throw new Error(`Unhandled trap disposition: ${JSON.stringify(_ex)}`);
      }
      }
    }
  }

  private async runTrapScript({ script, trapStatus, environment, stdin, stdout, stderr }: {
    script: string,
    trapStatus: WeshWaitStatus,
    environment: WeshExecutionEnvironment,
    stdin: WeshFileHandle,
    stdout: WeshFileHandle,
    stderr: WeshFileHandle,
  }): Promise<void> {
    const previousQuestionMark = environment.env.get('?');
    environment.env.set(
      '?',
      weshWaitStatusToExitCode({
        waitStatus: trapStatus,
      }).toString(),
    );
    try {
      await this.executeShellInState({
        source: createTextShellSource({ text: script }),
        environment: environment,
        stdin: stdin,
        stdout: stdout,
        stderr: stderr,
        history: 'ignore',
        allowReturn: false,
      });
    } finally {
      if (previousQuestionMark === undefined) {
        environment.env.delete('?');
      } else {
        environment.env.set('?', previousQuestionMark);
      }
    }
  }

  private async buildSignalCommandResultIfAny({ pid, environment, stdin, stdout, stderr }: {
    pid: number,
    environment: WeshExecutionEnvironment,
    stdin: WeshFileHandle,
    stdout: WeshFileHandle,
    stderr: WeshFileHandle,
  }): Promise<WeshCommandResult | undefined> {
    const signalWaitStatus = this.kernel.getWaitStatus({ pid: pid });
    if (signalWaitStatus === undefined) {
      return undefined;
    }

    switch (signalWaitStatus.kind) {
    case 'signaled':
      this.kernel.consumePendingSignals({ pid: pid });
      await this.runSignalTrapIfNeeded({
        signal: signalWaitStatus.signal,
        environment: environment,
        stdin: stdin,
        stdout: stdout,
        stderr: stderr,
      });
      return {
        exitCode: weshWaitStatusToExitCode({
          waitStatus: signalWaitStatus,
        }),
        waitStatus: signalWaitStatus,
      };
    case 'stopped':
      this.kernel.consumePendingSignals({ pid: pid });
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

  private async runWithForegroundProcessGroup<T>({ pgid, fn }: {
    pgid: number,
    fn: () => Promise<T>,
  }): Promise<T> {
    const scopeId = this.nextForegroundProcessGroupScopeId++;
    this.foregroundProcessGroupScopes.push({
      id: scopeId,
      pgid: pgid,
    });
    try {
      return await fn();
    } finally {
      const scopeIndex = this.foregroundProcessGroupScopes.findIndex(scope => scope.id === scopeId);
      if (scopeIndex >= 0) {
        this.foregroundProcessGroupScopes.splice(scopeIndex, 1);
      }
    }
  }

  private buildProcessSignalDispositions({ environment }: {
    environment: WeshExecutionEnvironment,
  }): Map<number, WeshProcessSignalDisposition> {
    const signalDispositions = new Map<number, WeshProcessSignalDisposition>();

    for (const [condition, disposition] of environment.traps.entries()) {
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

  private publishLastBackgroundPid({ environment, pid }: {
    environment: WeshExecutionEnvironment,
    pid: number,
  }): void {
    environment.lastBackgroundPid = pid;
    this.syncSpecialParameters({ environment });
  }

  private syncSpecialParameters({ environment }: {
    environment: WeshExecutionEnvironment,
  }): void {
    const previousPositionalCount = Number.parseInt(environment.env.get('#') ?? '0', 10);
    environment.env.set('$$', environment.shellRootPid.toString());
    environment.env.set('BASHPID', environment.shellPid.toString());
    environment.env.set('PPID', (this.kernel.getProcess({ pid: environment.shellPid })?.ppid ?? 0).toString());
    environment.env.set('#', environment.positionalArgs.length.toString());
    environment.env.set('0', environment.env.get('SHELL') ?? 'wesh');

    const positionalSlots = Math.max(previousPositionalCount, environment.positionalArgs.length, 9);
    for (let index = 1; index <= positionalSlots; index++) {
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

  private async executeShellInState({ source, environment, stdin, stdout, stderr, history, allowReturn }: {
    source: ShellSource,
    environment: WeshExecutionEnvironment,
    stdin: WeshFileHandle,
    stdout: WeshFileHandle,
    stderr: WeshFileHandle,
    history: 'record' | 'ignore',
    allowReturn: boolean,
  }): Promise<WeshShellExecutionResult> {
    if (history === 'record' && source.kind === 'text') {
      const normalizedScript = source.text.trim();
      if (normalizedScript.length > 0) {
        this.history.push(normalizedScript);
      }
    }

    const reader = createShellSourceReader({ source });
    let bufferedSource = '';
    let sourceCompletion: 'complete' | 'may-continue' = 'may-continue';
    let result: WeshShellExecutionResult = { exitCode: 0 };
    const sourceConsumerStdin = source.kind === 'handle' && source.handle === stdin
      ? createShellSourceConsumerHandle({
        handle: stdin,
        readRetainedBytes: ({ buffer, offset, length }) => {
          const bytesRead = reader.readRetainedBytes({ buffer, offset, length });
          bufferedSource = reader.getRetainedText();
          return bytesRead;
        },
      })
      : stdin;

    const readMoreSource = async (): Promise<
      | {
          kind: 'read',
          completion: 'complete' | 'may-continue',
        }
      | {
          kind: 'error',
        }
    > => {
      try {
        const next = await reader.read();
        bufferedSource = reader.getRetainedText();
        return {
          kind: 'read',
          completion: next.completion,
        };
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        await this.writeErrorText({
          stderr,
          text: `wesh: ${message}\n`,
        });
        result = { exitCode: 1 };
        environment.env.set('?', result.exitCode.toString());
        return { kind: 'error' };
      }
    };

    while (true) {
      if (bufferedSource.length === 0) {
        switch (sourceCompletion) {
        case 'complete':
          return result;
        case 'may-continue':
          break;
        default: {
          const _ex: never = sourceCompletion;
          throw new Error(`Unhandled shell source completion: ${_ex}`);
        }
        }
        const readResult = await readMoreSource();
        switch (readResult.kind) {
        case 'error':
          return result;
        case 'read':
          sourceCompletion = readResult.completion;
          break;
        default: {
          const _ex: never = readResult;
          throw new Error(
            `Unhandled shell source read result: ${JSON.stringify(_ex)}`,
          );
        }
        }
        if (bufferedSource.length === 0) {
          switch (sourceCompletion) {
          case 'complete':
            return result;
          case 'may-continue':
            continue;
          default: {
            const _ex: never = sourceCompletion;
            throw new Error(`Unhandled shell source completion: ${_ex}`);
          }
          }
        }
      }

      let parsedUnit: ReturnType<typeof parseNextShellUnit>;
      try {
        parsedUnit = parseNextShellUnit({
          commandLine: bufferedSource,
          env: environment.env,
          sourceCompletion,
        });
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        await this.writeErrorText({
          stderr,
          text: `wesh: ${message}\n`,
        });
        return { exitCode: 2 };
      }

      switch (parsedUnit.kind) {
      case 'needs-more-source': {
        switch (sourceCompletion) {
        case 'complete':
          throw new Error('Shell parser requested more source after end of source');
        case 'may-continue':
          break;
        default: {
          const _ex: never = sourceCompletion;
          throw new Error(`Unhandled shell source completion: ${_ex}`);
        }
        }
        const readResult = await readMoreSource();
        switch (readResult.kind) {
        case 'error':
          return result;
        case 'read':
          sourceCompletion = readResult.completion;
          continue;
        default: {
          const _ex: never = readResult;
          throw new Error(
            `Unhandled shell source read result: ${JSON.stringify(_ex)}`,
          );
        }
        }
      }
      case 'parsed':
        break;
      default: {
        const _ex: never = parsedUnit;
        throw new Error(`Unhandled shell unit parse result: ${JSON.stringify(_ex)}`);
      }
      }

      if (parsedUnit.consumedCharacters <= 0) {
        throw new Error('Shell parser did not consume source input');
      }
      reader.consumeText({ characters: parsedUnit.consumedCharacters });
      bufferedSource = reader.getRetainedText();

      if (parsedUnit.node.kind === 'list' && parsedUnit.node.parts.length === 0) {
        continue;
      }

      try {
        result = await this.executeNode({
          node: parsedUnit.node,
          environment,
          stdin: sourceConsumerStdin,
          stdout,
          stderr,
          functionDepth: allowReturn ? 1 : 0,
        });
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        await this.writeErrorText({
          stderr,
          text: `wesh: ${message}\n`,
        });
        result = {
          exitCode: error instanceof WeshShellExecutionError
            ? error.exitCode
            : 1,
        };
        environment.env.set('?', result.exitCode.toString());
        if (error instanceof WeshShellExecutionError) {
          switch (error.disposition) {
          case 'continue':
            break;
          case 'abort-shell':
            return result;
          default: {
            const _ex: never = error.disposition;
            throw new Error(`Unhandled shell error disposition: ${_ex}`);
          }
          }
        }
      }

      if (result.controlFlow !== undefined) {
        return result;
      }
    }
  }

}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
