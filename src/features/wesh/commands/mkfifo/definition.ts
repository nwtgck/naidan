import type { WeshCommandDefinition } from '@/features/wesh/types';

export const mkfifoCommandDefinition = {
  meta: {
    name: 'mkfifo',
    description: 'Make FIFOs (named pipes)',
    usage: 'mkfifo [OPTION]... NAME...',
  },
  load: async () => (await import('./index.ts')).mkfifoCommandImplementation.fn,
} satisfies WeshCommandDefinition;

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
