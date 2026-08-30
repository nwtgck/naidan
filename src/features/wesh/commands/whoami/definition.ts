import type { WeshCommandDefinition } from '@/features/wesh/types';

export const whoamiCommandDefinition = {
  meta: {
    name: 'whoami',
    description: 'Print the user name associated with the current effective user ID',
    usage: 'whoami',
  },
  load: async () => (await import('./index.ts')).whoamiCommandImplementation.fn,
} satisfies WeshCommandDefinition;

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
