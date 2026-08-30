import type { WeshCommandDefinition } from '@/features/wesh/types';

export const aliasCommandDefinition = {
  meta: {
    name: 'alias',
    description: 'Define or display shell aliases',
    usage: 'alias [-p] [name[=value] ...]',
  },
  load: async () => (await import('./index.ts')).aliasCommandImplementation.fn,
} satisfies WeshCommandDefinition;

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
