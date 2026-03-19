import type { WeshCommandContext, WeshCommandDefinition, WeshCommandResult } from '@/services/wesh/types';

export const execCommandDefinition: WeshCommandDefinition = {
  meta: {
    name: 'exec',
    description: 'Replace the shell command context or persist file-descriptor changes',
    usage: 'exec [command [arg...]]',
  },
  fn: async ({ context }: { context: WeshCommandContext }): Promise<WeshCommandResult> => {
    if (context.args.length === 0) {
      for (const [fd, handle] of context.getFileDescriptors()) {
        await context.setFileDescriptor({ fd, handle, persist: true });
      }
      return { exitCode: 0 };
    }

    const [command, ...args] = context.args;
    if (command === undefined) {
      return { exitCode: 0 };
    }

    return context.executeCommand({
      command,
      args,
    });
  },
};
