import type { WeshCommandDefinition } from '@/features/wesh/types';

export const pwdCommandDefinition = {
  meta: {
    name: 'pwd',
    description: 'Print name of current/working directory',
    usage: 'pwd [-LP]',
  },
  load: async () => (await import('./index.ts')).pwdCommandImplementation.fn,
} satisfies WeshCommandDefinition;

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
