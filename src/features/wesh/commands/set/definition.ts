import type { WeshShellBuiltinDefinition } from '@/features/wesh/types';

export const setCommandDefinition = {
  meta: {
    name: 'set',
    description: 'Display shell variables or change shell options and positional parameters',
    usage: 'set [+-aeu] [+-o [option-name]] [--] [arg ...]',
  },
  loadShellBuiltin: async () => (await import('./index.ts')).setCommandImplementation.fn,
} satisfies WeshShellBuiltinDefinition;

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
