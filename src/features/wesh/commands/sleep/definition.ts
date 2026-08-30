import type { WeshCommandDefinition } from '@/features/wesh/types';

export const sleepCommandDefinition = {
  meta: {
    name: 'sleep',
    description: 'Delay for a specified amount of time',
    usage: 'sleep NUMBER[SUFFIX]...',
  },
  load: async () => (await import('./index.ts')).sleepCommandImplementation.fn,
} satisfies WeshCommandDefinition;

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
