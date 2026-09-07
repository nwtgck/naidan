import type { WeshCommandDefinition } from '@/features/wesh/types';

export const trapCommandDefinition = {
  meta: {
    name: 'trap',
    description: 'Set shell trap handlers',
    usage: 'trap [-lp] [[arg] signal_spec ...]',
  },
  load: async () => (await import('./index.ts')).trapCommandImplementation.fn,
} satisfies WeshCommandDefinition;

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
