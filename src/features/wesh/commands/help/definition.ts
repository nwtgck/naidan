import type { WeshCommandDefinition } from '@/features/wesh/types';

export const helpCommandDefinition = {
  meta: {
    name: 'help',
    description: 'Display information about builtin commands',
    usage: 'help [COMMAND]',
  },
  load: async () => (await import('./index.ts')).helpCommandImplementation.fn,
} satisfies WeshCommandDefinition;

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
