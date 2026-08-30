import type { WeshCommandDefinition } from '@/features/wesh/types';

export const touchCommandDefinition = {
  meta: {
    name: 'touch',
    description: 'Update file timestamps or create empty files',
    usage: 'touch [-chm] [-d STRING] [-r FILE] [-t STAMP] path...',
  },
  load: async () => (await import('./index.ts')).touchCommandImplementation.fn,
} satisfies WeshCommandDefinition;

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
