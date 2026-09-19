import type { WeshCommandDefinition } from '@/features/wesh/types';

export const gitCommandDefinition = {
  meta: {
    name: 'git',
    description: 'Git-compatible version control commands',
    usage: 'git [--version] [--help] <command> [<args>]',
  },
  load: async () => (await import('./index.ts')).gitCommandImplementation.fn,
} satisfies WeshCommandDefinition;

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
