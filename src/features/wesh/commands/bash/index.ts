import { canonicalizeExistingPath, resolvePath } from '@/features/wesh/path';
import {
  createHandleShellSource,
  createTextShellSource,
  type ShellSource,
} from '@/features/wesh/shell/source';
import type { ShellInvocation } from '@/features/wesh/shell/invocation';
import type {
  WeshCommandContext,
  WeshCommandDefinition,
  WeshCommandResult,
  WeshFileHandle,
  WeshStat,
} from '@/features/wesh/types';
import {
  applyBashStartupEnvironmentOptions,
  parseBashArgv,
  type BashInvocationPlan,
} from './argv';



const BASH_BINARY_PROBE_BYTES = 80;

type BashScriptPrefixChunkInspection = 'binary' | 'line-end' | 'continue';

function inspectBashScriptPrefixChunk({ chunk }: {
  chunk: Uint8Array,
}): BashScriptPrefixChunkInspection {
  const newlineIndex = chunk.indexOf(0x0a);
  const nulIndex = chunk.indexOf(0x00);
  if (nulIndex >= 0 && (newlineIndex < 0 || nulIndex < newlineIndex)) {
    return 'binary';
  }
  return newlineIndex >= 0 ? 'line-end' : 'continue';
}

async function hasBashBinaryScriptPrefix({ handle }: {
  handle: WeshFileHandle,
}): Promise<boolean> {
  const buffer = new Uint8Array(BASH_BINARY_PROBE_BYTES);
  let totalRead = 0;

  while (totalRead < buffer.length) {
    const remaining = buffer.length - totalRead;
    const { bytesRead } = await handle.read({
      buffer,
      offset: totalRead,
      length: remaining,
      position: totalRead,
    });
    if (bytesRead < 0 || bytesRead > remaining) {
      throw new Error(`Invalid Bash script prefix read length: ${bytesRead}`);
    }
    if (bytesRead === 0) {
      break;
    }

    const chunkEnd = totalRead + bytesRead;
    const inspection = inspectBashScriptPrefixChunk({
      chunk: buffer.subarray(totalRead, chunkEnd),
    });
    switch (inspection) {
    case 'binary':
      return true;
    case 'line-end':
      return false;
    case 'continue':
      totalRead = chunkEnd;
      break;
    default: {
      const _ex: never = inspection;
      throw new Error(`Unhandled Bash script prefix inspection: ${_ex}`);
    }
    }
  }

  return false;
}


type PreparedBashScriptSource =
  | { readonly kind: 'binary' }
  | { readonly kind: 'source', readonly source: ShellSource };

function createPrefixedHandleShellSource({ prefix, handle }: {
  prefix: Uint8Array,
  handle: WeshFileHandle,
}): ShellSource {
  let prefixOffset = 0;
  return {
    kind: 'bytes',
    async read({ maximumBytes }) {
      if (!Number.isSafeInteger(maximumBytes) || maximumBytes <= 0) {
        throw new Error('Bash script source maximumBytes must be a positive safe integer');
      }
      if (prefixOffset < prefix.length) {
        const end = Math.min(prefix.length, prefixOffset + maximumBytes);
        const chunk = prefix.subarray(prefixOffset, end);
        prefixOffset = end;
        return chunk;
      }

      const buffer = new Uint8Array(maximumBytes);
      const { bytesRead } = await handle.read({
        buffer,
        offset: 0,
        length: buffer.length,
        position: undefined,
      });
      if (bytesRead < 0 || bytesRead > buffer.length) {
        throw new Error(`Invalid Bash script source read length: ${bytesRead}`);
      }
      return bytesRead === 0 ? undefined : buffer.subarray(0, bytesRead);
    },
  };
}

