import type { WeshCommandDefinition } from '@/features/wesh/types';

export const dirnameCommandDefinition = {
  meta: {
    name: 'dirname',
    description: 'Strip last component from file name',
    usage: 'dirname [OPTION]... NAME...',
  },
  load: async () => (await import('./index.ts')).dirnameCommandImplementation.fn,
} satisfies WeshCommandDefinition;

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
