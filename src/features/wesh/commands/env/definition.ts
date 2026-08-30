import type { WeshCommandDefinition } from '@/features/wesh/types';

export const envCommandDefinition = {
  meta: {
    name: 'env',
    description: 'Run a command in a modified environment',
    usage: 'env [-i] [-0] [-u name] [-C dir] [name=value ...] [command [argument ...]]',
  },
  load: async () => (await import('./index.ts')).envCommandImplementation.fn,
} satisfies WeshCommandDefinition;

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
