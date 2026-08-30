import type { WeshCommandDefinition } from '@/features/wesh/types';

export const rmCommandDefinition = {
  meta: {
    name: 'rm',
    description: 'Remove files or directories',
    usage: 'rm [OPTION]... FILE...',
  },
  load: async () => (await import('./index.ts')).rmCommandImplementation.fn,
} satisfies WeshCommandDefinition;

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
