import type { WeshCommandContext, WeshCommandResult } from "@/features/wesh/types";
import { GitUsageError } from '@/features/wesh/commands/git/errors';
import { readCommit } from "@/features/wesh/commands/git/commits";
import { getConfigValue, readEffectiveConfig, shouldCreateBranchReflog, removeLocalConfigSection } from "@/features/wesh/commands/git/config";
import { pathExists } from "@/features/wesh/commands/git/files";
import { compileGitWildmatch } from "@/features/wesh/commands/git/wildmatch";
import type { GitWildmatchMatcher } from "@/features/wesh/commands/git/wildmatch";
import { createGitCommitGraphCache, isAncestor } from "@/features/wesh/commands/git/graph";
import { resolveGitReflogIdentity, resolveGitTimestamp } from "@/features/wesh/commands/git/identity";
import { branchNameFromHead, createRef, deleteRef, listRefs, readHead, readRef, renameBranch } from "@/features/wesh/commands/git/refs";
import { discoverRepository, joinPath, discoverRepositoryFromContext } from "@/features/wesh/commands/git/repository";
import { resolveCommitRevision } from "@/features/wesh/commands/git/revision";
import { branchRefName } from "@/features/wesh/commands/git/branch";

function matchesBranchPatterns({ name, matchers }: {
    name: string;
    matchers: readonly GitWildmatchMatcher[];
}): boolean {
  if (matchers.length === 0) {
    return true;
  }
  return matchers.some(matcher => matcher.matches({ value: name }));
}

function isBranchDeleteMode({ mode }: {
    mode: BranchDeleteMode;
}): boolean {
  switch (mode) {
  case 'none':
    return false;
  case 'safe':
  case 'force':
    return true;
  default: {
    const _ex: never = mode;
    throw new Error(`Unhandled branch delete mode: ${_ex}`);
  }
  }
}

function requiresMergedBranch({ mode }: {
    mode: BranchDeleteMode;
}): boolean {
  switch (mode) {
  case 'none':
  case 'force':
    return false;
  case 'safe':
    return true;
  default: {
    const _ex: never = mode;
    throw new Error(`Unhandled branch delete mode: ${_ex}`);
  }
  }
}

async function deleteBranchReflog({ context, repository, refName }: {
    context: WeshCommandContext;
    repository: Awaited<ReturnType<typeof discoverRepository>>;
    refName: string;
}): Promise<void> {
  const path = joinPath({ base: repository.commonDirPath, child: `logs/${refName}` });
  if (await pathExists({ files: context.files, path })) {
    await context.files.unlink({ path });
  }
}

import { parseBranchArguments } from "./arguments";
import type { BranchDeleteMode } from "./arguments";

