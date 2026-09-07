import type { WeshCommandDefinition } from '@/features/wesh/types';

export const awkCommandDefinition = {
  meta: {
    name: 'awk',
    description: 'Pattern scanning and processing language',
    usage: 'awk [-F FS] [-v VAR=VALUE] [-f PROGRAM_FILE] [--] PROGRAM [FILE]...',
  },
  load: async () => (await import('./index.ts')).awkCommandImplementation.fn,
} satisfies WeshCommandDefinition;

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
