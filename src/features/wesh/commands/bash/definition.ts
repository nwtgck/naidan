import type { ShellInvocation } from '@/features/wesh/shell/invocation';
import type { WeshCommandContext, WeshCommandDefinition, WeshCommandResult } from '@/features/wesh/types';

export type ExecuteBashShellInvocation = ({ context, invocation }: {
  context: WeshCommandContext,
  invocation: ShellInvocation,
}) => Promise<WeshCommandResult>;

export function createBashCommandDefinition({ executeShellInvocation }: {
  executeShellInvocation: ExecuteBashShellInvocation,
}): WeshCommandDefinition {
  return {
    meta: {
      name: 'bash',
      description: 'Run commands using the bash shell compatibility entrypoint',
      usage: 'bash [-c command] [file [argument...]]',
    },
    load: async () => (await import('./index.ts')).createBashCommand({ executeShellInvocation }),
  };
}

export const TEST_ONLY = {
};
