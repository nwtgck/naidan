import type { WeshShellBuiltinDefinition } from '@/features/wesh/types';

export const trapCommandDefinition = {
  meta: {
    name: 'trap',
    description: 'Set shell trap handlers',
    usage: 'trap [-lp] [[arg] signal_spec ...]',
  },
  loadShellBuiltin: async () => (await import('./index.ts')).trapCommandImplementation.fn,
} satisfies WeshShellBuiltinDefinition;

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
