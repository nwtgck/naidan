import type { WeshCommandDefinition } from '@/features/wesh/types';

export const wcCommandDefinition = {
  meta: {
    name: 'wc',
    description: 'Print newline, word, byte, character, and line length counts',
    usage: 'wc [OPTION]... [FILE]... | wc [OPTION]... --files0-from=FILE',
  },
  load: async () => (await import('./index.ts')).wcCommandImplementation.fn,
} satisfies WeshCommandDefinition;

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
