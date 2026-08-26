import type { WeshCommandContext, WeshCommandResult } from "@/features/wesh/types";
import { readCommit } from "@/features/wesh/commands/git/commits";
import { readEffectiveConfig } from "@/features/wesh/commands/git/config";
import { fastForwardHead } from "@/features/wesh/commands/git/fast-forward";
import { sortGitPaths } from "@/features/wesh/commands/git/path-order";
import { isAncestor } from "@/features/wesh/commands/git/graph";
import { readMergeState } from "@/features/wesh/commands/git/merge-state";
import { resolveGitReflogIdentity, resolveGitTimestamp } from "@/features/wesh/commands/git/identity";
import { readIndex } from "@/features/wesh/commands/git/index-file";
import { readHead } from "@/features/wesh/commands/git/refs";
import { discoverRepositoryFromContext } from "@/features/wesh/commands/git/repository";
import { resolveCommitRevision } from "@/features/wesh/commands/git/revision";
import { abortMerge, continueMerge, integrateDivergentMerge } from "@/features/wesh/commands/git/merge-operation";
import { resolveContentConfigForContext } from "@/features/wesh/commands/git/content-config";
import { printCheckoutConflicts } from "@/features/wesh/commands/git/checkout-like";
import { assertSupportedRepositoryContentPolicy } from "@/features/wesh/commands/git/content-policy";

export async function runMerge({ context, args }: {
    context: WeshCommandContext;
    args: readonly string[];
}): Promise<WeshCommandResult> {
  await assertSupportedRepositoryContentPolicy({ context });
  if (args.length === 1 && args[0] === '--continue')
    return continueMerge({ context });
  if (args.length === 1 && args[0] === '--abort')
    return abortMerge({ context });
  let fastForwardMode: 'default' | 'ff-only' | 'no-ff' = 'default';
  const operands: string[] = [];
  let parsingOptions = true;
  for (const arg of args) {
    if (parsingOptions && arg === '--') {
      parsingOptions = false;
      continue;
    }
    if (parsingOptions && arg === '--ff-only')
      fastForwardMode = 'ff-only';
    else if (parsingOptions && arg === '--no-ff')
      fastForwardMode = 'no-ff';
    else if (parsingOptions && arg === '--ff')
      fastForwardMode = 'default';
    else if (parsingOptions && arg.startsWith('-'))
      throw new Error(`unsupported merge option: ${arg}`);
    else
      operands.push(arg);
  }
  if (operands.length !== 1)
    throw new Error('git merge requires exactly one revision');
  const repository = await discoverRepositoryFromContext({ context });
  const existingMergeState = await readMergeState({ files: context.files, repository });
  if (existingMergeState !== undefined) {
    const unmergedPaths = sortGitPaths({ paths: new Set((await readIndex({ files: context.files, repository }))
      .filter(entry => entry.stage !== 0)
      .map(entry => entry.path)) });
    if (unmergedPaths.length > 0) {
      await context.text().error({ text: 'error: Merging is not possible because you have unmerged files.\n' });
      await context.text().error({ text: 'fatal: Exiting because of an unresolved conflict.\n' });
    } else {
      await context.text().error({ text: 'fatal: You have not concluded your merge (MERGE_HEAD exists).\n' });
      await context.text().error({ text: 'Please, commit your changes before you merge.\n' });
    }
    return { exitCode: 128 };
  }
  const head = await readHead({ files: context.files, repository });
  if (head.objectId === undefined)
    throw new Error('cannot merge on an unborn branch');
  const targetExpression = operands[0]!;
  const targetObjectId = await resolveCommitRevision({ files: context.files, repository, expression: targetExpression });
  await readCommit({ files: context.files, repository, objectId: targetObjectId });
  if (await isAncestor({ files: context.files, repository, ancestorObjectId: targetObjectId, descendantObjectId: head.objectId })) {
    await context.text().print({ text: 'Already up to date.\n' });
    return { exitCode: 0 };
  }
  const fastForward = await isAncestor({
    files: context.files,
    repository,
    ancestorObjectId: head.objectId,
    descendantObjectId: targetObjectId,
  });
  if (!fastForward) {
    switch (fastForwardMode) {
    case 'ff-only':
      await context.text().error({ text: 'fatal: Not possible to fast-forward, aborting.\n' });
      return { exitCode: 128 };
    case 'default':
    case 'no-ff':
      return integrateDivergentMerge({
        context,
        repository,
        headObjectId: head.objectId,
        targetObjectId,
        targetLabel: targetExpression,
        commitMessage: `Merge branch '${targetExpression}'`,
        reflogMessage: `merge ${targetExpression}: Merge made by the 'ort' strategy.`,
      });
    default: {
      const _ex: never = fastForwardMode;
      throw new Error(`Unhandled fast-forward mode: ${_ex}`);
    }
    }
  }
  switch (fastForwardMode) {
  case 'no-ff':
    return integrateDivergentMerge({
      context,
      repository,
      headObjectId: head.objectId,
      targetObjectId,
      targetLabel: targetExpression,
      commitMessage: `Merge branch '${targetExpression}'`,
      reflogMessage: `merge ${targetExpression}: Merge made by the 'ort' strategy.`,
    });
  case 'default':
  case 'ff-only':
    break;
  default: {
    const _ex: never = fastForwardMode;
    throw new Error(`Unhandled fast-forward mode: ${_ex}`);
  }
  }
  const config = await readEffectiveConfig({ files: context.files, repository, homePath: context.env.get('HOME') ?? '/', env: context.env });
  const result = await fastForwardHead({
    files: context.files,
    repository,
    targetObjectId,
    reflog: {
      identity: resolveGitReflogIdentity({ env: context.env, config }),
      timestamp: resolveGitTimestamp({ env: context.env, role: 'COMMITTER' }),
      message: `merge ${targetExpression}: Fast-forward`,
    },
    contentConfig: await resolveContentConfigForContext({ context, repository }),
  });
  switch (result.type) {
  case 'checkout-conflict':
    await printCheckoutConflicts({ context, conflicts: result.conflicts });
    return { exitCode: 1 };
  case 'updated':
    await context.text().print({
      text: `Updating ${result.oldObjectId.slice(0, 7)}..${result.newObjectId.slice(0, 7)}\nFast-forward\n`,
    });
    return { exitCode: 0 };
  default: {
    const _ex: never = result;
    throw new Error(`Unhandled fast-forward result: ${String(_ex)}`);
  }
  }
}

export const TEST_ONLY = {
};
