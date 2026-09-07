import type { WeshCommandDefinition } from '@/features/wesh/types';

export const readlinkCommandDefinition = {
  meta: {
    name: 'readlink',
    description: 'Print value of a symbolic link or canonical file name',
    usage: 'readlink [OPTION]... FILE...',
  },
  load: async () => (await import('./index.ts')).readlinkCommandImplementation.fn,
} satisfies WeshCommandDefinition;

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
