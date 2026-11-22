import type { WeshShellBuiltinDefinition } from '@/features/wesh/types';

export const killCommandDefinition = {
  meta: {
    name: 'kill',
    description: 'Send signals to processes or process groups, or list signal names',
    usage: 'kill -l [SIGNAL ...] | kill [-s SIGNAL | -n NUMBER | -SIGNAL] [--] PID ...',
  },
  loadShellBuiltin: async () => (await import('./index.ts')).killCommandImplementation.fn,
} satisfies WeshShellBuiltinDefinition;

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
