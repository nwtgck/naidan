import type { WeshCommandContext, WeshCommandResult } from "@/features/wesh/types";
import { selectRepositoryPaths } from "@/features/wesh/commands/git/pathspec";
import type { GitIndexEntry } from "@/features/wesh/commands/git/index-file";
import { readIndex, writeIndex } from "@/features/wesh/commands/git/index-file";
import { discoverRepositoryFromContext } from "@/features/wesh/commands/git/repository";
import { replaceTrackedWorktree } from "@/features/wesh/commands/git/worktree";
import { readCommitIndex } from "@/features/wesh/commands/git/commit-index";
import { resolveContentConfigForContext } from "@/features/wesh/commands/git/content-config";

export interface RestoreRequest {
  staged: boolean;
  worktree: boolean;
  sourceExpression: string | undefined;
  operands: string[];
}

export async function executeRestore({ context, request }: {
  context: WeshCommandContext;
  request: RestoreRequest;
}): Promise<WeshCommandResult> {
  const repository = await discoverRepositoryFromContext({ context });
  const currentIndex = await readIndex({ files: context.files, repository });
  for (const entry of currentIndex) {
    if (entry.stage !== 0)
      throw new Error(`unmerged index entry is not supported yet: ${entry.path}`);
  }
  const sourceEntries = request.sourceExpression !== undefined
    ? await readCommitIndex({ context, repository, revisionExpression: request.sourceExpression })
    : request.staged
      ? await readCommitIndex({ context, repository, revisionExpression: 'HEAD' })
      : currentIndex;
  const sourceByPath = new Map(sourceEntries.map(entry => [entry.path, entry]));
  const currentByPath = new Map(currentIndex.map(entry => [entry.path, entry]));
  const selectedPaths = selectRepositoryPaths({
    repository,
    cwd: context.cwd,
    operands: request.operands,
    availablePaths: [...currentByPath.keys(), ...sourceByPath.keys()],
  });
  const selectedCurrentEntries = [...selectedPaths]
    .map(path => currentByPath.get(path))
    .filter((entry): entry is GitIndexEntry => entry !== undefined);
  const selectedSourceEntries = [...selectedPaths]
    .map(path => sourceByPath.get(path))
    .filter((entry): entry is GitIndexEntry => entry !== undefined);
  if (request.worktree) {
    await replaceTrackedWorktree({
      files: context.files,
      repository,
      previousEntries: selectedCurrentEntries,
      targetEntries: selectedSourceEntries,
      attributeEntries: sourceEntries,
      contentConfig: await resolveContentConfigForContext({ context, repository }),
    });
  }
  if (request.staged) {
    for (const path of selectedPaths) {
      const sourceEntry = sourceByPath.get(path);
      if (sourceEntry === undefined)
        currentByPath.delete(path);
      else
        currentByPath.set(path, sourceEntry);
    }
    await writeIndex({ files: context.files, repository, entries: [...currentByPath.values()] });
  }
  return { exitCode: 0 };
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
