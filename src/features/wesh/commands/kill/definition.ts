import type { WeshCommandDefinition } from '@/features/wesh/types';

export const killCommandDefinition = {
  meta: {
    name: 'kill',
    description: 'List signals or signal a Wesh process or process group',
    usage: 'kill -l [SIGNAL ...] | kill [-s SIGNAL | -SIGNAL] PID ...',
  },
  load: async () => (await import('./index.ts')).killCommandImplementation.fn,
} satisfies WeshCommandDefinition;

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
