import type { WeshCommandDefinition } from '@/features/wesh/types';

export const basenameCommandDefinition = {
  meta: {
    name: 'basename',
    description: 'Strip directory and suffix from filenames',
    usage: 'basename [OPTION]... NAME...',
  },
  load: async () => (await import('./index.ts')).basenameCommandImplementation.fn,
} satisfies WeshCommandDefinition;

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
