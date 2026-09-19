import type { WeshCommandDefinition } from '@/features/wesh/types';

export const sedCommandDefinition = {
  meta: {
    name: "sed",
    description: "Stream editor for filtering and transforming text",
    usage: "sed [OPTION]... {script-only-if-no-other-script} [input-file]...",
  },
  load: async () => (await import('./index.ts')).sedCommandImplementation.fn,
} satisfies WeshCommandDefinition;

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
