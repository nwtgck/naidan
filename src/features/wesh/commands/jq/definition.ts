import type { WeshCommandDefinition } from '@/features/wesh/types';

export const jqCommandDefinition = {
  meta: {
    name: 'jq',
    description: 'Query and transform JSON values with jq-style filters',
    usage: 'jq [OPTION]... FILTER [FILE]...',
  },
  load: async () => (await import('./index.ts')).jqCommandImplementation.fn,
} satisfies WeshCommandDefinition;

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