async function prepareSequentialBashScriptSource({ handle }: {
  handle: WeshFileHandle,
}): Promise<PreparedBashScriptSource> {
  const prefix = new Uint8Array(BASH_BINARY_PROBE_BYTES);
  let totalRead = 0;

  while (totalRead < prefix.length) {
    const remaining = prefix.length - totalRead;
    const { bytesRead } = await handle.read({
      buffer: prefix,
      offset: totalRead,
      length: remaining,
      position: undefined,
    });
    if (bytesRead < 0 || bytesRead > remaining) {
      throw new Error(`Invalid Bash sequential script prefix read length: ${bytesRead}`);
    }
    if (bytesRead === 0) break;

    const chunkEnd = totalRead + bytesRead;
    const inspection = inspectBashScriptPrefixChunk({
      chunk: prefix.subarray(totalRead, chunkEnd),
    });
    switch (inspection) {
    case 'binary':
      return { kind: 'binary' };
    case 'line-end':
      totalRead = chunkEnd;
      break;
    case 'continue':
      totalRead = chunkEnd;
      continue;
    default: {
      const _ex: never = inspection;
      throw new Error(`Unhandled Bash sequential script prefix inspection: ${_ex}`);
    }
    }
    break;
  }

  return {
    kind: 'source',
    source: createPrefixedHandleShellSource({
      prefix: prefix.subarray(0, totalRead),
      handle,
    }),
  };
}

async function prepareBashScriptSource({ handle, stat }: {
  handle: WeshFileHandle,
  stat: WeshStat,
}): Promise<PreparedBashScriptSource> {
  switch (stat.type) {
  case 'fifo':
    // Bash does not apply the regular-file NUL preflight to FIFO scripts.
    return { kind: 'source', source: createHandleShellSource({ handle }) };
  case 'chardev':
    // Character devices are checked, but their reads are sequential. Replay a
    // non-binary prefix so the shell receives exactly the bytes that were probed.
    return prepareSequentialBashScriptSource({ handle });
  case 'file':
  case 'directory':
  case 'symlink':
    if (await hasBashBinaryScriptPrefix({ handle })) return { kind: 'binary' };
    return { kind: 'source', source: createHandleShellSource({ handle }) };
  default: {
    const _ex: never = stat.type;
    throw new Error(`Unhandled Bash script source type: ${_ex}`);
  }
  }
}

function isDirectoryStat({ stat }: { stat: WeshStat }): boolean {
  switch (stat.type) {
  case 'directory':
    return true;
  case 'file':
  case 'fifo':
  case 'chardev':
  case 'symlink':
    return false;
  default: {
    const _ex: never = stat.type;
    throw new Error(`Unhandled Wesh file type: ${_ex}`);
  }
  }
}

function isNotFoundError({ error }: { error: unknown }): boolean {
  if (error instanceof DOMException) {
    return error.name === 'NotFoundError';
  }
  if (!(error instanceof Error)) {
    return false;
  }
  return error.name === 'NotFoundError'
    || /(?:no such file|not found|does not exist)/iu.test(error.message);
}


function isTooManySymlinksError({ error }: { error: unknown }): boolean {
  return error instanceof Error && /too many levels of symbolic links/iu.test(error.message);
}

function isPathTypeMismatchError({ error }: { error: unknown }): boolean {
  if (error instanceof DOMException) {
    return error.name === 'TypeMismatchError';
  }
  if (!(error instanceof Error)) {
    return false;
  }
  return error.name === 'TypeMismatchError'
    || /(?:not a directory|not a file|not an entry of requested type)/iu.test(error.message);
}

function isPermissionDeniedError({ error }: { error: unknown }): boolean {
  if (error instanceof DOMException) {
    return error.name === 'NotAllowedError' || error.name === 'SecurityError';
  }
  return error instanceof Error
    && /(?:permission denied|access denied|not allowed)/iu.test(error.message);
}

type OpenBashScriptResult =
  | {
      readonly kind: 'opened',
      readonly handle: WeshFileHandle,
      readonly resolvedPath: string,
      readonly diagnosticPath: string,
    }
  | {
      readonly kind: 'error',
      readonly error: unknown,
      readonly resolvedPath: string,
      readonly diagnosticPath: string,
      readonly intermediateNotDirectory: boolean,
    };

