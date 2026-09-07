import type { WeshCommandDefinition } from '@/features/wesh/types';

export const tailCommandDefinition = {
  meta: {
    name: 'tail',
    description: 'Output the last part of files',
    usage: 'tail [OPTION]... [FILE]...',
  },
  load: async () => (await import('./index.ts')).tailCommandImplementation.fn,
} satisfies WeshCommandDefinition;

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
