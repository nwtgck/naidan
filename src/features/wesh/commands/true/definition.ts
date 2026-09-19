import type { WeshCommandDefinition } from '@/features/wesh/types';

export const trueCommandDefinition = {
  meta: {
    name: 'true',
    description: 'Do nothing successfully',
    usage: 'true [arguments...]',
  },
  load: async () => (await import('./index.ts')).trueCommandImplementation.fn,
} satisfies WeshCommandDefinition;

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
