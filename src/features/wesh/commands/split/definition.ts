import type { WeshCommandDefinition } from '@/features/wesh/types';

export const splitCommandDefinition = {
  meta: {
    name: 'split',
    description: 'Split a file into pieces',
    usage: 'split [OPTION]... [FILE [PREFIX]]',
  },
  load: async () => (await import('./index.ts')).splitCommandImplementation.fn,
} satisfies WeshCommandDefinition;

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
