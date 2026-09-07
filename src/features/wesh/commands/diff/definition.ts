import type { WeshCommandDefinition } from '@/features/wesh/types';

export const diffCommandDefinition = {
  meta: {
    name: 'diff',
    description: 'Compare files line by line',
    usage: 'diff [OPTION]... FILE1 FILE2',
  },
  load: async () => (await import('./index.ts')).diffCommandImplementation.fn,
} satisfies WeshCommandDefinition;

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
