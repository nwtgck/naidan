import { normalizePath, resolvePath } from '@/features/wesh/path';
import type {
  WeshCommandContext,
  WeshCommandMeta,
  WeshResolvedCommand as CoreWeshResolvedCommand,
} from '@/features/wesh/types';

export const shellControlFlowBuiltinNames: ReadonlySet<string> = new Set([
  'break',
  'continue',
  'exit',
  'return',
]);

const WESH_COMMAND_SEARCH_DIRECTORY = '/bin';

type CommandResolutionSource = 'builtin-name' | 'path-lookup' | 'explicit-path';

type ResolvedBuiltinCommand = {
  readonly kind: 'builtin';
  readonly name: string;
  readonly meta: WeshCommandMeta;
  readonly invocationPath: string | undefined;
  readonly resolution: CommandResolutionSource;
};

type ResolvedFileCommand = {
  readonly kind: 'file';
  readonly name: string;
  readonly invocationPath: string;
  readonly resolution: Extract<CommandResolutionSource, 'path-lookup' | 'explicit-path'>;
  readonly executable: boolean;
};

type ResolvedMissingCommand = {
  readonly kind: 'not_found';
  readonly name: string;
};

export type WeshResolvedCommand =
  | ResolvedBuiltinCommand
  | ResolvedFileCommand
  | ResolvedMissingCommand;

function toBuiltinResolution({
  name,
  meta,
  invocationPath,
  resolution,
}: {
  name: string;
  meta: WeshCommandMeta;
  invocationPath: string | undefined;
  resolution: CommandResolutionSource;
}): ResolvedBuiltinCommand {
  return {
    kind: 'builtin',
    name,
    meta,
    invocationPath,
    resolution,
  };
}

async function resolveFileAtPath({
  context,
  name,
  candidatePath,
  invocationPath,
  resolution,
}: {
  context: WeshCommandContext;
  name: string;
  candidatePath: string;
  invocationPath: string;
  resolution: Extract<CommandResolutionSource, 'path-lookup' | 'explicit-path'>;
}): Promise<ResolvedFileCommand | undefined> {
  try {
    const stat = await context.files.stat({ path: candidatePath });
    switch (stat.type) {
    case 'file':
      return {
        kind: 'file',
        name,
        invocationPath,
        resolution,
        executable: (stat.mode & 0o111) !== 0,
      };
    case 'directory':
    case 'fifo':
    case 'chardev':
    case 'symlink':
      return undefined;
    default: {
      const _ex: never = stat.type;
      throw new Error(`Unhandled file type: ${_ex}`);
    }
    }
  } catch {
    return undefined;
  }
}

function resolveWeshBuiltin({
  context,
  name,
}: {
  context: WeshCommandContext;
  name: string;
}): ResolvedBuiltinCommand | undefined {
  const meta = context.getWeshCommandMeta({ name });
  return meta === undefined
    ? undefined
    : toBuiltinResolution({
      name,
      meta,
      invocationPath: undefined,
      resolution: 'builtin-name',
    });
}

async function resolveExplicitCommand({
  context,
  name,
}: {
  context: WeshCommandContext;
  name: string;
}): Promise<WeshResolvedCommand> {
  const normalizedPath = normalizePath({ cwd: context.cwd, path: name });
  const separatorIndex = normalizedPath.lastIndexOf('/');
  const directory = separatorIndex === 0 ? '/' : normalizedPath.slice(0, separatorIndex);
  const basename = normalizedPath.slice(separatorIndex + 1);

  if (directory === WESH_COMMAND_SEARCH_DIRECTORY) {
    const meta = context.getWeshCommandMeta({ name: basename });
    if (meta !== undefined) {
      return toBuiltinResolution({
        name: basename,
        meta,
        invocationPath: name,
        resolution: 'explicit-path',
      });
    }
  }

  return await resolveFileAtPath({
    context,
    name: basename,
    candidatePath: normalizedPath,
    invocationPath: name,
    resolution: 'explicit-path',
  }) ?? { kind: 'not_found', name };
}

export function hasShellFunction({
  context,
  name,
}: {
  context: WeshCommandContext;
  name: string;
}): boolean {
  const functionAwareContext = context as WeshCommandContext & {
    hasFunction?: ({ name }: { name: string }) => boolean;
  };
  return functionAwareContext.hasFunction?.({ name }) === true;
}

