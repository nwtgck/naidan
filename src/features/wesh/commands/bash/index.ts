import { resolvePath } from '@/features/wesh/path';
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
import { parseBashArgv, type BashInvocationPlan } from './argv';



const BASH_BINARY_PROBE_BYTES = 80;

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
    const chunk = buffer.subarray(totalRead, chunkEnd);
    const newlineIndex = chunk.indexOf(0x0a);
    const inspectedLength = newlineIndex >= 0 ? newlineIndex : chunk.length;
    if (chunk.subarray(0, inspectedLength).includes(0x00)) {
      return true;
    }
    if (newlineIndex >= 0) {
      return false;
    }
    totalRead = chunkEnd;
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
    const chunk = prefix.subarray(totalRead, chunkEnd);
    const newlineIndex = chunk.indexOf(0x0a);
    const inspectedLength = newlineIndex >= 0 ? newlineIndex : chunk.length;
    if (chunk.subarray(0, inspectedLength).includes(0x00)) {
      return { kind: 'binary' };
    }
    totalRead = chunkEnd;
    if (newlineIndex >= 0) break;
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

async function reportScriptPathError({
  context,
  scriptPath,
  resolvedPath,
  error,
}: {
  context: WeshCommandContext,
  scriptPath: string,
  resolvedPath: string,
  error: unknown,
}): Promise<WeshCommandResult | undefined> {
  if (isNotFoundError({ error })) {
    await context.text().error({ text: `bash: ${scriptPath}: No such file or directory\n` });
    return { exitCode: 127 };
  }
  if (isTooManySymlinksError({ error })) {
    await context.text().error({
      text: `bash: ${scriptPath}: Too many levels of symbolic links\n`,
    });
    return { exitCode: 126 };
  }
  if (!isPathTypeMismatchError({ error })) {
    return undefined;
  }

  try {
    const stat = await context.files.stat({ path: resolvedPath });
    if (isDirectoryStat({ stat })) {
      await context.text().error({ text: `${scriptPath}: ${scriptPath}: Is a directory\n` });
      return { exitCode: 126 };
    }
  } catch {
    // If stat cannot resolve the normalized path either, the type mismatch came
    // from a non-directory path component rather than a final directory.
  }

  await context.text().error({ text: `bash: ${scriptPath}: Not a directory\n` });
  return { exitCode: 126 };
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
    fn: async ({ context }) => {
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

      switch (parsed.source.kind) {
      case 'command-string':
        return executeShellInvocation({
          context,
          invocation: createShellInvocation({
            plan: parsed,
            source: createTextShellSource({ text: parsed.source.script }),
          }),
        });
      case 'stdin':
        return executeShellInvocation({
          context,
          invocation: createShellInvocation({
            plan: parsed,
            source: createHandleShellSource({ handle: context.stdin }),
          }),
        });
      case 'file': {
        const scriptPath = parsed.source.path;
        if (scriptPath.length === 0) {
          await context.text().error({ text: 'bash: : No such file or directory\n' });
          return { exitCode: 127 };
        }
        try {
          const path = resolvePath({ cwd: context.cwd, path: scriptPath });
          if (scriptPath.endsWith('/')) {
            try {
              const stat = await context.files.stat({ path });
              if (isDirectoryStat({ stat })) {
                await context.text().error({
                  text: `${scriptPath}: ${scriptPath}: Is a directory\n`,
                });
              } else {
                await context.text().error({ text: `bash: ${scriptPath}: Not a directory\n` });
              }
              return { exitCode: 126 };
            } catch (error: unknown) {
              const pathError = await reportScriptPathError({
                context,
                scriptPath,
                resolvedPath: path,
                error,
              });
              if (pathError !== undefined) return pathError;
              throw error;
            }
          }
          const handle = await context.files.open({
            path,
            flags: {
              access: 'read',
              creation: 'never',
              truncate: 'preserve',
              append: 'preserve',
            },
          });
          try {
            const preparedSource = await prepareBashScriptSource({
              handle,
              stat: await handle.stat(),
            });
            switch (preparedSource.kind) {
            case 'binary':
              await context.text().error({
                text: `${scriptPath}: ${scriptPath}: cannot execute binary file\n`,
              });
              return { exitCode: 126 };
            case 'source':
              return await executeShellInvocation({
                context,
                invocation: createShellInvocation({
                  plan: parsed,
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
          });
          if (pathError !== undefined) return pathError;
          const message = error instanceof Error ? error.message : String(error);
          await context.text().error({ text: `bash: ${scriptPath}: ${message}\n` });
          return { exitCode: 126 };
        }
      }
      default: {
        const _ex: never = parsed.source;
        throw new Error(`Unhandled Bash invocation source: ${JSON.stringify(_ex)}`);
      }
      }
    },
  };
}

export const TEST_ONLY = {
  hasBashBinaryScriptPrefix,
};
