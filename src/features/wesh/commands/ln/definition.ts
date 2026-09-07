import type { WeshCommandDefinition } from '@/features/wesh/types';

export const lnCommandDefinition = {
  meta: {
    name: 'ln',
    description: 'Make links between files',
    usage: 'ln -s [-f] [-n] [-T] [-r] TARGET LINK_NAME',
  },
  load: async () => (await import('./index.ts')).lnCommandImplementation.fn,
} satisfies WeshCommandDefinition;

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
