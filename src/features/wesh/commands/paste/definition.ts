import type { WeshCommandDefinition } from '@/features/wesh/types';

export const pasteCommandDefinition = {
  meta: {
    name: 'paste',
    description: 'Merge lines of files in parallel or serially',
    usage: 'paste [OPTION]... [FILE]...',
  },
  load: async () => (await import('./index.ts')).pasteCommandImplementation.fn,
} satisfies WeshCommandDefinition;

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
