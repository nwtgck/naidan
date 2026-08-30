import type { WeshCommandDefinition } from '@/features/wesh/types';

export const colonCommandDefinition = {
  meta: {
    name: ':',
    description: 'Do nothing',
    usage: ': [arguments...]',
  },
  load: async () => (await import('./index.ts')).colonCommandImplementation.fn,
} satisfies WeshCommandDefinition;

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
