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
      return resolved.name;
    case 'command-V':
      return `${resolved.name} is a shell builtin`;
    case 'which':
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
