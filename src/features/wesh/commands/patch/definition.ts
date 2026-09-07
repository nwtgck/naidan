import type { WeshCommandDefinition } from '@/features/wesh/types';

export const patchCommandDefinition = {
  meta: {
    name: 'patch',
    description: 'Apply a diff file to original files',
    usage: 'patch [OPTION]... [ORIGFILE [PATCHFILE]]',
  },
  load: async () => (await import('./index.ts')).patchCommandImplementation.fn,
} satisfies WeshCommandDefinition;

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
