import type { WeshCommandDefinition } from '@/features/wesh/types';

export const testCommandDefinition = {
  meta: {
    name: 'test',
    description: 'Evaluate shell conditional expressions',
    usage: 'test EXPRESSION',
  },
  load: async () => (await import('./index.ts')).createTestCommandImplementation({ commandName: 'test' }).fn,
} satisfies WeshCommandDefinition;

export const leftBracketCommandDefinition = {
  meta: {
    name: '[',
    description: 'Evaluate shell conditional expressions',
    usage: '[ EXPRESSION ]',
  },
  load: async () => (await import('./index.ts')).createTestCommandImplementation({ commandName: '[' }).fn,
} satisfies WeshCommandDefinition;

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
