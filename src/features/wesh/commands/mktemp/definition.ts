import type { WeshCommandDefinition } from '@/features/wesh/types';

export const mktempCommandDefinition = {
  meta: {
    name: 'mktemp',
    description: 'Create a temporary file or directory',
    usage: 'mktemp [OPTION]... [TEMPLATE]',
  },
  load: async () => (await import('./index.ts')).mktempCommandImplementation.fn,
} satisfies WeshCommandDefinition;

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
