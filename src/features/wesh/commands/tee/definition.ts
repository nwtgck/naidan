import type { WeshCommandDefinition } from '@/features/wesh/types';

export const teeCommandDefinition = {
  meta: {
    name: 'tee',
    description: 'Read from standard input and write to standard output and files',
    usage: 'tee [OPTION]... [FILE]...',
  },
  load: async () => (await import('./index.ts')).teeCommandImplementation.fn,
} satisfies WeshCommandDefinition;

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
