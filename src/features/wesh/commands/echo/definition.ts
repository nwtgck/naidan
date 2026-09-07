import type { WeshCommandDefinition } from '@/features/wesh/types';

export const echoCommandDefinition = {
  meta: {
    name: 'echo',
    description: 'Display a line of text',
    usage: 'echo [-neE] [string...]',
  },
  load: async () => (await import('./index.ts')).echoCommandImplementation.fn,
} satisfies WeshCommandDefinition;

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
