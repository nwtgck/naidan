import type { WeshCommandDefinition } from '@/features/wesh/types';

export const clearCommandDefinition = {
  meta: {
    name: 'clear',
    description: 'Clear the terminal screen',
    usage: 'clear',
  },
  load: async () => (await import('./index.ts')).clearCommandImplementation.fn,
} satisfies WeshCommandDefinition;

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
