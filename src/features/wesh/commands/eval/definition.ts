import type { WeshCommandDefinition } from '@/features/wesh/types';

export const evalCommandDefinition = {
  meta: {
    name: 'eval',
    description: 'Evaluate arguments as shell code',
    usage: 'eval [arg...]',
  },
  load: async () => (await import('./index.ts')).evalCommandImplementation.fn,
} satisfies WeshCommandDefinition;

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
