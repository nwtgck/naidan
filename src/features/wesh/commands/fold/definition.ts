import type { WeshCommandDefinition } from '@/features/wesh/types';

export const foldCommandDefinition = {
  meta: {
    name: 'fold',
    description: 'Wrap input lines to fit in specified width',
    usage: 'fold [OPTION]... [FILE]...',
  },
  load: async () => (await import('./index.ts')).foldCommandImplementation.fn,
} satisfies WeshCommandDefinition;

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
