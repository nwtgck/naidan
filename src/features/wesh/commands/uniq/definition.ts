import type { WeshCommandDefinition } from '@/features/wesh/types';

export const uniqCommandDefinition = {
  meta: {
    name: 'uniq',
    description: 'Report or omit repeated lines',
    usage: 'uniq [OPTION]... [INPUT [OUTPUT]]',
  },
  load: async () => (await import('./index.ts')).uniqCommandImplementation.fn,
} satisfies WeshCommandDefinition;

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
