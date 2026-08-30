import { GitUsageError } from '@/features/wesh/commands/git/errors';
import type { WeshCommandContext, WeshCommandResult } from "@/features/wesh/types";
import { getConfigValue, readEffectiveConfig } from "@/features/wesh/commands/git/config";
import { fastForwardHead } from "@/features/wesh/commands/git/fast-forward";
import { findMergeBases, isAncestor } from "@/features/wesh/commands/git/graph";
import { fetchLocalRemote } from "@/features/wesh/commands/git/local-transport";
import { resolveGitReflogIdentity, resolveGitTimestamp } from "@/features/wesh/commands/git/identity";
import { branchNameFromHead, readHead, readRef } from "@/features/wesh/commands/git/refs";
import { discoverRepositoryFromContext } from "@/features/wesh/commands/git/repository";
import { startRebaseSequence, validateRebaseStartWorktree } from "@/features/wesh/commands/git/rebase-operation";
import { integrateDivergentMerge } from "@/features/wesh/commands/git/merge-operation";
import { resolveContentConfigForContext } from "@/features/wesh/commands/git/content-config";
import { printCheckoutConflicts } from "@/features/wesh/commands/git/checkout-like";
import { assertSupportedRepositoryContentPolicy } from "@/features/wesh/commands/git/content-policy";
import { defineArgvCatalog, parseStandardArgv, type StandardArgvAction, type StandardArgvPolicy } from '@/features/wesh/argv-v2';

const PULL_ARGV_CATALOG = defineArgvCatalog<StandardArgvAction<never>>({
  nonExecutableLongOptions: [],
  definitions: [
    {
      semantic: { kind: 'effects', effects: [{ key: 'quiet', value: true }] },
      forms: [
        { kind: 'short', name: 'q', value: { kind: 'none' } },
        { kind: 'long', name: 'quiet', value: { kind: 'none' } },
      ],
    },
    {
      semantic: { kind: 'effects', effects: [{ key: 'ffOnly', value: true }] },
      forms: [{ kind: 'long', name: 'ff-only', value: { kind: 'none' } }],
    },
    {
      semantic: { kind: 'effects', effects: [{ key: 'rebase', value: true }] },
      forms: [{ kind: 'long', name: 'rebase', value: { kind: 'none' } }],
    },
    {
      semantic: { kind: 'effects', effects: [{ key: 'rebase', value: false }] },
      forms: [{ kind: 'long', name: 'no-rebase', value: { kind: 'none' } }],
    },
  ],
});

const PULL_ARGV_POLICY: StandardArgvPolicy = {
  longNameMatch: 'exact',
  optionBoundary: 'continue',
  occurrenceRetention: 'none',
};

