import type { WeshCommandContext, WeshCommandImplementation, WeshCommandResult } from '@/features/wesh/types';

export const falseCommandImplementation: WeshCommandImplementation = {
  fn: async ({ context: _context }: { context: WeshCommandContext }): Promise<WeshCommandResult> => {
    return { exitCode: 1 };
  },
};

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
