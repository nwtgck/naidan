import type { WeshCommandContext } from "@/features/wesh/types";
import { readCommit } from "./commits";
import type { GitIndexEntry } from "./index-file";
import { discoverRepository } from "./repository";
import { resolveCommitRevision } from "./revision";
import { readTreeIntoIndex } from "./tree";

export async function readCommitIndex({ context, repository, revisionExpression }: {
    context: WeshCommandContext;
    repository: Awaited<ReturnType<typeof discoverRepository>>;
    revisionExpression: string;
}): Promise<GitIndexEntry[]> {
  const objectId = await resolveCommitRevision({
    files: context.files,
    repository,
    expression: revisionExpression,
  });
  const commit = await readCommit({ files: context.files, repository, objectId });
  return readTreeIntoIndex({ files: context.files, repository, treeObjectId: commit.treeObjectId });
}

export const TEST_ONLY = {
};
