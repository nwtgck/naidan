import type { WeshCommandDefinition } from '@/features/wesh/types';

export const sortCommandDefinition = {
  meta: {
    name: 'sort',
    description: 'Sort lines of text files',
    usage: 'sort [OPTION]... [FILE]...',
  },
  load: async () => (await import('./index.ts')).sortCommandImplementation.fn,
} satisfies WeshCommandDefinition;

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
