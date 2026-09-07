import type { WeshCommandDefinition } from '@/features/wesh/types';

export const cutCommandDefinition = {
  meta: {
    name: 'cut',
    description: 'Remove sections from each line of files',
    usage: 'cut [OPTION]... [FILE]...',
  },
  load: async () => (await import('./index.ts')).cutCommandImplementation.fn,
} satisfies WeshCommandDefinition;

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
