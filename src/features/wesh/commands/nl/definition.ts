import type { WeshCommandDefinition } from '@/features/wesh/types';

export const nlCommandDefinition = {
  meta: {
    name: 'nl',
    description: 'Number lines of files',
    usage: 'nl [OPTION]... [FILE]...',
  },
  load: async () => (await import('./index.ts')).nlCommandImplementation.fn,
} satisfies WeshCommandDefinition;

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
