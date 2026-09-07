import type { WeshCommandDefinition } from '@/features/wesh/types';

export const shufCommandDefinition = {
  meta: {
    name: 'shuf',
    description: 'Randomly shuffle lines',
    usage: 'shuf [OPTION]... [FILE]',
  },
  load: async () => (await import('./index.ts')).shufCommandImplementation.fn,
} satisfies WeshCommandDefinition;

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
