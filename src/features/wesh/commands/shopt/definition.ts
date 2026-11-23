import type { WeshShellBuiltinDefinition } from '@/features/wesh/types';

export const shoptCommandDefinition = {
  meta: {
    name: 'shopt',
    description: 'Set and unset shell options',
    usage: 'shopt [-opqsu] [optname ...]',
  },
  loadShellBuiltin: async () => (await import('./index.ts')).shoptCommandImplementation.fn,
} satisfies WeshShellBuiltinDefinition;

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
