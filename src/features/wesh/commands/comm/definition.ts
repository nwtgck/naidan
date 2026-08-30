import type { WeshCommandDefinition } from '@/features/wesh/types';

export const commCommandDefinition = {
  meta: {
    name: 'comm',
    description: 'Compare two sorted files line by line',
    usage: 'comm [OPTION]... FILE1 FILE2',
  },
  load: async () => (await import('./index.ts')).commCommandImplementation.fn,
} satisfies WeshCommandDefinition;

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
