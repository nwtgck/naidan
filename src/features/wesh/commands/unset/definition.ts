import type { WeshShellBuiltinDefinition } from '@/features/wesh/types';

export const unsetCommandDefinition = {
  meta: {
    name: 'unset',
    description: 'Unset environment variables',
    usage: 'unset [-v] [-f] [name ...]',
  },
  loadShellBuiltin: async () => (await import('./index.ts')).unsetCommandImplementation.fn,
} satisfies WeshShellBuiltinDefinition;

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
