import type { WeshCommandDefinition } from '@/features/wesh/types';

export const csplitCommandDefinition = {
  meta: {
    name: 'csplit',
    description: 'Split a file into sections determined by context lines',
    usage: 'csplit [OPTION]... FILE PATTERN...',
  },
  load: async () => (await import('./index.ts')).csplitCommandImplementation.fn,
} satisfies WeshCommandDefinition;

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
