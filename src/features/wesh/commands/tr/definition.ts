import type { WeshCommandDefinition } from '@/features/wesh/types';

export const trCommandDefinition = {
  meta: {
    name: 'tr',
    description: 'Translate or delete characters',
    usage: 'tr [OPTION]... SET1 [SET2]',
  },
  load: async () => (await import('./index.ts')).trCommandImplementation.fn,
} satisfies WeshCommandDefinition;

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
