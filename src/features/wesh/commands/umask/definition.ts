import type { WeshCommandDefinition } from '@/features/wesh/types';

export const umaskCommandDefinition = {
  meta: {
    name: 'umask',
    description: 'Display the file creation mask',
    usage: 'umask [-p] [-S]',
  },
  load: async () => (await import('./index.ts')).umaskCommandImplementation.fn,
} satisfies WeshCommandDefinition;

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
