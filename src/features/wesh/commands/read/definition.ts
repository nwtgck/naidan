import type { WeshCommandDefinition } from '@/features/wesh/types';

export const readCommandDefinition = {
  meta: {
    name: 'read',
    description: 'Read a line from standard input or a file descriptor into shell variables',
    usage: 'read [-r] [-d delim] [-n nchars] [-N nchars] [-s] [-p prompt] [-u fd] [name...]',
  },
  load: async () => (await import('./index.ts')).readCommandImplementation.fn,
} satisfies WeshCommandDefinition;

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
