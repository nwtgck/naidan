import type { WeshCommandDefinition } from '@/features/wesh/types';

export const exportCmdCommandDefinition = {
  meta: {
    name: 'export',
    description: 'Set environment variables',
    usage: 'export [-pn] [name[=value]...]',
  },
  load: async () => (await import('./index.ts')).exportCmdCommandImplementation.fn,
} satisfies WeshCommandDefinition;

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
