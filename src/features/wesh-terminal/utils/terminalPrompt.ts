import type { WeshWorkerShellState } from '@/features/wesh/worker/types';

export function formatWeshTerminalPrompt({ shellState }: {
  shellState: WeshWorkerShellState | undefined,
}): string {
  if (shellState === undefined) {
    return '$';
  }

  const home = shellState.env.HOME;
  const displayCwd = home !== undefined && shellState.cwd === home
    ? '~'
    : home !== undefined && shellState.cwd.startsWith(`${home}/`)
      ? `~/${shellState.cwd.slice(home.length + 1)}`
      : shellState.cwd;

  return `${displayCwd} $`;
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {};
