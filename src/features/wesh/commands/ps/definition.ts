import type { WeshCommandDefinition } from '@/features/wesh/types';

export const psCommandDefinition = {
  meta: {
    name: 'ps',
    description: 'Report process status',
    usage: 'ps [-eA] [-p PIDLIST] [-o FORMAT]',
  },
  load: async () => (await import('./index.ts')).psCommandImplementation.fn,
} satisfies WeshCommandDefinition;

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
