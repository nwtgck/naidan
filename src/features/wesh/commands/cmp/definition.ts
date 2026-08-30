import type { WeshCommandDefinition } from '@/features/wesh/types';

export const cmpCommandDefinition = {
  meta: {
    name: 'cmp',
    description: 'Compare two files byte by byte',
    usage: 'cmp [OPTION]... FILE1 [FILE2 [SKIP1 [SKIP2]]]',
  },
  load: async () => (await import('./index.ts')).cmpCommandImplementation.fn,
} satisfies WeshCommandDefinition;

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
