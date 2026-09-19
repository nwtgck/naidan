import type { WeshCommandDefinition } from '@/features/wesh/types';

export const unsetCommandDefinition = {
  meta: {
    name: 'unset',
    description: 'Unset environment variables',
    usage: 'unset [-v] [-f] [name ...]',
  },
  load: async () => (await import('./index.ts')).unsetCommandImplementation.fn,
} satisfies WeshCommandDefinition;

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
