import type { WeshCommandDefinition } from '@/features/wesh/types';

export const rgCommandDefinition = {
  meta: {
    name: 'rg',
    description: 'Recursively search for a regex pattern',
    usage: 'rg [OPTIONS] PATTERN [PATH ...]',
  },
  load: async () => (await import('./index.ts')).rgCommandImplementation.fn,
} satisfies WeshCommandDefinition;

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
