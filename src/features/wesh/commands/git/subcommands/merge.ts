import { formatGitAmbiguousLongOption } from '@/features/wesh/commands/git/argv-diagnostics';
import { GitUsageError } from '@/features/wesh/commands/git/errors';
import { analyzeArgvLongForm, defineArgvCatalog } from '@/features/wesh/argv-v2';
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

type MergeFastForwardMode = 'default' | 'ff-only' | 'no-ff';
type MergeControlAction = 'continue' | 'abort';

const MERGE_FF_ARGV_CATALOG = defineArgvCatalog<'ff-only' | 'no-ff'>({
  nonExecutableLongOptions: ['file'],
  definitions: [
    {
      semantic: 'ff-only',
      forms: [{ kind: 'long', name: 'ff-only', value: { kind: 'none' } }],
    },
    {
      semantic: 'no-ff',
      forms: [{ kind: 'long', name: 'no-ff', value: { kind: 'none' } }],
    },
  ],
});

function resolveMergeControlAction({ token }: { token: string }): MergeControlAction | undefined {
  if (!token.startsWith('--') || token.includes('=')) return undefined;
  const name = token.slice(2);
  if (name.length >= 3 && 'continue'.startsWith(name)) return 'continue';
  if (name.length >= 2 && 'abort'.startsWith(name)) return 'abort';
  return undefined;
}

function updateMergeFastForwardMode({
  arg,
}: {
  arg: string;
}): MergeFastForwardMode | undefined {
  if (arg === '--ff') return 'default';
  if (!arg.startsWith('--')) return undefined;
  const analysis = analyzeArgvLongForm({
    token: arg,
    catalog: MERGE_FF_ARGV_CATALOG,
    longNameMatch: 'unique-prefix',
  });
  switch (analysis.kind) {
  case 'matched':
    switch (analysis.value.kind) {
    case 'none':
      break;
    case 'unexpected-inline':
    case 'inline':
    case 'following-required':
      throw new GitUsageError({ message: `unsupported merge option: ${arg}` });
    default: {
      const _ex: never = analysis.value;
      throw new Error(`Unhandled merge argv-v2 value analysis: ${JSON.stringify(_ex)}`);
    }
    }
    switch (analysis.semantic) {
    case 'ff-only':
      return 'ff-only';
    case 'no-ff':
      return 'no-ff';
    default: {
      const _ex: never = analysis.semantic;
      throw new Error(`Unhandled merge argv-v2 semantic: ${_ex}`);
    }
    }
  case 'ambiguous':
    throw new GitUsageError({
      message: formatGitAmbiguousLongOption({
        option: analysis.option,
        candidateOptions: analysis.candidateOptions,
      }),
    });
  case 'unknown':
    return undefined;
  default: {
    const _ex: never = analysis;
    throw new Error(`Unhandled merge argv-v2 analysis: ${JSON.stringify(_ex)}`);
  }
  }
}

export async function runMerge({ context, args }: {
    context: WeshCommandContext;
    args: readonly string[];
}): Promise<WeshCommandResult> {
  await assertSupportedRepositoryContentPolicy({ context });
  const controlAction = args.length === 1 ? resolveMergeControlAction({ token: args[0]! }) : undefined;
  switch (controlAction) {
  case 'continue':
    return continueMerge({ context });
  case 'abort':
    return abortMerge({ context });
  case undefined:
    break;
  default: {
    const _ex: never = controlAction;
    throw new Error(`Unhandled merge control action: ${_ex}`);
  }
  }
  let fastForwardMode: MergeFastForwardMode = 'default';
  const operands: string[] = [];
  let parsingOptions = true;
  for (const arg of args) {
    if (parsingOptions && arg === '--') {
      parsingOptions = false;
      continue;
    }
    if (parsingOptions) {
      const nextMode = updateMergeFastForwardMode({ arg });
      if (nextMode !== undefined) {
        fastForwardMode = nextMode;
        continue;
      }
    }
    if (parsingOptions && arg.startsWith('-'))
      throw new GitUsageError({ message: `unsupported merge option: ${arg}` });
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
  const config = await readEffectiveConfig({ files: context.files, repository, homePath: context.env.get('HOME') ?? '/', cwd: context.cwd, env: context.env });
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