function bashPathSearchDiagnosticPath({ pathEntry, scriptPath }: {
  pathEntry: string,
  scriptPath: string,
}): string {
  if (pathEntry.length === 0) {
    return scriptPath;
  }
  return pathEntry.endsWith('/')
    ? `${pathEntry}${scriptPath}`
    : `${pathEntry}/${scriptPath}`;
}

function shouldSkipBashPathSearchCandidate({ error }: { error: unknown }): boolean {
  return isNotFoundError({ error })
    || isPathTypeMismatchError({ error })
    || isTooManySymlinksError({ error })
    || isPermissionDeniedError({ error });
}

function requiresBashPathTraversalPreflight({ path }: { path: string }): boolean {
  const isRelativePath = !path.startsWith('/');
  let hasConcretePrefix = false;
  for (const component of path.split('/')) {
    if (component.length === 0) {
      continue;
    }
    if (component === '..') {
      if (hasConcretePrefix || isRelativePath) {
        return true;
      }
      continue;
    }
    if (component === '.') {
      if (hasConcretePrefix) {
        return true;
      }
      continue;
    }
    hasConcretePrefix = true;
  }
  return false;
}

async function openBashScript({ context, scriptPath }: {
  context: WeshCommandContext,
  scriptPath: string,
}): Promise<OpenBashScriptResult> {
  const flags = {
    access: 'read' as const,
    creation: 'never' as const,
    truncate: 'preserve' as const,
    append: 'preserve' as const,
  };
  const normalizedDirectPath = resolvePath({ cwd: context.cwd, path: scriptPath });
  const directNeedsTraversalPreflight = requiresBashPathTraversalPreflight({ path: scriptPath });
  let directPath = normalizedDirectPath;
  let directError: unknown;
  let directErrorIsIntermediateNotDirectory = false;
  try {
    if (directNeedsTraversalPreflight) {
      try {
        directPath = await canonicalizeExistingPath({
          context,
          path: scriptPath,
          symlinkPolicy: 'limit_40',
        });
      } catch (error: unknown) {
        directErrorIsIntermediateNotDirectory = isPathTypeMismatchError({ error });
        throw error;
      }
    }
    return {
      kind: 'opened',
      handle: await context.files.open({ path: directPath, flags }),
      resolvedPath: directPath,
      diagnosticPath: scriptPath,
    };
  } catch (error: unknown) {
    directError = error;
  }

  if (scriptPath.includes('/') || !isNotFoundError({ error: directError })) {
    return {
      kind: 'error',
      error: directError,
      resolvedPath: directPath,
      diagnosticPath: scriptPath,
      intermediateNotDirectory: directErrorIsIntermediateNotDirectory,
    };
  }

  const pathValue = context.env.get('PATH');
  if (pathValue === undefined) {
    return {
      kind: 'error',
      error: directError,
      resolvedPath: directPath,
      diagnosticPath: scriptPath,
      intermediateNotDirectory: directErrorIsIntermediateNotDirectory,
    };
  }

  for (const pathEntry of pathValue.split(':')) {
    const diagnosticPath = bashPathSearchDiagnosticPath({ pathEntry, scriptPath });
    const candidateInputPath = diagnosticPath;
    let candidatePath = resolvePath({ cwd: context.cwd, path: candidateInputPath });

    try {
      if (requiresBashPathTraversalPreflight({ path: candidateInputPath })) {
        candidatePath = await canonicalizeExistingPath({
          context,
          path: candidateInputPath,
          symlinkPolicy: 'limit_40',
        });
      }
      if (candidatePath === directPath) {
        continue;
      }
      return {
        kind: 'opened',
        handle: await context.files.open({ path: candidatePath, flags }),
        resolvedPath: candidatePath,
        diagnosticPath,
      };
    } catch (error: unknown) {
      if (shouldSkipBashPathSearchCandidate({ error })) {
        continue;
      }
      return {
        kind: 'error',
        error,
        resolvedPath: candidatePath,
        diagnosticPath,
        intermediateNotDirectory: false,
      };
    }
  }

  return {
    kind: 'error',
    error: directError,
    resolvedPath: directPath,
    diagnosticPath: scriptPath,
    intermediateNotDirectory: directErrorIsIntermediateNotDirectory,
  };
}


