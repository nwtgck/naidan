import type { WeshShellBuiltinDefinition } from '@/features/wesh/types';

export const exportCmdCommandDefinition = {
  meta: {
    name: 'export',
    description: 'Set environment variables',
    usage: 'export [-pn] [name[=value]...]',
  },
  loadShellBuiltin: async () => (await import('./index.ts')).exportCmdCommandImplementation.fn,
} satisfies WeshShellBuiltinDefinition;

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
