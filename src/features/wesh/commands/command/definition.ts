import type { WeshCommandDefinition } from '@/features/wesh/types';

export const commandCommandDefinition = {
  meta: {
    name: 'command',
    description: 'Run command with arguments, ignoring any function or alias',
    usage: 'command [-pVv] command [argument...]',
  },
  load: async () => (await import('./index.ts')).commandCommandImplementation.fn,
} satisfies WeshCommandDefinition;

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
