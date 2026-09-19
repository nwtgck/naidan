import type { WeshCommandDefinition } from '@/features/wesh/types';

export const xmlCommandDefinition = {
  meta: {
    name: 'xml',
    description: 'XMLStarlet-like XML toolkit built on browser DOM/XPath APIs',
    usage: 'xml <command> [options] [args]',
  },
  load: async () => (await import('./index.ts')).xmlCommandImplementation.fn,
} satisfies WeshCommandDefinition;

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
