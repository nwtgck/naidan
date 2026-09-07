import type { WeshCommandDefinition } from '@/features/wesh/types';

export const xxdCommandDefinition = {
  meta: {
    name: 'xxd',
    description: 'Make a hex dump',
    usage: 'xxd [OPTION]... [INFILE [OUTFILE]]',
  },
  load: async () => (await import('./index.ts')).xxdCommandImplementation.fn,
} satisfies WeshCommandDefinition;

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
