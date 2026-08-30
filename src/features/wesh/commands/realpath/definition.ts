import type { WeshCommandDefinition } from '@/features/wesh/types';

export const realpathCommandDefinition = {
  meta: {
    name: 'realpath',
    description: 'Print the resolved absolute path name',
    usage: 'realpath [OPTION]... FILE...',
  },
  load: async () => (await import('./index.ts')).realpathCommandImplementation.fn,
} satisfies WeshCommandDefinition;

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
