import type { WeshCommandContext, WeshResolvedCommand } from '@/services/wesh/types';

export function resolveCommand({
  context,
  name,
}: {
  context: WeshCommandContext;
  name: string;
}): WeshResolvedCommand {
  return context.resolveCommand({ name });
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
        const _ex: never = resolved.resolution;
        throw new Error(`Unhandled builtin resolution: ${_ex}`);
      }
      }
    case 'command-V':
      switch (resolved.resolution) {
      case 'builtin-name':
        return `${resolved.name} is a shell builtin`;
      case 'path-lookup':
      case 'explicit-path':
        return `${resolved.invocationPath ?? resolved.name} is a shell builtin`;
      default: {
        const _ex: never = resolved.resolution;
        throw new Error(`Unhandled builtin resolution: ${_ex}`);
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
  case 'not-found':
    return undefined;
  default: {
    const _ex: never = resolved;
    throw new Error(`Unhandled resolved command: ${JSON.stringify(_ex)}`);
  }
  }
}
