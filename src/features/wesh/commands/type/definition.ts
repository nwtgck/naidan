import type { WeshCommandDefinition } from '@/features/wesh/types';

export const typeCommandDefinition = {
  meta: {
    name: 'type',
    description: 'Describe how command names are interpreted',
    usage: 'type [-afptP] name [name ...]',
  },
  load: async () => (await import('./index.ts')).typeCommandImplementation.fn,
} satisfies WeshCommandDefinition;

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
