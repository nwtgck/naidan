import type { WeshCommandDefinition } from '@/features/wesh/types';

export const zipCommandDefinition = {
  meta: {
    name: 'zip',
    description: 'Package and compress files into ZIP archives',
    usage: 'zip [-rjq0-9] zipfile file...',
  },
  load: async () => (await import('./index.ts')).zipCommandImplementation.fn,
} satisfies WeshCommandDefinition;

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
