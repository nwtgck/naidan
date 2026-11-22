import { ReadonlyDirectoryHandle } from './readonly-directory-handle';
import type {
  WeshCommandDefinition,
  WeshCommandFunction,
  WeshRegisteredCommandDefinition,
  WeshShellBuiltinContext,
  WeshShellBuiltinFunction,
  WeshShellExecutionResult,
  WeshCommandResult,
  WeshIVirtualFileSystem,
  WeshCommandContext,
  WeshConditionalCommandNode,
  WeshConditionalExpression,
  WeshBuiltinCommandContext,
  WeshASTNode,
  WeshFileHandle,
  WeshCommandNode,
  WeshPipelineNode,
  WeshProcessSubstitutionNode,
  WeshRedirectedNode,
  WeshTrapDisposition,
  WeshWaitStatus,
  WeshProcess,
  WeshProcessSignalDisposition,
  WeshShellOption,
  WeshFileHandleCloseSemantics,
  WeshShellStateSnapshot,
  WeshCommandListEntry,
  WeshDirEntry,
  WeshEntryRef,
  WeshOpenFlags,
} from './types';
import { isExecCompletion, WeshBrokenPipeError, WeshCommandInterruptedError, weshWaitStatusToExitCode } from './types';
import { WeshVFS } from './vfs';
import { WeshKernel, type WeshPipeEnd, type WeshProcessSignalHandler } from './kernel';
import { createCommandFiles } from './command-files';
import { closeFileHandleReferences } from './utils/fs';
import { parseCommandLine, parseNextShellUnit } from './parser';
import { duplicateFileReference, OPEN_FILE_DESCRIPTION, openFileDescription } from './utils/file-input';
import { WeshHandleCloseSignal } from './utils/closeSignal';
import { createHandleShellSource, createShebangStrippedShellSource, createShellSourceReader, createTextShellSource } from './shell/source';
import type { ShellSource } from './shell/source';
import { createDefaultExecutionOptions, SHELL_EXECUTION_OPTION_NAMES, type ShellInvocation, type ShellInvocationMode, type WeshExecutionOptions } from './shell/invocation';
import { WeshArithmeticError } from './shell/arithmetic-error';
import {
  isAsciiDecimalDigit,
  isAsciiShellIdentifierPart,
  isAsciiShellIdentifierStart,
} from './shell/ascii';
import { parseShellShebangLine, readShellShebangLine, splitEnvShebangArguments } from './shell/shebang';
import { parseDoubleQuotedParameterOperandParts, parseShellWordParts } from './shell/word';
import { decodeShellBytesToText, encodeShellTextToBytes } from './shell/byte-text';
import { createShellTextIoHelpers } from './shell/io';
import { WeshReadonlyVariableError, WeshShellVariables, type WeshVariableValues } from './shell/variables';
import { WeshShellImage } from './shell/image';
import type { WeshShellChild } from './shell/child-processes';
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
import { resolvePath, toAbsolutePath } from './path';
import { createReadHandleFromStream, createWriteHandleFromStream } from './utils/stream';

import { builtinCommands } from './commands';
import { linuxSignalByName, linuxSignalByNumber } from './commands/_shared/linux-signals';
import { setCommandDefinition } from './commands/set/definition';
import { unsetCommandDefinition } from './commands/unset/definition';
import { iterateCommandPaths, registeredCommandPath } from './command-resolution';
import { helpCommandDefinition } from './commands/help/definition';
import { createBashCommandDefinition } from './commands/bash/definition';

type WeshLoadedCommand =
  | { readonly executeCommand: WeshCommandFunction }
  | { readonly executeShellBuiltin: WeshShellBuiltinFunction };

type WeshCommandLoadResult = { command: WeshLoadedCommand } | { error: unknown };

type WeshCommandLoad = {
  ready: Promise<WeshLoadedCommand> | undefined,
  waiters: Set<({ result }: { result: WeshCommandLoadResult }) => void> | undefined,
};

type WeshExpandedWordPart = {
  text: string,
  quoted: boolean,
  fieldSplitEligible: boolean,
};

function toWeshCommandResult({ result }: {
  result: WeshCommandResult,
}): WeshCommandResult {
  return { exitCode: result.exitCode, waitStatus: result.waitStatus };
}

type WeshShellErrorDisposition = 'continue' | 'abort-unit' | 'abort-shell';

class WeshShellExecutionError extends Error {
  readonly exitCode: number;
  readonly disposition: WeshShellErrorDisposition;

  constructor({ message, exitCode, disposition }: {
    message: string,
    exitCode: number,
    disposition: WeshShellErrorDisposition,
  }) {
    super(message);
    this.name = 'WeshShellExecutionError';
    this.exitCode = exitCode;
    this.disposition = disposition;
  }
}

type WeshStdinReferenceOwnership = 'borrowed' | 'command-local';

type WeshRestoreFileDescriptors = ({ fds }: { fds: Iterable<number> | undefined }) => WeshFileHandle[];

interface WeshForwardedRedirections {
  fds: readonly number[],
  restore: (() => WeshFileHandle[]) | undefined,
}

interface WeshProcessSubstitutionTask {
  task: Promise<WeshCommandResult>,
  redirectedEnd: WeshPipeEnd | undefined,
}

async function waitForProcessSubstitutions({ tasks }: { tasks: readonly WeshProcessSubstitutionTask[] }): Promise<void> {
  if (tasks.length === 0) {
    return;
  }
  // A retained redirection, such as one installed by exec, can still be used by later shell input.
  const localTasks = tasks.filter(({ redirectedEnd }) => redirectedEnd?.hasOpenReferences() !== true);
  await Promise.allSettled(localTasks.map(({ task }) => task));
}

interface WeshProgram {
  definition: WeshRegisteredCommandDefinition | undefined,
  name: string,
  image: string,
  args: [string, ...string[]],
  argumentEntryRefs: readonly (WeshEntryRef | undefined)[] | undefined,
}

interface WeshCommandEvaluation {
  definition: WeshRegisteredCommandDefinition | undefined,
  argumentEntryRefs: readonly (WeshEntryRef | undefined)[] | undefined,
  stdinToClose: WeshFileHandle | undefined,
}

interface WeshChildCommand {
  readonly process: WeshProcess,
  readonly cleanupStderr: WeshFileHandle,
  stdinPipe: WeshFileHandle | undefined,
  stdoutPipe: WeshFileHandle | undefined,
}

type WeshSignalStatus = Extract<WeshWaitStatus, { kind: 'signaled' }>;
const INPUT_ABORT_STATUS: WeshSignalStatus = Object.freeze({ kind: 'signaled', signal: 2 });
const RETIRED_SHELL_STATUS: WeshWaitStatus = Object.freeze({ kind: 'exited', exitCode: 1 });

type WeshForegroundProcessGroup = {
  readonly pgid: number,
  readonly foregroundSignal: AbortSignal | undefined,
  shell: WeshExecutionEnvironment | undefined,
};

interface WeshShellStdio {
  stdin: WeshFileHandle,
  stdout: WeshFileHandle,
  stderr: WeshFileHandle,
}

interface WeshShellInterrupt {
  status: WeshSignalStatus,
  lastExitCode: number,
}

interface WeshChildWait {
  children: WeshProcess[],
  interrupt?: WeshShellInterrupt,
}

interface WeshForegroundWait extends WeshChildWait {
  lastChildStatus?: WeshWaitStatus,
}

interface WeshExecutionEnvironment {
  foregroundSignal: AbortSignal | undefined,
  groupInterrupt?: { controller: AbortController, status: WeshSignalStatus | undefined },
  interruptedWaitSignal?: number,
  foregroundWait?: WeshForegroundWait,
  commandSubstitutionWait?: WeshChildWait,
  assignment?: { interrupt?: WeshSignalStatus },
  pendingSubstitutionInterrupt?: true,
  pendingSelfSignals?: Map<number, string>,
  waitingForShellChild?: true,
  shellPid: number,
  shellRootPid: number,
  pgid: number,
  variables: WeshShellVariables,
  aliases: Map<string, string>,
  functions: Map<string, WeshASTNode>,
  fds: Map<number, WeshFileHandle>,
  traps: Map<string, WeshTrapDisposition>,
  inheritedTrapListing?: ReadonlyMap<string, WeshTrapDisposition>,
  shellOptions: Map<WeshShellOption, boolean>,
  readonly executionOptions: Readonly<WeshExecutionOptions>,
  positionalArgs: string[],
  getoptsState: {
    argumentSignature: string,
    optind: number,
    characterOffset: number,
  } | undefined,
  readonly shellImage: WeshShellImage,
  commandSubstitutionSequence: number,
  lastCommandSubstitutionExitCode: number,
  ownedPersistentFds: Set<number>,
  scopedRedirectionFds: Set<number>,
  inheritedSignalDispositions?: ReadonlyMap<number, WeshProcessSignalDisposition>,
  runningExitTrap?: boolean,
  exitTrapRan?: true,
  terminationTrapSignal?: WeshSignalStatus,
  execResult?: WeshShellExecutionResult,
  replacedProcess?: true,
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

class WeshBadFileDescriptorError extends Error {
  constructor() {
    super('Bad file descriptor');
  }
}

const badFileDescriptor = async (): Promise<never> => {
  throw new WeshBadFileDescriptorError();
};

const closedFileDescriptor: WeshFileHandle = {
  read: badFileDescriptor,
  write: badFileDescriptor,
  stat: badFileDescriptor,
  truncate: badFileDescriptor,
  ioctl: badFileDescriptor,
  close: async () => {},
  getCloseSemantics: () => 'soft',
};

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

class WeshShellEntryFileHandle implements WeshFileHandle {
  private readonly bytes: Uint8Array;
  readonly entrypoint: keyof typeof WESH_SHELL_SPECIAL_FILES;
  private position = 0;

  constructor({ entrypoint }: { entrypoint: keyof typeof WESH_SHELL_SPECIAL_FILES }) {
    this.entrypoint = entrypoint;
    this.bytes = new TextEncoder().encode(WESH_SHELL_SPECIAL_FILE_CONTENT[entrypoint]);
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
      mode: 0o555,
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

  get [OPEN_FILE_DESCRIPTION](): object {
    return openFileDescription({ handle: this.state.handle });
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
    return this.state.handle.getCloseSemantics?.() ?? 'soft';
  }
}

function weshSignalConditionNames({
  signal,
}: {
  signal: number,
}): string[] {
  const name = linuxSignalByNumber({ number: signal })?.name;
  return name === undefined ? [String(signal)] : [name.slice(3), name, String(signal)];
}

function findSignalTrapAction({ signal, traps }: { signal: number, traps: ReadonlyMap<string, WeshTrapDisposition> }): string | undefined {
  for (const name of weshSignalConditionNames({ signal })) {
    const trap = traps.get(name);
    switch (trap?.kind) {
    case 'run':
      return trap.action;
    case 'ignore':
      return undefined;
    case undefined:
      break;
    default: {
      const _ex: never = trap;
      throw new Error(`Unhandled trap disposition: ${JSON.stringify(_ex)}`);
    }
    }
  }
  return undefined;
}

function ignoresSignal({ disposition }: { disposition: WeshProcessSignalDisposition | undefined }): boolean {
  switch (disposition) {
  case 'ignore':
    return true;
  case 'default':
  case undefined:
    return false;
  default: {
    const _ex: never = disposition;
    throw new Error(`Unhandled signal disposition: ${_ex}`);
  }
  }
}

function createStartupTraps({ signalDispositions }: {
  signalDispositions: ReadonlyMap<number, WeshProcessSignalDisposition> | undefined,
}): Map<string, WeshTrapDisposition> {
  const traps = new Map<string, WeshTrapDisposition>();
  for (const [signal, disposition] of signalDispositions ?? []) {
    if (ignoresSignal({ disposition })) {
      traps.set(linuxSignalByNumber({ number: signal })?.name ?? String(signal), { kind: 'ignore' });
    }
  }
  return traps;
}

export class Wesh {
  public vfs: WeshIVirtualFileSystem;
  public kernel: WeshKernel;
  private readonly shellBuiltinFiles: WeshBuiltinCommandContext['files'] = {
    lstat: ({ path }) => this.kernel.lstat({ path }),
    readlink: ({ path }) => this.kernel.readlink({ path }),
    resolve: ({ path }) => this.kernel.resolve({ path }),
    stat: ({ path }) => this.kernel.stat({ path }),
  };

  private variables: WeshShellVariables;
  private aliases: Map<string, string> = new Map();
  private history: string[] = [];
  private commands: Map<string, WeshRegisteredCommandDefinition> = new Map();
  private readonly commandLoads = new WeakMap<WeshRegisteredCommandDefinition, WeshCommandLoad>();
  private conditionalEvaluator: typeof import('./shell/conditional')['evaluateShellConditional'] | undefined;
  private arithmeticEvaluator: typeof import('./shell/arithmetic')['evaluateShellArithmetic'] | undefined;
  private readonly builtinCommandPreloadQueue: readonly WeshRegisteredCommandDefinition[] = [
    ...builtinCommands,
    helpCommandDefinition,
  ];
  private builtinCommandPreloadIndex = 0;
  private nextProcessSubstitutionId = 10;
  private shellFds: Map<number, WeshFileHandle | undefined> = new Map();
  private traps: Map<string, WeshTrapDisposition> = new Map();
  private readonly activeErrTrapEnvironments = new WeakSet<WeshExecutionEnvironment>();
  private readonly activeSignalTrapEnvironments = new WeakSet<WeshExecutionEnvironment>();
  private readonly handledSignalTraps = new WeakMap<WeshExecutionEnvironment, WeakSet<WeshWaitStatus>>();
  private readonly shellSignalPids = new WeakMap<WeshWaitStatus, number>();
  private shellOptions: Map<WeshShellOption, boolean> = new Map([
    ['dotglob', false],
    ['extglob', false],
    ['failglob', false],
    ['globstar', false],
    ['nullglob', false],
  ]);
  private readonly foregroundInputs = new Map<AbortSignal, AbortSignal | undefined>();
  private readonly foregroundProcessGroupScopes: WeshForegroundProcessGroup[] = [];

  private shellPid: number = 0;
  private shellImage: WeshShellImage;
  private shellInitialization?: Promise<void>;

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
    this.shellImage = new WeshShellImage({ cwd: resolvedCwd, lastPid: undefined });

    this.variables = WeshShellVariables.fromEnvironment({
      executionOptions: createDefaultExecutionOptions(),
      entries: Object.entries({
        HOME: '/',
        PWD: resolvedCwd,
        PATH: '/bin',
        USER: user,
        SHELL: '/bin/wesh',
        ...initialEnv,
      }),
    });
    this.variables.setExport({ name: 'OLDPWD', value: undefined, exported: true });

    for (const definition of builtinCommands) {
      this.commands.set(definition.meta.name, definition);
    }
    this.registerCommand({ definition: helpCommandDefinition });
    this.registerCommand({ definition: this.createShCommandDefinition() });
    this.registerCommand({
      definition: createBashCommandDefinition({
        executeShellInvocation: ({ context, invocation }) => this.executeShellProgram({ name: 'bash', context, invocation }),
      }),
    });
    this.vfs.registerSpecialFile({
      path: WESH_SHELL_SPECIAL_FILES.sh,
      type: 'file',
      handler: () => new WeshShellEntryFileHandle({ entrypoint: 'sh' }),
    });
    this.vfs.registerSpecialFile({
      path: WESH_SHELL_SPECIAL_FILES.bash,
      type: 'file',
      handler: () => new WeshShellEntryFileHandle({ entrypoint: 'bash' }),
    });

    this.commands.set('jobs', {
      meta: { name: 'jobs', description: 'List shell jobs', usage: 'jobs' },
      loadShellBuiltin: async () => async ({ context, shell }) => {
        const jobs = shell.getJobs();
        const { print } = context.text();
        for (const job of jobs) {
          await print({ text: `[${job.id}] ${job.status} ${job.command}\n` });
        }
        return { exitCode: 0 };
      },
    });
  }

  async init(): Promise<void> {
    while (this.shellPid !== 0) {
      const pid = this.shellPid;
      const status = this.getShellExitStatus({ pid });
      if (status !== undefined) {
        const handles = this.retireRootShellImage({ status });
        const failure = await this.closeAndReapProcess({ pid, additionalHandles: handles });
        if (failure !== undefined) {
          throw failure.error;
        }
      } else if (this.shellImage.termination !== undefined) {
        const shellImage = this.shellImage;
        await new Promise<void>(resolve => shellImage.subscribeRetirement({ notify: resolve }));
      } else {
        return;
      }
    }
    this.shellInitialization ??= this.kernel.spawn({
      image: 'wesh',
      args: ['wesh', '-l'],
      env: this.variables.exportedEntries({ assignments: undefined }),
      cwd: this.shellImage.cwd,
    }).then(({ pid, process }) => {
      this.shellPid = pid;
      this.bindShellSignalHandler({ process, environment: undefined });
    }).finally(() => {
      this.shellInitialization = undefined;
    });
    await this.shellInitialization;
  }

  registerCommand({ definition }: { definition: WeshCommandDefinition }): void {
    this.commands.set(definition.meta.name, definition);
  }

  private loadCommandDefinition({ definition, interruption }: {
    definition: WeshRegisteredCommandDefinition,
    interruption: {
      environment: WeshExecutionEnvironment | undefined,
      process: WeshProcess | undefined,
      isInterrupted: () => boolean,
    } | undefined,
  }): Promise<WeshLoadedCommand> {
    const existing = this.commandLoads.get(definition);
    if (existing?.ready !== undefined) {
      return existing.ready;
    }

    if (interruption?.isInterrupted()) {
      return Promise.reject(new WeshCommandInterruptedError());
    }

    const load: WeshCommandLoad = existing ?? { ready: undefined, waiters: undefined };
    if (existing === undefined) {
      this.commandLoads.set(definition, load);
      const settle = ({ result }: { result: WeshCommandLoadResult }) => {
        const waiters = load.waiters;
        load.waiters = undefined;
        for (const waiter of waiters ?? []) {
          waiter({ result });
        }
      };
      const loading = Promise.resolve().then(async (): Promise<WeshLoadedCommand> => {
        return 'load' in definition
          ? { executeCommand: await definition.load() }
          : { executeShellBuiltin: await definition.loadShellBuiltin() };
      });
      void loading.then(command => {
        load.ready = loading;
        settle({ result: { command } });
      }, (error: unknown) => {
        this.commandLoads.delete(definition);
        settle({ result: { error } });
      });
    }

    // Share the import while letting a stopped process release its own wait and listeners.
    const waiters = load.waiters ??= new Set();
    return new Promise((resolve, reject) => {
      const cleanup = () => {
        unsubscribe();
      };
      const onLoaded = ({ result }: { result: WeshCommandLoadResult }) => {
        cleanup();
        if ('command' in result) {
          resolve(result.command);
        } else {
          reject(result.error);
        }
      };
      const onInterrupt = () => {
        if (interruption?.isInterrupted()) {
          waiters.delete(onLoaded);
          cleanup();
          reject(new WeshCommandInterruptedError());
        }
      };
      waiters.add(onLoaded);
      const unsubscribe = this.subscribeInterrupt({
        environment: interruption?.environment,
        process: interruption?.process,
        notify: onInterrupt,
      });
    });
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
        await this.loadCommandDefinition({ definition, interruption: undefined });
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
      cwd: this.shellImage.cwd,
      env: Object.fromEntries(this.variables.entries()),
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
    const resolvedPath = toAbsolutePath({ cwd: this.shellImage.cwd, path });
    const entries: WeshDirEntry[] = [];
    for await (const entry of this.vfs.readDir({ path: resolvedPath })) {
      entries.push(entry);
    }
    return entries.sort((left, right) => left.name.localeCompare(right.name));
  }

  async signalForegroundProcessGroup({ signal, foregroundSignal }: { signal: number, foregroundSignal?: AbortSignal }): Promise<boolean> {
    const scopes = this.foregroundProcessGroupScopes;
    const foreground = scopes.findLast(scope =>
      scope.foregroundSignal !== undefined && this.foregroundInputs.has(scope.foregroundSignal));
    const selectedSignals = foregroundSignal === undefined
      ? new Set(foreground?.foregroundSignal === undefined ? [] : [foreground.foregroundSignal])
      : this.getForegroundInputSignals({ foregroundSignal });

    const selectedScopes = scopes.filter(({ foregroundSignal }) => foregroundSignal !== undefined && selectedSignals.has(foregroundSignal));
    const { groups, excludedPids, shells } = this.getForegroundGroupTargets({ scopes: selectedScopes, selectedSignals });
    if (signal === 2 && groups.has(this.shellPid) && this.shellImage.termination === undefined) {
      const root = this.kernel.getProcess({ pid: this.shellPid });
      if (root !== undefined && this.hasDefaultInterruptDisposition({ process: root, traps: this.traps })) {
        // The interactive shell PID is shared by inputs. Default INT cancels only the selected evaluations.
        const waitStatus = Object.freeze({ kind: 'signaled', signal });
        for (const shell of shells) {
          if (shell.shellImage === this.shellImage) {
            this.interruptShellEvaluation({ environment: shell, waitStatus });
            if (!excludedPids.includes(root.pid)) {
              excludedPids.push(root.pid);
            }
          }
        }
      }
    }
    await this.kernel.killProcessGroups({ pgids: groups, signal, excludedPids });
    return groups.size > 0;
  }

  async interruptForeground({ foregroundSignal }: { foregroundSignal: AbortSignal }): Promise<boolean> {
    if (!foregroundSignal.aborted) {
      return false;
    }
    const selectedSignals = this.getForegroundInputSignals({ foregroundSignal });
    const scopes = this.foregroundProcessGroupScopes.filter(scope =>
      scope.foregroundSignal !== undefined && selectedSignals.has(scope.foregroundSignal));
    const { groups, shells } = this.getForegroundGroupTargets({ scopes, selectedSignals: undefined });
    const excluded = new Set([...shells].map(({ shellPid }) => shellPid));
    const pids = new Set<number>();
    for (const proc of this.kernel.getProcesses()) {
      const inputSignal = proc.foregroundSignal;
      if (groups.has(proc.pgid) && inputSignal !== undefined && selectedSignals.has(inputSignal) && !excluded.has(proc.pid)) {
        pids.add(proc.pid);
      }
    }
    await this.kernel.interruptInputProcesses({ pids, foregroundSignals: selectedSignals });
    return groups.size > 0;
  }

  private getForegroundInputSignals({ foregroundSignal }: { foregroundSignal: AbortSignal }): Set<AbortSignal> {
    const selectedSignals = new Set<AbortSignal>();
    for (const [inputSignal, externalSignal] of this.foregroundInputs) {
      if (externalSignal === foregroundSignal) {
        selectedSignals.add(inputSignal);
      }
    }
    return selectedSignals;
  }

  private getForegroundGroupTargets({ scopes, selectedSignals }: {
    scopes: readonly WeshForegroundProcessGroup[],
    selectedSignals: ReadonlySet<AbortSignal> | undefined,
  }): { groups: Set<number>, excludedPids: number[], shells: Set<WeshExecutionEnvironment> } {
    const groups = new Set(scopes.map(({ pgid }) => pgid));
    const excludedPids: number[] = [];
    const shells = new Set<WeshExecutionEnvironment>();
    for (const { shell, foregroundSignal } of scopes) {
      if (shell !== undefined && foregroundSignal !== undefined) {
        shells.add(shell);
      }
    }
    if (selectedSignals !== undefined) {
      for (const proc of this.kernel.getProcesses()) {
        const inputSignal = proc.foregroundSignal;
        if (inputSignal !== undefined && this.foregroundInputs.has(inputSignal) && !selectedSignals.has(inputSignal)) {
          excludedPids.push(proc.pid);
        }
      }
    }
    return { groups, excludedPids, shells };
  }

  private bindShellSignalHandler({ process, environment }: { process: WeshProcess, environment: WeshExecutionEnvironment | undefined }): void {
    this.kernel.setSignalHandler({ process, handle: this.createShellSignalHandler({ environment, builtinSelfSignal: undefined }) });
  }

  private createShellSignalHandler({ environment, builtinSelfSignal }: {
    environment: WeshExecutionEnvironment | undefined,
    builtinSelfSignal: true | undefined,
  }): WeshProcessSignalHandler {
    const image = environment?.shellImage ?? this.shellImage;
    const traps = environment?.traps ?? this.traps;
    const rootShell = image === this.shellImage;
    return {
      catchSignal: ({ signal }) => {
        const action = findSignalTrapAction({ traps, signal });
        if (image.termination !== undefined || action === undefined) {
          return false;
        }
        if (builtinSelfSignal === true && environment !== undefined) {
          // A concurrent input for the same root shell must not claim this trap.
          (environment.pendingSelfSignals ??= new Map()).set(signal, action);
        } else {
          image.queueSignal({ signal });
        }
        return true;
      },
      terminate: ({ waitStatus }) => {
        if (waitStatus.signal === 3) { // Bash ignores an untrapped QUIT.
          return true;
        }
        const scopes = this.foregroundProcessGroupScopes;
        let evaluating = environment ?? scopes.findLast(({ shell }) => shell?.shellImage === image)?.shell;
        if (rootShell && waitStatus.signal === 2 && image.termination === undefined) {
          if (evaluating !== undefined) {
            this.interruptShellEvaluation({ environment: evaluating, waitStatus });
          }
          return true;
        }
        if (evaluating === undefined) {
          return false;
        }
        if (environment === undefined && this.getShellEvaluationInterrupt({ environment: evaluating }) === INPUT_ABORT_STATUS) {
          evaluating = scopes.findLast(({ shell }) => shell?.shellImage === image
              && this.getShellEvaluationInterrupt({ environment: shell }) !== INPUT_ABORT_STATUS)?.shell ?? evaluating;
        }
        if (waitStatus.signal !== 9 && this.getShellEvaluationInterrupt({ environment: evaluating }) === INPUT_ABORT_STATUS) {
          return true;
        }
        const exitCode = builtinSelfSignal === true ? 0
          : waitStatus.signal === 2 && evaluating.waitingForShellChild === true ? 130
            : Number(evaluating.variables.get({ name: '?' }) ?? 0);
        const waiting = evaluating.foregroundWait ?? evaluating.commandSubstitutionWait;
        if (waitStatus.signal === 2 && image.termination === undefined && waiting !== undefined
            && waiting.children.some(child => this.kernel.getProcess({ pid: child.pid }) === child)) {
          waiting.interrupt ??= { status: waitStatus, lastExitCode: exitCode };
          return true;
        }
        this.terminateShellImage({
          environment: evaluating,
          waitStatus,
          lastExitCode: exitCode,
          unwindSource: builtinSelfSignal === true && waitStatus.signal !== 9 ? true : undefined,
        });
        return true;
      },
    };
  }

