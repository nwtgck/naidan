import type { WeshCommandDefinition } from '@/features/wesh/types';

export const unaliasCommandDefinition = {
  meta: {
    name: 'unalias',
    description: 'Remove shell aliases',
    usage: 'unalias [-a] name [name ...]',
  },
  load: async () => (await import('./index.ts')).unaliasCommandImplementation.fn,
} satisfies WeshCommandDefinition;

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
