import type { WeshCommandDefinition } from '@/features/wesh/types';

export const nodeCommandDefinition = {
  meta: {
    name: 'node',
    description: 'check JavaScript syntax without executing it',
    usage: 'node (-c|--check) [FILE [ARG...]]',
  },
  load: async () => (await import('./index.ts')).nodeCommandImplementation.fn,
} satisfies WeshCommandDefinition;

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