  private signalCommandProcessGroup({ proc, signal }: { proc: WeshProcess, signal: number }): Promise<void> {
    return this.kernel.killProcessGroups({ pgids: new Set([proc.pgid]), signal });
  }

  private terminateShellImage({ environment, waitStatus, lastExitCode, unwindSource }: {
    environment: WeshExecutionEnvironment,
    waitStatus: WeshSignalStatus,
    lastExitCode: number,
    unwindSource?: true,
  }): void {
    const image = environment.shellImage;
    image.terminate({ status: waitStatus, lastExitCode, unwindOwner: unwindSource === true ? environment : undefined });
    const process = this.kernel.getProcess({ pid: environment.shellPid });
    if (process !== undefined) {
      process.terminationStatus = image.termination!.status;
    }
  }

  private interruptShellEvaluation({ environment, waitStatus }: { environment: WeshExecutionEnvironment, waitStatus: WeshSignalStatus }): void {
    if (this.getShellEvaluationInterrupt({ environment }) === undefined) {
      const interruption = environment.groupInterrupt ??= { controller: new AbortController(), status: undefined };
      interruption.status = waitStatus;
      interruption.controller.abort();
    }
  }

  private hasDefaultInterruptDisposition({ process, traps }: {
    process: WeshProcess,
    traps: ReadonlyMap<string, WeshTrapDisposition>,
  }): boolean {
    return process.waitStatus === undefined && !ignoresSignal({ disposition: process.signalDispositions?.get(2) })
      && findSignalTrapAction({ signal: 2, traps }) === undefined;
  }

  private getShellEvaluationInterrupt({ environment }: { environment: WeshExecutionEnvironment }): WeshSignalStatus | undefined {
    const signal = environment.foregroundSignal;
    return signal === undefined ? undefined : environment.groupInterrupt?.status ?? this.getInputAbortStatus({ signal });
  }

  private getInputAbortStatus({ signal }: { signal: AbortSignal | undefined }): WeshSignalStatus | undefined {
    return signal?.aborted ? INPUT_ABORT_STATUS : undefined;
  }

  private subscribeInterrupt({ environment, process, notify }: {
    environment: WeshExecutionEnvironment | undefined,
    process: WeshProcess | undefined,
    notify: () => void,
  }): () => void {
    const signal = environment === undefined ? process?.foregroundSignal : environment.foregroundSignal;
    const groupSignal = environment !== undefined && signal !== undefined
      ? (environment.groupInterrupt ??= { controller: new AbortController(), status: undefined }).controller.signal
      : undefined;
    const unsubscribe = process === undefined ? undefined : this.kernel.subscribeWaitStatus({ process, notify });
    const unsubscribeRetirement = environment?.shellImage.subscribeRetirement({ notify });
    const unsubscribeTermination = environment?.shellImage.subscribeTermination({ notify });
    signal?.addEventListener('abort', notify, { once: true });
    groupSignal?.addEventListener('abort', notify, { once: true });
    return () => {
      unsubscribe?.();
      unsubscribeRetirement?.();
      unsubscribeTermination?.();
      signal?.removeEventListener('abort', notify);
      groupSignal?.removeEventListener('abort', notify);
    };
  }

  private subscribeShellInterrupt({ environment, notify }: {
    environment: WeshExecutionEnvironment,
    notify: () => void,
  }): () => void {
    return this.subscribeInterrupt({
      environment,
      process: this.kernel.getProcess({ pid: environment.shellPid }),
      notify,
    });
  }

  private createShCommandDefinition(): WeshCommandDefinition {
    return {
      meta: {
        name: 'sh',
        description: 'Run commands using the sh shell compatibility entrypoint',
        usage: 'sh [-c command] [file [argument...]]',
      },
      load: async () => async ({ context }) => {
        if (context.args.length === 1 && context.args[0] === '--help') {
          await context.text().print({
            text: `\
sh: sh shell compatibility entrypoint
usage: sh [-c command] [file [argument...]]
`,
          });
          return { exitCode: 0 };
        }

        let argumentIndex = 0;
        let mode: ShellInvocationMode = 'execute';
        let stdinMode = false;
        const executionOptions = createDefaultExecutionOptions();
        while (argumentIndex < context.args.length) {
          const argument = context.args[argumentIndex];
          if (argument === '-a' || argument === '+a') {
            executionOptions.allexport = argument === '-a';
            argumentIndex += 1;
            continue;
          }
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
          if (argument === '-o' || argument === '+o') {
            const option = SHELL_EXECUTION_OPTION_NAMES.find(name => name === context.args[argumentIndex + 1]);
            if (option !== undefined) {
              executionOptions[option] = argument === '-o';
              argumentIndex += 2;
              continue;
            }
          }
          if (argument === '-n') {
            mode = 'parse-only';
            argumentIndex += 1;
            continue;
          }
          if (argument === '-s') {
            stdinMode = true;
            argumentIndex += 1;
            break;
          }
          break;
        }

        const runSource = ({ source, argv0, positionalArgs }: {
          source: ShellSource,
          argv0: string | undefined,
          positionalArgs: readonly string[],
        }) => this.executeShellProgram({
          name: 'sh',
          context,
          invocation: { source, argv0, positionalArgs, executionOptions, shellOptionOverrides: [], mode },
        });

        if (context.args[argumentIndex] === '-c') {
          const script = context.args[argumentIndex + 1];
          if (script === undefined) {
            await context.text().error({ text: "sh: option requires an argument -- 'c'\n" });
            return { exitCode: 2 };
          }
          return runSource({
            source: createTextShellSource({ text: script }),
            argv0: context.args[argumentIndex + 2],
            positionalArgs: context.args.slice(argumentIndex + 3),
          });
        }

        const scriptPath = context.args[argumentIndex];
        if (stdinMode || scriptPath === undefined) {
          return runSource({
            source: createHandleShellSource({ handle: context.stdin }),
            argv0: undefined,
            positionalArgs: context.args.slice(argumentIndex),
          });
        }

        try {
          const path = toAbsolutePath({ cwd: context.cwd, path: scriptPath });
          const handle = await context.files.open({
            path,
            flags: { access: 'read', creation: 'never', truncate: 'preserve', append: 'preserve' },
          });
          try {
            return await runSource({
              source: createShebangStrippedShellSource({ source: createHandleShellSource({ handle }) }),
              argv0: scriptPath,
              positionalArgs: context.args.slice(argumentIndex + 1),
            });
          } finally {
            await handle.close();
          }
        } catch (error: unknown) {
          const message = error instanceof Error ? error.message : String(error);
          await context.text().error({ text: `sh: ${scriptPath}: ${message}\n` });
          return { exitCode: 1 };
        }
      },
    };
  }

  private async executeShellProgram({ name, context, invocation }: {
    name: 'sh' | 'bash',
    context: WeshCommandContext,
    invocation: ShellInvocation,
  }): Promise<WeshCommandResult> {
    const process = this.kernel.getProcess({ pid: context.pid });
    if (process === undefined) {
      throw new Error(`Missing shell command process: ${context.pid}`);
    }
    const shellopts = (() => {
      switch (name) {
      case 'bash':
        return true;
      case 'sh':
        return undefined;
      default: {
        const _ex: never = name;
        throw new Error(`Unhandled shell entrypoint: ${_ex}`);
      }
      }
    })();
    const variables = WeshShellVariables.fromEnvironment({
      entries: process.env,
      executionOptions: { ...invocation.executionOptions },
      shellopts,
    });
    variables.setExport({ name: 'PWD', value: process.cwd, exported: true });
    variables.setExport({ name: 'OLDPWD', value: undefined, exported: true });
    const environment = this.createExecutionEnvironment({
      shellPid: process.pid,
      pgid: process.pgid,
      variables,
      aliases: new Map(),
      functions: new Map(),
      fds: new Map(process.fds),
      traps: createStartupTraps({ signalDispositions: process.signalDispositions }),
      shellOptions: new Map(invocation.shellOptionOverrides.map(({ name, enabled }) => [name, enabled])),
      positionalArgs: [...invocation.positionalArgs],
      shellImage: new WeshShellImage({ cwd: process.cwd, lastPid: undefined }),
    });
    environment.foregroundSignal = process.foregroundSignal;
    environment.inheritedSignalDispositions = process.signalDispositions;
    this.bindShellSignalHandler({ process, environment });
    variables.setSpecial({ name: '0', value: invocation.argv0 ?? process.args[0] ?? name });
    const stdin = context.stdin;
    const stdout = context.stdout;
    const stderr = context.stderr;
    const resolveStdio = this.createStdioResolver({ environment, stdin, stdout, stderr });
    const syntaxCheck = (() => {
      switch (invocation.mode) {
      case 'parse-only':
        return { name };
      case 'execute':
        return undefined;
      default: {
        const _ex: never = invocation.mode;
        throw new Error(`Unhandled shell invocation mode: ${_ex}`);
      }
      }
    })();
    let result: WeshShellExecutionResult;
    let closeFailure: { error: unknown } | undefined;
    try {
      result = await this.runWithForegroundProcessGroup({
        pgid: process.pgid,
        foregroundSignal: process.foregroundSignal,
        // The shell interprets the interrupt and can still write its INT trap.
        shell: environment,
        fn: async () => {
          const completed = await this.evaluateShellToCompletion({
            environment,
            resolveStdio,
            execute: () => this.executeShellInState({
              source: invocation.source,
              environment,
              stdin,
              stdout,
              stderr,
              history: 'ignore',
              loopDepth: 0,
              allowReturn: false,
              syntaxCheck,
            }),
          });
          this.recordShellSignalExit({ environment, waitStatus: completed.waitStatus });
          return completed;
        },
      });
    } finally {
      // The command runner owns the original process descriptors.
      environment.shellImage.retire({ status: process.waitStatus ?? RETIRED_SHELL_STATUS });
      closeFailure = await closeFileHandleReferences({ handles: this.takeOwnedPersistentFileHandles({ environment }) });
    }
    if (closeFailure !== undefined) {
      throw closeFailure.error;
    }
    return { exitCode: result.exitCode, waitStatus: result.waitStatus };
  }

  private resolveRegisteredCommand({ name, cwd }: {
    name: string,
    cwd: string,
  }): { definition: WeshRegisteredCommandDefinition, invocationPath: string | undefined } | undefined {
    const direct = this.commands.get(name);
    if (direct !== undefined) {
      let invocationPath: string | undefined;
      switch (name) {
      case 'sh':
        invocationPath = WESH_SHELL_SPECIAL_FILES.sh;
        break;
      case 'bash':
        invocationPath = WESH_SHELL_SPECIAL_FILES.bash;
        break;
      }
      return { definition: direct, invocationPath };
    }

    if (!name.includes('/')) {
      return undefined;
    }
    const registered = registeredCommandPath({ name, cwd });
    if (registered === undefined) {
      return undefined;
    }
    const definition = this.commands.get(registered.name);
    return definition === undefined ? undefined : { definition, invocationPath: registered.path };
  }

