import type { WeshCommandContext, WeshCommandResult } from '@/features/wesh/types';
import { executeRestore } from '@/features/wesh/commands/git/restore-operation';
import { parseRestoreArguments } from './arguments';
import { assertSupportedRepositoryContentPolicy } from "@/features/wesh/commands/git/content-policy";

export async function runRestore({ context, args }: {
  context: WeshCommandContext,
  args: readonly string[],
}): Promise<WeshCommandResult> {
  await assertSupportedRepositoryContentPolicy({ context });
  return executeRestore({ context, request: parseRestoreArguments({ args }) });
}

export const TEST_ONLY = {
};
