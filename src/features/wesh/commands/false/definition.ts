import type { WeshCommandDefinition } from '@/features/wesh/types';

export const falseCommandDefinition = {
  meta: {
    name: 'false',
    description: 'Do nothing unsuccessfully',
    usage: 'false [arguments...]',
  },
  load: async () => (await import('./index.ts')).falseCommandImplementation.fn,
} satisfies WeshCommandDefinition;

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
