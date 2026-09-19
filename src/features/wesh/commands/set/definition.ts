import type { WeshCommandDefinition } from '@/features/wesh/types';

export const setCommandDefinition = {
  meta: {
    name: 'set',
    description: 'Display shell variables in reusable assignment form',
    usage: 'set',
  },
  load: async () => (await import('./index.ts')).setCommandImplementation.fn,
} satisfies WeshCommandDefinition;

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
