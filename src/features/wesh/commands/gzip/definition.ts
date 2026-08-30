import type { WeshCommandDefinition } from '@/features/wesh/types';

export const gzipCommandDefinition = {
  meta: {
    name: 'gzip',
    description: 'Compress files',
    usage: 'gzip [file...]',
  },
  load: async () => (await import('./index.ts')).gzipCommandImplementation.fn,
} satisfies WeshCommandDefinition;

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