// GNU Bash collapses script-path resolution/open failures to status 1 when
// invocation-time errexit is enabled. Its binary-script preflight is distinct
// and deliberately keeps status 126, so only path-failure branches use this.
function bashScriptPathFailureExitCode({ errexit, defaultExitCode }: {
  errexit: boolean,
  defaultExitCode: 126 | 127,
}): 1 | 126 | 127 {
  return errexit ? 1 : defaultExitCode;
}

async function reportScriptReadError({
  context,
  scriptPath,
  stat,
  error,
  errexit,
}: {
  context: WeshCommandContext,
  scriptPath: string,
  stat: WeshStat,
  error: unknown,
  errexit: boolean,
}): Promise<WeshCommandResult | undefined> {
  const message = error instanceof Error ? error.message : String(error);
  switch (stat.type) {
  case 'chardev':
    await context.text().error({
      text: `${scriptPath}: error reading input file: ${message}\n`,
    });
    return { exitCode: 2 };
  case 'file':
  case 'symlink':
    await context.text().error({ text: `${scriptPath}: ${scriptPath}: ${message}\n` });
    return {
      exitCode: bashScriptPathFailureExitCode({
        errexit,
        defaultExitCode: 126,
      }),
    };
  case 'fifo':
  case 'directory':
    return undefined;
  default: {
    const _ex: never = stat.type;
    throw new Error(`Unhandled Wesh file type: ${_ex}`);
  }
  }
}

async function reportScriptPathError({
  context,
  scriptPath,
  resolvedPath,
  error,
  errexit,
}: {
  context: WeshCommandContext,
  scriptPath: string,
  resolvedPath: string,
  error: unknown,
  errexit: boolean,
}): Promise<WeshCommandResult | undefined> {
  if (isNotFoundError({ error })) {
    await context.text().error({ text: `bash: ${scriptPath}: No such file or directory\n` });
    return { exitCode: bashScriptPathFailureExitCode({ errexit, defaultExitCode: 127 }) };
  }
  if (isTooManySymlinksError({ error })) {
    await context.text().error({
      text: `bash: ${scriptPath}: Too many levels of symbolic links\n`,
    });
    return { exitCode: bashScriptPathFailureExitCode({ errexit, defaultExitCode: 126 }) };
  }
  if (!isPathTypeMismatchError({ error })) {
    return undefined;
  }

  try {
    const stat = await context.files.stat({ path: resolvedPath });
    if (isDirectoryStat({ stat })) {
      await context.text().error({ text: `${scriptPath}: ${scriptPath}: Is a directory\n` });
      return { exitCode: bashScriptPathFailureExitCode({ errexit, defaultExitCode: 126 }) };
    }
  } catch {
    // If stat cannot resolve the normalized path either, the type mismatch came
    // from a non-directory path component rather than a final directory.
  }

  await context.text().error({ text: `bash: ${scriptPath}: Not a directory\n` });
  return { exitCode: bashScriptPathFailureExitCode({ errexit, defaultExitCode: 126 }) };
}

