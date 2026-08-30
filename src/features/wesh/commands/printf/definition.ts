import type { WeshCommandDefinition } from '@/features/wesh/types';

export const printfCommandDefinition = {
  meta: {
    name: 'printf',
    description: 'Format and print data',
    usage: 'printf [-v var] FORMAT [ARGUMENT]...',
  },
  load: async () => (await import('./index.ts')).printfCommandImplementation.fn,
} satisfies WeshCommandDefinition;

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
