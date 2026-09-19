import type { WeshCommandDefinition } from '@/features/wesh/types';

export const timeCommandDefinition = {
  meta: {
    name: 'time',
    description: 'Measure command execution time',
    usage: 'time [-p] COMMAND [ARG]...',
  },
  load: async () => (await import('./index.ts')).timeCommandImplementation.fn,
} satisfies WeshCommandDefinition;

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
