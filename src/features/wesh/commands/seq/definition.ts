import type { WeshCommandDefinition } from '@/features/wesh/types';

export const seqCommandDefinition = {
  meta: {
    name: 'seq',
    description: 'Print a sequence of numbers',
    usage: 'seq [OPTION]... LAST | seq [OPTION]... FIRST LAST | seq [OPTION]... FIRST INCREMENT LAST',
  },
  load: async () => (await import('./index.ts')).seqCommandImplementation.fn,
} satisfies WeshCommandDefinition;

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