export async function runBranch({ context, args }: {
    context: WeshCommandContext;
    args: readonly string[];
}): Promise<WeshCommandResult> {
  const repository = await discoverRepositoryFromContext({ context });
  const config = await readEffectiveConfig({
    files: context.files,
    repository,
    homePath: context.env.get('HOME') ?? '/',
    cwd: context.cwd,
    env: context.env,
  });
  const { showCurrent, move, deleteMode, listMode, listOnly, operands } = parseBranchArguments({ args });
  if (move && !showCurrent) {
    if (listOnly || isBranchDeleteMode({ mode: deleteMode })) {
      throw new Error('options are incompatible');
    }
    if (operands.length === 0 || operands.length > 2) {
      throw new Error('branch name required');
    }
    await renameBranch({
      files: context.files,
      repository,
      oldName: operands.length === 2 ? operands[0] : undefined,
      newName: operands.at(-1)!,
      config,
      env: context.env,
    });
    return { exitCode: 0 };
  }

  const head = await readHead({ files: context.files, repository });
  const currentBranch = branchNameFromHead({ head });
  if (showCurrent) {
    if (move || listOnly || isBranchDeleteMode({ mode: deleteMode })) {
      throw new GitUsageError({ message: 'usage: git branch [<options>] [<branch-name>...]', prefix: 'none' });
    }
    if (currentBranch !== undefined) {
      await context.text().print({ text: `${currentBranch}\n` });
    }
    return { exitCode: 0 };
  }
  if (isBranchDeleteMode({ mode: deleteMode })) {
    if (listOnly) {
      throw new Error('options are incompatible');
    }
    const deletingRemoteTrackingBranches = (() => {
      switch (listMode) {
      case 'local':
        return false;
      case 'remote':
        return true;
      case 'all':
        throw new Error("cannot use -a with branch deletion");
      default: {
        const _ex: never = listMode;
        throw new Error(`Unhandled branch list mode: ${_ex}`);
      }
      }
    })();
    if (operands.length === 0) {
      throw new Error('branch name required');
    }
    const deleteConfig = deletingRemoteTrackingBranches ? undefined : config;
    const graphCache = !deletingRemoteTrackingBranches && requiresMergedBranch({ mode: deleteMode })
      ? createGitCommitGraphCache()
      : undefined;
    let exitCode = 0;
    for (const name of operands) {
      if (!deletingRemoteTrackingBranches && name === currentBranch) {
        await context.text().error({
          text: `error: cannot delete branch '${name}' used by worktree at '${repository.worktreePath}'\n`,
        });
        exitCode = 1;
        continue;
      }
      const refName = deletingRemoteTrackingBranches ? `refs/remotes/${name}` : branchRefName({ name });
      const objectId = await readRef({ files: context.files, repository, refName });
      if (objectId === undefined) {
        const kind = deletingRemoteTrackingBranches ? 'remote-tracking branch' : 'branch';
        await context.text().error({ text: `error: ${kind} '${name}' not found.\n` });
        exitCode = 1;
        continue;
      }
      if (!deletingRemoteTrackingBranches && requiresMergedBranch({ mode: deleteMode })) {
        const headMerged = head.objectId !== undefined && await isAncestor({
          files: context.files,
          repository,
          cache: graphCache,
          ancestorObjectId: objectId,
          descendantObjectId: head.objectId,
        });
        const remoteName = deleteConfig === undefined
          ? undefined
          : getConfigValue({ config: deleteConfig, key: `branch.${name}.remote` });
        const mergeRefName = deleteConfig === undefined
          ? undefined
          : getConfigValue({ config: deleteConfig, key: `branch.${name}.merge` });
        const upstreamRefName = remoteName !== undefined && mergeRefName?.startsWith('refs/heads/') === true
          ? remoteName === '.'
            ? mergeRefName
            : `refs/remotes/${remoteName}/${mergeRefName.slice('refs/heads/'.length)}`
          : undefined;
        const upstreamObjectId = upstreamRefName === undefined
          ? undefined
          : await readRef({ files: context.files, repository, refName: upstreamRefName });
        const mergedIntoDeleteBase = upstreamObjectId === undefined
          ? headMerged
          : await isAncestor({
            files: context.files,
            repository,
            cache: graphCache,
            ancestorObjectId: objectId,
            descendantObjectId: upstreamObjectId,
          });
        if (!mergedIntoDeleteBase) {
          if (upstreamObjectId !== undefined && headMerged) {
            await context.text().error({
              text: `warning: not deleting branch '${name}' that is not yet merged to\n         '${upstreamRefName}', even though it is merged to HEAD\n`,
            });
          }
          await context.text().error({ text: `error: the branch '${name}' is not fully merged\n` });
          exitCode = 1;
          continue;
        }
        if (upstreamObjectId !== undefined && !headMerged) {
          await context.text().error({
            text: `warning: deleting branch '${name}' that has been merged to\n         '${upstreamRefName}', but not yet merged to HEAD\n`,
          });
        }
      }
      await deleteRef({ files: context.files, repository, refName });
      await deleteBranchReflog({ context, repository, refName });
      if (!deletingRemoteTrackingBranches) {
        await removeLocalConfigSection({
          files: context.files,
          repository,
          section: 'branch',
          subsection: name,
        });
      }
      const kind = deletingRemoteTrackingBranches ? 'remote-tracking branch' : 'branch';
      await context.text().print({ text: `Deleted ${kind} ${name} (was ${objectId.slice(0, 7)}).\n` });
    }
    return { exitCode };
  }
  if (operands.length === 0 || listOnly) {
    const patterns = listOnly ? operands : [];
    const patternMatchers = patterns.map(pattern => compileGitWildmatch({
      pattern,
      slashMode: 'wildcards-include-slash',
      anchorMode: 'full',
    }));
    if (listMode === 'local' || listMode === 'all') {
      if (patterns.length === 0 && currentBranch === undefined && head.objectId !== undefined) {
        await context.text().print({ text: '* (no branch)\n' });
      }
      const refs = await listRefs({ files: context.files, repository, prefix: 'refs/heads' });
      for (const ref of refs) {
        const name = ref.refName.slice('refs/heads/'.length);
        if (!matchesBranchPatterns({ name, matchers: patternMatchers })) {
          continue;
        }
        await context.text().print({ text: `${name === currentBranch ? '*' : ' '} ${name}\n` });
      }
    }
    if (listMode === 'remote' || listMode === 'all') {
      const refs = await listRefs({ files: context.files, repository, prefix: 'refs/remotes' });
      for (const ref of refs) {
        const shortName = ref.refName.slice('refs/remotes/'.length);
        const displayName = (() => {
          switch (listMode) {
          case 'all': return `remotes/${shortName}`;
          case 'remote': return shortName;
          default: {
            const _ex: never = listMode;
            throw new Error(`Unhandled branch list mode: ${_ex}`);
          }
          }
        })();
        if (!matchesBranchPatterns({ name: displayName, matchers: patternMatchers })) {
          continue;
        }
        const targetSuffix = ref.symbolicTargetRefName === undefined
          ? ''
          : ` -> ${ref.symbolicTargetRefName.slice('refs/remotes/'.length)}`;
        await context.text().print({ text: `  ${displayName}${targetSuffix}\n` });
      }
    }
    return { exitCode: 0 };
  }
  switch (listMode) {
  case 'local':
    break;
  case 'remote':
  case 'all':
    throw new Error("the -a, and -r, options to 'git branch' do not take a branch name; use --list with patterns");
  default: {
    const _ex: never = listMode;
    throw new Error(`Unhandled branch list mode: ${_ex}`);
  }
  }
  if (operands.length > 2) {
    throw new Error('too many arguments');
  }
  const name = operands[0]!;
  const refName = branchRefName({ name });
  if (await readRef({ files: context.files, repository, refName }) !== undefined) {
    throw new Error(`a branch named '${name}' already exists`);
  }
  let startObjectId: string;
  let startDescription: string;
  if (operands[1] !== undefined) {
    startDescription = operands[1];
    startObjectId = await resolveCommitRevision({ files: context.files, repository, expression: operands[1] });
  } else {
    startDescription = currentBranch ?? 'HEAD';
    if (head.objectId === undefined) {
      throw new Error(`not a valid object name: '${startDescription}'`);
    }
    startObjectId = head.objectId;
  }
  await readCommit({ files: context.files, repository, objectId: startObjectId });
  const reflog = !shouldCreateBranchReflog({ config })
    ? undefined
    : {
      identity: resolveGitReflogIdentity({ env: context.env, config }),
      timestamp: resolveGitTimestamp({ env: context.env, role: 'COMMITTER' }),
      message: `branch: Created from ${startDescription}`,
    };
  await createRef({ files: context.files, repository, refName, objectId: startObjectId, reflog });
  return { exitCode: 0 };
}

export const TEST_ONLY = {
};
