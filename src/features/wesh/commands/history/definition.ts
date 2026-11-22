import type { WeshShellBuiltinDefinition } from '@/features/wesh/types';

export const historyCommandDefinition = {
  meta: {
    name: 'history',
    description: 'Display the command history list',
    usage: 'history [n]',
  },
  loadShellBuiltin: async () => (await import('./index.ts')).historyCommandImplementation.fn,
} satisfies WeshShellBuiltinDefinition;

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