async function reportScriptOpenError({
  context,
  scriptPath,
  resolvedPath,
  error,
  errexit,
  intermediateNotDirectory,
}: {
  context: WeshCommandContext,
  scriptPath: string,
  resolvedPath: string,
  error: unknown,
  errexit: boolean,
  intermediateNotDirectory: boolean,
}): Promise<WeshCommandResult> {
  if (intermediateNotDirectory) {
    await context.text().error({ text: `bash: ${scriptPath}: Not a directory\n` });
    return {
      exitCode: bashScriptPathFailureExitCode({
        errexit,
        defaultExitCode: 126,
      }),
    };
  }
  const pathError = await reportScriptPathError({
    context,
    scriptPath,
    resolvedPath,
    error,
    errexit,
  });
  if (pathError !== undefined) {
    return pathError;
  }

  const message = error instanceof Error ? error.message : String(error);
  await context.text().error({ text: `bash: ${scriptPath}: ${message}\n` });
  return {
    exitCode: bashScriptPathFailureExitCode({
      errexit,
      defaultExitCode: 126,
    }),
  };
}

export type ExecuteBashShellInvocation = ({ context, invocation }: {
  context: WeshCommandContext,
  invocation: ShellInvocation,
}) => Promise<WeshCommandResult>;

function createShellInvocation({ plan, source }: {
  plan: BashInvocationPlan,
  source: ShellSource,
}): ShellInvocation {
  return {
    source,
    argv0: plan.argv0,
    positionalArgs: plan.positionalArgs,
    executionOptions: { ...plan.executionOptions },
    shellOptionOverrides: plan.shellOptionOverrides.map((override) => ({ ...override })),
    mode: plan.mode,
  };
}