export async function resolvePathCommands({
  context,
  name,
}: {
  context: WeshCommandContext;
  name: string;
}): Promise<readonly ResolvedFileCommand[]> {
  if (name.includes('/')) {
    const normalizedPath = normalizePath({ cwd: context.cwd, path: name });
    const separatorIndex = normalizedPath.lastIndexOf('/');
    const basename = normalizedPath.slice(separatorIndex + 1);
    const file = await resolveFileAtPath({
      context,
      name: basename,
      candidatePath: normalizedPath,
      invocationPath: name,
      resolution: 'explicit-path',
    });
    return file === undefined ? [] : [file];
  }

  const matches: ResolvedFileCommand[] = [];
  for (const pathEntry of (context.env.get('PATH') ?? '').split(':')) {
    const directory = resolvePath({
      cwd: context.cwd,
      path: pathEntry.length === 0 ? '.' : pathEntry,
    });
    const candidatePath = directory === '/' ? `/${name}` : `${directory}/${name}`;
    const invocationPath = pathEntry.length === 0
      ? `./${name}`
      : `${pathEntry.replace(/\/+$/u, '')}/${name}`;
    const file = await resolveFileAtPath({
      context,
      name,
      candidatePath,
      invocationPath,
      resolution: 'path-lookup',
    });
    if (file !== undefined) {
      matches.push(file);
    }
  }
  return matches;
}

export async function resolveCommands({
  context,
  name,
}: {
  context: WeshCommandContext;
  name: string;
}): Promise<readonly WeshResolvedCommand[]> {
  const weshBuiltin = resolveWeshBuiltin({ context, name });
  if (weshBuiltin !== undefined) {
    return [weshBuiltin];
  }

  if (name.includes('/')) {
    const explicit = await resolveExplicitCommand({ context, name });
    switch (explicit.kind) {
    case 'builtin':
    case 'file':
      return [explicit];
    case 'not_found':
      return [];
    default: {
      const _ex: never = explicit;
      throw new Error(`Unhandled resolved command kind: ${((_ex satisfies never) as { readonly kind: string }).kind}`);
    }
    }
  }

  return await resolvePathCommands({ context, name });
}

export async function resolveCommand({
  context,
  name,
}: {
  context: WeshCommandContext;
  name: string;
}): Promise<WeshResolvedCommand> {
  const first = (await resolveCommands({ context, name }))[0];
  return first ?? { kind: 'not_found', name };
}

export function formatResolvedCommand({
  resolved,
  mode,
}: {
  resolved: WeshResolvedCommand;
  mode: 'command-v' | 'command-V' | 'which';
}): string | undefined {
  switch (resolved.kind) {
  case 'builtin':
    switch (mode) {
    case 'command-v':
      switch (resolved.resolution) {
      case 'builtin-name':
        return resolved.name;
      case 'path-lookup':
      case 'explicit-path':
        return resolved.invocationPath ?? resolved.name;
      default: {
        const _ex: never = resolved;
        throw new Error(`Unhandled builtin resolution: ${JSON.stringify(_ex)}`);
      }
      }
    case 'command-V':
      switch (resolved.resolution) {
      case 'builtin-name':
        return `${resolved.name} is a shell builtin`;
      case 'path-lookup':
        return `${resolved.name} is ${resolved.invocationPath ?? resolved.name}`;
      case 'explicit-path': {
        const invocationPath = resolved.invocationPath ?? resolved.name;
        return `${invocationPath} is ${invocationPath}`;
      }
      default: {
        const _ex: never = resolved;
        throw new Error(`Unhandled builtin resolution: ${JSON.stringify(_ex)}`);
      }
      }
    case 'which':
      if (resolved.invocationPath !== undefined) {
        return resolved.invocationPath;
      }
      return `${resolved.name}: builtin command`;
    default: {
      const _ex: never = mode;
      throw new Error(`Unhandled command format mode: ${_ex}`);
    }
    }
  case 'file':
    switch (mode) {
    case 'command-v':
    case 'which':
      return resolved.invocationPath;
    case 'command-V':
      return `${resolved.name} is ${resolved.invocationPath}`;
    default: {
      const _ex: never = mode;
      throw new Error(`Unhandled command format mode: ${_ex}`);
    }
    }
  case 'not_found':
    return undefined;
  default: {
    const _ex: never = resolved;
    throw new Error(`Unhandled resolved command: ${JSON.stringify(_ex)}`);
  }
  }
}

// Keep the core type import checked so this command-layer adapter cannot silently
// diverge from the built-in resolution fields that the core already exposes.
type _CoreBuiltinResolution = Extract<CoreWeshResolvedCommand, { kind: 'builtin' }>;
const _coreBuiltinShapeCheck: _CoreBuiltinResolution | undefined = undefined;
void _coreBuiltinShapeCheck;

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
