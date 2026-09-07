import type { WeshCommandDefinition } from '@/features/wesh/types';

export const catCommandDefinition = {
  meta: {
    name: 'cat',
    description: 'Concatenate files and print on the standard output',
    usage: 'cat [OPTION]... [FILE]...',
  },
  load: async () => (await import('./index.ts')).catCommandImplementation.fn,
} satisfies WeshCommandDefinition;

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
