import type { WeshCommandDefinition } from '@/features/wesh/types';

export const cpCommandDefinition = {
  meta: {
    name: 'cp',
    description: 'Copy files',
    usage: 'cp [-R] [-H|-L|-P] [-f|-n] [-T] [-t DIR] source... destination',
  },
  load: async () => (await import('./index.ts')).cpCommandImplementation.fn,
} satisfies WeshCommandDefinition;

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