export function createBashCommandDefinition({ executeShellInvocation }: {
  executeShellInvocation: ExecuteBashShellInvocation,
}): WeshCommandDefinition {
  return {
    meta: {
      name: 'bash',
      description: 'Run commands using the bash shell compatibility entrypoint',
      usage: 'bash [-c command] [file [argument...]]',
    },
    load: async () => async ({ context }) => {
      const parsed = parseBashArgv({ args: context.args });
      switch (parsed.kind) {
      case 'help':
        await context.text().print({
          text: `\
bash: bash shell compatibility entrypoint
usage: bash [-c command] [file [argument...]]
`,
        });
        return { exitCode: 0 };
      case 'error':
        await context.text().error({ text: parsed.message });
        return { exitCode: parsed.exitCode };
      case 'run':
        break;
      default: {
        const _ex: never = parsed;
        throw new Error(`Unhandled Bash argv result: ${JSON.stringify(_ex)}`);
      }
      }

      const startupEnvironment = applyBashStartupEnvironmentOptions({
        plan: parsed,
        shellopts: context.env.get('SHELLOPTS'),
        bashopts: context.env.get('BASHOPTS'),
      });
      for (const warning of startupEnvironment.warnings) {
        await context.text().error({ text: warning });
      }
      const plan = startupEnvironment.plan;

      switch (plan.source.kind) {
      case 'command-string':
        return executeShellInvocation({
          context,
          invocation: createShellInvocation({
            plan,
            source: createTextShellSource({ text: plan.source.script }),
          }),
        });
      case 'stdin':
        return executeShellInvocation({
          context,
          invocation: createShellInvocation({
            plan,
            source: createHandleShellSource({ handle: context.stdin }),
          }),
        });
      case 'file': {
        const scriptPath = plan.source.path;
        if (scriptPath.length === 0) {
          await context.text().error({ text: 'bash: : No such file or directory\n' });
          return {
            exitCode: bashScriptPathFailureExitCode({
              errexit: plan.executionOptions.errexit,
              defaultExitCode: 127,
            }),
          };
        }
        try {
          let path = resolvePath({ cwd: context.cwd, path: scriptPath });
          if (scriptPath.endsWith('/')) {
            const needsTraversalPreflight = requiresBashPathTraversalPreflight({ path: scriptPath });
            try {
              if (needsTraversalPreflight) {
                path = await canonicalizeExistingPath({
                  context,
                  path: scriptPath,
                  symlinkPolicy: 'limit_40',
                });
              }
              const stat = await context.files.stat({ path });
              if (isDirectoryStat({ stat })) {
                await context.text().error({
                  text: `${scriptPath}: ${scriptPath}: Is a directory\n`,
                });
              } else {
                await context.text().error({ text: `bash: ${scriptPath}: Not a directory\n` });
              }
              return {
                exitCode: bashScriptPathFailureExitCode({
                  errexit: plan.executionOptions.errexit,
                  defaultExitCode: 126,
                }),
              };
            } catch (error: unknown) {
              if (needsTraversalPreflight && isPathTypeMismatchError({ error })) {
                await context.text().error({ text: `bash: ${scriptPath}: Not a directory\n` });
                return {
                  exitCode: bashScriptPathFailureExitCode({
                    errexit: plan.executionOptions.errexit,
                    defaultExitCode: 126,
                  }),
                };
              }
              const pathError = await reportScriptPathError({
                context,
                scriptPath,
                resolvedPath: path,
                error,
                errexit: plan.executionOptions.errexit,
              });
              if (pathError !== undefined) return pathError;
              throw error;
            }
          }
          const opened = await openBashScript({ context, scriptPath });
          switch (opened.kind) {
          case 'error':
            return reportScriptOpenError({
              context,
              scriptPath: opened.diagnosticPath,
              resolvedPath: opened.resolvedPath,
              error: opened.error,
              errexit: plan.executionOptions.errexit,
              intermediateNotDirectory: opened.intermediateNotDirectory,
            });
          case 'opened':
            break;
          default: {
            const _ex: never = opened;
            throw new Error(`Unhandled Bash script open result: ${JSON.stringify(_ex)}`);
          }
          }

          const { handle } = opened;
          const diagnosticPath = opened.diagnosticPath;
          try {
            let stat: WeshStat;
            try {
              stat = await handle.stat();
            } catch (error: unknown) {
              return await reportScriptOpenError({
                context,
                scriptPath: diagnosticPath,
                resolvedPath: opened.resolvedPath,
                error,
                errexit: plan.executionOptions.errexit,
                intermediateNotDirectory: false,
              });
            }
            let preparedSource: PreparedBashScriptSource;
            try {
              preparedSource = await prepareBashScriptSource({ handle, stat });
            } catch (error: unknown) {
              const readError = await reportScriptReadError({
                context,
                scriptPath: diagnosticPath,
                stat,
                error,
                errexit: plan.executionOptions.errexit,
              });
              if (readError !== undefined) return readError;
              throw error;
            }
            switch (preparedSource.kind) {
            case 'binary':
              await context.text().error({
                text: `${diagnosticPath}: ${diagnosticPath}: cannot execute binary file\n`,
              });
              return { exitCode: 126 };
            case 'source':
              return await executeShellInvocation({
                context,
                invocation: createShellInvocation({
                  plan,
                  source: preparedSource.source,
                }),
              });
            default: {
              const _ex: never = preparedSource;
              throw new Error(`Unhandled prepared Bash script source: ${JSON.stringify(_ex)}`);
            }
            }
          } finally {
            await handle.close();
          }
        } catch (error: unknown) {
          const pathError = await reportScriptPathError({
            context,
            scriptPath,
            resolvedPath: resolvePath({ cwd: context.cwd, path: scriptPath }),
            error,
            errexit: plan.executionOptions.errexit,
          });
          if (pathError !== undefined) return pathError;
          const message = error instanceof Error ? error.message : String(error);
          await context.text().error({ text: `bash: ${scriptPath}: ${message}\n` });
          return {
            exitCode: bashScriptPathFailureExitCode({
              errexit: plan.executionOptions.errexit,
              defaultExitCode: 126,
            }),
          };
        }
      }
      default: {
        const _ex: never = plan.source;
        throw new Error(`Unhandled Bash invocation source: ${JSON.stringify(_ex)}`);
      }
      }
    },
  };
}

export const TEST_ONLY = {
  hasBashBinaryScriptPrefix,
};
