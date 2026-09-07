import type { WeshCommandDefinition } from '@/features/wesh/types';

export const sha256sumCommandDefinition = {
  meta: {
    name: 'sha256sum',
    description: 'Print or check SHA256 checksums',
    usage: 'sha256sum [OPTION]... [FILE]...',
  },
  load: async () => (await import('./index.ts')).sha256sumCommandImplementation.fn,
} satisfies WeshCommandDefinition;

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
