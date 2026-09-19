import type { WeshCommandDefinition } from '@/features/wesh/types';

export const xargsCommandDefinition = {
  meta: {
    name: 'xargs',
    description: 'Build and run command lines from standard input',
    usage: 'xargs [-0rtx] [-a FILE] [-d DELIM] [-E EOFSTR] [-n MAX] [-L MAX] [-s MAX] [-I REPLSTR] [COMMAND [INITIAL-ARGS]...]',
  },
  load: async () => (await import('./index.ts')).xargsCommandImplementation.fn,
} satisfies WeshCommandDefinition;

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
