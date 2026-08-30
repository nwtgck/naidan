import type { WeshCommandDefinition } from '@/features/wesh/types';

export const lsCommandDefinition = {
  meta: {
    name: 'ls',
    description: 'List directory contents',
    usage: 'ls [path...] [-l] [-a] [-A] [-R] [-1] [-h] [-L] [-H]',
  },
  load: async () => (await import('./index.ts')).lsCommandImplementation.fn,
} satisfies WeshCommandDefinition;

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
