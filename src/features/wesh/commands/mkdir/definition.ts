import type { WeshCommandDefinition } from '@/features/wesh/types';

export const mkdirCommandDefinition = {
  meta: {
    name: 'mkdir',
    description: 'Create directories',
    usage: 'mkdir [OPTION]... DIRECTORY...',
  },
  load: async () => (await import('./index.ts')).mkdirCommandImplementation.fn,
} satisfies WeshCommandDefinition;

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
