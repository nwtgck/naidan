import type { WeshCommandDefinition } from '@/features/wesh/types';

export const base64CommandDefinition = {
  meta: {
    name: 'base64',
    description: 'Base64 encode or decode data',
    usage: 'base64 [OPTION]... [FILE]',
  },
  load: async () => (await import('./index.ts')).base64CommandImplementation.fn,
} satisfies WeshCommandDefinition;

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
