import type { WeshCommandDefinition } from '@/features/wesh/types';

export const unzipCommandDefinition = {
  meta: {
    name: 'unzip',
    description: 'List, test and extract compressed files in a ZIP archive',
    usage: 'unzip [-ltpnjoq] [-d dir] archive[.zip] [file ...]',
  },
  load: async () => (await import('./index.ts')).unzipCommandImplementation.fn,
} satisfies WeshCommandDefinition;

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
