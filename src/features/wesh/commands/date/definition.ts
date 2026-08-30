import type { WeshCommandDefinition } from '@/features/wesh/types';

export const dateCommandDefinition = {
  meta: {
    name: 'date',
    description: 'Print the system date and time',
    usage: 'date [-u] [-d STRING] [-I[TIMESPEC]] [--rfc-3339=TIMESPEC] [+FORMAT]',
  },
  load: async () => (await import('./index.ts')).dateCommandImplementation.fn,
} satisfies WeshCommandDefinition;

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