export async function runPull({ context, args }: {
    context: WeshCommandContext;
    args: readonly string[];
}): Promise<WeshCommandResult> {
  await assertSupportedRepositoryContentPolicy({ context });
  const parsed = parseStandardArgv({ args, catalog: PULL_ARGV_CATALOG, policy: PULL_ARGV_POLICY });
  const diagnostic = parsed.diagnostics[0];
  if (diagnostic !== undefined) {
    throw new GitUsageError({ message: `unknown option: ${args[diagnostic.argvIndex] ?? diagnostic.option}` });
  }
  const ffOnly = parsed.optionValues.ffOnly === true;
  const rebase = parsed.optionValues.rebase === true;
  const quiet = parsed.optionValues.quiet === true;
  const operands = parsed.positionals;
  if (operands.length > 2)
    throw new Error('too many arguments');
  const repository = await discoverRepositoryFromContext({ context });
  const head = await readHead({ files: context.files, repository });
  const currentBranch = branchNameFromHead({ head });
  if (head.objectId === undefined || currentBranch === undefined)
    throw new Error('pull currently requires an attached branch with commits');
  const config = await readEffectiveConfig({ files: context.files, repository, homePath: context.env.get('HOME') ?? '/', cwd: context.cwd, env: context.env });
  const configuredRemote = getConfigValue({ config, key: `branch.${currentBranch}.remote` });
  const configuredMerge = getConfigValue({ config, key: `branch.${currentBranch}.merge` });
  const remoteName = operands[0] ?? configuredRemote ?? 'origin';
  const remoteBranch = operands[1]
        ?? configuredMerge?.replace(/^refs\/heads\//u, '')
        ?? currentBranch;
  const fetchResult = await fetchLocalRemote({ files: context.files, repository, remoteName, config });
  if (!quiet) {
    const changed = fetchResult.branchUpdates.filter(update => update.oldObjectId !== update.newObjectId);
    if (changed.length > 0)
      await context.text().error({ text: `From ${fetchResult.sourcePath}\n` });
  }
  const targetObjectId = await readRef({
    files: context.files,
    repository,
    refName: `refs/remotes/${remoteName}/${remoteBranch}`,
  });
  if (targetObjectId === undefined)
    throw new Error(`couldn't find remote ref ${remoteBranch}`);
  if (await isAncestor({ files: context.files, repository, ancestorObjectId: targetObjectId, descendantObjectId: head.objectId })) {
    if (!quiet)
      await context.text().print({ text: 'Already up to date.\n' });
    return { exitCode: 0 };
  }
  const canFastForward = await isAncestor({
    files: context.files,
    repository,
    ancestorObjectId: head.objectId,
    descendantObjectId: targetObjectId,
  });
  if (!canFastForward) {
    if (ffOnly) {
      await context.text().error({ text: 'fatal: Not possible to fast-forward, aborting.\n' });
      return { exitCode: 128 };
    }
    if (rebase) {
      const preflightFailure = await validateRebaseStartWorktree({ context, repository, headObjectId: head.objectId });
      if (preflightFailure !== undefined)
        return preflightFailure;
      const bases = await findMergeBases({
        files: context.files,
        repository,
        leftObjectId: head.objectId,
        rightObjectId: targetObjectId,
      });
      if (bases.length !== 1) {
        await context.text().error({ text: `fatal: expected one merge base, found ${bases.length}\n` });
        return { exitCode: 128 };
      }
      return startRebaseSequence({
        context,
        repository,
        headRefName: `refs/heads/${currentBranch}`,
        origHeadObjectId: head.objectId,
        checkoutHeadObjectId: head.objectId,
        ontoObjectId: targetObjectId,
        replayBaseObjectId: targetObjectId,
        ontoDisplay: targetObjectId,
        reflogAction: 'pull --rebase',
      });
    }
    return integrateDivergentMerge({
      context,
      repository,
      headObjectId: head.objectId,
      targetObjectId,
      targetLabel: remoteBranch,
      commitMessage: `Merge branch '${remoteBranch}' of ${fetchResult.sourcePath}`,
      reflogMessage: `pull --no-rebase: Merge made by the 'ort' strategy.`,
    });
  }
  const result = await fastForwardHead({
    files: context.files,
    repository,
    targetObjectId,
    reflog: {
      identity: resolveGitReflogIdentity({ env: context.env, config }),
      timestamp: resolveGitTimestamp({ env: context.env, role: 'COMMITTER' }),
      message: `pull ${remoteName} ${remoteBranch}: Fast-forward`,
    },
    contentConfig: await resolveContentConfigForContext({ context, repository }),
  });
  switch (result.type) {
  case 'checkout-conflict':
    await printCheckoutConflicts({ context, conflicts: result.conflicts });
    return { exitCode: 1 };
  case 'updated':
    if (!quiet) {
      await context.text().print({
        text: `Updating ${result.oldObjectId.slice(0, 7)}..${result.newObjectId.slice(0, 7)}\nFast-forward\n`,
      });
    }
    return { exitCode: 0 };
  default: {
    const _ex: never = result;
    throw new Error(`Unhandled pull fast-forward result: ${String(_ex)}`);
  }
  }
}

export const TEST_ONLY = {
};
