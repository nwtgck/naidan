import type { WeshCommandDefinition } from '@/features/wesh/types';

export const cdCommandDefinition = {
  meta: {
    name: 'cd',
    description: 'Change current directory',
    usage: 'cd [-LP] [path]',
  },
  load: async () => (await import('./index.ts')).cdCommandImplementation.fn,
} satisfies WeshCommandDefinition;

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
