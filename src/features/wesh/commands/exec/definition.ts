import type { WeshCommandDefinition } from '@/features/wesh/types';

export const execCommandDefinition = {
  meta: {
    name: 'exec',
    description: 'Replace the shell command context or persist file-descriptor changes',
    usage: 'exec [-cl] [-a name] [command [arg...]]',
  },
  load: async () => (await import('./index.ts')).execCommandImplementation.fn,
} satisfies WeshCommandDefinition;

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