  private async resolveProgramFile({ name, cwd, searchPath }: {
    name: string,
    cwd: string,
    searchPath: string | undefined,
  }): Promise<
    | { kind: 'shell-entrypoint', entrypoint: keyof typeof WESH_SHELL_SPECIAL_FILES }
    | { kind: 'script', scriptPath: string, interpreter: string, interpreterArgs: string[] }
    | undefined
  > {
    for (const { candidatePath, invocationPath } of iterateCommandPaths({ name, cwd, searchPathEntries: searchPath?.split(':') ?? [] })) {
      try {
        const entry = await this.kernel.resolveEntry({ path: candidatePath, finalSymlinkTreatment: 'follow' });
        switch (entry.type) {
        case 'file':
          break;
        case 'directory':
        case 'fifo':
        case 'chardev':
        case 'symlink':
          continue;
        default: {
          const _ex: never = entry;
          throw new Error(`Unhandled program entry: ${String(_ex)}`);
        }
        }
        const handle = await this.kernel.openEntry({
          entry,
          flags: {
            access: 'read',
            creation: 'never',
            truncate: 'preserve',
            append: 'preserve',
          },
        });
        let firstLine: string | undefined;
        try {
          if (handle instanceof WeshShellEntryFileHandle) {
            return { kind: 'shell-entrypoint', entrypoint: handle.entrypoint };
          }
          firstLine = await readShellShebangLine({ handle });
        } finally {
          await handle.close();
        }
        const shebang = firstLine === undefined ? undefined : parseShellShebangLine({ firstLine });
        if (shebang === undefined) {
          return { kind: 'script', scriptPath: invocationPath, interpreter: 'bash', interpreterArgs: [] };
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
          const envInterpreter = envArguments?.[0];
          if (envArguments === undefined || envInterpreter === undefined || envInterpreter.length === 0) {
            continue;
          }
          return {
            kind: 'script',
            scriptPath: invocationPath,
            interpreter: envInterpreter,
            interpreterArgs: envArguments.slice(1),
          };
        }
        return {
          kind: 'script',
          scriptPath: invocationPath,
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
  }): WeshCommandNode | WeshConditionalCommandNode | WeshRedirectedNode {
    if (expandedAliases.has(node.name)) {
      return node;
    }
    const aliasValue = environment.aliases.get(node.name);
    if (aliasValue === undefined) {
      return node;
    }

    const parsed = parseCommandLine({ commandLine: aliasValue });
    const rejectTrailingArguments = () => {
      if (node.args.length !== 0) {
        throw new WeshShellExecutionError({
          message: 'Unexpected argument after conditional command',
          exitCode: 2,
          disposition: 'abort-shell',
        });
      }
    };
    switch (parsed.kind) {
    case 'command':
      break;
    case 'conditionalCommand':
      if (node.assignments.length !== 0) {
        return node;
      }
      rejectTrailingArguments();
      return node.redirections.length === 0
        ? parsed
        : { kind: 'redirected', node: parsed, redirections: node.redirections };
    case 'redirected': {
      const conditional = parsed.node.kind === 'conditionalCommand';
      if (!conditional || node.assignments.length !== 0) {
        return node;
      }
      rejectTrailingArguments();
      return { ...parsed, redirections: [...parsed.redirections, ...node.redirections] };
    }
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
    escapeMode,
  }: {
    text: string,
    env: WeshVariableValues,
    environment: WeshExecutionEnvironment,
    escapeMode: 'standard' | 'here-document' | 'arithmetic',
  }): Promise<string> {
    let result = '';

    for (let index = 0; index < text.length; index++) {
      const char = text[index];
      if (escapeMode === 'arithmetic' && char === '"') {
        continue;
      }
      if (escapeMode === 'arithmetic' && char === '\\') {
        const escaped = text[index + 1];
        if (escaped === '\n') {
          index += 1;
          continue;
        }
        if (escaped === '"' || escaped === '\\' || escaped === '$' || escaped === '`') {
          result += escaped;
          index += 1;
          continue;
        }
      }
      if (escapeMode === 'here-document' && char === '\\') {
        const escaped = text[index + 1];
        if (escaped === '\\' || escaped === '$' || escaped === '`') {
          result += escaped;
          index += 1;
          continue;
        }
      }
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
        result += env.get({ name: '?' }) ?? '0';
        index += 1;
        continue;
      }

      if (nextChar === '$') {
        result += env.get({ name: '$$' }) ?? '';
        index += 1;
        continue;
      }

      if (nextChar === '#') {
        result += env.get({ name: '#' }) ?? '0';
        index += 1;
        continue;
      }

      if (nextChar === '!') {
        result += env.get({ name: '!' }) ?? '';
        index += 1;
        continue;
      }

      if (nextChar === '0') {
        result += env.get({ name: '0' }) ?? '';
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
          const expansion = await this.expandArithmeticExpansion({
            text,
            startIndex: index,
            env,
            environment,
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
    env: WeshVariableValues,
    environment: WeshExecutionEnvironment,
    quoted: boolean,
    literalFieldSplitEligible: boolean,
  }): Promise<WeshExpandedWordPart[]> {
    const parts: WeshExpandedWordPart[] = [];
    let literal = '';

    const flushLiteral = (): void => {
      if (literal.length === 0) {
        return;
      }
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
        appendExpansion({ value: env.get({ name: '?' }) ?? '0' });
        index += 1;
        continue;
      }

      if (nextChar === '$') {
        appendExpansion({ value: env.get({ name: '$$' }) ?? '' });
        index += 1;
        continue;
      }

      if (nextChar === '#') {
        appendExpansion({ value: env.get({ name: '#' }) ?? '0' });
        index += 1;
        continue;
      }

      if (nextChar === '!') {
        appendExpansion({ value: env.get({ name: '!' }) ?? '' });
        index += 1;
        continue;
      }

      if (nextChar === '@' || nextChar === '*') {
        appendExpansion({ value: this.joinPositionalParameters({ name: nextChar, environment }) });
        index += 1;
        continue;
      }

      if (nextChar === '0') {
        appendExpansion({ value: env.get({ name: '0' }) ?? '' });
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
          const expansion = await this.expandArithmeticExpansion({
            text,
            startIndex: index,
            env,
            environment,
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
    env: WeshVariableValues,
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
    env: WeshVariableValues,
    environment: WeshExecutionEnvironment,
    quoted: boolean,
  }): Promise<WeshExpandedWordPart[]> {
    const currentValue = env.get({ name });
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
        env.set({ name, value: expandedOperand.map((part) => part.text).join('') });
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
    env: WeshVariableValues,
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
    const pendingAssignmentInterrupt = environment.assignment?.interrupt;
    if (pendingAssignmentInterrupt !== undefined) {
      this.interruptFromCommandSubstitution({ environment, waitStatus: pendingAssignmentInterrupt });
      throw new WeshCommandInterruptedError();
    }
    const chunks: Uint8Array[] = [];
    let capturing = true;
    const captureHandle = createWriteHandleFromStream({
      target: new WritableStream<Uint8Array>({
        write: async (chunk) => {
          if (!capturing) {
            throw new WeshBrokenPipeError();
          }
          chunks.push(new Uint8Array(chunk));
        },
      }),
    });
    let result: WeshCommandResult;
    const waiting: WeshChildWait = { children: [] };
    environment.commandSubstitutionWait = waiting;
    try {
      const childEnvironment = await this.spawnChildExecutionEnvironment({
        parentEnvironment: environment,
        childEnvironment: this.forkExecutionEnvironment({ environment }),
        pgid: environment.pgid,
        waiting,
        foregroundSignal: environment.foregroundSignal,
        stdio: { ...this.getShellStdio({ environment }), stdout: captureHandle },
      });
      const process = this.kernel.getProcess({ pid: childEnvironment.shellPid });
      const stopped = this.getForegroundInterruptResult({ environment });
      if (stopped !== undefined) {
        await this.finishChildExecutionEnvironment({ environment: childEnvironment, result: stopped });
        throw new WeshCommandInterruptedError();
      }
      const stdio = this.getShellStdio({ environment: childEnvironment });
      const completed = this.runChildExecutionEnvironment({
        environment: childEnvironment,
        stdio,
        execute: () => this.executeShellInState({
          source: createTextShellSource({ text: script }),
          environment: childEnvironment,
          ...stdio,
          history: 'ignore',
          loopDepth: 0,
          allowReturn: false,
        }),
      });
      result = await this.waitForForegroundProcess({ completed, environment, process });
      if (this.getShellInterruptStatus({ environment }) === undefined) {
        const interrupt = waiting.interrupt;
        const childSignal = this.getSignaledWaitStatus({ waitStatus: process?.waitStatus });
        if (interrupt !== undefined) {
          this.terminateShellImage({ environment, waitStatus: interrupt.status, lastExitCode: interrupt.lastExitCode });
        } else if (childSignal?.signal === 2) {
          const shell = this.kernel.getProcess({ pid: environment.shellPid });
          if (shell !== undefined && this.hasDefaultInterruptDisposition({ process: shell, traps: environment.traps })) {
            if (environment.assignment !== undefined) {
              // A standalone assignment can use the partial output before this input ends.
              environment.assignment.interrupt = childSignal;
            } else {
              this.interruptFromCommandSubstitution({ environment, waitStatus: childSignal });
            }
          } else if (shell?.waitStatus === undefined && findSignalTrapAction({ signal: 2, traps: environment.traps }) !== undefined) {
            environment.pendingSubstitutionInterrupt = true;
          }
        }
      }
    } finally {
      delete environment.commandSubstitutionWait;
      capturing = false;
      if (this.getShellTerminationStatus({ environment }) !== undefined) {
        chunks.length = 0;
      }
      await captureHandle.close();
    }
    if (this.getShellInterruptStatus({ environment }) !== undefined) {
      throw new WeshCommandInterruptedError();
    }
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

  private interruptFromCommandSubstitution({ environment, waitStatus }: {
    environment: WeshExecutionEnvironment,
    waitStatus: WeshSignalStatus,
  }): void {
    if (this.getShellInterruptStatus({ environment }) !== undefined) {
      return;
    }
    if (environment.shellImage === this.shellImage) {
      this.interruptShellEvaluation({ environment, waitStatus });
    } else {
      this.terminateShellImage({ environment, waitStatus, lastExitCode: 130 });
    }
  }

  private async expandArithmeticExpansion({
    text,
    startIndex,
    env,
    environment,
  }: {
    text: string,
    startIndex: number,
    env: WeshVariableValues,
    environment: WeshExecutionEnvironment,
  }): Promise<{
    value: string,
    endIndex: number,
  }> {
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
    const expanded = this.expandArithmeticText({ expression: parsed.content, env, environment });
    const value = this.evaluateArithmeticExpression({
      expression: typeof expanded === 'string' ? expanded : await expanded,
      evaluate: this.arithmeticEvaluator ?? await this.loadArithmeticEvaluator({ environment }),
      env,
      executionOptions: environment.executionOptions,
      context: 'expansion',
    });
    return {
      value: value.toString(),
      endIndex: parsed.endIndex,
    };
  }

  private joinPositionalParameters({ name, environment }: {
    name: '@' | '*',
    environment: WeshExecutionEnvironment,
  }): string {
    const ifs = environment.variables.get({ name: 'IFS' });
    const separator = name === '@' || ifs === undefined ? ' ' : ifs[0] ?? '';
    return environment.positionalArgs.join(separator);
  }

  private async evaluateParameterExpansion({
    expression,
    env,
    environment,
  }: {
    expression: string,
    env: WeshVariableValues,
    environment: WeshExecutionEnvironment,
  }): Promise<string> {
    if (expression.length === 0) {
      return '';
    }

    if (expression === '@' || expression === '*') {
      return this.joinPositionalParameters({ name: expression, environment });
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
      if (parsedExpression.offsetExpression.length === 0 && parsedExpression.lengthExpression === undefined) {
        throw new WeshShellExecutionError({
          message: `\${${expression}}: bad substitution`,
          exitCode: 1,
          disposition: environment.executionOptions.errexit ? 'abort-shell' : 'abort-unit',
        });
      }
      const value = this.getParameterValue({
        name: parsedExpression.name,
        env,
        nounset: environment.executionOptions.nounset,
      });
      const characters = Array.from(value);
      const characterCount = BigInt(characters.length);
      const expandedOffset = this.expandArithmeticText({ expression: parsedExpression.offsetExpression, env, environment });
      const offsetExpression = typeof expandedOffset === 'string' ? expandedOffset : await expandedOffset;
      const evaluate = this.arithmeticEvaluator ?? await this.loadArithmeticEvaluator({ environment });
      const offset = this.evaluateArithmeticExpression({
        expression: offsetExpression,
        evaluate,
        env,
        executionOptions: environment.executionOptions,
        context: 'expansion',
      });
      const start = offset < 0n ? characterCount + offset : offset;
      if (start < 0n || start > characterCount) {
        return '';
      }
      if (parsedExpression.lengthExpression === undefined) {
        return characters.slice(Number(start)).join('');
      }
      const expandedLength = this.expandArithmeticText({ expression: parsedExpression.lengthExpression, env, environment });
      const length = this.evaluateArithmeticExpression({
        expression: typeof expandedLength === 'string' ? expandedLength : await expandedLength,
        evaluate,
        env,
        executionOptions: environment.executionOptions,
        context: 'expansion',
      });
      const end = length < 0n ? characterCount + length : start + length;
      if (end < start) {
        throw new WeshShellExecutionError({
          message: `${length}: substring expression < 0`,
          exitCode: 1,
          disposition: 'abort-unit',
        });
      }
      return characters.slice(Number(start), Number(end > characterCount ? characterCount : end)).join('');
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
        escapeMode: 'standard',
      });
      const replacement = await this.expandPartVariables({
        text: parsedExpression.replacement,
        env,
        environment,
        escapeMode: 'standard',
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
            escapeMode: 'standard',
          });
        })(),
      });
    default: {
      const _ex: never = parsedExpression;
      throw new Error(`Unhandled parsed parameter expression: ${String(_ex)}`);
    }
    }
  }

  private evaluateArithmeticExpression({ expression, env, executionOptions, context, evaluate }: {
    expression: string,
    env: WeshVariableValues,
    executionOptions: Readonly<WeshExecutionOptions>,
    context: 'command' | 'expansion',
    evaluate: typeof import('./shell/arithmetic')['evaluateShellArithmetic'],
  }): bigint {
    try {
      return evaluate({
        expression,
        env: {
          get: ({ name }) => this.getParameterValue({ name, env, nounset: executionOptions.nounset }),
          set: ({ name, value }) => env.set({ name, value }),
        },
      });
    } catch (error: unknown) {
      if (error instanceof WeshReadonlyVariableError) {
        switch (context) {
        case 'expansion':
          throw new WeshShellExecutionError({
            message: error.message,
            exitCode: 1,
            disposition: executionOptions.errexit ? 'abort-shell' : 'abort-unit',
          });
        case 'command':
          throw new WeshArithmeticError(error.message);
        default: {
          const _ex: never = context;
          throw new Error(`Unhandled arithmetic context: ${_ex}`);
        }
        }
      }
      if (context === 'expansion' && error instanceof WeshArithmeticError) {
        throw new WeshShellExecutionError({ message: error.message, exitCode: 1, disposition: 'abort-unit' });
      }
      throw error;
    }
  }

  private expandArithmeticText({ expression, env, environment }: {
    expression: string,
    env: WeshVariableValues,
    environment: WeshExecutionEnvironment,
  }): string | Promise<string> {
    return /[$`"\\]/u.test(expression)
      ? this.expandPartVariables({ text: expression, env, environment, escapeMode: 'arithmetic' })
      : expression;
  }

  private splitTildePrefix({ text, env }: {
    text: string,
    env: WeshVariableValues,
  }): {
    prefix: string,
    suffix: string,
  } | undefined {
    if (!text.startsWith('~') || (text.length !== 1 && text[1] !== '/')) {
      return undefined;
    }

    const prefix = env.get({ name: 'HOME' }) ?? '/home';
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
    env: WeshVariableValues,
    environment: WeshExecutionEnvironment,
  }): Promise<string> {
    const currentValue = env.get({ name });
    const isSet = currentValue !== undefined;
    const isNull = currentValue === '';
    const requireNonNull = operator.startsWith(':');
    const shouldUseOperand = requireNonNull ? !isSet || isNull : !isSet;
    const expandOperand = () => this.expandPartVariables({
      text: operand,
      env,
      environment,
      escapeMode: 'standard',
    });

    switch (operator) {
    case ':-':
    case '-':
      return shouldUseOperand ? await expandOperand() : currentValue ?? '';
    case ':=':
    case '=':
      if (shouldUseOperand) {
        const expandedOperand = await expandOperand();
        env.set({ name, value: expandedOperand });
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
    if (pattern.length === 0 && (operator === 'first' || operator === 'all')) {
      return value;
    }

    const compiledPattern = compileShellPattern({ pattern });
    const matchesRange = ({ start, end }: { start: number, end: number }): boolean =>
      matchesCompiledShellPattern({
        compiledPattern,
        text: value.slice(start, end),
      });

    const longestMatchFrom = ({ start }: { start: number }): number | undefined => {
      for (let end = value.length;;) {
        if (end >= start && matchesRange({ start, end })) {
          return end;
        }
        if (end <= start) {
          break;
        }
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
        if (start === value.length) {
          break;
        }
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
        if (start === value.length) {
          break;
        }
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
              if (start === value.length) {
                return result;
              }
              const next = nextShellCharacterIndex({ text: value, index: start });
              result += value.slice(start, next);
              cursor = next;
            } else {
              cursor = end;
            }
            matched = true;
            break;
          }
          if (start === value.length) {
            break;
          }
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
    env: WeshVariableValues,
    nounset?: boolean,
  }): string {
    if (name === 'RANDOM') {
      return Math.floor(Math.random() * 32768).toString();
    }
    const value = env.get({ name });
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
      for (const m of deepMatches) {
        deduplicated.add(m);
      }
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
    env: WeshVariableValues,
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
        ifs: environment.variables.get({ name: 'IFS' }),
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
        const ifs = environment.variables.get({ name: 'IFS' });
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
        const separator = environment.variables.get({ name: 'IFS' })?.[0] ?? ' ';
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
        ifs: environment.variables.get({ name: 'IFS' }),
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
    env: WeshVariableValues,
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
  }): { fds: Map<number, WeshFileHandle>, ownedFds: Set<number> } {
    const fds = new Map<number, WeshFileHandle>([
      [0, this.createPrimaryFileHandleReference({ handle: stdin })],
      [1, this.createPrimaryFileHandleReference({ handle: stdout })],
      [2, this.createPrimaryFileHandleReference({ handle: stderr })],
    ]);

    const ownedFds = new Set<number>();
    for (const [fd, handle] of this.shellFds) {
      if (handle === undefined) {
        fds.delete(fd);
        continue;
      }
      const reference = this.cloneFileHandleReference({ handle });
      fds.set(fd, reference);
      if (reference !== handle) {
        ownedFds.add(fd);
      }
    }

    return { fds, ownedFds };
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
    return new SharedFileHandle({ state: { handle, refCount: 1, closed: false } });
  }

  private cloneFileHandleReference({
    handle,
  }: {
    handle: WeshFileHandle,
  }): WeshFileHandle {
    return duplicateFileReference({ handle });
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

  private takeOwnedPersistentFileHandles({ environment }: {
    environment: WeshExecutionEnvironment,
  }): WeshFileHandle[] {
    const handles: WeshFileHandle[] = [];
    for (const fd of environment.ownedPersistentFds) {
      const handle = environment.fds.get(fd);
      if (handle !== undefined) {
        handles.push(handle);
      }
    }
    environment.ownedPersistentFds.clear();
    return handles;
  }

  private scopeShellFileDescriptors({ environment, fdTable, fds }: {
    environment: WeshExecutionEnvironment,
    fdTable: ReadonlyMap<number, WeshFileHandle>,
    fds: Iterable<number>,
  }): WeshRestoreFileDescriptors {
    const savedFds = new Map<number, { handle: WeshFileHandle | undefined, owned: boolean, scoped: boolean }>();
    for (const fd of new Set(fds)) {
      const handle = environment.fds.get(fd);
      const replacement = fdTable.get(fd);
      savedFds.set(fd, {
        handle,
        owned: environment.ownedPersistentFds.delete(fd),
        scoped: environment.scopedRedirectionFds.has(fd),
      });
      environment.scopedRedirectionFds.add(fd);
      if (replacement === undefined) {
        environment.fds.delete(fd);
      } else {
        environment.fds.set(fd, replacement);
      }
    }

    return ({ fds }) => {
      const replacedHandles: WeshFileHandle[] = [];
      for (const fd of fds ?? savedFds.keys()) {
        const saved = savedFds.get(fd);
        if (saved === undefined) {
          continue;
        }
        savedFds.delete(fd);
        const scopedHandle = environment.fds.get(fd);
        if (environment.ownedPersistentFds.delete(fd) && scopedHandle !== undefined) {
          replacedHandles.push(scopedHandle);
        }
        if (saved.handle === undefined) {
          environment.fds.delete(fd);
        } else {
          environment.fds.set(fd, saved.handle);
        }
        if (saved.owned) {
          environment.ownedPersistentFds.add(fd);
        }
        if (!saved.scoped) {
          environment.scopedRedirectionFds.delete(fd);
        }
      }
      return replacedHandles;
    };
  }

  private createStdioResolver({ environment, stdin, stdout, stderr }: {
    environment: WeshExecutionEnvironment,
    stdin: WeshFileHandle,
    stdout: WeshFileHandle,
    stderr: WeshFileHandle,
  }): () => { stdin: WeshFileHandle, stdout: WeshFileHandle, stderr: WeshFileHandle } {
    const useShellStdin = (environment.fds.get(0) ?? closedFileDescriptor) === stdin;
    const useShellStdout = (environment.fds.get(1) ?? closedFileDescriptor) === stdout;
    const useShellStderr = (environment.fds.get(2) ?? closedFileDescriptor) === stderr;
    return () => ({
      stdin: useShellStdin ? environment.fds.get(0) ?? closedFileDescriptor : stdin,
      stdout: useShellStdout ? environment.fds.get(1) ?? closedFileDescriptor : stdout,
      stderr: useShellStderr ? environment.fds.get(2) ?? closedFileDescriptor : stderr,
    });
  }

  private getShellStdio({ environment }: { environment: WeshExecutionEnvironment }): WeshShellStdio {
    const { fds } = environment;
    return {
      stdin: fds.get(0) ?? closedFileDescriptor,
      stdout: fds.get(1) ?? closedFileDescriptor,
      stderr: fds.get(2) ?? closedFileDescriptor,
    };
  }

  private async openRedirectionTarget({
    redirection,
    environment,
    cwd,
    fdTable,
    processSubstitutions,
  }: {
    redirection: WeshCommandNode['redirections'][number],
    environment: WeshExecutionEnvironment,
    cwd: string,
    fdTable: Map<number, WeshFileHandle>,
    processSubstitutions: WeshProcessSubstitutionTask[],
  }): Promise<WeshFileHandle | undefined> {
    if (redirection.type === 'heredoc' || redirection.type === 'herestring') {
      if (redirection.content === undefined) {
        return undefined;
      }

      let content: string;
      switch (redirection.type) {
      case 'herestring':
        content = `${await this.expandSingleWord({
          raw: redirection.content,
          env: environment.variables,
          cwd,
          context: 'assignment',
          shellOptions: environment.shellOptions,
          environment,
        })}\n`;
        break;
      case 'heredoc':
        switch (redirection.contentExpansion) {
        case 'variables':
          content = await this.expandPartVariables({
            text: redirection.content,
            env: environment.variables,
            environment,
            escapeMode: 'here-document',
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
      // Heredoc input is already materialized. A bounded pipe cannot be
      // synchronously prefilled beyond its capacity without a concurrent
      // reader, and would deadlock on sufficiently large heredocs.
      const bytes = encodeShellTextToBytes({ text: content });
      return createReadHandleFromStream({
        source: new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(bytes);
            controller.close();
          },
        }),
      });
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
      const substitution = await this.startProcessSubstitution({
        node: redirection.target,
        environment,
        stdio: {
          stdin: fdTable.get(0) ?? closedFileDescriptor,
          stdout: fdTable.get(1) ?? closedFileDescriptor,
          stderr: fdTable.get(2) ?? closedFileDescriptor,
        },
      });
      processSubstitutions.push(substitution);
      return this.createPrimaryFileHandleReference({ handle: substitution.redirectedEnd });
    }

    const rawTarget = redirection.target ? await this.expandSingleWord({
      raw: redirection.target,
      env: environment.variables,
      cwd,
      context: 'redirection',
      shellOptions: environment.shellOptions,
      environment,
    }) : undefined;

    if (rawTarget === undefined || this.getShellInterruptStatus({ environment }) !== undefined) {
      return undefined;
    }

    const fullTarget = rawTarget.startsWith('/') ? rawTarget : `${cwd}/${rawTarget}`;

    let flags: WeshOpenFlags;
    switch (redirection.type) {
    case 'read':
      flags = { access: 'read', creation: 'never', truncate: 'preserve', append: 'preserve' };
      break;
    case 'write':
      flags = { access: 'write', creation: 'if-needed', truncate: 'truncate', append: 'preserve' };
      break;
    case 'append':
      flags = { access: 'write', creation: 'if-needed', truncate: 'preserve', append: 'append' };
      break;
    case 'read_write':
      flags = { access: 'read-write', creation: 'if-needed', truncate: 'preserve', append: 'preserve' };
      break;
    default: {
      const _ex: never = redirection.type;
      throw new Error(`Unhandled redirection type: ${_ex}`);
    }
    }

    try {
      const handle = await this.kernel.open({
        path: fullTarget,
        flags,
        mode: 0o644,
        checkActive: () => {
          if (this.getShellInterruptStatus({ environment }) !== undefined) {
            throw new WeshCommandInterruptedError();
          }
        },
      });
      return this.createPrimaryFileHandleReference({ handle });
    } catch (error: unknown) {
      if (error instanceof WeshCommandInterruptedError) {
        return undefined;
      }
      throw error;
    }
  }

  private async applyRedirectionsToFdTable({
    redirections,
    environment,
    cwd,
    fdTable,
    trackOpenedHandle,
    releaseOpenedHandle,
    processSubstitutions,
  }: {
    redirections: WeshCommandNode['redirections'],
    environment: WeshExecutionEnvironment,
    cwd: string,
    fdTable: Map<number, WeshFileHandle>,
    trackOpenedHandle: ({ handle }: { handle: WeshFileHandle }) => void,
    releaseOpenedHandle: ({ handle }: { handle: WeshFileHandle }) => Promise<void>,
    processSubstitutions: WeshProcessSubstitutionTask[],
  }): Promise<void> {
    const ownedFds = new Set<number>();
    for (const redirection of redirections) {
      if (this.getShellInterruptStatus({ environment }) !== undefined) {
        return;
      }
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
        cwd,
        fdTable,
        processSubstitutions,
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
    signal,
  }: {
    source: ShellSource,
    stdin: WeshFileHandle,
    stdout: WeshFileHandle,
    stderr: WeshFileHandle,
    signal?: AbortSignal,
  }): Promise<WeshCommandResult> {
    if (this.shellPid === 0 || this.shellImage.termination !== undefined
        || this.kernel.getWaitStatus({ pid: this.shellPid }) !== undefined) {
      await this.init();
    }

    const inputSignal = signal === undefined ? new AbortController().signal : AbortSignal.any([signal]);
    let rootEnvironment: WeshExecutionEnvironment | undefined;
    let result: WeshCommandResult;
    let closeFailure: { error: unknown } | undefined;
    try {
      const { fds, ownedFds } = this.createShellFdTable({ stdin, stdout, stderr });
      const environment = this.createExecutionEnvironment({
        shellPid: this.shellPid,
        pgid: this.shellPid,
        variables: this.variables.forExecution(),
        aliases: this.aliases,
        functions: new Map(),
        fds,
        traps: this.traps,
        shellOptions: this.shellOptions,
        positionalArgs: [],
        shellImage: this.shellImage,
      });
      environment.ownedPersistentFds = ownedFds;
      rootEnvironment = environment;
      environment.foregroundSignal = inputSignal;
      this.foregroundInputs.set(inputSignal, signal);
      const shellStdin = environment.fds.get(0) ?? closedFileDescriptor;
      const shellStdout = environment.fds.get(1) ?? closedFileDescriptor;
      const shellStderr = environment.fds.get(2) ?? closedFileDescriptor;
      const resolveStdio = this.createStdioResolver({ environment, stdin: shellStdin, stdout: shellStdout, stderr: shellStderr });

      result = await this.runWithForegroundProcessGroup({
        pgid: environment.pgid,
        foregroundSignal: inputSignal,
        shell: environment,
        fn: async () => {
          const shellResult = await this.evaluateShellToCompletion({
            environment,
            resolveStdio,
            execute: () => this.executeShellInState({
              source,
              environment,
              stdin: shellStdin,
              stdout: shellStdout,
              stderr: shellStderr,
              history: 'record',
              loopDepth: 0,
              allowReturn: false,
            }),
          });
          return toWeshCommandResult({ result: shellResult });
        },
      });
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      await this.writeErrorText({ stderr, text: `wesh: ${message}\n` });
      result = { exitCode: 1 };
    } finally {
      this.foregroundInputs.delete(inputSignal);
      if (rootEnvironment !== undefined) {
        const handles = this.takeOwnedPersistentFileHandles({ environment: rootEnvironment });
        const terminated = rootEnvironment.shellImage === this.shellImage
          ? this.getShellExitStatus({ pid: rootEnvironment.shellPid })
          : undefined;
        if (terminated !== undefined) {
          handles.push(...this.retireRootShellImage({ status: terminated }));
        }
        closeFailure = terminated !== undefined || rootEnvironment.replacedProcess === true
          ? await this.closeAndReapProcess({ pid: rootEnvironment.shellPid, additionalHandles: handles })
          : await closeFileHandleReferences({ handles });
      }
    }
    if (closeFailure !== undefined && result.exitCode === 0) {
      const error = closeFailure.error;
      const message = error instanceof Error ? error.message : String(error);
      await this.writeErrorText({ stderr, text: `wesh: ${message}\n` });
      return { exitCode: 1 };
    }
    return result;
  }

  private getShellInterruptStatus({ environment }: {
    environment: WeshExecutionEnvironment,
  }): WeshWaitStatus | undefined {
    const retirement = this.getShellRetirementStatus({ environment });
    if (retirement !== undefined) {
      return retirement;
    }
    const termination = this.getShellTerminationStatus({ environment });
    if (termination !== undefined) {
      return termination;
    }
    const interrupt = this.getShellEvaluationInterrupt({ environment });
    if (interrupt !== undefined) {
      return interrupt;
    }
    if (this.activeSignalTrapEnvironments.has(environment)) {
      return undefined;
    }
    // A process substitution can still be attached to a descriptor from an earlier input.
    return this.getSignaledWaitStatus({ waitStatus: this.kernel.getWaitStatus({ pid: environment.shellPid }) });
  }

  private getShellRetirementStatus({ environment }: { environment: WeshExecutionEnvironment }): WeshWaitStatus | undefined {
    return environment.replacedProcess === true ? undefined : environment.shellImage.retirementStatus;
  }

  private getShellTerminationStatus({ environment }: { environment: WeshExecutionEnvironment }): WeshSignalStatus | undefined {
    const status = environment.shellImage.termination?.status;
    return environment.replacedProcess === true || environment.terminationTrapSignal === status ? undefined : status;
  }

  private getShellExitStatus({ pid }: { pid: number }): WeshWaitStatus | undefined {
    const status = this.kernel.getWaitStatus({ pid });
    switch (status?.kind) {
    case 'exited':
    case 'signaled':
      return status;
    case 'stopped':
    case undefined:
      return undefined;
    default: {
      const _ex: never = status;
      throw new Error(`Unhandled shell wait status: ${JSON.stringify(_ex)}`);
    }
    }
  }

  private getSignaledWaitStatus({ waitStatus }: {
    waitStatus: WeshWaitStatus | undefined,
  }): Extract<WeshWaitStatus, { kind: 'signaled' }> | undefined {
    if (waitStatus === undefined) {
      return undefined;
    }
    switch (waitStatus.kind) {
    case 'signaled':
      return waitStatus;
    case 'exited':
    case 'stopped':
      return undefined;
    default: {
      const _ex: never = waitStatus;
      throw new Error(`Unhandled shell wait status: ${JSON.stringify(_ex)}`);
    }
    }
  }

  private getForegroundInterruptResult({ environment }: {
    environment: WeshExecutionEnvironment,
  }): WeshShellExecutionResult | undefined {
    const waitStatus = this.getShellInterruptStatus({ environment });
    if (waitStatus === undefined) {
      return undefined;
    }
    const exitCode = weshWaitStatusToExitCode({ waitStatus });
    environment.variables.setSpecial({ name: '?', value: String(exitCode) });
    // Unwind compound commands and the current source while keeping the shell session.
    return { exitCode, waitStatus, controlFlow: { kind: 'exit', exitCode } };
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
    childCommand,
    exitShell,
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
    childCommand?: WeshChildCommand,
    exitShell?: true,
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
    if (exitShell && node.kind !== 'redirected') {
      const resolveStdio = this.createStdioResolver({ environment, stdin, stdout, stderr });
      const execution = { ...options, childCommand };
      let skipExitTrap: true | undefined;
      const kind = node.kind;
      switch (kind) {
      case 'subshell':
        execution.node = node.list;
        execution.childCommand = undefined;
        break;
      case 'if':
      case 'case':
      case 'for':
      case 'while':
      case 'until':
        // Bash's implicit fork for a bare control structure does not run EXIT.
        skipExitTrap = true;
        break;
      case 'command':
      case 'list':
      case 'pipeline':
      case 'assignment':
      case 'functionDefinition':
      case 'arithmeticCommand':
      case 'conditionalCommand':
        break;
      default: {
        const _ex: never = kind;
        throw new Error(`Unhandled shell completion node: ${_ex}`);
      }
      }
      return this.evaluateShellToCompletion({
        environment,
        resolveStdio,
        skipExitTrap,
        execute: () => this.executeNode(execution),
      });
    }
    const interrupted = this.getForegroundInterruptResult({ environment });
    if (interrupted !== undefined) {
      return interrupted;
    }
    let result: WeshShellExecutionResult;
    let suppressErrexitForResult = errexitSuppressed;

    switch (node.kind) {
    case 'list': {
      let lastResult: WeshShellExecutionResult = { exitCode: 0 };
      let previousOperator: ';' | '&&' | '||' | '&' = ';';
      const resolveStdio = this.createStdioResolver({ environment, stdin, stdout, stderr });

      for (const part of node.parts) {
        const interrupted = this.getForegroundInterruptResult({ environment });
        if (interrupted !== undefined) {
          return interrupted;
        }

        let shouldExecute = true;
        if (previousOperator === '&&' && lastResult.exitCode !== 0) {
          shouldExecute = false;
        }
        if (previousOperator === '||' && lastResult.exitCode === 0) {
          shouldExecute = false;
        }

        if (!shouldExecute) {
          previousOperator = part.operator;
          continue;
        }

        const partStdio = resolveStdio();
        switch (part.operator) {
        case '&': {
          const jobEnvironment = await this.spawnChildExecutionEnvironment({
            parentEnvironment: environment,
            childEnvironment: this.forkExecutionEnvironment({ environment }),
            pgid: undefined,
            foregroundSignal: undefined,
            stdio: partStdio,
            backgroundJob: true,
          });

          const stoppedBeforeJob = this.getForegroundInterruptResult({ environment });
          if (stoppedBeforeJob !== undefined) {
            await this.finishChildExecutionEnvironment({
              environment: jobEnvironment,
              result: toWeshCommandResult({ result: stoppedBeforeJob }),
              cleanupStderr: partStdio.stderr,
            });
            return stoppedBeforeJob;
          }
          // A simple background command can replace the shell fork directly.
          // The process recorded in $! then runs the command itself.
          const jobProcess = this.kernel.getProcess({ pid: jobEnvironment.shellPid });
          const childCommand = part.node.kind === 'command' && jobProcess !== undefined ? {
            process: jobProcess,
            cleanupStderr: partStdio.stderr,
            stdinPipe: undefined,
            stdoutPipe: undefined,
          } : undefined;
          const jobTask = this.runChildExecutionEnvironment({
            environment: jobEnvironment,
            execute: () => this.executeNode({
              node: part.node,
              environment: jobEnvironment,
              ...this.getShellStdio({ environment: jobEnvironment }),
              loopDepth,
              functionDepth,
              childCommand,
              exitShell: true,
            }),
          });
          environment.shellImage.children.register({ pid: jobEnvironment.shellPid, job: 'background', task: jobTask });
          environment.variables.setSpecial({ name: '!', value: jobEnvironment.shellPid.toString() });

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
              ...partStdio,
              loopDepth,
              functionDepth,
              errexitSuppressed: suppressForPart,
            });
            // The part already applied ERR and errexit to its own result.
            suppressErrexitForResult = true;
          } catch (error: unknown) {
            if (environment.execResult !== undefined) {
              return this.reportExecCleanupFailure({ environment, result: environment.execResult, error, stderr: partStdio.stderr });
            }
            const stopped = this.getForegroundInterruptResult({ environment });
            if (stopped !== undefined) {
              return stopped;
            }
            if (error instanceof WeshShellExecutionError) {
              switch (error.disposition) {
              case 'abort-unit':
              case 'abort-shell':
                throw error;
              case 'continue':
                break;
              default: {
                const _ex: never = error.disposition;
                throw new Error(`Unhandled shell error disposition: ${_ex}`);
              }
              }
            }
            const message = error instanceof Error ? error.message : String(error);
            await this.writeErrorText({
              stderr: partStdio.stderr,
              text: `wesh: ${message}\n`,
            });
            lastResult = { exitCode: error instanceof WeshShellExecutionError ? error.exitCode : 1 };
            if (this.hasPendingSignalTraps({ environment })) {
              lastResult = await this.runPendingSignalTraps({
                exitCode: lastResult.exitCode,
                environment,
                resolveStdio,
              }) ?? lastResult;
            }
            suppressErrexitForResult = suppressForPart;
          }
          if (lastResult.controlFlow !== undefined) {
            result = lastResult;
            environment.variables.setSpecial({ name: '?', value: result.exitCode.toString() });
            return result;
          }
          environment.variables.setSpecial({ name: '?', value: lastResult.exitCode.toString() });
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
      result = await this.withForegroundWait({
        environment,
        execute: () => this.executePipeline({ ...options, node: node as WeshPipelineNode }),
      });
      break;
    }

    case 'command': {
      const expanded = this.expandAliasCommandNode({ node, environment, expandedAliases: new Set() });
      switch (expanded.kind) {
      case 'conditionalCommand':
      case 'redirected':
        return this.executeNode({ ...options, node: expanded, childCommand });
      case 'command':
        break;
      default: {
        const _ex: never = expanded;
        throw new Error(`Unhandled alias expansion: ${_ex}`);
      }
      }
      try {
        result = await this.runWithForegroundProcessGroup({
          pgid: environment.pgid,
          foregroundSignal: environment.foregroundSignal,
          shell: undefined,
          fn: async () => this.executeCommandNode({
            ...options,
            node: expanded,
            loopDepth,
            functionDepth,
            childCommand,
          }),
        });
      } catch (error: unknown) {
        this.requeueInterruptedWaitSignal({ environment });
        throw error;
      }
      break;
    }

    case 'subshell': {
      result = await this.withForegroundWait({
        environment,
        execute: async () => {
          const subshellEnvironment = await this.spawnChildExecutionEnvironment({
            parentEnvironment: environment,
            childEnvironment: this.forkExecutionEnvironment({ environment }),
            pgid: undefined,
            waiting: environment.foregroundWait,
            foregroundSignal: environment.foregroundSignal,
            stdio: { stdin, stdout, stderr },
          });
          const process = this.kernel.getProcess({ pid: subshellEnvironment.shellPid });
          const stopped = this.getForegroundInterruptResult({ environment });
          if (stopped !== undefined) {
            await this.finishChildExecutionEnvironment({ environment: subshellEnvironment, result: stopped });
            return stopped;
          }
          const completed = this.runChildExecutionEnvironment({
            environment: subshellEnvironment,
            execute: () => this.executeNode({
              ...options,
              environment: subshellEnvironment,
              ...this.getShellStdio({ environment: subshellEnvironment }),
              exitShell: true,
            }),
          });
          return this.waitForForegroundProcess({ completed, environment, process });
        },
      });
      break;
    }

    case 'if': {
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
      } else if (conditionResult.exitCode === 0) {
        result = await this.executeNode({
          node: node.thenBody,
          environment,
          stdin,
          stdout,
          stderr,
          loopDepth,
          functionDepth,
        });
      } else if (node.elseBody) {
        result = await this.executeNode({
          node: node.elseBody,
          environment,
          stdin,
          stdout,
          stderr,
          loopDepth,
          functionDepth,
        });
      } else {
        result = { exitCode: 0 };
      }
      break;
    }

    case 'for': {
      const cwd = environment.shellImage.cwd;
      let lastForRes: WeshShellExecutionResult = { exitCode: 0 };
      const expandedItems: string[] = [];
      for (const item of node.items) {
        const itemFields = await this.expandWord({
          raw: item,
          env: environment.variables,
          cwd,
          context: 'argv',
          shellOptions: environment.shellOptions,
          environment,
        });
        const stopped = this.getForegroundInterruptResult({ environment });
        if (stopped !== undefined) {
          return stopped;
        }
        expandedItems.push(...itemFields);
      }

      for (const item of expandedItems) {
        const stopped = this.getForegroundInterruptResult({ environment });
        if (stopped !== undefined) {
          return stopped;
        }
        environment.variables.set({ name: node.variable, value: item });
        lastForRes = await this.executeNode({
          node: node.body,
          environment,
          stdin,
          stdout,
          stderr,
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
              environment.variables.setSpecial({ name: '?', value: result.exitCode.toString() });
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
              environment.variables.setSpecial({ name: '?', value: result.exitCode.toString() });
              return result;
            }
            result = { exitCode: lastForRes.exitCode };
            environment.variables.setSpecial({ name: '?', value: result.exitCode.toString() });
            return result;
          case 'return':
          case 'exit':
          case 'exec':
            environment.variables.setSpecial({ name: '?', value: lastForRes.exitCode.toString() });
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
          case 'exec':
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
        env: environment.variables,
        cwd: environment.shellImage.cwd,
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

    case 'arithmeticCommand': {
      try {
        const expanded = this.expandArithmeticText({ expression: node.expression, env: environment.variables, environment });
        const value = this.evaluateArithmeticExpression({
          expression: typeof expanded === 'string' ? expanded : await expanded,
          evaluate: this.arithmeticEvaluator ?? await this.loadArithmeticEvaluator({ environment }),
          env: environment.variables,
          executionOptions: environment.executionOptions,
          context: 'command',
        });
        result = { exitCode: value === 0n ? 1 : 0 };
      } catch (error: unknown) {
        if (!(error instanceof WeshArithmeticError)) {
          throw error;
        }
        await this.writeErrorText({ stderr, text: `wesh: ${error.message}\n` });
        result = { exitCode: 1 };
      }
      break;
    }

    case 'conditionalCommand':
      result = await this.executeConditionalCommand({ expression: node.expression, environment, stdio: { stdin, stdout, stderr } });
      break;

    case 'redirected': {
      const redirectedFds = new Map(environment.fds);
      const openHandles: WeshFileHandle[] = [];
      const processSubstitutions: WeshProcessSubstitutionTask[] = [];
      let restoreFds: WeshRestoreFileDescriptors | undefined;
      let firstCloseFailure: { error: unknown } | undefined;
      try {
        await this.applyRedirectionsToFdTable({
          redirections: node.redirections,
          environment,
          cwd: environment.shellImage.cwd,
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
          processSubstitutions,
        });
        const redirectedStdin = redirectedFds.get(0) ?? closedFileDescriptor;
        const redirectedStdout = redirectedFds.get(1) ?? closedFileDescriptor;
        const redirectedStderr = redirectedFds.get(2) ?? closedFileDescriptor;

        restoreFds = this.scopeShellFileDescriptors({
          environment,
          fdTable: redirectedFds,
          fds: node.redirections.map(({ fd }) => fd),
        });

        if (childCommand !== undefined) {
          await this.closeReplacedPipeEnds({ childCommand, stdin: redirectedStdin, stdout: redirectedStdout });
        }

        result = await this.executeNode({
          node: node.node,
          environment,
          stdin: redirectedStdin,
          stdout: redirectedStdout,
          stderr: redirectedStderr,
          loopDepth,
          functionDepth,
          errexitSuppressed,
          stdinReferenceOwnership,
          childCommand,
          exitShell,
        });
      } finally {
        openHandles.push(...(restoreFds?.({ fds: undefined }) ?? []));
        firstCloseFailure = await closeFileHandleReferences({ handles: openHandles });
        if (processSubstitutions.length !== 0) {
          const completed = waitForProcessSubstitutions({ tasks: processSubstitutions }).then(() => ({ exitCode: 0 }));
          await this.waitForForegroundProcess({ completed, environment, process: undefined });
        }
      }
      if (firstCloseFailure !== undefined) {
        throw firstCloseFailure.error;
      }
      if (exitShell) {
        return result;
      }
      // The redirected command already applied ERR and errexit with its descriptors.
      suppressErrexitForResult = true;
      break;
    }

    case 'assignment': {
      const cwd = environment.shellImage.cwd;
      const commandSubstitutionSequenceBefore = environment.commandSubstitutionSequence;
      const assignment: NonNullable<WeshExecutionEnvironment['assignment']> = {};
      environment.assignment = assignment;
      try {
        for (const assign of node.assignments) {
          const value = await this.expandSingleWord({
            raw: assign.value,
            env: environment.variables,
            cwd,
            context: 'assignment',
            shellOptions: environment.shellOptions,
            environment,
          });
          const stopped = this.getForegroundInterruptResult({ environment });
          if (stopped !== undefined) {
            return stopped;
          }
          try {
            environment.variables.set({ name: assign.key, value });
          } catch (error: unknown) {
            if (error instanceof WeshReadonlyVariableError) {
              throw new WeshShellExecutionError({
                message: error.message,
                exitCode: 1,
                disposition: environment.executionOptions.errexit ? 'abort-shell' : 'abort-unit',
              });
            }
            throw error;
          }
        }
      } finally {
        delete environment.assignment;
        if (assignment.interrupt !== undefined) {
          this.interruptFromCommandSubstitution({ environment, waitStatus: assignment.interrupt });
        }
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

    if (environment.execResult !== undefined) {
      this.requeueInterruptedWaitSignal({ environment });
      return environment.execResult;
    }
    const stopped = this.getForegroundInterruptResult({ environment });
    if (stopped !== undefined) {
      this.requeueInterruptedWaitSignal({ environment });
      if (this.getShellTerminationStatus({ environment }) !== undefined && environment.shellImage.termination?.unwindOwner === undefined) {
        return this.finishShellTermination({ environment, resolveStdio: () => this.getShellStdio({ environment }) });
      }
      return stopped;
    }

    const waitSignal = environment.interruptedWaitSignal;
    if (waitSignal !== undefined) {
      delete environment.interruptedWaitSignal;
      const trapResult = await this.runClaimedSignalTrap({
        signal: waitSignal,
        exitCode: 128 + waitSignal,
        environment,
        ...this.getShellStdio({ environment }),
      });
      if (trapResult !== undefined) {
        return trapResult;
      }
    }
    if (this.hasPendingSignalTraps({ environment })) {
      const trapResult = await this.runPendingSignalTraps({ environment, exitCode: result.exitCode, resolveStdio: undefined });
      if (trapResult !== undefined) {
        return trapResult;
      }
    }

    if (
      result.controlFlow === undefined
      && !suppressErrexitForResult
      && result.exitCode !== 0
    ) {
      const trapResult = await this.runErrTrapIfNeeded({
        result,
        environment,
        stdin,
        stdout,
        stderr,
      });
      if (environment.execResult !== undefined) {
        return environment.execResult;
      }
      if (trapResult !== undefined && isExecCompletion({ result: trapResult })) {
        return trapResult;
      }
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
    environment.variables.setSpecial({ name: '?', value: result.exitCode.toString() });
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
    if (commands.length === 0) {
      return { exitCode: 0 };
    }

    // Take all stage snapshots before pipe creation or spawning can yield.
    const childEnvironments = commands.map(() => this.forkExecutionEnvironment({ environment }));
    const { pipefail } = environment.executionOptions;
    const pipes: Array<{ read: WeshFileHandle, write: WeshFileHandle }> = [];
    const stages: Array<{ node: WeshASTNode, environment: WeshExecutionEnvironment, stage: WeshChildCommand }> = [];
    // A background pipeline remains in its job group. Other pipelines get a
    // separate group, including pipelines executed by a foreground Stop trap.
    let pipelinePgid = this.kernel.isBackgroundProcessGroup({ pgid: environment.pgid }) ? environment.pgid : undefined;

    try {
      let closeFailure: { error: unknown } | undefined;
      try {
        for (let index = 1; index < commands.length; index++) {
          if (this.getShellInterruptStatus({ environment }) !== undefined) {
            break;
          }
          pipes.push(await this.kernel.pipe());
        }
        for (const [index, stageNode] of commands.entries()) {
          const interrupted = this.getForegroundInterruptResult({ environment });
          if (interrupted !== undefined) {
            break;
          }
          const input = pipes[index - 1];
          const output = pipes[index];
          const pipelineEnvironment = await this.spawnChildExecutionEnvironment({
            parentEnvironment: environment,
            childEnvironment: childEnvironments[index]!,
            pgid: pipelinePgid,
            waiting: environment.foregroundWait,
            foregroundSignal: environment.foregroundSignal,
            stdio: { stdin: input?.read ?? stdin, stdout: output?.write ?? stdout, stderr },
          });
          pipelinePgid = pipelineEnvironment.pgid;
          const process = this.kernel.getProcess({ pid: pipelineEnvironment.shellPid });
          if (process === undefined) {
            throw new Error(`Missing pipeline process: ${pipelineEnvironment.shellPid}`);
          }
          stages.push({
            node: stageNode,
            environment: pipelineEnvironment,
            stage: {
              process,
              cleanupStderr: stderr,
              stdinPipe: input === undefined ? undefined : process.fds.get(0),
              stdoutPipe: output === undefined ? undefined : process.fds.get(1),
            },
          });
        }
      } finally {
        closeFailure = await closeFileHandleReferences({ handles: pipes.flatMap(({ read, write }) => [read, write]) });
      }
      if (closeFailure !== undefined) {
        throw closeFailure.error;
      }
    } catch (error: unknown) {
      await Promise.allSettled(stages.map(({ environment }) => this.finishChildExecutionEnvironment({
        environment,
        result: undefined,
        cleanupStderr: stderr,
      })));
      throw error;
    }

    const stopped = this.getForegroundInterruptResult({ environment });
    if (stopped !== undefined) {
      await Promise.all(stages.map(({ environment }) => this.finishChildExecutionEnvironment({
        environment,
        result: stopped,
        cleanupStderr: stderr,
      })));
      return toWeshCommandResult({ result: stopped });
    }

    const results = await this.runWithForegroundProcessGroup({
      pgid: pipelinePgid ?? environment.pgid,
      foregroundSignal: environment.foregroundSignal,
      shell: undefined,
      fn: () => {
        const promises = stages.map(({ node, environment, stage }) => this.runChildExecutionEnvironment({
          environment,
          cleanupStderr: stderr,
          execute: () => this.executeNode({
            node,
            environment,
            stdin: environment.fds.get(0) ?? closedFileDescriptor,
            stdout: environment.fds.get(1) ?? closedFileDescriptor,
            stderr: environment.fds.get(2) ?? closedFileDescriptor,
            loopDepth,
            functionDepth,
            stdinReferenceOwnership: stage.stdinPipe === undefined ? stdinReferenceOwnership : 'command-local',
            childCommand: stage,
            exitShell: true,
          }),
        }).catch(async (error: unknown): Promise<WeshCommandResult> => {
          await this.writeProcessCleanupError({ stderr, error });
          const exitCode = error instanceof WeshShellExecutionError ? error.exitCode : 1;
          return { exitCode, waitStatus: { kind: 'exited', exitCode } };
        }));
        return Promise.all(promises.map((completed, index) => this.waitForForegroundProcess({
          completed,
          environment,
          process: stages[index]!.stage.process,
        })));
      },
    });
    if (pipefail) {
      for (let index = results.length - 1; index >= 0; index -= 1) {
        const result = results[index];
        if (result !== undefined && result.exitCode !== 0) {
          return result;
        }
      }
    }
    return results[results.length - 1]!;
  }

  private async closeReplacedPipeEnds({ childCommand, stdin, stdout }: {
    childCommand: WeshChildCommand,
    stdin: WeshFileHandle,
    stdout: WeshFileHandle,
  }): Promise<void> {
    if (childCommand.stdinPipe !== undefined && childCommand.stdinPipe !== stdin) {
      const previous = childCommand.stdinPipe;
      childCommand.stdinPipe = undefined;
      await previous.close();
    }
    if (childCommand.stdoutPipe !== undefined && childCommand.stdoutPipe !== stdout) {
      const previous = childCommand.stdoutPipe;
      childCommand.stdoutPipe = undefined;
      await previous.close();
    }
  }

  private async executeCommandNode({
    node,
    environment,
    stdin,
    stdout,
    stderr,
    directInvocation,
    loopDepth = 0,
    functionDepth = 0,
    stdinReferenceOwnership,
    childCommand,
  }: {
    node: WeshCommandNode,
    environment: WeshExecutionEnvironment,
    stdin: WeshFileHandle,
    stdout: WeshFileHandle,
    stderr: WeshFileHandle,
    directInvocation?: {
      command: string,
      args: string[],
      cwd: string,
      argumentEntryRefs: readonly (WeshEntryRef | undefined)[] | undefined,
      functionLookup: 'allow' | 'bypass',
      searchPathOverride: string | undefined,
      forwardedRedirections: WeshForwardedRedirections | undefined,
      hasCommandAssignments: boolean,
    },
    loopDepth?: number,
    functionDepth?: number,
    stdinReferenceOwnership?: WeshStdinReferenceOwnership,
    childCommand?: WeshChildCommand,
  }): Promise<WeshShellExecutionResult> {
    const interrupted = this.getForegroundInterruptResult({ environment });
    if (interrupted !== undefined) {
      return interrupted;
    }
    // A different input can change the shell directory while this command awaits I/O.
    const cwd = directInvocation?.cwd ?? environment.shellImage.cwd;
    const expandedArgs: string[] = directInvocation === undefined
      ? []
      : [...directInvocation.args];
    const procSubPaths: Array<{ path: string, redirectedEnd: WeshPipeEnd }> = [];
    const procSubTasks: WeshProcessSubstitutionTask[] = [];
    const openHandles: WeshFileHandle[] = [];
    const cmdFds = new Map(environment.fds);

    const finishProcessSubstitutions = async (): Promise<WeshShellExecutionResult> => {
      for (const { redirectedEnd } of procSubPaths) {
        await redirectedEnd.close();
      }
      await waitForProcessSubstitutions({ tasks: procSubTasks });
      for (const { path } of procSubPaths) {
        this.vfs.unregisterSpecialFile({ path });
      }
      return { exitCode: 0 };
    };
    const cleanupCommandResources = async (): Promise<void> => {
      const closeFailure = await closeFileHandleReferences({ handles: openHandles });
      if (procSubTasks.length !== 0) {
        await this.waitForForegroundProcess({ completed: finishProcessSubstitutions(), environment, process: undefined });
      }
      if (closeFailure !== undefined) {
        throw closeFailure.error;
      }
    };

    let cmdName: string;
    try {
      if (directInvocation === undefined) {
        for (const arg of node.args) {
          if (typeof arg === 'string') {
            const fields = await this.expandWord({
              raw: arg,
              env: environment.variables,
              cwd,
              context: 'argv',
              shellOptions: environment.shellOptions,
              environment,
            });
            expandedArgs.push(...fields);
          } else if (arg.kind === 'processSubstitution') {
            const { path, task, redirectedEnd } = await this.openProcessSubstitutionPath({ node: arg, environment, stdio: { stdin, stdout, stderr } });
            procSubTasks.push({ task, redirectedEnd: undefined });
            procSubPaths.push({ path, redirectedEnd });

            expandedArgs.push(path);
          }
        }
      }

      cmdName = directInvocation?.command ?? await this.expandSingleWord({
        raw: node.name,
        env: environment.variables,
        cwd,
        context: 'assignment',
        shellOptions: environment.shellOptions,
        environment,
      });
    } catch (error: unknown) {
      await cleanupCommandResources();
      throw error;
    }

    let temporaryShellAssignments: Map<string, string>;
    try {
      temporaryShellAssignments = node.assignments.length === 0
        ? new Map()
        : await environment.variables.expandCommandAssignments({
          assignments: node.assignments,
          expand: ({ raw, variables }) => this.expandSingleWord({
            raw,
            env: variables,
            cwd,
            context: 'assignment',
            shellOptions: environment.shellOptions,
            environment,
          }),
          isInterrupted: () => this.getShellInterruptStatus({ environment }) !== undefined,
          reportReadonlyAssignment: ({ name }) => {
            const message = `${name}: readonly variable`;
            if (environment.executionOptions.errexit) {
              throw new WeshShellExecutionError({ message, exitCode: 1, disposition: 'abort-shell' });
            }
            return this.writeErrorText({ stderr, text: `wesh: ${message}\n` });
          },
        });
    } catch (error: unknown) {
      await cleanupCommandResources();
      throw error;
    }
    const stoppedAfterAssignments = this.getForegroundInterruptResult({ environment });
    if (stoppedAfterAssignments !== undefined) {
      await cleanupCommandResources();
      return stoppedAfterAssignments;
    }

    const hasCommandAssignments = temporaryShellAssignments.size > 0 || directInvocation?.hasCommandAssignments === true;
    const executeWithTemporaryShellAssignments = <T>({ execute }: {
      execute: () => Promise<T>,
    }): Promise<T> => this.withCommandAssignments({
        variables: environment.variables,
        assignments: temporaryShellAssignments,
        execute,
      });

    for (const [fd, handle] of [[0, stdin], [1, stdout], [2, stderr]] as const) {
      if (handle === closedFileDescriptor) {
        cmdFds.delete(fd);
      } else {
        cmdFds.set(fd, handle);
      }
    }
    try {
      await this.applyRedirectionsToFdTable({
        redirections: node.redirections,
        environment,
        cwd,
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
        processSubstitutions: procSubTasks,
      });
    } catch (error: unknown) {
      await cleanupCommandResources();
      throw error;
    }

    const stoppedAfterRedirection = this.getForegroundInterruptResult({ environment });
    if (stoppedAfterRedirection !== undefined) {
      await cleanupCommandResources();
      return stoppedAfterRedirection;
    }

    const cmdStdin = cmdFds.get(0) ?? closedFileDescriptor;
    const cmdStdout = cmdFds.get(1) ?? closedFileDescriptor;
    const cmdStderr = cmdFds.get(2) ?? closedFileDescriptor;

    const searchPath = directInvocation?.searchPathOverride
      ?? temporaryShellAssignments.get('PATH')
      ?? environment.variables.get({ name: 'PATH' })
      ?? '';
    const resolvedCommand = this.resolveRegisteredCommand({ name: cmdName, cwd });

    let controlFlowResult: WeshShellExecutionResult | undefined;
    try {
      if (childCommand !== undefined && node.redirections.length !== 0) {
        await this.closeReplacedPipeEnds({ childCommand, stdin: cmdStdin, stdout: cmdStdout });
        controlFlowResult = this.getForegroundInterruptResult({ environment });
      }
      controlFlowResult ??= await executeWithTemporaryShellAssignments({
        execute: () => this.tryExecuteShellBuiltin({
          commandName: cmdName,
          definition: resolvedCommand?.definition,
          args: expandedArgs,
          cwd,
          stdin: cmdStdin,
          stdout: cmdStdout,
          stderr: cmdStderr,
          loopDepth,
          functionDepth,
          hasCommandAssignments,
          getEnvironment: () => environment,
          fdTable: cmdFds,
          redirections: node.redirections,
          forwardedRedirections: directInvocation?.forwardedRedirections,
        }),
      });
    } catch (error: unknown) {
      await cleanupCommandResources();
      throw error;
    }
    controlFlowResult ??= this.getForegroundInterruptResult({ environment });
    if (controlFlowResult !== undefined) {
      await cleanupCommandResources();
      return controlFlowResult;
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
      const restoreFds = node.redirections.length === 0 ? undefined : this.scopeShellFileDescriptors({
        environment,
        fdTable: cmdFds,
        fds: node.redirections.map(({ fd }) => fd),
      });
      try {
        return await this.executeShellFunction({
          body: shellFunctionBody,
          args: expandedArgs,
          assignments: temporaryShellAssignments,
          environment,
          stdin: cmdStdin,
          stdout: cmdStdout,
          stderr: cmdStderr,
          loopDepth,
          functionDepth,
        });
      } finally {
        openHandles.push(...(restoreFds?.({ fds: undefined }) ?? []));
        await cleanupCommandResources();
      }
    }

    let resourcesTransferred = false;
    try {
      const argumentEntryRefs = directInvocation?.argumentEntryRefs;
      const program: WeshProgram = resolvedCommand === undefined
        ? await this.resolveProgram({ command: cmdName, args: expandedArgs, argumentEntryRefs, cwd, searchPath })
        : {
          definition: resolvedCommand.definition,
          name: cmdName,
          image: resolvedCommand.invocationPath ?? cmdName,
          args: [cmdName, ...expandedArgs],
          argumentEntryRefs,
        };
      const stoppedAfterProbe = this.getForegroundInterruptResult({ environment });
      if (stoppedAfterProbe !== undefined) {
        return stoppedAfterProbe;
      }
      const stdinToClose = (cmdStdin !== stdin || stdinReferenceOwnership === 'command-local') && this.isFileHandleReferenceCloneable({ handle: cmdStdin })
        ? cmdStdin
        : undefined;
      const definition = program.definition;
      if (resolvedCommand !== undefined && definition !== undefined && !('load' in definition)) {
        let loaded: WeshLoadedCommand;
        try {
          loaded = await this.loadCommandDefinition({
            definition,
            interruption: {
              environment,
              process: this.kernel.getProcess({ pid: environment.shellPid }),
              isInterrupted: () => this.getShellInterruptStatus({ environment }) !== undefined,
            },
          });
        } catch (error: unknown) {
          const stopped = this.getForegroundInterruptResult({ environment });
          if (stopped !== undefined) {
            return stopped;
          }
          throw error;
        }
        const interrupted = this.getForegroundInterruptResult({ environment });
        if (interrupted !== undefined) {
          return interrupted;
        }
        const proc = this.kernel.getProcess({ pid: environment.shellPid });
        if (proc === undefined || !('executeShellBuiltin' in loaded)) {
          throw new Error(`Cannot run ${cmdName} in the current shell process`);
        }
        return await this.executeShellBuiltin({
          execute: loaded.executeShellBuiltin,
          commandName: cmdName,
          proc,
          args: expandedArgs,
          cwd,
          environment,
          fdTable: cmdFds,
          redirections: node.redirections,
          forwardedRedirections: directInvocation?.forwardedRedirections,
          shellAssignments: temporaryShellAssignments,
          hasCommandAssignments,
          loopDepth,
          functionDepth,
        });
      }
      if (childCommand !== undefined) {
        return await this.executeChildCommand({
          process: childCommand.process,
          program,
          environment,
          cwd,
          fdTable: cmdFds,
          cleanupStderr: childCommand.cleanupStderr,
          assignments: temporaryShellAssignments,
          stdinToClose,
        });
      }
      const result = await this.withForegroundWait({
        environment,
        execute: async () => {
          const waiting = environment.foregroundWait;
          const { process, completed } = await this.startCommandProcess({
            processOptions: {
              image: program.image,
              args: program.args,
              env: environment.variables.exportedEntries({ assignments: temporaryShellAssignments }),
              cwd,
              fds: cmdFds,
              ppid: environment.shellPid,
              pgid: environment.pgid,
              signalDispositions: this.buildProcessSignalDispositions({ environment }),
              foregroundSignal: environment.foregroundSignal,
              onSpawn: waiting === undefined ? undefined : ({ process }) => {
                waiting.children.push(process);
              },
            },
            evaluation: {
              definition: program.definition,
              argumentEntryRefs: program.argumentEntryRefs,
              stdinToClose,
            },
            redirectionHandles: openHandles,
            finishSubstitutions: procSubTasks.length === 0 ? undefined : finishProcessSubstitutions,
            checkInterrupt: () => this.getForegroundInterruptResult({ environment }),
          });
          resourcesTransferred = true;
          return this.waitForForegroundProcess({ completed, environment, process });
        },
      });
      return resolvedCommand === undefined ? toWeshCommandResult({ result }) : result;
    } finally {
      if (!resourcesTransferred) {
        await cleanupCommandResources();
      }
    }
  }

  private async withCommandAssignments<T>({ variables, assignments, execute }: {
    variables: WeshShellVariables,
    assignments: ReadonlyMap<string, string> | undefined,
    execute: () => Promise<T>,
  }): Promise<T> {
    if (assignments === undefined || assignments.size === 0) {
      return execute();
    }
    variables.enterCommand({ assignments });
    try {
      return await execute();
    } finally {
      variables.leaveScope();
    }
  }

  private async executeCommand({ command, args, argumentEntryRefs, stdin, stdout, cwd: nextCwd, env: nextEnv, parent }: {
    command: string,
    args: string[],
    argumentEntryRefs: readonly (WeshEntryRef | undefined)[] | undefined,
    stdin: WeshFileHandle | undefined,
    stdout: WeshFileHandle | undefined,
    cwd: string | undefined,
    env: ReadonlyMap<string, string> | undefined,
    parent: WeshProcess,
  }): Promise<WeshCommandResult> {
    const stopped = this.getCommandProcessCompletion({ proc: parent });
    if (stopped !== undefined) {
      return stopped;
    }

    const cwd = nextCwd ?? parent.cwd;
    const env = nextEnv === undefined ? parent.env : new Map(nextEnv);
    const program = await this.resolveProgram({
      command,
      args,
      argumentEntryRefs,
      cwd,
      searchPath: env.get('PATH'),
    });
    const stoppedWhileResolving = this.getCommandProcessCompletion({ proc: parent });
    if (stoppedWhileResolving !== undefined) {
      return stoppedWhileResolving;
    }

    const fds = new Map(parent.fds);
    if (stdin !== undefined) {
      fds.set(0, stdin);
    }
    if (stdout !== undefined) {
      fds.set(1, stdout);
    }
    const { completed } = await this.startCommandProcess({
      processOptions: {
        image: program.image,
        args: program.args,
        env,
        cwd,
        fds,
        ppid: parent.pid,
        pgid: parent.pgid,
        signalDispositions: parent.signalDispositions,
        foregroundSignal: parent.foregroundSignal,
      },
      evaluation: {
        definition: program.definition,
        argumentEntryRefs: program.argumentEntryRefs,
        stdinToClose: undefined,
      },
      redirectionHandles: [],
      finishSubstitutions: undefined,
      checkInterrupt: undefined,
    });
    return toWeshCommandResult({ result: await completed });
  }

  private async resolveProgram({ command, args, argumentEntryRefs, cwd, searchPath, argv0 }: {
    command: string,
    args: string[],
    argumentEntryRefs: readonly (WeshEntryRef | undefined)[] | undefined,
    cwd: string,
    searchPath: string | undefined,
    argv0?: string,
  }): Promise<WeshProgram> {
    let name = command;
    let operands = args;
    let entryRefs = argumentEntryRefs;
    // A script can name another script as its interpreter. Bound this chain like execve does.
    for (let depth = 0; depth <= 4; depth++) {
      const resolved = this.resolveRegisteredCommand({ name, cwd });
      if (resolved !== undefined || this.isWeshBuiltinName({ name })) {
        return {
          definition: resolved?.definition,
          name,
          image: resolved?.invocationPath ?? name,
          args: [(depth === 0 ? argv0 : undefined) ?? name, ...operands],
          argumentEntryRefs: entryRefs,
        };
      }
      const file = await this.resolveProgramFile({ name, cwd, searchPath });
      if (file === undefined) {
        throw new WeshShellExecutionError({ message: `Command not found: ${name}`, exitCode: 127, disposition: 'continue' });
      }
      switch (file.kind) {
      case 'shell-entrypoint':
        return {
          definition: this.commands.get(file.entrypoint),
          name,
          image: WESH_SHELL_SPECIAL_FILES[file.entrypoint],
          args: [(depth === 0 ? argv0 : undefined) ?? name, ...operands],
          argumentEntryRefs: entryRefs,
        };
      case 'script':
        name = file.interpreter;
        operands = [...file.interpreterArgs, file.scriptPath, ...operands];
        if (entryRefs !== undefined) {
          entryRefs = [...new Array<WeshEntryRef | undefined>(file.interpreterArgs.length + 1).fill(undefined), ...entryRefs];
        }
        break;
      default: {
        const _ex: never = file;
        throw new Error(`Unhandled program file: ${String(_ex)}`);
      }
      }
    }
    throw new WeshShellExecutionError({ message: `${command}: too many levels of script interpreters`, exitCode: 126, disposition: 'continue' });
  }

  private async persistFileDescriptors({ environment, fdTable, redirections, forwardedRedirections }: {
    environment: WeshExecutionEnvironment,
    fdTable: ReadonlyMap<number, WeshFileHandle>,
    redirections: WeshCommandNode['redirections'],
    forwardedRedirections: WeshForwardedRedirections | undefined,
  }): Promise<void> {
    // These descriptors are already bound in fdTable. Restore the wrapper's shell
    // overrides before persisting the references selected by the exec command.
    const replacedHandles = forwardedRedirections?.restore?.() ?? [];
    const persistentForwardedFds = forwardedRedirections?.restore === undefined ? [] : forwardedRedirections.fds;
    const fds = new Set([...persistentForwardedFds, ...redirections.map(({ fd }) => fd)]);
    const processFds = environment.shellPid === this.shellPid ? undefined : this.kernel.getProcess({ pid: environment.shellPid })?.fds;
    for (const fd of fds) {
      const handle = fdTable.get(fd);
      const scoped = environment.scopedRedirectionFds.has(fd);
      const previousOwned = environment.ownedPersistentFds.has(fd)
        ? environment.fds.get(fd)
        : scoped ? undefined : processFds?.get(fd);
      if (previousOwned !== undefined) {
        replacedHandles.push(previousOwned);
      }
      if (environment.shellPid === this.shellPid && !scoped) {
        const previousPersistent = this.shellFds.get(fd);
        if (previousPersistent !== undefined) {
          replacedHandles.push(previousPersistent);
        }
        if (handle === undefined && fd > 2) {
          this.shellFds.delete(fd);
        } else {
          this.shellFds.set(fd, handle === undefined ? undefined : this.cloneFileHandleReference({ handle }));
        }
      }
      if (handle === undefined) {
        environment.fds.delete(fd);
        environment.ownedPersistentFds.delete(fd);
        if (!scoped) {
          processFds?.delete(fd);
        }
      } else {
        const reference = this.cloneFileHandleReference({ handle });
        environment.fds.set(fd, reference);
        if (!scoped && processFds !== undefined) {
          processFds.set(fd, reference);
          environment.ownedPersistentFds.delete(fd);
        } else {
          environment.ownedPersistentFds.add(fd);
        }
      }
    }
    const closeFailure = await closeFileHandleReferences({ handles: replacedHandles });
    if (closeFailure !== undefined) {
      throw closeFailure.error;
    }
  }

  private retireRootShellImage({ status }: { status: WeshWaitStatus }): WeshFileHandle[] {
    const oldImage = this.shellImage;
    const handles = [...this.shellFds.values()].filter(handle => handle !== undefined);
    this.shellFds.clear();
    // A pending evaluation may still be unwinding against the old state.
    this.variables = this.variables.clone({ mapStrategy: 'snapshot_copy' });
    this.aliases = new Map(this.aliases);
    this.shellOptions = new Map(this.shellOptions);
    this.traps = new Map();
    this.shellPid = 0;
    this.shellImage = new WeshShellImage({ cwd: oldImage.cwd, lastPid: undefined });
    oldImage.retire({ status });
    return handles;
  }

  private replaceProcessImage({ process, program, environment, cwd, fdTable, env }: {
    process: WeshProcess,
    program: WeshProgram,
    environment: WeshExecutionEnvironment,
    cwd: string,
    fdTable: ReadonlyMap<number, WeshFileHandle>,
    env: Iterable<readonly [string, string]> | undefined,
  }): WeshFileHandle[] {
    const oldHandles = [...process.fds.values(), ...(process.ownedHandles ?? [])];
    const files = this.kernel.bindFdTable({ pid: process.pid, fdTable });
    this.kernel.setSignalHandler({ process, handle: undefined });
    for (const scope of this.foregroundProcessGroupScopes) {
      if (scope.shell?.shellPid === process.pid) {
        scope.shell = undefined;
      }
    }
    process.image = program.image;
    process.args = program.args;
    process.env = new Map(env);
    process.cwd = cwd;
    process.fds = files;
    process.ownedHandles = new Set();
    process.signalDispositions = this.buildProcessSignalDispositions({ environment });
    process.foregroundSignal = environment.foregroundSignal;
    return oldHandles;
  }

  private async executeChildCommand({ process, program, environment, cwd, fdTable, cleanupStderr, assignments, stdinToClose }: {
    process: WeshProcess,
    program: WeshProgram,
    environment: WeshExecutionEnvironment,
    cwd: string,
    fdTable: ReadonlyMap<number, WeshFileHandle>,
    cleanupStderr: WeshFileHandle,
    assignments: ReadonlyMap<string, string>,
    stdinToClose: WeshFileHandle | undefined,
  }): Promise<WeshShellExecutionResult> {
    const oldHandles = this.replaceProcessImage({
      process,
      program,
      environment,
      cwd,
      fdTable,
      env: environment.variables.exportedEntries({ assignments }),
    });
    let result: WeshShellExecutionResult;
    try {
      const closeFailure = await closeFileHandleReferences({ handles: oldHandles });
      if (closeFailure !== undefined) {
        throw closeFailure.error;
      }
      result = await this.executeProgram({
        proc: process,
        commandName: program.name,
        diagnosticStderr: process.fds.get(2) ?? closedFileDescriptor,
        evaluation: {
          definition: program.definition,
          argumentEntryRefs: program.argumentEntryRefs,
          stdinToClose,
        },
      });
    } finally {
      // Commands may have started process substitutions that need to see EOF before cleanup can join them.
      try {
        await this.kernel.closeProcessResources({ pid: process.pid });
      } catch (error: unknown) {
        this.recordProcessCloseFailure({ process });
        await this.writeProcessCleanupError({ stderr: cleanupStderr, error });
      }
    }
    return {
      exitCode: process.exitCode ?? result.exitCode,
      waitStatus: process.waitStatus ?? result.waitStatus,
      controlFlow: { kind: 'exec' },
    };
  }

  private async execProgram({ command, args, argv0, login, clearEnvironment, environment, cwd, fdTable, redirections, forwardedRedirections, writeDiagnostic }: {
    command: string,
    args: string[],
    argv0: string | undefined,
    login: boolean,
    clearEnvironment: boolean,
    environment: WeshExecutionEnvironment,
    cwd: string,
    fdTable: ReadonlyMap<number, WeshFileHandle>,
    redirections: WeshCommandNode['redirections'],
    forwardedRedirections: WeshForwardedRedirections | undefined,
    writeDiagnostic({ text }: { text: string }): Promise<void>,
  }): Promise<WeshShellExecutionResult> {
    let stderr = fdTable.get(2) ?? closedFileDescriptor;
    let program: WeshProgram;
    try {
      program = await this.resolveProgram({
        command,
        args,
        argv0: login ? `-${argv0 ?? command}` : argv0,
        argumentEntryRefs: undefined,
        cwd,
        searchPath: environment.variables.get({ name: 'PATH' }) ?? '',
      });
      if (program.definition !== undefined) {
        try {
          await this.loadCommandDefinition({
            definition: program.definition,
            interruption: {
              environment,
              process: this.kernel.getProcess({ pid: environment.shellPid }),
              isInterrupted: () => this.getShellInterruptStatus({ environment }) !== undefined,
            },
          });
        } catch (error: unknown) {
          const message = error instanceof Error ? error.message : String(error);
          throw new WeshShellExecutionError({ message: `${command}: ${message}`, exitCode: 126, disposition: 'continue' });
        }
      }
    } catch (error: unknown) {
      const stopped = this.getForegroundInterruptResult({ environment });
      if (stopped !== undefined) {
        return stopped;
      }
      if (error instanceof WeshShellExecutionError) {
        await writeDiagnostic({ text: `exec: ${error.message}\n` });
        const stoppedAfterDiagnostic = this.getForegroundInterruptResult({ environment });
        if (stoppedAfterDiagnostic !== undefined) {
          return stoppedAfterDiagnostic;
        }
        const restoreFds = this.scopeShellFileDescriptors({
          environment,
          fdTable,
          fds: [...environment.fds.keys(), ...fdTable.keys()],
        });
        let result: WeshShellExecutionResult;
        try {
          result = await this.runExitTrapIfNeeded({
            result: { exitCode: error.exitCode },
            environment,
            stdin: fdTable.get(0) ?? closedFileDescriptor,
            stdout: fdTable.get(1) ?? closedFileDescriptor,
            stderr,
          });
        } finally {
          const closeFailure = await closeFileHandleReferences({ handles: restoreFds({ fds: undefined }) });
          if (closeFailure !== undefined) {
            const error = closeFailure.error;
            const message = error instanceof Error ? error.message : String(error);
            await this.writeErrorText({ stderr, text: `exec: ${message}\n` });
          }
        }
        return { ...result, controlFlow: { kind: 'exec' } };
      }
      throw error;
    }
    const stopped = this.getForegroundInterruptResult({ environment });
    if (stopped !== undefined) {
      return stopped;
    }
    let programFds = fdTable;
    if (this.hasPendingSignalTraps({ environment })) {
      const shellFdsBeforeTrap = new Map(environment.fds);
      const exitCode = Number(environment.variables.get({ name: '?' }) ?? 0);
      const trapped = await this.runPendingSignalTraps({ exitCode, environment, resolveStdio: undefined });
      const trapResult = trapped ?? this.getForegroundInterruptResult({ environment });
      if (trapResult !== undefined) {
        return trapResult;
      }
      const updated = new Map(environment.fds);
      const explicitFds = new Set([...(forwardedRedirections?.fds ?? []), ...redirections.map(({ fd }) => fd)]);
      // A trap can change inherited FDs while this exec's explicit redirections stay in effect.
      for (const fd of new Set([...shellFdsBeforeTrap.keys(), ...fdTable.keys(), ...explicitFds])) {
        const handle = fdTable.get(fd);
        if (explicitFds.has(fd) || handle !== shellFdsBeforeTrap.get(fd)) {
          if (handle === undefined) {
            updated.delete(fd);
          } else {
            updated.set(fd, handle);
          }
        }
      }
      programFds = updated;
      stderr = programFds.get(2) ?? closedFileDescriptor;
    }
    const proc = this.kernel.getProcess({ pid: environment.shellPid });
    if (proc === undefined) {
      throw new Error(`No such process: ${environment.shellPid}`);
    }

    const oldHandles = this.replaceProcessImage({
      process: proc,
      program,
      environment,
      cwd,
      fdTable: programFds,
      env: clearEnvironment ? undefined : environment.variables.exportedEntries({ assignments: undefined }),
    });
    environment.replacedProcess = true;
    oldHandles.push(...this.takeOwnedPersistentFileHandles({ environment }));
    if (environment.shellImage === this.shellImage) {
      oldHandles.push(...this.retireRootShellImage({ status: RETIRED_SHELL_STATUS }));
    } else {
      environment.shellImage.retire({ status: RETIRED_SHELL_STATUS });
    }

    let closeFailure = await closeFileHandleReferences({ handles: oldHandles });
    let result: WeshCommandResult;
    try {
      result = await this.executeProgram({
        proc,
        commandName: program.name,
        diagnosticStderr: stderr,
        evaluation: {
          definition: program.definition,
          argumentEntryRefs: program.argumentEntryRefs,
          stdinToClose: undefined,
        },
      });
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      await this.writeErrorText({ stderr, text: `exec: ${message}\n` }).catch(() => {});
      result = { exitCode: 1 };
    }
    try {
      await this.kernel.closeProcessResources({ pid: proc.pid });
    } catch (error: unknown) {
      closeFailure ??= { error };
    }
    proc.fds.clear();
    proc.ownedHandles?.clear();
    // The image's end and the cancellation of the enclosing input can race.
    const waitStatus = this.getProcessExitStatus({ process: proc, result });
    this.kernel.recordWaitStatus({ process: proc, waitStatus });
    const interrupted = this.getForegroundInterruptResult({ environment });
    const execResult: WeshShellExecutionResult = {
      ...toWeshCommandResult({ result: interrupted ?? result }),
      controlFlow: { kind: 'exec' },
    };
    if (closeFailure !== undefined) {
      return this.reportExecCleanupFailure({ environment, result: execResult, error: closeFailure.error, stderr });
    }
    environment.execResult = execResult;
    return execResult;
  }

  private async reportExecCleanupFailure({ environment, result, error, stderr }: {
    environment: WeshExecutionEnvironment,
    result: WeshShellExecutionResult,
    error: unknown,
    stderr: WeshFileHandle,
  }): Promise<WeshShellExecutionResult> {
    const message = error instanceof Error ? error.message : String(error);
    await this.writeErrorText({ stderr, text: `exec: ${message}\n` }).catch(() => {});
    const failedResult: WeshShellExecutionResult = result.exitCode !== 0 ? result : {
      exitCode: 1,
      waitStatus: { kind: 'exited', exitCode: 1 },
      controlFlow: { kind: 'exec' },
    };
    environment.execResult = failedResult;
    const process = this.kernel.getProcess({ pid: environment.shellPid });
    if (process !== undefined) {
      this.recordProcessCloseFailure({ process });
    }
    return failedResult;
  }

  private async startCommandProcess({ processOptions, evaluation, redirectionHandles, finishSubstitutions, checkInterrupt }: {
    processOptions: Parameters<WeshKernel['spawn']>[0] & {
      args: [string, ...string[]],
      env: Iterable<readonly [string, string]>,
      cwd: string,
      fds: Map<number, WeshFileHandle>,
    },
    evaluation: WeshCommandEvaluation,
    redirectionHandles: readonly WeshFileHandle[],
    finishSubstitutions: (() => Promise<WeshShellExecutionResult>) | undefined,
    checkInterrupt: (() => WeshShellExecutionResult | undefined) | undefined,
  }): Promise<{ process: WeshProcess, completed: Promise<WeshShellExecutionResult> }> {
    const { fds, ...spawnOptions } = processOptions;
    const { pid, process: proc } = await this.kernel.spawn(spawnOptions);
    try {
      proc.fds = this.kernel.bindFdTable({ pid, fdTable: fds });
    } catch (error: unknown) {
      // The shell still owns the descriptors that were supplied to spawn.
      await this.closeAndReapProcess({ pid, additionalHandles: [] });
      throw error;
    }
    const completed = this.finishCommandProcess({
      proc,
      commandName: processOptions.args[0],
      evaluation,
      diagnosticStderr: fds.get(2) ?? closedFileDescriptor,
      redirectionHandles,
      finishSubstitutions,
      interrupted: checkInterrupt?.(),
    });
    return { process: proc, completed };
  }

  private async finishCommandProcess({ proc, commandName, evaluation, diagnosticStderr, redirectionHandles, finishSubstitutions, interrupted }: {
    proc: WeshProcess,
    commandName: string,
    evaluation: WeshCommandEvaluation,
    diagnosticStderr: WeshFileHandle,
    redirectionHandles: readonly WeshFileHandle[],
    finishSubstitutions: (() => Promise<WeshShellExecutionResult>) | undefined,
    interrupted: WeshShellExecutionResult | undefined,
  }): Promise<WeshShellExecutionResult> {
    let result: WeshShellExecutionResult;
    let closeFailure: { error: unknown } | undefined;
    try {
      result = interrupted ?? await this.executeProgram({
        proc,
        commandName,
        diagnosticStderr,
        evaluation,
      });
    } finally {
      try {
        closeFailure = await this.closeAndReapProcess({ pid: proc.pid, additionalHandles: redirectionHandles });
        if (closeFailure !== undefined) {
          await this.writeProcessCleanupError({ stderr: diagnosticStderr, error: closeFailure.error });
        }
      } finally {
        await finishSubstitutions?.();
      }
    }
    return closeFailure === undefined
      ? result
      : { ...result, exitCode: proc.exitCode ?? result.exitCode, waitStatus: proc.waitStatus ?? result.waitStatus };
  }

  private async withForegroundWait({ environment, execute }: {
    environment: WeshExecutionEnvironment,
    execute: () => Promise<WeshShellExecutionResult>,
  }): Promise<WeshShellExecutionResult> {
    if (environment.shellImage === this.shellImage) {
      return execute();
    }
    const waiting: WeshForegroundWait = { children: [] };
    environment.foregroundWait = waiting;
    try {
      const result = await execute();
      const { interrupt, lastChildStatus } = waiting;
      if (interrupt !== undefined && this.getSignaledWaitStatus({ waitStatus: lastChildStatus })?.signal === 2
          && this.getShellInterruptStatus({ environment }) === undefined) {
        this.terminateShellImage({ environment, waitStatus: interrupt.status, lastExitCode: interrupt.lastExitCode });
      }
      return result;
    } finally {
      delete environment.foregroundWait;
    }
  }

  private async waitForForegroundProcess({ completed, environment, process }: {
    completed: Promise<WeshShellExecutionResult>,
    environment: WeshExecutionEnvironment,
    process: WeshProcess | undefined,
  }): Promise<WeshShellExecutionResult> {
    const { promise, resolve } = Promise.withResolvers<WeshShellExecutionResult>();
    const stopWaiting = () => {
      const termination = this.getShellTerminationStatus({ environment });
      if (termination === undefined) {
        return;
      }
      // Group delivery is synchronous up to receipt. Join a recipient that
      // received this same signal while it closes its own descriptors.
      if (process?.terminationStatus === termination && this.kernel.getProcess({ pid: process.pid }) === process) {
        return;
      }
      const stopped = this.getForegroundInterruptResult({ environment });
      if (stopped !== undefined) {
        resolve(stopped);
      }
    };
    const notify = () => queueMicrotask(stopWaiting);
    const unsubscribe = environment.shellImage.subscribeTermination({ notify });
    try {
      stopWaiting();
      const result = await Promise.race([completed, promise]);
      const waiting = environment.foregroundWait;
      if (waiting?.interrupt !== undefined && process?.waitStatus !== undefined) {
        // A pipeline's exit value (including pipefail) is independent of its last completed process.
        waiting.lastChildStatus = process.waitStatus;
      }
      return result;
    } finally {
      unsubscribe();
    }
  }

  private createCommandContext({ proc, args, argumentEntryRefs, commandFiles }: {
    proc: WeshProcess,
    args: string[],
    argumentEntryRefs: readonly (WeshEntryRef | undefined)[] | undefined,
    commandFiles: ReturnType<typeof createCommandFiles>,
  }): WeshCommandContext {
    const { pid, cwd, fds } = proc;
    const stdin = fds.get(0) ?? closedFileDescriptor;
    const stdout = fds.get(1) ?? closedFileDescriptor;
    const stderr = fds.get(2) ?? closedFileDescriptor;
    return {
      args,
      env: proc.env,
      cwd,
      pid,
      stdin,
      stdout,
      stderr,
      getArgumentEntryRef: ({ index }) => argumentEntryRefs?.[index],
      getWeshCommandMeta: ({ name }: { name: string }) => this.commands.get(name)?.meta,
      getCommandNames: () => Array.from(this.commands.keys()),
      getProcesses: () => this.kernel.getProcesses().map((process) => ({
        pid: process.pid,
        ppid: process.ppid,
        pgid: process.pgid,
        state: process.state,
        user: process.env.get('USER') ?? 'unknown',
        image: process.image,
        argv0: process.args[0] ?? process.image,
        args: process.args.slice(1),
        cwd: process.cwd,
      })),
      executeCommand: ({ command, args, argumentEntryRefs, stdin, stdout, cwd, env }) => {
        try {
          commandFiles.checkActive();
        } catch (error: unknown) {
          const stopped = this.getCommandProcessCompletion({ proc });
          return stopped === undefined ? Promise.reject(error) : Promise.resolve(stopped);
        }
        return this.executeCommand({ command, args, argumentEntryRefs, stdin, stdout, cwd, env, parent: proc });
      },
      get files() {
        return commandFiles.files;
      },
      process: {
        getPid: () => pid,
        getGroupId: () => proc.pgid,
        getWaitStatus: () => this.kernel.getWaitStatus({ pid }),
        signalSelf: async ({ signal }) => {
          commandFiles.checkActive();
          await this.kernel.kill({ pid, signal });
        },
        signalGroup: async ({ signal }) => {
          commandFiles.checkActive();
          await this.signalCommandProcessGroup({ proc, signal });
        },
        waitForSignalOrTimeout: ({ timeoutMs }) => this.kernel.waitForSignalOrTimeout({ pid, timeoutMs }),
      },
      getFileDescriptor: ({ fd }) => proc.fds.get(fd),
      text: () => createShellTextIoHelpers({ stdin, stdout, stderr }),
    };

  }

  private getCommandProcessCompletion({ proc }: { proc: WeshProcess }): WeshCommandResult | undefined {
    const waitStatus = proc.waitStatus ?? this.getInputAbortStatus({ signal: proc.foregroundSignal });
    return waitStatus === undefined ? undefined : { exitCode: weshWaitStatusToExitCode({ waitStatus }), waitStatus };
  }

  private recordShellSignalExit({ environment, waitStatus }: {
    environment: WeshExecutionEnvironment,
    waitStatus: WeshWaitStatus | undefined,
  }): void {
    const pid = environment.shellPid;
    if (waitStatus === undefined || (this.getShellEvaluationInterrupt({ environment }) !== waitStatus
      && this.shellSignalPids.get(waitStatus) !== pid)) {
      return;
    }
    const process = this.kernel.getProcess({ pid });
    if (process !== undefined && process.waitStatus === undefined) {
      // Trap execution is over. Preserve the signal through descriptor cleanup.
      this.kernel.recordWaitStatus({ process, waitStatus });
    }
  }

  private getProcessExitStatus({ process, result }: {
    process: WeshProcess,
    result: WeshCommandResult | undefined,
  }): WeshWaitStatus {
    if (process.waitStatus !== undefined) {
      return process.waitStatus;
    }
    // A shell or command wrapper can return the status of a child. Only a
    // signal delivered to this PID describes how this process ended.
    const reported = result?.waitStatus;
    if (reported !== undefined && this.shellSignalPids.get(reported) === process.pid) {
      return reported;
    }
    return this.getInputAbortStatus({ signal: process.foregroundSignal }) ?? { kind: 'exited', exitCode: result?.exitCode ?? 1 };
  }

  private async executeProgram({ proc, commandName: cmdName, diagnosticStderr, evaluation }: {
    proc: WeshProcess,
    commandName: string,
    diagnosticStderr: WeshFileHandle,
    evaluation: WeshCommandEvaluation,
  }): Promise<WeshShellExecutionResult> {
    const { definition, argumentEntryRefs, stdinToClose } = evaluation;
    const { pid } = proc;
    const args = proc.args.slice(1);
    const boundStdin = proc.fds.get(0) ?? closedFileDescriptor;
    const boundStdout = proc.fds.get(1) ?? closedFileDescriptor;
    const boundStderr = proc.fds.get(2) ?? closedFileDescriptor;

    let environment: WeshExecutionEnvironment | undefined;
    const getShellEnvironment = () => {
      if (environment !== undefined) {
        return environment;
      }
      environment = this.createExecutionEnvironment({
        shellPid: pid,
        pgid: proc.pgid,
        variables: WeshShellVariables.fromEnvironment({ entries: proc.env, executionOptions: createDefaultExecutionOptions() }),
        aliases: new Map(),
        functions: new Map(),
        fds: new Map(proc.fds),
        traps: createStartupTraps({ signalDispositions: proc.signalDispositions }),
        shellOptions: new Map(),
        positionalArgs: [],
        shellImage: new WeshShellImage({ cwd: proc.cwd, lastPid: undefined }),
      });
      environment.foregroundSignal = proc.foregroundSignal;
      environment.inheritedSignalDispositions = proc.signalDispositions;
      this.bindShellSignalHandler({ process: proc, environment });
      return environment;
    };
    try {
      if (stdinToClose !== undefined) {
        await stdinToClose.close();
      }
      const readPendingInterrupt = () => {
        const signalResult = this.getProcessSignalResult({ process: proc });
        const foregroundStatus = this.getInputAbortStatus({ signal: proc.foregroundSignal });
        if (signalResult !== undefined || foregroundStatus === undefined) {
          return signalResult;
        }
        const interrupted = this.getForegroundInterruptResult({ environment: getShellEnvironment() });
        if (interrupted !== undefined) {
          this.kernel.recordWaitStatus({ process: proc, waitStatus: foregroundStatus });
        }
        return interrupted;
      };
      let result: WeshShellExecutionResult | undefined;
      const interrupted = readPendingInterrupt();
      if (interrupted !== undefined) {
        return interrupted;
      }
      if (definition === undefined || definition === setCommandDefinition || definition === unsetCommandDefinition) {
        result = await this.tryExecuteShellBuiltin({
          commandName: cmdName,
          definition,
          args,
          cwd: proc.cwd,
          stdin: boundStdin,
          stdout: boundStdout,
          stderr: boundStderr,
          loopDepth: 0,
          functionDepth: 0,
          hasCommandAssignments: false,
          getEnvironment: getShellEnvironment,
          fdTable: proc.fds,
          redirections: [],
          forwardedRedirections: undefined,
        });
      }
      if (result === undefined) {
        if (definition === undefined) {
          throw new Error(`Missing command definition for ${cmdName}`);
        }
        const loadedCommand = await this.loadCommandDefinition({
          definition,
          interruption: {
            environment: undefined,
            process: proc,
            isInterrupted: () => proc.waitStatus !== undefined || proc.foregroundSignal?.aborted === true,
          },
        });
        const stoppedWhileLoading = readPendingInterrupt();
        if (stoppedWhileLoading !== undefined) {
          return stoppedWhileLoading;
        }
        if ('executeCommand' in loadedCommand) {
          const commandFiles = createCommandFiles({
            kernel: this.kernel,
            process: proc,
            isInterrupted: () => proc.foregroundSignal?.aborted === true,
          });
          const context = this.createCommandContext({ proc, args, argumentEntryRefs, commandFiles });
          try {
            result = toWeshCommandResult({ result: await loadedCommand.executeCommand({ context }) });
          } finally {
            const ending = commandFiles.finish();
            const failure = ending instanceof Promise ? await ending : ending;
            if (failure !== undefined) {
              await this.writeProcessCleanupError({ stderr: diagnosticStderr, error: failure.error });
              if (result?.exitCode === 0) {
                result = { exitCode: 1 };
              }
            }
          }
        } else {
          result = await this.executeShellBuiltin({
            execute: loadedCommand.executeShellBuiltin,
            commandName: cmdName,
            proc,
            args,
            cwd: proc.cwd,
            environment: getShellEnvironment(),
            fdTable: proc.fds,
            redirections: [],
            forwardedRedirections: undefined,
            shellAssignments: undefined,
            hasCommandAssignments: false,
            loopDepth: 0,
            functionDepth: 0,
          });
        }
      }
      if (!isExecCompletion({ result })) {
        if (environment !== undefined && this.getShellTerminationStatus({ environment }) !== undefined) {
          result = await this.finishShellTermination({ environment, resolveStdio: () => this.getShellStdio({ environment: getShellEnvironment() }) });
        }
        const signalResult = this.getProcessSignalResult({ process: proc });
        if (signalResult !== undefined) {
          return signalResult;
        }
      }

      const waitStatus = this.getProcessExitStatus({ process: proc, result });
      const exitCode = weshWaitStatusToExitCode({ waitStatus });
      this.kernel.recordWaitStatus({ process: proc, waitStatus });
      return { ...result, exitCode, waitStatus };
    } catch (error: unknown) {
      const signalResult = this.getProcessSignalResult({ process: proc });
      if (signalResult !== undefined) {
        return signalResult;
      }
      if (error instanceof WeshCommandInterruptedError) {
        const stopped = this.getCommandProcessCompletion({ proc });
        if (stopped?.waitStatus !== undefined) {
          this.kernel.recordWaitStatus({ process: proc, waitStatus: stopped.waitStatus });
          return stopped;
        }
      }
      const badFileDescriptor = error instanceof WeshBadFileDescriptorError;
      let diagnosticFailure: { error: unknown } | undefined;
      if (badFileDescriptor) {
        try {
          await this.writeErrorText({ stderr: boundStderr, text: `${cmdName}: ${error.message}\n` });
        } catch (error: unknown) {
          diagnosticFailure = { error };
        }
        const interrupted = this.getProcessSignalResult({ process: proc });
        if (interrupted !== undefined) {
          return interrupted;
        }
      }
      const waitStatus: WeshWaitStatus = { kind: 'exited', exitCode: 1 };
      this.kernel.recordWaitStatus({ process: proc, waitStatus });
      if (diagnosticFailure !== undefined) {
        throw diagnosticFailure.error;
      }
      if (badFileDescriptor) {
        return { exitCode: 1, waitStatus };
      }
      throw error;
    } finally {
      if (environment !== undefined) {
        environment.shellImage.retire({ status: proc.waitStatus ?? RETIRED_SHELL_STATUS });
        await this.closePersistentFileHandles({ environment });
      }
    }
  }

  private async executeShellBuiltin({
    execute,
    commandName,
    proc,
    args,
    cwd,
    environment,
    fdTable,
    redirections,
    forwardedRedirections,
    shellAssignments,
    hasCommandAssignments,
    loopDepth,
    functionDepth,
  }: {
    execute: WeshShellBuiltinFunction,
    commandName: string,
    proc: WeshProcess,
    args: string[],
    cwd: string,
    environment: WeshExecutionEnvironment,
    fdTable: ReadonlyMap<number, WeshFileHandle>,
    redirections: WeshCommandNode['redirections'],
    forwardedRedirections: WeshForwardedRedirections | undefined,
    shellAssignments: ReadonlyMap<string, string> | undefined,
    hasCommandAssignments: boolean,
    loopDepth: number,
    functionDepth: number,
  }): Promise<WeshShellExecutionResult> {
    let active = true;
    let brokenPipe: Extract<WeshWaitStatus, { kind: 'signaled' }> | undefined;
    const onBrokenPipe = () => {
      if (active && brokenPipe === undefined && this.getShellInterruptStatus({ environment }) === undefined
          && !ignoresSignal({ disposition: proc.signalDispositions?.get(13) })
          && !ignoresSignal({ disposition: environment.inheritedSignalDispositions?.get(13) })
          && !ignoresSignal({ disposition: this.buildProcessSignalDispositions({ environment }).get(13) })) {
        // A builtin runs in the shell's PID. Keep the descriptors open for its
        // trap and associate the local SIGPIPE with that PID until completion.
        brokenPipe = { kind: 'signaled', signal: 13 };
        this.shellSignalPids.set(brokenPipe, proc.pid);
      }
    };
    const canMutate = () => active && brokenPipe === undefined && proc.state === 'running' && this.getShellInterruptStatus({ environment }) === undefined;
    let selfSignals: Map<number, ({ handler }: { handler: WeshProcessSignalHandler | undefined }) => void> | undefined;
    const interrupted = (): WeshShellExecutionResult | undefined => active
      ? this.getForegroundInterruptResult({ environment })
      : { exitCode: 1 };
    const { variables } = environment;
    let restoreFds: WeshRestoreFileDescriptors | undefined;
    let evaluationRedirections = forwardedRedirections;
    const shellStdio = () => ({
      stdin: environment.fds.get(0) ?? closedFileDescriptor,
      stdout: environment.fds.get(1) ?? closedFileDescriptor,
      stderr: environment.fds.get(2) ?? closedFileDescriptor,
    });
    const enterNestedEvaluation = () => {
      if (restoreFds === undefined) {
        const redirectedFds = redirections.map(({ fd }) => fd);
        const stdioOverrides = [0, 1, 2].filter(fd => environment.fds.get(fd) !== fdTable.get(fd));
        const restore = this.scopeShellFileDescriptors({
          environment,
          fdTable,
          fds: [...redirectedFds, ...stdioOverrides],
        });
        restoreFds = restore;
        if (redirectedFds.length !== 0) {
          evaluationRedirections = { fds: redirectedFds, restore: () => restore({ fds: redirectedFds }) };
        }
      }
    };
    const shell: WeshShellBuiltinContext = {
      setCwd: ({ path }) => {
        if (canMutate()) {
          const previousPwd = variables.get({ name: 'PWD' });
          const skipCurrentCommand = hasCommandAssignments ? true : undefined;
          variables.set({ name: 'OLDPWD', value: previousPwd, skipCurrentCommand });
          environment.shellImage.cwd = path;
          proc.cwd = path;
          variables.set({ name: 'PWD', value: path, skipCurrentCommand });
        }
      },
      getHistory: () => environment.shellRootPid === this.shellPid ? [...this.history] : [],
      getAliases: () => Array.from(environment.aliases.entries())
        .sort(([leftName], [rightName]) => leftName.localeCompare(rightName))
        .map(([name, value]) => ({ name, value })),
      setAlias: ({ name, value }) => {
        if (canMutate()) {
          environment.aliases.set(name, value);
        }
      },
      unsetAlias: ({ name }) => {
        if (canMutate()) {
          environment.aliases.delete(name);
        }
      },
      hasFunction: ({ name }) => environment.functions.has(name),
      getJobs: () => environment.shellImage.children.listJobs(),
      sendSignal: ({ target, signal }) => {
        if (!canMutate()) {
          return 'interrupted';
        }
        const failure = this.kernel.sendSignal({
          sender: proc,
          target,
          signal,
          deferSelf: ({ signal, deliver }) => {
            // The shell defers a signal it handles. A default fatal signal
            // can take effect before kill reaches the next operand.
            if (signal !== 9 && (environment.traps.get('EXIT')?.kind === 'run'
              || findSignalTrapAction({ signal, traps: environment.traps }) !== undefined)) {
              (selfSignals ??= new Map()).set(signal, deliver);
            } else {
              deliver({ handler: this.createShellSignalHandler({ environment, builtinSelfSignal: true }) });
            }
          },
        });
        return canMutate() ? failure : 'interrupted';
      },
      getShellOption: ({ name }) => environment.shellOptions.get(name) === true,
      setShellOption: ({ name, enabled }) => {
        if (canMutate()) {
          environment.shellOptions.set(name, enabled);
        }
      },
      getExecutionOption: ({ name }) => environment.executionOptions[name],
      setExecutionOption: ({ name, enabled }) => {
        if (canMutate()) {
          variables.updateExecutionOptions({ options: { [name]: enabled } });
        }
      },
      setTraps: ({ conditions, disposition }) => {
        if (!canMutate()) {
          return;
        }
        environment.inheritedTrapListing = undefined;
        for (const condition of conditions) {
          const signal = linuxSignalByName({ name: condition })?.number;
          if (signal !== undefined && ignoresSignal({ disposition: environment.inheritedSignalDispositions?.get(signal) })) {
            continue;
          }
          if (disposition === undefined) {
            environment.traps.delete(condition);
          } else {
            environment.traps.set(condition, disposition);
          }
        }
        proc.signalDispositions = this.buildProcessSignalDispositions({ environment });
      },
      getTraps: () => Array.from((environment.inheritedTrapListing ?? environment.traps).entries())
        .sort(([leftCondition], [rightCondition]) => leftCondition.localeCompare(rightCondition)),
      variables: {
        get: ({ name }) => variables.get({ name }),
        entries: () => variables.entries({ omitCurrentCommand: hasCommandAssignments }),
        exportDeclarations: () => variables.exportDeclarations({ omitCurrentCommand: hasCommandAssignments }),
        set: ({ name, value, skipCurrentCommand }) => {
          if (canMutate()) {
            variables.set({ name, value, skipCurrentCommand: hasCommandAssignments ? skipCurrentCommand : undefined });
          }
        },
        unset: ({ name, skipCurrentCommand }) => {
          if (canMutate()) {
            variables.unset({ name, skipCurrentCommand: hasCommandAssignments ? skipCurrentCommand : undefined });
          }
        },
        setExport: ({ name, value, exported }) => {
          if (canMutate()) {
            variables.setExport({ name, value, exported, directAssignment: hasCommandAssignments });
          }
        },
      },
      getSearchPath: () => variables.get({ name: 'PATH' }),
      evaluateCommand: async ({ command, args, searchPathOverride, functionLookup }) => {
        const stopped = interrupted();
        if (stopped !== undefined) {
          return stopped;
        }
        enterNestedEvaluation();
        return this.evaluateShellArgv({
          command,
          args,
          cwd,
          argumentEntryRefs: undefined,
          environment,
          ...shellStdio(),
          loopDepth,
          functionDepth,
          functionLookup,
          searchPathOverride,
          forwardedRedirections: evaluationRedirections,
          hasCommandAssignments: functionLookup === 'bypass' && hasCommandAssignments,
        });
      },
      evaluateSource: async ({ script }) => {
        const stopped = interrupted();
        if (stopped !== undefined) {
          return stopped;
        }
        enterNestedEvaluation();
        return this.executeShellInState({
          source: createTextShellSource({ text: script }),
          environment,
          ...shellStdio(),
          history: 'ignore',
          loopDepth,
          allowReturn: functionDepth > 0,
        });
      },
      exec: async ({ command, args, argv0, login, clearEnvironment }) =>
        interrupted() ?? this.execProgram({
          command,
          args,
          argv0,
          login,
          clearEnvironment,
          environment,
          cwd,
          fdTable,
          redirections,
          forwardedRedirections,
          writeDiagnostic: ({ text }) => this.writeErrorText({ stderr: bind({ handle: fdTable.get(2) }) ?? closedFileDescriptor, text }),
        }),
      persistFileDescriptors: async () => {
        if (canMutate()) {
          await this.persistFileDescriptors({ environment, fdTable, redirections, forwardedRedirections });
        }
      },
    };

    const binding = new Map<WeshFileHandle, WeshFileHandle>();
    let closing: Promise<{ error: unknown } | undefined> | undefined;
    const bind = ({ handle }: { handle: WeshFileHandle | undefined }): WeshFileHandle | undefined => {
      if (handle === undefined || handle === closedFileDescriptor) {
        return undefined;
      }
      if (closing !== undefined) {
        return closedFileDescriptor;
      }
      let reference = binding.get(handle);
      if (reference === undefined) {
        reference = this.kernel.bindShellFileDescriptor({
          pid: proc.pid,
          handle: this.createPrimaryFileHandleReference({ handle }),
          onBrokenPipe,
          foregroundSignal: environment.foregroundSignal,
        });
        binding.set(handle, reference);
      }
      return reference;
    };
    const closeBindings = () => {
      closing ??= closeFileHandleReferences({ handles: [...binding.values()] });
    };
    let commandEnv: ReadonlyMap<string, string> | undefined;
    const context: WeshBuiltinCommandContext = {
      args,
      cwd,
      get env() {
        return commandEnv ??= new Map(variables.exportedEntries({ assignments: undefined }));
      },
      get stdout() {
        return bind({ handle: fdTable.get(1) }) ?? closedFileDescriptor;
      },
      getFileDescriptor: ({ fd }) => bind({ handle: fdTable.get(fd) }),
      getWeshCommandMeta: ({ name }) => this.commands.get(name)?.meta,
      files: this.shellBuiltinFiles,
      text: () => {
        const fds = restoreFds === undefined ? fdTable : environment.fds;
        return createShellTextIoHelpers({
          stdin: bind({ handle: fds.get(0) }) ?? closedFileDescriptor,
          stdout: bind({ handle: fds.get(1) }) ?? closedFileDescriptor,
          stderr: bind({ handle: fds.get(2) }) ?? closedFileDescriptor,
        });
      },
    };
    const onInterrupt = () => {
      if (this.getShellInterruptStatus({ environment }) !== undefined) {
        closeBindings();
      }
    };
    const unsubscribe = this.subscribeShellInterrupt({ environment, notify: onInterrupt });
    if (this.getShellInterruptStatus({ environment }) !== undefined) {
      closeBindings();
    }
    let closeFailure: { error: unknown } | undefined;
    let result: WeshShellExecutionResult;
    try {
      result = interrupted() ?? await this.withCommandAssignments({
        variables,
        assignments: shellAssignments,
        execute: () => execute({ context, shell }),
      });
    } catch (error: unknown) {
      const stopped = interrupted();
      if (stopped !== undefined) {
        result = stopped;
      } else if (error instanceof WeshBadFileDescriptorError || error instanceof WeshReadonlyVariableError) {
        await this.writeErrorText({ stderr: bind({ handle: fdTable.get(2) }) ?? closedFileDescriptor, text: `${commandName}: ${error.message}\n` });
        result = { exitCode: 1 };
      } else {
        throw error;
      }
    } finally {
      active = false;
      unsubscribe();
      if (selfSignals !== undefined) {
        // A handled self-signal takes effect after all operands. Traps
        // observe the successful delivery.
        const handler = this.createShellSignalHandler({ environment, builtinSelfSignal: true });
        for (const deliver of selfSignals.values()) {
          deliver({ handler });
        }
      }
      closeBindings();
      closeFailure = await closing;
      if (restoreFds !== undefined) {
        const restoreFailure = await closeFileHandleReferences({ handles: restoreFds({ fds: undefined }) });
        closeFailure ??= restoreFailure;
      }
    }
    if (!isExecCompletion({ result }) && this.getShellTerminationStatus({ environment }) !== undefined
        && environment.shellImage.termination?.unwindOwner === undefined) {
      const overridden = [...new Set([...environment.fds.keys(), ...fdTable.keys()])]
        .filter(fd => environment.fds.get(fd) !== fdTable.get(fd));
      const restore = this.scopeShellFileDescriptors({ environment, fdTable, fds: overridden });
      try {
        if (closeFailure !== undefined) {
          await this.writeProcessCleanupError({ stderr: fdTable.get(2) ?? closedFileDescriptor, error: closeFailure.error });
        }
        return await this.finishShellTermination({ environment, resolveStdio: () => this.getShellStdio({ environment }) });
      } finally {
        await closeFileHandleReferences({ handles: restore({ fds: undefined }) });
      }
    }
    if (closeFailure !== undefined) {
      throw closeFailure.error;
    }
    if (isExecCompletion({ result })) {
      return result;
    }
    const stopped = this.getForegroundInterruptResult({ environment });
    if (stopped !== undefined) {
      return stopped;
    }
    if (brokenPipe !== undefined) {
      if (!this.activeSignalTrapEnvironments.has(environment)) {
        await this.runSignalTrapIfNeeded({
          waitStatus: brokenPipe,
          environment,
          stdin: fdTable.get(0) ?? closedFileDescriptor,
          stdout: fdTable.get(1) ?? closedFileDescriptor,
          stderr: fdTable.get(2) ?? closedFileDescriptor,
        });
      }
      return { exitCode: 141, waitStatus: brokenPipe };
    }
    return result;
  }

  private async closePersistentFileHandles({ environment }: { environment: WeshExecutionEnvironment }): Promise<void> {
    const closeFailure = await closeFileHandleReferences({ handles: this.takeOwnedPersistentFileHandles({ environment }) });
    if (closeFailure !== undefined) {
      throw closeFailure.error;
    }
  }

  private async writeErrorText({
    stderr,
    text,
    environment,
  }: {
    stderr: WeshFileHandle,
    text: string,
    environment?: WeshExecutionEnvironment,
  }): Promise<void> {
    if (stderr === closedFileDescriptor
        || (environment !== undefined && this.getShellInterruptStatus({ environment }) !== undefined)) {
      return;
    }
    const buffer = new TextEncoder().encode(text);
    if (environment === undefined) {
      await stderr.write({ buffer });
      return;
    }
    const handle = this.kernel.duplicateFileDescriptor({ handle: stderr });
    if (handle === stderr) {
      await stderr.write({ buffer });
      return;
    }
    // Cancel this writer's wait without closing the descriptor shared by the shell or its children.
    const unsubscribe = this.subscribeShellInterrupt({
      environment,
      notify: () => {
        if (this.getShellInterruptStatus({ environment }) !== undefined) {
          void handle.close().catch(() => {});
        }
      },
    });
    try {
      await handle.write({ buffer });
    } finally {
      unsubscribe();
      await handle.close();
    }
  }

  private async tryExecuteShellBuiltin({
    commandName: invocationName,
    definition,
    args,
    cwd,
    stdin,
    stdout,
    stderr,
    loopDepth,
    functionDepth,
    hasCommandAssignments,
    getEnvironment,
    fdTable,
    redirections,
    forwardedRedirections,
  }: {
    commandName: string,
    definition: WeshRegisteredCommandDefinition | undefined,
    args: string[],
    cwd: string,
    stdin: WeshFileHandle,
    stdout: WeshFileHandle,
    stderr: WeshFileHandle,
    loopDepth: number,
    functionDepth: number,
    hasCommandAssignments: boolean,
    getEnvironment: () => WeshExecutionEnvironment,
    fdTable: ReadonlyMap<number, WeshFileHandle>,
    redirections: WeshCommandNode['redirections'],
    forwardedRedirections: WeshForwardedRedirections | undefined,
  }): Promise<WeshShellExecutionResult | undefined> {
    let commandName = invocationName;
    if (definition !== undefined) {
      if (definition !== setCommandDefinition && definition !== unsetCommandDefinition) {
        return undefined;
      }
      commandName = definition.meta.name;
    }

    switch (commandName) {
    case 'builtin':
      return this.executeBuiltinBuiltin({
        args,
        cwd,
        stdin,
        stdout,
        stderr,
        loopDepth,
        functionDepth,
        hasCommandAssignments,
        environment: getEnvironment(),
        fdTable,
        redirections,
        forwardedRedirections,
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
    case 'getopts':
      return this.executeGetoptsBuiltin({ args, stderr, hasCommandAssignments, environment: getEnvironment() });
    case 'set':
      return this.executeSetBuiltin({ args, stderr, environment: getEnvironment() });
    case 'shift':
      return this.executeShiftBuiltin({
        args,
        stderr,
        environment: getEnvironment(),
      });
    case 'local':
      return this.executeLocalBuiltin({
        args,
        stderr,
        functionDepth,
        hasCommandAssignments,
        environment: getEnvironment(),
      });
    case 'let':
      return this.executeLetBuiltin({ args, stderr, environment: getEnvironment() });
    case 'unset':
      if (!this.shouldExecuteUnsetAsShellIntrinsic({ args })) {
        return undefined;
      }
      return this.executeUnsetBuiltin({
        args,
        stderr,
        environment: getEnvironment(),
      });
    case 'source':
    case '.': {
      const environment = getEnvironment();
      const restoreFds = this.scopeShellFileDescriptors({ environment, fdTable, fds: redirections.map(({ fd }) => fd) });
      let closeFailure: { error: unknown } | undefined;
      let result: WeshShellExecutionResult;
      try {
        result = await this.executeSourceCommand({ commandName, args, environment, cwd, loopDepth, stdin, stdout, stderr });
      } finally {
        closeFailure = await closeFileHandleReferences({ handles: restoreFds({ fds: undefined }) });
      }
      if (closeFailure !== undefined) {
        throw closeFailure.error;
      }
      return result;
    }
    case 'wait':
      return this.executeWaitCommand({
        args,
        stderr,
        environment: getEnvironment(),
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
      const rawExitCode = parsedExitCode.value ?? Number.parseInt(getEnvironment().variables.get({ name: '?' }) ?? '0', 10);
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
      const exitCode = parsedExitCode.value ?? Number.parseInt(getEnvironment().variables.get({ name: '?' }) ?? '0', 10);
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
    cwd,
    stdin,
    stdout,
    stderr,
    loopDepth,
    functionDepth,
    hasCommandAssignments,
    environment,
    fdTable,
    redirections,
    forwardedRedirections,
  }: {
    args: string[],
    cwd: string,
    stdin: WeshFileHandle,
    stdout: WeshFileHandle,
    stderr: WeshFileHandle,
    loopDepth: number,
    functionDepth: number,
    hasCommandAssignments: boolean,
    environment: WeshExecutionEnvironment,
    fdTable: ReadonlyMap<number, WeshFileHandle>,
    redirections: WeshCommandNode['redirections'],
    forwardedRedirections: WeshForwardedRedirections | undefined,
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

    const redirectedFds = redirections.map(({ fd }) => fd);
    const stdioOverrides = [0, 1, 2].filter(fd => environment.fds.get(fd) !== fdTable.get(fd));
    const restoreFds = this.scopeShellFileDescriptors({
      environment,
      fdTable,
      fds: [...redirectedFds, ...stdioOverrides],
    });
    let result: WeshShellExecutionResult;
    let closeFailure: { error: unknown } | undefined;
    try {
      result = await this.evaluateShellArgv({
        command: commandName,
        args: args.slice(1),
        cwd,
        argumentEntryRefs: undefined,
        environment,
        stdin,
        stdout,
        stderr,
        loopDepth,
        functionDepth,
        functionLookup: 'bypass',
        searchPathOverride: undefined,
        // These redirections apply to the launched program but aren't persisted by an operand-less exec.
        forwardedRedirections: {
          fds: [...(forwardedRedirections?.fds ?? []), ...redirectedFds],
          restore: undefined,
        },
        hasCommandAssignments,
      });
    } finally {
      closeFailure = await closeFileHandleReferences({ handles: restoreFds({ fds: undefined }) });
    }
    if (closeFailure !== undefined) {
      throw closeFailure.error;
    }
    return result;
  }

  private async executeGetoptsBuiltin({ args, stderr, hasCommandAssignments, environment }: {
    args: string[],
    stderr: WeshFileHandle,
    hasCommandAssignments: boolean,
    environment: WeshExecutionEnvironment,
  }): Promise<WeshShellExecutionResult> {
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
    const parsedOptind = Number.parseInt(environment.variables.get({ name: 'OPTIND' }) ?? '1', 10);
    let optind = Number.isSafeInteger(parsedOptind) && parsedOptind >= 1 ? parsedOptind : 1;
    let characterOffset = 1;

    if (
      environment.getoptsState !== undefined
      && environment.getoptsState.argumentSignature === argumentSignature
      && environment.getoptsState.optind === optind
    ) {
      characterOffset = environment.getoptsState.characterOffset;
    }

    const skipCurrentCommand = hasCommandAssignments ? true : undefined;
    const set = ({ name, value }: { name: string, value: string }) => environment.variables.set({ name, value, skipCurrentCommand });
    const unsetOptarg = () => environment.variables.unset({ name: 'OPTARG', skipCurrentCommand });
    const finish = async ({ nextOptind, nextCharacterOffset, value, exitCode }: {
      nextOptind: number,
      nextCharacterOffset: number,
      value: string,
      exitCode: 0 | 1,
    }): Promise<WeshCommandResult> => {
      const readonly = environment.variables.isReadonly({ name: variableName });
      if (!readonly) {
        set({ name: variableName, value });
      }
      set({ name: 'OPTIND', value: nextOptind.toString() });
      environment.getoptsState = {
        argumentSignature,
        optind: nextOptind,
        characterOffset: nextCharacterOffset,
      };
      if (readonly) {
        await this.writeErrorText({ stderr, text: `wesh: ${variableName}: readonly variable\n` });
        return { exitCode: exitCode || 2 };
      }
      return { exitCode };
    };

    while (true) {
      const current = optionArguments[optind - 1];
      if (current === undefined || current === '-' || !current.startsWith('-')) {
        unsetOptarg();
        return finish({ nextOptind: optind, nextCharacterOffset: 1, value: '?', exitCode: 1 });
      }
      if (current === '--') {
        unsetOptarg();
        return finish({ nextOptind: optind + 1, nextCharacterOffset: 1, value: '?', exitCode: 1 });
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
        if (silentErrors) {
          set({ name: 'OPTARG', value: option });
        } else {
          await this.writeErrorText({
            stderr,
            text: `wesh: getopts: illegal option -- ${option}\n`,
          });
          const interrupted = this.getForegroundInterruptResult({ environment });
          if (interrupted !== undefined) {
            return interrupted;
          }
          unsetOptarg();
        }
        return finish({ nextOptind, nextCharacterOffset, value: '?', exitCode: 0 });
      }

      if (requiresArgument) {
        const attached = current.slice(characterOffset + 1);
        if (attached.length > 0) {
          set({ name: 'OPTARG', value: attached });
          nextOptind = optind + 1;
          nextCharacterOffset = 1;
        } else {
          const value = optionArguments[optind];
          if (value === undefined) {
            if (silentErrors) {
              set({ name: 'OPTARG', value: option });
            } else {
              await this.writeErrorText({
                stderr,
                text: `wesh: getopts: option requires an argument -- ${option}\n`,
              });
              const interrupted = this.getForegroundInterruptResult({ environment });
              if (interrupted !== undefined) {
                return interrupted;
              }
              unsetOptarg();
            }
            return finish({ nextOptind: optind + 1, nextCharacterOffset: 1, value: silentErrors ? ':' : '?', exitCode: 0 });
          }
          set({ name: 'OPTARG', value });
          nextOptind = optind + 2;
          nextCharacterOffset = 1;
        }
      } else {
        unsetOptarg();
      }

      return finish({ nextOptind, nextCharacterOffset, value: option, exitCode: 0 });
    }
  }

  private async executeLetBuiltin({ args, stderr, environment }: {
    args: string[],
    stderr: WeshFileHandle,
    environment: WeshExecutionEnvironment,
  }): Promise<WeshCommandResult> {
    let value = 0n;
    try {
      for (const expression of args) {
        value = this.evaluateArithmeticExpression({
          expression,
          evaluate: this.arithmeticEvaluator ?? await this.loadArithmeticEvaluator({ environment }),
          env: environment.variables,
          executionOptions: environment.executionOptions,
          context: 'command',
        });
      }
    } catch (error: unknown) {
      if (!(error instanceof WeshArithmeticError)) {
        throw error;
      }
      await this.writeErrorText({ stderr, text: `let: ${error.message}\n` });
      return { exitCode: 1 };
    }
    return { exitCode: value === 0n ? 1 : 0 };
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
        case 'a':
          executionOptions.allexport = enabled;
          break;
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
          const optionName = SHELL_EXECUTION_OPTION_NAMES.find(name => name === args[index + 1]);
          if (optionName === undefined) {
            return undefined;
          }
          executionOptions[optionName] = enabled;
          index += 1;
          break;
        }
        default:
          return undefined;
        }
      }
    }

    environment.variables.updateExecutionOptions({ options: executionOptions });
    if (positionalStart !== undefined) {
      environment.positionalArgs = args.slice(positionalStart);
      this.syncSpecialParameters({ environment });
    }
    return { exitCode: 0 };
  }

  private async executeLocalBuiltin({ args, stderr, functionDepth, hasCommandAssignments, environment }: {
    args: string[],
    stderr: WeshFileHandle,
    functionDepth: number,
    hasCommandAssignments: boolean,
    environment: WeshExecutionEnvironment,
  }): Promise<WeshCommandResult> {
    if (functionDepth <= 0) {
      await this.writeErrorText({
        stderr,
        text: 'wesh: local: can only be used in a function\n',
      });
      return { exitCode: 1 };
    }

    let exitCode = 0;
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
      try {
        environment.variables.declareLocal({
          name,
          value: equalsIndex < 0 ? undefined : argument.slice(equalsIndex + 1),
          directAssignment: hasCommandAssignments,
        });
      } catch (error: unknown) {
        if (!(error instanceof WeshReadonlyVariableError)) {
          throw error;
        }
        exitCode = 1;
        await this.writeErrorText({ stderr, text: `wesh: local: ${error.message}\n` });
        const stopped = this.getForegroundInterruptResult({ environment });
        if (stopped !== undefined) {
          return stopped;
        }
      }
    }

    return { exitCode };
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
    let exitCode = 0;

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
        try {
          environment.variables.unset({ name: argument });
        } catch (error: unknown) {
          if (!(error instanceof WeshReadonlyVariableError)) {
            throw error;
          }
          exitCode = 1;
          await this.writeErrorText({ stderr, text: `wesh: unset: ${argument}: cannot unset: readonly variable\n` });
          const stopped = this.getForegroundInterruptResult({ environment });
          if (stopped !== undefined) {
            return stopped;
          }
        }
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

    return { exitCode };
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
    cwd,
    loopDepth,
    stdin,
    stdout,
    stderr,
  }: {
    commandName: 'source' | '.',
    args: string[],
    environment: WeshExecutionEnvironment,
    cwd: string,
    loopDepth: number,
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

    const resolvedPath = toAbsolutePath({ cwd, path });
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
        loopDepth,
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
      case 'exec':
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
  }): Promise<WeshShellExecutionResult> {
    const children = environment.shellImage.children;
    const rawPids = args[0] === '--' ? args.slice(1) : args;
    if (rawPids.length === 0) {
      const waiting = children.snapshot();
      for (const child of waiting) {
        const waited = await this.waitForShellChild({ child, environment });
        if ('result' in waited) {
          return waited.result;
        }
      }
      children.forgetBackgroundJobs({ children: waiting });
      return { exitCode: 0 };
    }

    let lastExitCode = 0;
    for (const rawPid of rawPids) {
      const interrupted = this.getForegroundInterruptResult({ environment });
      if (interrupted !== undefined) {
        return interrupted;
      }
      if (!/^\d+$/u.test(rawPid)) {
        await this.writeErrorText({
          stderr,
          text: `wesh: wait: ${rawPid}: not a pid or valid job spec\n`,
        });
        lastExitCode = 1;
        continue;
      }

      const pid = Number(rawPid);
      const child = children.get({ pid });
      if (child === undefined) {
        await this.writeErrorText({
          stderr,
          text: `wesh: wait: ${rawPid}: pid is not a child of this shell\n`,
        });
        lastExitCode = 127;
        continue;
      }

      const waited = await this.waitForShellChild({ child, environment });
      if ('result' in waited) {
        return waited.result;
      }
      lastExitCode = weshWaitStatusToExitCode({ waitStatus: waited.waitStatus });
    }

    return { exitCode: lastExitCode };
  }

  private async waitForShellChild({ child, environment }: {
    child: WeshShellChild,
    environment: WeshExecutionEnvironment,
  }): Promise<{ waitStatus: WeshWaitStatus } | { result: WeshShellExecutionResult }> {
    if (environment.pendingSubstitutionInterrupt === true && environment.terminationTrapSignal === undefined
        && !this.activeSignalTrapEnvironments.has(environment)) {
      return { result: { exitCode: 130 } };
    }
    while (true) {
      const waitStatus = await this.awaitShellChild({ child, environment });
      const stopped = this.getForegroundInterruptResult({ environment });
      if (stopped !== undefined) {
        return { result: stopped };
      }
      if (waitStatus !== undefined) {
        return { waitStatus };
      }
      const signal = environment.terminationTrapSignal !== undefined || this.activeSignalTrapEnvironments.has(environment)
        ? undefined
        : environment.shellImage.claimSignal();
      if (signal !== undefined) {
        // The evaluator runs the handler after closing the command's redirections.
        environment.interruptedWaitSignal = signal;
        return { result: { exitCode: 128 + signal } };
      }
      // A concurrent evaluation of the same PID may have claimed the signal.
    }
  }

  private async awaitShellChild({ child, environment }: {
    child: WeshShellChild,
    environment: WeshExecutionEnvironment,
  }): Promise<WeshWaitStatus | undefined> {
    if (child.waitStatus !== undefined) {
      return child.waitStatus;
    }
    const { promise, resolve } = Promise.withResolvers<WeshWaitStatus | undefined>();
    const unsubscribeChild = child.subscribe({ notify: () => resolve(child.waitStatus) });
    const acceptsCaughtSignals = environment.terminationTrapSignal === undefined && !this.activeSignalTrapEnvironments.has(environment);
    const stopWaiting = () => {
      if (this.getShellInterruptStatus({ environment }) !== undefined || (acceptsCaughtSignals && environment.shellImage.hasPendingSignal)) {
        resolve(undefined);
      }
    };
    const unsubscribeInterrupt = this.subscribeShellInterrupt({ environment, notify: stopWaiting });
    const unsubscribeSignal = acceptsCaughtSignals ? environment.shellImage.subscribeSignals({ notify: stopWaiting }) : undefined;
    environment.waitingForShellChild = true;
    try {
      stopWaiting();
      return await promise;
    } finally {
      delete environment.waitingForShellChild;
      unsubscribeInterrupt();
      unsubscribeSignal?.();
      unsubscribeChild();
    }
  }

  private requeueInterruptedWaitSignal({ environment }: { environment: WeshExecutionEnvironment }): void {
    const signal = environment.interruptedWaitSignal;
    if (signal !== undefined) {
      delete environment.interruptedWaitSignal;
      environment.shellImage.queueSignal({ signal });
      environment.shellImage.finishSignal();
    }
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
    body,
    args,
    assignments,
    environment,
    stdin,
    stdout,
    stderr,
    loopDepth,
    functionDepth,
  }: {
    body: WeshASTNode,
    args: string[],
    assignments: ReadonlyMap<string, string>,
    environment: WeshExecutionEnvironment,
    stdin: WeshFileHandle,
    stdout: WeshFileHandle,
    stderr: WeshFileHandle,
    loopDepth: number,
    functionDepth: number,
  }): Promise<WeshShellExecutionResult> {
    const previousArgs = [...environment.positionalArgs];
    environment.variables.enterFunction({ assignments });
    environment.positionalArgs = [...args];
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
        case 'exec':
          return result;
        default: {
          const _ex: never = result.controlFlow;
          throw new Error(`Unhandled control flow: ${JSON.stringify(_ex)}`);
        }
        }
      }
      return result;
    } finally {
      environment.variables.leaveScope();
      environment.positionalArgs = previousArgs;
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
          env: environment.variables,
          environment,
          escapeMode: 'standard',
        })
        : part.text;
      text += part.quoted
        ? escapeShellPatternLiteral({ text: expandedPart })
        : expandedPart;
    }
    return text;
  }

  private async expandConditionalOperand({
    raw,
    environment,
    context,
  }: {
    raw: string,
    environment: WeshExecutionEnvironment,
    context: 'word' | 'pattern' | 'regex',
  }): Promise<string> {
    const parts = await this.expandParameterOperandParts({
      operand: raw,
      env: environment.variables,
      environment,
      quoted: false,
    });
    let text = '';
    for (const part of parts) {
      if (!part.quoted) {
        text += part.text;
        continue;
      }
      switch (context) {
      case 'word':
        text += part.text;
        break;
      case 'pattern':
        text += escapeShellPatternLiteral({ text: part.text });
        break;
      case 'regex':
        text += part.text.replace(/[\\^$.*+?()[\]{}|]/g, '\\$&');
        break;
      default: {
        const _ex: never = context;
        throw new Error(`Unhandled conditional expansion: ${_ex}`);
      }
      }
    }
    return text;
  }

  private loadArithmeticEvaluator({ environment }: {
    environment: WeshExecutionEnvironment,
  }): Promise<typeof import('./shell/arithmetic')['evaluateShellArithmetic']> {
    return this.loadShellEvaluator({
      environment,
      load: async () => {
        const { evaluateShellArithmetic } = await import('./shell/arithmetic');
        this.arithmeticEvaluator = evaluateShellArithmetic;
        return evaluateShellArithmetic;
      },
    });
  }

  private loadConditionalEvaluator({ environment }: {
    environment: WeshExecutionEnvironment,
  }): Promise<typeof import('./shell/conditional')['evaluateShellConditional']> {
    return this.loadShellEvaluator({
      environment,
      load: async () => {
        const { evaluateShellConditional } = await import('./shell/conditional');
        this.conditionalEvaluator = evaluateShellConditional;
        return evaluateShellConditional;
      },
    });
  }

  private async loadShellEvaluator<T>({ environment, load }: {
    environment: WeshExecutionEnvironment,
    load: () => Promise<T>,
  }): Promise<T> {
    if (this.getShellInterruptStatus({ environment }) !== undefined) {
      throw new WeshCommandInterruptedError();
    }
    const interrupted = Promise.withResolvers<undefined>();
    const stopWaiting = () => {
      if (this.getShellInterruptStatus({ environment }) !== undefined) {
        interrupted.resolve(undefined);
      }
    };
    const unsubscribe = this.subscribeShellInterrupt({ environment, notify: stopWaiting });
    try {
      const evaluator = await Promise.race([load(), interrupted.promise]);
      if (evaluator === undefined || this.getShellInterruptStatus({ environment }) !== undefined) {
        throw new WeshCommandInterruptedError();
      }
      return evaluator;
    } finally {
      unsubscribe();
    }
  }

  private async executeConditionalCommand({ expression, environment, stdio }: {
    expression: WeshConditionalExpression,
    environment: WeshExecutionEnvironment,
    stdio: WeshShellStdio,
  }): Promise<WeshShellExecutionResult> {
    const cwd = environment.shellImage.cwd;
    let processSubstitutions: { path: string, redirectedEnd: WeshPipeEnd }[] | undefined;
    const checkActive = () => {
      if (this.getShellInterruptStatus({ environment }) !== undefined) {
        throw new WeshCommandInterruptedError();
      }
    };
    try {
      const evaluateShellConditional = this.conditionalEvaluator ?? await this.loadConditionalEvaluator({ environment });
      const exitCode = await evaluateShellConditional({
        expression,
        expand: ({ operand, context }) => {
          if (typeof operand === 'string') {
            return this.expandConditionalOperand({ raw: operand, context, environment });
          }
          return this.openProcessSubstitutionPath({ node: operand, environment, stdio }).then(({ path, redirectedEnd }) => {
            (processSubstitutions ??= []).push({ path, redirectedEnd });
            return path;
          });
        },
        evaluateNumber: async ({ expression: operand }) => {
          try {
            return this.evaluateArithmeticExpression({
              expression: operand,
              evaluate: this.arithmeticEvaluator ?? await this.loadArithmeticEvaluator({ environment }),
              env: environment.variables,
              executionOptions: environment.executionOptions,
              context: 'command',
            });
          } catch (error: unknown) {
            if (!(error instanceof WeshArithmeticError)) {
              throw error;
            }
            await this.writeErrorText({ stderr: stdio.stderr, text: `wesh: [[: ${error.message}\n` });
            return undefined;
          }
        },
        getVariable: ({ name }) => environment.variables.get({ name }),
        cwd,
        files: this.vfs,
        checkActive,
      });
      return this.getForegroundInterruptResult({ environment }) ?? { exitCode };
    } catch (error: unknown) {
      if (error instanceof WeshCommandInterruptedError) {
        const result = this.getForegroundInterruptResult({ environment });
        if (result !== undefined) {
          return result;
        }
      }
      throw error;
    } finally {
      if (processSubstitutions !== undefined) {
        for (const { path } of processSubstitutions) {
          this.vfs.unregisterSpecialFile({ path });
        }
        const failure = await closeFileHandleReferences({ handles: processSubstitutions.map(({ redirectedEnd }) => redirectedEnd) });
        if (failure !== undefined) {
          await this.writeProcessCleanupError({ stderr: stdio.stderr, error: failure.error });
        }
      }
    }
  }

  private evaluateShellArgv({ command, args, cwd, argumentEntryRefs, environment, stdin, stdout, stderr, loopDepth, functionDepth, functionLookup, searchPathOverride, forwardedRedirections, hasCommandAssignments }: {
    command: string,
    args: string[],
    cwd: string,
    argumentEntryRefs: readonly (WeshEntryRef | undefined)[] | undefined,
    environment: WeshExecutionEnvironment,
    stdin: WeshFileHandle,
    stdout: WeshFileHandle,
    stderr: WeshFileHandle,
    loopDepth: number,
    functionDepth: number,
    functionLookup: 'allow' | 'bypass',
    searchPathOverride: string | undefined,
    forwardedRedirections: WeshForwardedRedirections | undefined,
    hasCommandAssignments: boolean,
  }): Promise<WeshShellExecutionResult> {
    return this.executeCommandNode({
      node: {
        kind: 'command',
        assignments: [],
        name: command,
        args,
        redirections: [],
      },
      environment,
      stdin,
      stdout,
      stderr,
      loopDepth,
      functionDepth,
      directInvocation: { command, args, cwd, argumentEntryRefs, functionLookup, searchPathOverride, forwardedRedirections, hasCommandAssignments },
    });
  }

  private createExecutionEnvironment({
    shellPid,
    pgid,
    variables,
    aliases,
    functions,
    fds,
    traps,
    shellOptions,
    positionalArgs,
    shellImage,
  }: {
    shellPid: number,
    pgid: number,
    variables: WeshShellVariables,
    aliases: Map<string, string>,
    functions: Map<string, WeshASTNode>,
    fds: Map<number, WeshFileHandle>,
    traps: Map<string, WeshTrapDisposition>,
    shellOptions: Map<WeshShellOption, boolean>,
    positionalArgs: string[],
    shellImage: WeshShellImage,
  }): WeshExecutionEnvironment {
    const environment: WeshExecutionEnvironment = {
      foregroundSignal: undefined,
      shellPid,
      shellRootPid: shellPid,
      pgid,
      variables,
      aliases,
      functions,
      fds,
      traps,
      shellOptions,
      executionOptions: variables.executionOptions,
      positionalArgs,
      getoptsState: undefined,
      shellImage,
      commandSubstitutionSequence: 0,
      lastCommandSubstitutionExitCode: 0,
      ownedPersistentFds: new Set(),
      scopedRedirectionFds: new Set(),
    };
    this.syncSpecialParameters({
      environment,
    });
    return environment;
  }

  private forkExecutionEnvironment({ environment }: {
    environment: WeshExecutionEnvironment,
  }): WeshExecutionEnvironment {
    const traps = new Map<string, WeshTrapDisposition>();
    for (const [condition, disposition] of environment.traps) {
      if (disposition.kind === 'ignore' && (condition === 'EXIT' || linuxSignalByName({ name: condition }) !== undefined)) {
        traps.set(condition, disposition);
      }
    }
    // A fork lists the parent's definitions until the child assigns a trap.
    const inheritedTrapListing = environment.inheritedTrapListing ?? (
      traps.size === environment.traps.size ? undefined : new Map(environment.traps)
    );

    const variables = environment.variables.clone({ mapStrategy: 'snapshot_copy' });
    return {
      foregroundSignal: environment.foregroundSignal,
      shellPid: environment.shellPid,
      shellRootPid: environment.shellRootPid,
      pgid: environment.pgid,
      variables,
      aliases: new Map(environment.aliases),
      functions: new Map(environment.functions),
      fds: new Map(environment.fds),
      traps,
      inheritedTrapListing,
      inheritedSignalDispositions: environment.inheritedSignalDispositions,
      shellOptions: new Map(environment.shellOptions),
      executionOptions: variables.executionOptions,
      positionalArgs: [...environment.positionalArgs],
      getoptsState: environment.getoptsState === undefined ? undefined : { ...environment.getoptsState },
      shellImage: new WeshShellImage({ cwd: environment.shellImage.cwd, lastPid: environment.shellImage.children.lastPid }),
      commandSubstitutionSequence: environment.commandSubstitutionSequence,
      lastCommandSubstitutionExitCode: environment.lastCommandSubstitutionExitCode,
      ownedPersistentFds: new Set(),
      scopedRedirectionFds: new Set(),
    };
  }

  private async runChildExecutionEnvironment({
    environment,
    cleanupStderr,
    stdio,
    execute,
  }: {
    environment: WeshExecutionEnvironment,
    cleanupStderr?: WeshFileHandle,
    stdio?: WeshShellStdio,
    execute: () => Promise<WeshShellExecutionResult>,
  }): Promise<WeshCommandResult> {
    const resolveStdio = stdio === undefined ? undefined : this.createStdioResolver({ environment, ...stdio });
    let result: WeshCommandResult | undefined;
    let waitStatus: WeshWaitStatus | undefined;
    try {
      const evaluate = async () => {
        let result = resolveStdio === undefined
          ? await execute()
          : await this.evaluateShellToCompletion({ environment, resolveStdio, execute });
        if (this.getShellTerminationStatus({ environment }) !== undefined && !isExecCompletion({ result })) {
          result = await this.finishShellTermination({ environment, resolveStdio: resolveStdio ?? (() => this.getShellStdio({ environment })) });
        }
        this.recordShellSignalExit({ environment, waitStatus: result.waitStatus });
        return result;
      };
      const { foregroundSignal, pgid } = environment;
      const childResult = foregroundSignal === undefined
        ? await evaluate()
        : await this.runWithForegroundProcessGroup({ pgid, foregroundSignal, shell: environment, fn: evaluate });
      result = toWeshCommandResult({ result: childResult });
    } catch (error: unknown) {
      const stopped = this.getForegroundInterruptResult({ environment });
      if (stopped === undefined) {
        if (error instanceof WeshShellExecutionError) {
          result = { exitCode: error.exitCode };
        }
        throw error;
      }
      result = this.getShellTerminationStatus({ environment }) === undefined
        ? toWeshCommandResult({ result: stopped })
        : toWeshCommandResult({
          result: await this.finishShellTermination({ environment, resolveStdio: resolveStdio ?? (() => this.getShellStdio({ environment })) }),
        });
    } finally {
      waitStatus = await this.finishChildExecutionEnvironment({ environment, result, cleanupStderr });
    }
    return waitStatus === undefined ? result : { exitCode: weshWaitStatusToExitCode({ waitStatus }), waitStatus };
  }

  private async finishChildExecutionEnvironment({
    environment,
    result,
    cleanupStderr,
  }: {
    environment: WeshExecutionEnvironment,
    result: WeshCommandResult | undefined,
    cleanupStderr?: WeshFileHandle,
  }): Promise<WeshWaitStatus | undefined> {
    const process = this.kernel.getProcess({ pid: environment.shellPid });
    if (process === undefined) {
      return;
    }

    const waitStatus = this.getProcessExitStatus({ process, result });
    if (process.waitStatus !== waitStatus) {
      this.kernel.recordWaitStatus({ process, waitStatus });
    }

    switch (waitStatus.kind) {
    case 'stopped':
      return waitStatus;
    case 'exited':
    case 'signaled': {
      environment.shellImage.retire({ status: waitStatus });
      // Cleanup can report to the child's effective stderr after the parent has
      // left. Hold this reference only while the descriptors are being closed.
      const stderr = process.fds.get(2) ?? closedFileDescriptor;
      const diagnosticStderr = cleanupStderr ?? this.kernel.duplicateFileDescriptor({ handle: stderr });
      try {
        const closeFailure = await this.closeAndReapProcess({
          pid: process.pid,
          additionalHandles: this.takeOwnedPersistentFileHandles({ environment }),
        });
        if (closeFailure !== undefined) {
          await this.writeProcessCleanupError({ stderr: diagnosticStderr, error: closeFailure.error });
        }
      } finally {
        if (cleanupStderr === undefined && diagnosticStderr !== stderr) {
          const failure = await closeFileHandleReferences({ handles: [diagnosticStderr] });
          if (failure !== undefined) {
            this.recordProcessCloseFailure({ process });
          }
        }
      }
      return process.waitStatus ?? waitStatus;
    }
    default: {
      const _ex: never = waitStatus;
      throw new Error(`Unhandled child shell wait status: ${JSON.stringify(_ex)}`);
    }
    }
  }

  private async closeAndReapProcess({ pid, additionalHandles }: {
    pid: number,
    additionalHandles: readonly WeshFileHandle[],
  }): Promise<{ error: unknown } | undefined> {
    let closeFailure = await closeFileHandleReferences({ handles: additionalHandles });
    try {
      await this.kernel.closeProcessResources({ pid });
    } catch (error: unknown) {
      closeFailure ??= { error };
    }
    const process = this.kernel.getProcess({ pid });
    if (process !== undefined) {
      if (process.waitStatus === undefined) {
        this.kernel.recordWaitStatus({ process, waitStatus: { kind: 'exited', exitCode: 1 } });
      }
      if (closeFailure !== undefined) {
        this.recordProcessCloseFailure({ process });
      }
    }
    this.kernel.reapProcess({ pid });
    return closeFailure;
  }

  private recordProcessCloseFailure({ process }: { process: WeshProcess }): void {
    if (process.exitCode === 0) {
      this.kernel.recordWaitStatus({ process, waitStatus: { kind: 'exited', exitCode: 1 } });
    }
  }

  private async writeProcessCleanupError({ stderr, error }: { stderr: WeshFileHandle, error: unknown }): Promise<void> {
    const message = error instanceof Error ? error.message : String(error);
    await this.writeErrorText({ stderr, text: `wesh: ${message}\n` }).catch(() => {});
  }

  private async openProcessSubstitutionPath({ node, environment, stdio }: {
    node: WeshProcessSubstitutionNode,
    environment: WeshExecutionEnvironment,
    stdio: WeshShellStdio,
  }): Promise<{ path: string, task: Promise<WeshCommandResult>, redirectedEnd: WeshPipeEnd }> {
    const { task, redirectedEnd } = await this.startProcessSubstitution({ node, environment, stdio });
    const path = `/dev/fd/${this.nextProcessSubstitutionId++}`;
    this.vfs.registerSpecialFile({
      path,
      type: 'fifo',
      handler: () => this.cloneFileHandleReference({ handle: redirectedEnd }),
    });
    return { path, task, redirectedEnd };
  }

  private async startProcessSubstitution({ node, environment, stdio }: {
    node: WeshProcessSubstitutionNode,
    environment: WeshExecutionEnvironment,
    stdio: WeshShellStdio,
  }): Promise<{ task: Promise<WeshCommandResult>, redirectedEnd: WeshPipeEnd }> {
    const { read, write } = await this.kernel.pipe();
    const { childStdio, childEnd, redirectedEnd } = (() => {
      switch (node.type) {
      case 'input':
        return { childStdio: { ...stdio, stdout: write }, childEnd: write, redirectedEnd: read };
      case 'output':
        return { childStdio: { ...stdio, stdin: read }, childEnd: read, redirectedEnd: write };
      default: {
        const _ex: never = node.type;
        throw new Error(`Unhandled process substitution type: ${_ex}`);
      }
      }
    })();
    let child: WeshExecutionEnvironment;
    try {
      child = await this.spawnChildExecutionEnvironment({
        parentEnvironment: environment,
        childEnvironment: this.forkExecutionEnvironment({ environment }),
        pgid: environment.pgid,
        foregroundSignal: environment.foregroundSignal,
        stdio: childStdio,
      });
    } catch (error: unknown) {
      await closeFileHandleReferences({ handles: [read, write] });
      throw error;
    }
    // The child now owns its reference. An exec in the child can close the end before it exits.
    await childEnd.close();
    const stopped = this.getForegroundInterruptResult({ environment });
    if (stopped !== undefined) {
      await redirectedEnd.close();
      await this.finishChildExecutionEnvironment({ environment: child, result: stopped, cleanupStderr: stdio.stderr });
      throw new WeshCommandInterruptedError();
    }
    const childDescriptors = this.getShellStdio({ environment: child });
    this.kernel.registerProcessSubstitutionPipe({ handle: redirectedEnd, peerPid: child.shellPid });
    const task = this.runChildExecutionEnvironment({
      environment: child,
      stdio: childDescriptors,
      execute: () => this.executeNode({ node: node.list, environment: child, ...childDescriptors }),
    });
    environment.shellImage.children.register({ pid: child.shellPid, job: 'process-substitution', task });
    environment.variables.setSpecial({ name: '!', value: child.shellPid.toString() });
    return { task, redirectedEnd };
  }

  private async spawnChildExecutionEnvironment({
    parentEnvironment,
    childEnvironment,
    pgid,
    foregroundSignal,
    stdio,
    backgroundJob,
    waiting,
  }: {
    parentEnvironment: WeshExecutionEnvironment,
    childEnvironment: WeshExecutionEnvironment,
    pgid: number | undefined,
    foregroundSignal: AbortSignal | undefined,
    stdio: WeshShellStdio,
    backgroundJob?: true,
    waiting?: WeshChildWait,
  }): Promise<WeshExecutionEnvironment> {
    childEnvironment.foregroundSignal = foregroundSignal;
    if (backgroundJob === true) {
      // In the absence of job control, asynchronous commands start with
      // SIGINT and SIGQUIT ignored. Shell code can install its own traps.
      childEnvironment.traps.set('SIGINT', { kind: 'ignore' });
      childEnvironment.traps.set('SIGQUIT', { kind: 'ignore' });
    }
    for (const [fd, handle] of [[0, stdio.stdin], [1, stdio.stdout], [2, stdio.stderr]] as const) {
      if (handle === closedFileDescriptor) {
        childEnvironment.fds.delete(fd);
      } else {
        childEnvironment.fds.set(fd, handle);
      }
    }
    const fds = this.cloneFileDescriptorTable({ fdTable: childEnvironment.fds });
    let pid: number;
    try {
      ({ pid } = await this.kernel.spawn({
        image: 'wesh',
        args: ['wesh', '-c'],
        env: childEnvironment.variables.exportedEntries({ assignments: undefined }),
        cwd: childEnvironment.shellImage.cwd,
        fds,
        ppid: parentEnvironment.shellPid,
        pgid: pgid,
        foregroundSignal,
        backgroundJob,
        onSpawn: waiting === undefined ? undefined : ({ process }) => {
          waiting.children.push(process);
        },
        signalDispositions: this.buildProcessSignalDispositions({
          environment: childEnvironment,
        }),
      }));
    } catch (error: unknown) {
      await closeFileHandleReferences({ handles: fds.values() });
      throw error;
    }
    childEnvironment.fds = fds;
    childEnvironment.shellPid = pid;
    childEnvironment.pgid = pgid ?? pid;
    const stopped = this.getForegroundInterruptResult({ environment: parentEnvironment });
    if (stopped !== undefined) {
      await this.finishChildExecutionEnvironment({ environment: childEnvironment, result: stopped, cleanupStderr: stdio.stderr });
      throw new WeshCommandInterruptedError();
    }
    const process = this.kernel.getProcess({ pid });
    if (process !== undefined) {
      this.bindShellSignalHandler({ process, environment: childEnvironment });
    }
    this.syncSpecialParameters({ environment: childEnvironment });
    return childEnvironment;
  }

  private async runErrTrapIfNeeded({ result, environment, stdin, stdout, stderr }: {
    result: WeshShellExecutionResult,
    environment: WeshExecutionEnvironment,
    stdin: WeshFileHandle,
    stdout: WeshFileHandle,
    stderr: WeshFileHandle,
  }): Promise<WeshShellExecutionResult | undefined> {
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
      return await this.runTrapScript({
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
    if (environment.execResult !== undefined) {
      return environment.execResult;
    }
    const exitTrap = environment.traps.get('EXIT');
    if (isExecCompletion({ result }) || environment.runningExitTrap || exitTrap === undefined || exitTrap.kind !== 'run') {
      return result;
    }

    environment.runningExitTrap = true;
    environment.exitTrapRan = true;
    try {
      const trapResult = await this.runTrapScript({
        script: exitTrap.action,
        trapStatus: result.waitStatus ?? { kind: 'exited', exitCode: result.exitCode },
        environment,
        stdin,
        stdout,
        stderr,
      });
      return isExecCompletion({ result: trapResult }) || trapResult.controlFlow?.kind === 'exit'
        ? trapResult
        : environment.execResult ?? result;
    } finally {
      environment.runningExitTrap = false;
    }
  }

  private async evaluateShellToCompletion({ environment, resolveStdio, execute, skipExitTrap }: {
    environment: WeshExecutionEnvironment,
    resolveStdio: () => WeshShellStdio,
    execute: () => Promise<WeshShellExecutionResult>,
    skipExitTrap?: true,
  }): Promise<WeshShellExecutionResult> {
    let result: WeshShellExecutionResult;
    try {
      result = await execute();
    } catch (error: unknown) {
      if (environment.execResult !== undefined) {
        return this.reportExecCleanupFailure({ environment, result: environment.execResult, error, stderr: resolveStdio().stderr });
      }
      const stopped = this.getForegroundInterruptResult({ environment });
      if (stopped !== undefined) {
        result = stopped;
      } else if (error instanceof WeshShellExecutionError) {
        await this.writeErrorText({ stderr: resolveStdio().stderr, text: `wesh: ${error.message}\n`, environment });
        result = { exitCode: error.exitCode };
      } else {
        throw error;
      }
    }
    return this.completeShellEvaluation({ result, environment, resolveStdio, skipExitTrap });
  }

  private async completeShellEvaluation({ result, environment, resolveStdio, skipExitTrap }: {
    result: WeshShellExecutionResult,
    environment: WeshExecutionEnvironment,
    resolveStdio: ReturnType<Wesh['createStdioResolver']>,
    skipExitTrap?: true,
  }): Promise<WeshShellExecutionResult> {
    if (isExecCompletion({ result }) || environment.execResult !== undefined) {
      return environment.execResult ?? result;
    }
    if (this.getShellTerminationStatus({ environment }) !== undefined) {
      return this.finishShellTermination({ environment, resolveStdio });
    }
    const interrupted = this.getForegroundInterruptResult({ environment });
    if (this.getShellRetirementStatus({ environment }) !== undefined) {
      return interrupted ?? result;
    }
    if (interrupted !== undefined) {
      await this.runForegroundInterruptTrap({ environment, ...resolveStdio() });
    }
    const trapped = interrupted === undefined && this.hasPendingSignalTraps({ environment })
      ? await this.runPendingSignalTraps({ environment, exitCode: result.exitCode, resolveStdio })
      : undefined;
    const completion = interrupted ?? trapped ?? result;
    const afterTrap = skipExitTrap ? completion : await this.runExitTrapIfNeeded({ result: completion, environment, ...resolveStdio() });
    if (isExecCompletion({ result: afterTrap })) {
      return afterTrap;
    }
    if (this.getShellTerminationStatus({ environment }) !== undefined) {
      return this.finishShellTermination({ environment, resolveStdio });
    }
    const finalInterrupt = this.getForegroundInterruptResult({ environment });
    if (interrupted === undefined && finalInterrupt !== undefined) {
      await this.runForegroundInterruptTrap({ environment, ...resolveStdio() });
    }
    return finalInterrupt ?? afterTrap;
  }

  private async finishShellTermination({ environment, resolveStdio }: {
    environment: WeshExecutionEnvironment,
    resolveStdio: () => WeshShellStdio,
  }): Promise<WeshShellExecutionResult> {
    const image = environment.shellImage;
    const termination = image.termination!;
    if ((termination.unwindOwner === undefined || termination.unwindOwner === environment) && image.claimExitTrap()) {
      if (termination.status.signal !== 9 && environment.exitTrapRan !== true) {
        environment.terminationTrapSignal = termination.status;
        try {
          const trapped = await this.runExitTrapIfNeeded({
            result: { exitCode: termination.lastExitCode },
            environment,
            ...resolveStdio(),
          });
          if (isExecCompletion({ result: trapped })) {
            if (environment.replacedProcess === true) {
              return trapped;
            }
            const process = this.kernel.getProcess({ pid: environment.shellPid });
            if (image.termination === termination && process !== undefined && process.waitStatus === undefined) {
              const waitStatus = { kind: 'exited', exitCode: trapped.exitCode } as const;
              this.kernel.recordWaitStatus({ process, waitStatus });
              return { ...trapped, waitStatus };
            }
          }
        } catch (error: unknown) {
          await this.writeProcessCleanupError({ stderr: resolveStdio().stderr, error });
        } finally {
          delete environment.terminationTrapSignal;
        }
      }
      const status = image.termination!.status;
      const process = this.kernel.getProcess({ pid: environment.shellPid });
      if (process !== undefined && process.waitStatus === undefined) {
        this.kernel.recordWaitStatus({ process, waitStatus: status });
      }
    }
    const waitStatus = image.termination!.status;
    const exitCode = weshWaitStatusToExitCode({ waitStatus });
    return { waitStatus, exitCode, controlFlow: { kind: 'exit', exitCode } };
  }

  private hasPendingSignalTraps({ environment }: { environment: WeshExecutionEnvironment }): boolean {
    return environment.pendingSubstitutionInterrupt === true
      || (environment.pendingSelfSignals?.size ?? 0) > 0
      || environment.shellImage.hasPendingSignal;
  }

  private async runPendingSignalTraps({ exitCode, environment, resolveStdio }: {
    exitCode: number,
    environment: WeshExecutionEnvironment,
    resolveStdio: (() => WeshShellStdio) | undefined,
  }): Promise<WeshShellExecutionResult | undefined> {
    if (environment.terminationTrapSignal !== undefined || this.activeSignalTrapEnvironments.has(environment)) {
      return undefined;
    }
    if (environment.pendingSubstitutionInterrupt === true) {
      delete environment.pendingSubstitutionInterrupt;
      // A real delivery and the death of the substitution may report the same INT.
      if (!environment.shellImage.hasPendingSignal || !environment.shellImage.hasQueuedSignal({ signal: 2 })) {
        const action = findSignalTrapAction({ signal: 2, traps: environment.traps });
        if (action !== undefined) {
          const result = await this.runCaughtSignalTrap({ action, exitCode, environment, stdio: resolveStdio?.() ?? this.getShellStdio({ environment }) });
          if (result !== undefined) {
            return result;
          }
        } else {
          const shell = this.kernel.getProcess({ pid: environment.shellPid });
          if (shell !== undefined && this.hasDefaultInterruptDisposition({ process: shell, traps: environment.traps })) {
            this.interruptFromCommandSubstitution({ environment, waitStatus: { kind: 'signaled', signal: 2 } });
            return this.getForegroundInterruptResult({ environment });
          }
        }
      }
    }
    const selfSignals = environment.pendingSelfSignals;
    if (selfSignals !== undefined) {
      for (const [signal, action] of selfSignals) {
        selfSignals.delete(signal);
        const result = await this.runCaughtSignalTrap({ action, exitCode, environment, stdio: resolveStdio?.() ?? this.getShellStdio({ environment }) });
        if (result !== undefined) {
          return result;
        }
      }
    }
    let signal = environment.shellImage.claimSignal();
    while (signal !== undefined) {
      const stdio = resolveStdio?.() ?? this.getShellStdio({ environment });
      const result = await this.runClaimedSignalTrap({ signal, exitCode, environment, ...stdio });
      if (result !== undefined) {
        return result;
      }
      signal = environment.shellImage.claimSignal();
    }
    return undefined;
  }

  private async runClaimedSignalTrap({ signal, exitCode, environment, stdin, stdout, stderr }: {
    signal: number,
    exitCode: number,
    environment: WeshExecutionEnvironment,
    stdin: WeshFileHandle,
    stdout: WeshFileHandle,
    stderr: WeshFileHandle,
  }): Promise<WeshShellExecutionResult | undefined> {
    try {
      const action = findSignalTrapAction({ signal, traps: environment.traps });
      if (action !== undefined) {
        return await this.runCaughtSignalTrap({ action, exitCode, environment, stdio: { stdin, stdout, stderr } });
      }
      // A preceding trap may have restored this signal's default action.
      await this.kernel.kill({ pid: environment.shellPid, signal });
      return this.getForegroundInterruptResult({ environment });
    } finally {
      environment.shellImage.finishSignal();
    }
  }

  private async runCaughtSignalTrap({ action, exitCode, environment, stdio }: {
    action: string,
    exitCode: number,
    environment: WeshExecutionEnvironment,
    stdio: WeshShellStdio,
  }): Promise<WeshShellExecutionResult | undefined> {
    const result = await this.runTrapScript({ script: action, trapStatus: { kind: 'exited', exitCode }, environment, ...stdio });
    return result.controlFlow === undefined ? this.getForegroundInterruptResult({ environment }) : result;
  }

  private runForegroundInterruptTrap({ environment, stdin, stdout, stderr }: {
    environment: WeshExecutionEnvironment,
    stdin: WeshFileHandle,
    stdout: WeshFileHandle,
    stderr: WeshFileHandle,
  }): Promise<void> {
    const waitStatus = this.getShellEvaluationInterrupt({ environment });
    if (waitStatus === undefined) {
      return Promise.resolve();
    }
    return this.runSignalTrapIfNeeded({ waitStatus, environment, stdin, stdout, stderr, trigger: 'foreground-interrupt' });
  }

  private async runSignalTrapIfNeeded({ waitStatus, environment, stdin, stdout, stderr, trigger }: {
    waitStatus: Extract<WeshWaitStatus, { kind: 'signaled' }>,
    environment: WeshExecutionEnvironment,
    stdin: WeshFileHandle,
    stdout: WeshFileHandle,
    stderr: WeshFileHandle,
    trigger?: 'foreground-interrupt',
  }): Promise<void> {
    const { signal } = waitStatus;
    // A cancelled shell evaluation owns its SIGINT trap. Kernel signals issued
    // independently of that evaluation still use their process's disposition.
    if (this.getShellEvaluationInterrupt({ environment })?.signal === signal && trigger === undefined) {
      return;
    }
    for (const condition of weshSignalConditionNames({ signal: signal })) {
      const trapDisposition = environment.traps.get(condition);
      if (trapDisposition === undefined) {
        continue;
      }

      switch (trapDisposition.kind) {
      case 'ignore':
        return;
      case 'run': {
        // A group delivery can reach several processes evaluating this shell.
        let handled = this.handledSignalTraps.get(environment);
        if (handled?.has(waitStatus) === true) {
          return;
        }
        if (handled === undefined) {
          handled = new WeakSet();
          this.handledSignalTraps.set(environment, handled);
        }
        handled.add(waitStatus);
        const alreadyHandlingSignal = this.activeSignalTrapEnvironments.has(environment);
        this.activeSignalTrapEnvironments.add(environment);
        try {
          await this.runTrapScript({
            script: trapDisposition.action,
            trapStatus: waitStatus,
            environment: environment,
            stdin: stdin,
            stdout: stdout,
            stderr: stderr,
          });
        } finally {
          if (!alreadyHandlingSignal) {
            this.activeSignalTrapEnvironments.delete(environment);
          }
        }
        return;
      }
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
  }): Promise<WeshShellExecutionResult> {
    const foregroundSignal = environment.foregroundSignal;
    if (this.getShellEvaluationInterrupt({ environment }) !== undefined) {
      // An interrupted command still runs the trap selected by the shell.
      environment.foregroundSignal = undefined;
    }
    const previousQuestionMark = environment.variables.get({ name: '?' });
    environment.variables.setSpecial({
      name: '?',
      value: weshWaitStatusToExitCode({ waitStatus: trapStatus }).toString(),
    });
    try {
      return await this.executeShellInState({
        source: createTextShellSource({ text: script }),
        environment: environment,
        stdin: stdin,
        stdout: stdout,
        stderr: stderr,
        history: 'ignore',
        loopDepth: 0,
        allowReturn: false,
      });
    } finally {
      environment.foregroundSignal = foregroundSignal;
      environment.variables.setSpecial({ name: '?', value: previousQuestionMark });
    }
  }

  private getProcessSignalResult({ process }: { process: WeshProcess }): WeshCommandResult | undefined {
    const { pid, waitStatus } = process;
    if (waitStatus === undefined) {
      return undefined;
    }

    switch (waitStatus.kind) {
    case 'signaled':
    case 'stopped':
      this.kernel.consumePendingSignals({ pid });
      return { exitCode: weshWaitStatusToExitCode({ waitStatus }), waitStatus };
    case 'exited':
      return undefined;
    default: {
      const _ex: never = waitStatus;
      throw new Error(`Unhandled wait status: ${JSON.stringify(_ex)}`);
    }
    }
  }

  private async runWithForegroundProcessGroup<T>({ pgid, foregroundSignal, shell, fn }: {
    pgid: number,
    foregroundSignal: AbortSignal | undefined,
    shell: WeshExecutionEnvironment | undefined,
    fn: () => Promise<T>,
  }): Promise<T> {
    const scope = { pgid, foregroundSignal, shell };
    this.foregroundProcessGroupScopes.push(scope);
    try {
      return await fn();
    } finally {
      const scopeIndex = this.foregroundProcessGroupScopes.indexOf(scope);
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
      case 'ignore': {
        const signal = linuxSignalByName({ name: condition })?.number;
        if (signal !== undefined && signal !== 9 && signal !== 19) {
          signalDispositions.set(signal, 'ignore');
        }
        break;
      }
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

  private syncSpecialParameters({ environment }: {
    environment: WeshExecutionEnvironment,
  }): void {
    const { variables } = environment;
    const previousPositionalCount = Number.parseInt(variables.get({ name: '#' }) ?? '0', 10);
    variables.setSpecial({ name: '$$', value: environment.shellRootPid.toString() });
    variables.setSpecial({ name: 'BASHPID', value: environment.shellPid.toString() });
    variables.setSpecial({ name: 'PPID', value: (this.kernel.getProcess({ pid: environment.shellPid })?.ppid ?? 0).toString() });
    variables.setSpecial({ name: '#', value: environment.positionalArgs.length.toString() });
    if (variables.get({ name: '0' }) === undefined) {
      variables.setSpecial({ name: '0', value: variables.get({ name: 'SHELL' }) ?? 'wesh' });
    }

    const positionalSlots = Math.max(previousPositionalCount, environment.positionalArgs.length, 9);
    for (let index = 1; index <= positionalSlots; index++) {
      variables.setSpecial({ name: index.toString(), value: environment.positionalArgs[index - 1] });
    }
    variables.setSpecial({ name: '!', value: environment.shellImage.children.lastPid?.toString() });
  }

  private async executeShellInState({ source, environment, stdin, stdout, stderr, history, loopDepth, allowReturn, syntaxCheck }: {
    source: ShellSource,
    environment: WeshExecutionEnvironment,
    stdin: WeshFileHandle,
    stdout: WeshFileHandle,
    stderr: WeshFileHandle,
    history: 'record' | 'ignore',
    loopDepth: number,
    allowReturn: boolean,
    syntaxCheck?: { readonly name: 'sh' | 'bash' },
  }): Promise<WeshShellExecutionResult> {
    if (history === 'record' && source.kind === 'text') {
      const normalizedScript = source.text.trim();
      if (normalizedScript.length > 0) {
        this.history.push(normalizedScript);
      }
    }

    const resolveStdio = this.createStdioResolver({ environment, stdin, stdout, stderr });
    const sourceHandle = 'handle' in source ? source.handle : undefined;
    const sourceUsesStdin = sourceHandle !== undefined
      && openFileDescription({ handle: sourceHandle }) === openFileDescription({ handle: stdin });
    const followsStdin = sourceUsesStdin && (environment.fds.get(0) ?? closedFileDescriptor) === stdin;
    let currentSourceHandle = sourceUsesStdin ? stdin : sourceHandle;
    if (followsStdin && currentSourceHandle === closedFileDescriptor) {
      return { exitCode: 0 };
    }
    let input = currentSourceHandle === undefined ? undefined : this.kernel.openInputForShell({
      pid: environment.shellPid,
      handle: currentSourceHandle,
      foregroundSignal: environment.foregroundSignal,
    });
    let reader = createShellSourceReader({ source, input });
    const sourceWait = 'text' in source ? undefined : new WeshHandleCloseSignal();
    const diagnosticName = syntaxCheck?.name ?? 'wesh';
    let closing: Promise<void> | undefined;
    const abortRead = () => {
      if (this.getShellInterruptStatus({ environment }) !== undefined) {
        sourceWait?.close();
        closing ??= input?.close();
        void closing?.catch(() => {});
      }
    };
    const unsubscribe = sourceWait === undefined ? undefined : this.subscribeShellInterrupt({ environment, notify: abortRead });
    if (sourceWait !== undefined) {
      abortRead();
    }
    let bufferedSource = '';
    let sourceCompletion: 'complete' | 'may-continue' = 'may-continue';
    let result: WeshShellExecutionResult = { exitCode: 0 };

    try {
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
          const reading = reader.read();
          const next: Awaited<ReturnType<typeof reader.read>> | undefined = sourceWait === undefined
            ? await reading
            : await sourceWait.raceWithClose({ operation: reading, buildClosedResult: () => undefined });
          const interrupted = this.getForegroundInterruptResult({ environment });
          if (interrupted !== undefined) {
            result = interrupted;
            return { kind: 'error' };
          }
          if (next === undefined) {
            throw new Error('Shell source closed while reading');
          }
          return {
            kind: 'read',
            completion: next.completion,
          };
        } catch (error: unknown) {
          const interrupted = this.getForegroundInterruptResult({ environment });
          if (interrupted !== undefined) {
            result = interrupted;
            return { kind: 'error' };
          }
          const message = error instanceof Error ? error.message : String(error);
          await this.writeErrorText({
            stderr: resolveStdio().stderr,
            text: `${diagnosticName}: ${message}\n`,
            environment,
          });
          result = { exitCode: syntaxCheck === undefined ? 1 : 2 };
          environment.variables.setSpecial({ name: '?', value: result.exitCode.toString() });
          return { kind: 'error' };
        }
      };

      while (true) {
        const interrupted = this.getForegroundInterruptResult({ environment });
        if (interrupted !== undefined) {
          return interrupted;
        }

        if (followsStdin) {
          const nextSourceHandle = environment.fds.get(0) ?? closedFileDescriptor;
          if (nextSourceHandle === closedFileDescriptor) {
            return result;
          }
          if (currentSourceHandle !== undefined && nextSourceHandle !== currentSourceHandle) {
            if (openFileDescription({ handle: nextSourceHandle }) !== openFileDescription({ handle: currentSourceHandle })) {
              closing ??= input?.close();
              await closing;
              closing = undefined;
              input = this.kernel.openInputForShell({
                pid: environment.shellPid,
                handle: nextSourceHandle,
                foregroundSignal: environment.foregroundSignal,
              });
              abortRead();
              reader = createShellSourceReader({ source: createHandleShellSource({ handle: nextSourceHandle }), input });
              sourceCompletion = 'may-continue';
            }
            currentSourceHandle = nextSourceHandle;
          }
        }
        if (input !== undefined) {
          bufferedSource = reader.getRetainedText();
        }
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
            bufferedSource = reader.getRetainedText();
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

        const stoppedAfterRead = this.getForegroundInterruptResult({ environment });
        if (stoppedAfterRead !== undefined) {
          return stoppedAfterRead;
        }
        if (this.hasPendingSignalTraps({ environment }) && environment.terminationTrapSignal === undefined
            && !this.activeSignalTrapEnvironments.has(environment)) {
          const exitCode = Number(environment.variables.get({ name: '?' }) ?? 0);
          const trapResult = await this.runPendingSignalTraps({ exitCode, environment, resolveStdio });
          if (trapResult !== undefined) {
            return trapResult;
          }
          // A trap can consume the retained input or replace its descriptor.
          continue;
        }

        let parsedUnit: ReturnType<typeof parseNextShellUnit>;
        try {
          parsedUnit = parseNextShellUnit({
            commandLine: bufferedSource,
            sourceCompletion,
          });
        } catch (error: unknown) {
          const message = error instanceof Error ? error.message : String(error);
          await this.writeErrorText({
            stderr: resolveStdio().stderr,
            text: `${diagnosticName}: ${message}\n`,
            environment,
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
            bufferedSource = reader.getRetainedText();
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

        const unitStdio = resolveStdio();
        for (const warning of parsedUnit.warnings ?? []) {
          await this.writeErrorText({ stderr: unitStdio.stderr, text: `${diagnosticName}: warning: ${warning}\n`, environment });
        }

        if (syntaxCheck !== undefined || (parsedUnit.node.kind === 'list' && parsedUnit.node.parts.length === 0)) {
          continue;
        }

        try {
          result = await this.executeNode({
            node: parsedUnit.node,
            environment,
            ...unitStdio,
            loopDepth,
            functionDepth: allowReturn ? 1 : 0,
          });
        } catch (error: unknown) {
          if (environment.execResult !== undefined) {
            return this.reportExecCleanupFailure({ environment, result: environment.execResult, error, stderr: unitStdio.stderr });
          }
          const stopped = this.getForegroundInterruptResult({ environment });
          if (stopped !== undefined) {
            if (environment.shellImage.termination?.unwindOwner === environment
                && this.getShellTerminationStatus({ environment }) !== undefined) {
              return this.finishShellTermination({ environment, resolveStdio });
            }
            return stopped;
          }
          const message = error instanceof Error ? error.message : String(error);
          await this.writeErrorText({ stderr: unitStdio.stderr, text: `wesh: ${message}\n`, environment });
          result = {
            exitCode: error instanceof WeshShellExecutionError
              ? error.exitCode
              : 1,
          };
          environment.variables.setSpecial({ name: '?', value: result.exitCode.toString() });
          if (error instanceof WeshShellExecutionError) {
            switch (error.disposition) {
            case 'continue':
            case 'abort-unit':
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

        if (environment.shellImage.termination?.unwindOwner === environment
            && this.getShellTerminationStatus({ environment }) !== undefined) {
          return this.finishShellTermination({ environment, resolveStdio });
        }
        if (result.controlFlow !== undefined) {
          return result;
        }
      }
    } finally {
      unsubscribe?.();
      if (input !== undefined) {
        await (closing ?? input.close());
      }
    }
  }

}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
