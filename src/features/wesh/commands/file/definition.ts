import type { WeshCommandDefinition } from '@/features/wesh/types';

export const fileCommandDefinition = {
  meta: {
    name: 'file',
    description: 'Determine file type',
    usage: 'file [-b] [-F SEPARATOR] [-i] [-L] [--brief] [--mime] [--mime-type] [--mime-encoding] [--help] FILE...',
  },
  load: async () => (await import('./index.ts')).fileCommandImplementation.fn,
} satisfies WeshCommandDefinition;

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
