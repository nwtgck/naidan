import type { WeshCommandDefinition } from '@/features/wesh/types';

export const duCommandDefinition = {
  meta: {
    name: 'du',
    description: 'Estimate logical file size usage',
    usage: 'du [OPTION]... [FILE]... | du [OPTION]... --files0-from=FILE',
  },
  load: async () => (await import('./index.ts')).duCommandImplementation.fn,
} satisfies WeshCommandDefinition;

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
