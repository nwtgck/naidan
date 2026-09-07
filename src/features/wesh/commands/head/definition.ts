import type { WeshCommandDefinition } from '@/features/wesh/types';

export const headCommandDefinition = {
  meta: {
    name: 'head',
    description: 'Output the first part of files',
    usage: 'head [OPTION]... [FILE]...',
  },
  load: async () => (await import('./index.ts')).headCommandImplementation.fn,
} satisfies WeshCommandDefinition;

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
