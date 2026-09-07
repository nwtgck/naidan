import type { WeshCommandDefinition } from '@/features/wesh/types';

export const statCommandDefinition = {
  meta: {
    name: 'stat',
    description: 'Display file status from the Wesh virtual filesystem',
    usage: 'stat [-L] [-c FORMAT | --printf FORMAT] FILE...',
  },
  load: async () => (await import('./index.ts')).statCommandImplementation.fn,
} satisfies WeshCommandDefinition;

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
