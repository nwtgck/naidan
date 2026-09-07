import type { WeshCommandDefinition } from '@/features/wesh/types';

export const columnCommandDefinition = {
  meta: {
    name: 'column',
    description: 'Columnate lists or create aligned tables',
    usage: 'column [OPTION]... [FILE]...',
  },
  load: async () => (await import('./index.ts')).columnCommandImplementation.fn,
} satisfies WeshCommandDefinition;

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
