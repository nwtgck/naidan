import type { WeshCommandDefinition } from '@/features/wesh/types';

export const treeCommandDefinition = {
  meta: {
    name: 'tree',
    description: 'List contents of directories in a tree-like format',
    usage: 'tree [OPTION]... [DIRECTORY...]',
  },
  load: async () => (await import('./index.ts')).treeCommandImplementation.fn,
} satisfies WeshCommandDefinition;

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
