import type { WeshCommandDefinition } from '@/features/wesh/types';

export const gunzipCommandDefinition = {
  meta: {
    name: 'gunzip',
    description: 'Decompress files',
    usage: 'gunzip [OPTION]... [FILE]...',
  },
  load: async () => (await import('./index.ts')).gunzipCommandImplementation.fn,
} satisfies WeshCommandDefinition;

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
