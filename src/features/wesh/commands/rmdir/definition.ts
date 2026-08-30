import type { WeshCommandDefinition } from '@/features/wesh/types';

export const rmdirCommandDefinition = {
  meta: {
    name: 'rmdir',
    description: 'Remove empty directories',
    usage: 'rmdir directory...',
  },
  load: async () => (await import('./index.ts')).rmdirCommandImplementation.fn,
} satisfies WeshCommandDefinition;

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
