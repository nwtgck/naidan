import type { WeshCommandDefinition } from '@/features/wesh/types';

export const zcatCommandDefinition = {
  meta: {
    name: 'zcat',
    description: 'Decompress and print files to standard output',
    usage: 'zcat [OPTION]... [FILE]...',
  },
  load: async () => (await import('./index.ts')).zcatCommandImplementation.fn,
} satisfies WeshCommandDefinition;

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
