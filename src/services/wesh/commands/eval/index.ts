import type { WeshCommandContext, WeshCommandDefinition, WeshCommandResult } from '@/services/wesh/types';

export const evalCommandDefinition: WeshCommandDefinition = {
  meta: {
    name: 'eval',
    description: 'Evaluate arguments as shell code',
    usage: 'eval [arg...]',
  },
  fn: async ({ context }: { context: WeshCommandContext }): Promise<WeshCommandResult> => {
    if (context.args.length === 0) {
      return { exitCode: 0 };
    }

    return context.executeShell({
      script: context.args.join(' '),
    });
  },
};
