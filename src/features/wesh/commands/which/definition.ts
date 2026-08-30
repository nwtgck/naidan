import type { WeshCommandDefinition } from '@/features/wesh/types';

export const whichCommandDefinition = {
  meta: {
    name: 'which',
    description: 'Locate a command',
    usage: 'which [-as] command...',
  },
  load: async () => (await import('./index.ts')).whichCommandImplementation.fn,
} satisfies WeshCommandDefinition;

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
