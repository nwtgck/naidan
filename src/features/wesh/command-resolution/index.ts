import { normalizePath, toAbsolutePath } from '@/features/wesh/path';
import type {
  WeshCommandContext,
  WeshCommandMeta,
  WeshResolvedCommand as CoreWeshResolvedCommand,
} from '@/features/wesh/types';

type CommandLookupContext = Pick<WeshCommandContext, 'cwd' | 'env' | 'getWeshCommandMeta'> & {
  readonly files: Pick<WeshCommandContext['files'], 'stat'>,
};

export const shellIntrinsicNames: ReadonlySet<string> = new Set([
  'break',
  'continue',
  'exit',
  'return',
  'wait',
]);

/** Literal compatibility paths for registered commands. Other paths go through the VFS. */
export function registeredCommandPath({ name, cwd }: { name: string, cwd: string }): { path: string, name: string } | undefined {
  const path = toAbsolutePath({ cwd, path: name });
  if (path.endsWith('/') || path.endsWith('/.') || /(?:^|\/)\.\.(?=\/|$)/u.test(path)) {
    return undefined;
  }
  const normalized = normalizePath({ cwd: '/', path });
  const separator = normalized.lastIndexOf('/');
  const parent = normalized.slice(0, separator);
  return parent === '/bin' || parent === '/usr/bin'
    ? { path: normalized, name: normalized.slice(separator + 1) }
    : undefined;
}

export function* iterateCommandPaths({ name, cwd, searchPathEntries }: {
  name: string, cwd: string, searchPathEntries: readonly string[],
}): Iterable<{ candidatePath: string, invocationPath: string }> {
  if (name.includes('/')) {
    yield { candidatePath: toAbsolutePath({ cwd, path: name }), invocationPath: name };
    return;
  }
  for (const entry of searchPathEntries) {
    const invocationPath = `${(entry || '.').replace(/\/+$/u, '')}/${name}`;
    yield { candidatePath: toAbsolutePath({ cwd, path: invocationPath }), invocationPath };
  }
}

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
  context: CommandLookupContext;
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
  context: CommandLookupContext;
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
  context: CommandLookupContext;
  name: string;
}): Promise<WeshResolvedCommand> {
  const registered = registeredCommandPath({ name, cwd: context.cwd });
  if (registered !== undefined) {
    const meta = context.getWeshCommandMeta({ name: registered.name });
    if (meta !== undefined) {
      return toBuiltinResolution({
        name: registered.name,
        meta,
        invocationPath: name,
        resolution: 'explicit-path',
      });
    }
  }

  const [file] = await resolvePathCommands({ context, name });
  return file ?? { kind: 'not_found', name };
}

export async function resolvePathCommands({
  context,
  name,
  searchPathEntries,
}: {
  context: CommandLookupContext;
  name: string;
  searchPathEntries?: readonly string[];
}): Promise<readonly ResolvedFileCommand[]> {
  const explicit = name.includes('/');
  const basename = name.slice(name.lastIndexOf('/') + 1);
  const matches: ResolvedFileCommand[] = [];
  for (const { candidatePath, invocationPath } of iterateCommandPaths({
    name,
    cwd: context.cwd,
    searchPathEntries: explicit ? [] : searchPathEntries ?? (context.env.get('PATH') ?? '').split(':'),
  })) {
    const file = await resolveFileAtPath({
      context,
      name: basename,
      candidatePath,
      invocationPath,
      resolution: explicit ? 'explicit-path' : 'path-lookup',
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
  searchPathEntries,
}: {
  context: CommandLookupContext;
  name: string;
  searchPathEntries?: readonly string[];
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

  return await resolvePathCommands({ context, name, searchPathEntries });
}

export async function resolveCommand({
  context,
  name,
  searchPathEntries,
}: {
  context: CommandLookupContext;
  name: string;
  searchPathEntries?: readonly string[];
}): Promise<WeshResolvedCommand> {
  const first = (await resolveCommands({ context, name, searchPathEntries }))[0];
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
