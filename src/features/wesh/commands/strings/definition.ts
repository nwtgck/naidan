import type { WeshCommandDefinition } from '@/features/wesh/types';

export const stringsCommandDefinition = {
  meta: {
    name: 'strings',
    description: 'Print the printable strings in files',
    usage: 'strings [OPTION]... [FILE]...',
  },
  load: async () => (await import('./index.ts')).stringsCommandImplementation.fn,
} satisfies WeshCommandDefinition;

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
