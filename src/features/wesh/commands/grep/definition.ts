import type { WeshCommandDefinition } from '@/features/wesh/types';

export const grepCommandDefinition = {
  meta: {
    name: "grep",
    description: "Search for patterns in files",
    usage: "grep [OPTION]... PATTERNS [FILE]...",
  },
  load: async () => (await import('./index.ts')).grepCommandImplementation.fn,
} satisfies WeshCommandDefinition;

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
