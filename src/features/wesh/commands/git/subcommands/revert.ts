import type { WeshCommandContext, WeshCommandResult } from '@/features/wesh/types';
import { executeReplay } from '@/features/wesh/commands/git/replay-operation';
import { assertSupportedRepositoryContentPolicy } from '@/features/wesh/commands/git/content-policy';
import { parseReplayArguments } from '@/features/wesh/commands/git/replay-arguments';

export async function runRevert({ context, args }: {
  context: WeshCommandContext;
  args: readonly string[];
}): Promise<WeshCommandResult> {
  await assertSupportedRepositoryContentPolicy({ context });
  return executeReplay({ context, request: parseReplayArguments({ args, kind: 'revert' }), kind: 'revert' });
}

export const TEST_ONLY = {
};
