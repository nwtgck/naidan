import type { WeshCommandContext, WeshCommandResult } from "@/features/wesh/types";
import { readCommit } from "@/features/wesh/commands/git/commits";
import { getConfigValue, readEffectiveConfig, renameLocalConfigSection } from "@/features/wesh/commands/git/config";
import { pathExists } from "@/features/wesh/commands/git/files";
import { gitPathspecGlobSource } from "@/features/wesh/commands/git/wildmatch";
import { isAncestor } from "@/features/wesh/commands/git/graph";
import { resolveGitReflogIdentity, resolveGitTimestamp } from "@/features/wesh/commands/git/identity";
import { branchNameFromHead, createRef, deleteRef, listRefs, readHead, readRef, renameRef, setHeadSymbolic } from "@/features/wesh/commands/git/refs";
import { discoverRepository, joinPath, discoverRepositoryFromContext } from "@/features/wesh/commands/git/repository";
import { resolveCommitRevision } from "@/features/wesh/commands/git/revision";
import { appendReflog } from "@/features/wesh/commands/git/reflog";
import { branchRefName } from "@/features/wesh/commands/git/branch";

function matchesBranchPatterns({ name, patterns }: {
    name: string;
    patterns: readonly string[];
}): boolean {
  if (patterns.length === 0)
    return true;
  return patterns.some(pattern => new RegExp(`^${gitPathspecGlobSource({ pattern })}$`, 'u').test(name));
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
  if (await pathExists({ files: context.files, path }))
    await context.files.unlink({ path });
}
import { parseBranchArguments } from "./arguments";
import type { BranchDeleteMode } from "./arguments";
export async function runBranch({ context, args }: {
    context: WeshCommandContext;
    args: readonly string[];
}): Promise<WeshCommandResult> {
  const repository = await discoverRepositoryFromContext({ context });
  const head = await readHead({ files: context.files, repository });
  const currentBranch = branchNameFromHead({ head });
  const { showCurrent, move, deleteMode, listMode, listOnly, operands } = parseBranchArguments({ args });
  if (showCurrent) {
    if (operands.length > 0 || move || listOnly || isBranchDeleteMode({ mode: deleteMode }) || listMode !== 'local') {
      throw new Error('options are incompatible');
    }
    if (currentBranch !== undefined)
      await context.text().print({ text: `${currentBranch}\n` });
    return { exitCode: 0 };
  }
  if (move) {
    if (showCurrent || listOnly || isBranchDeleteMode({ mode: deleteMode }))
      throw new Error('options are incompatible');
    if (operands.length === 0 || operands.length > 2)
      throw new Error('branch name required');
    const oldName = operands.length === 1 ? currentBranch : operands[0];
    const newName = operands.length === 1 ? operands[0]! : operands[1]!;
    if (oldName === undefined)
      throw new Error('cannot rename the current branch while not on any branch');
    const oldRefName = branchRefName({ name: oldName });
    const newRefName = branchRefName({ name: newName });
    if (await readRef({ files: context.files, repository, refName: newRefName }) !== undefined) {
      throw new Error(`a branch named '${newName}' already exists`);
    }
    const objectId = await readRef({ files: context.files, repository, refName: oldRefName });
    const renamingCurrent = head.symbolicRef === oldRefName;
    if (objectId === undefined) {
      if (!renamingCurrent)
        throw new Error(`branch '${oldName}' not found`);
      await setHeadSymbolic({ files: context.files, repository, refName: newRefName });
      await renameLocalConfigSection({
        files: context.files,
        repository,
        section: 'branch',
        oldSubsection: oldName,
        newSubsection: newName,
      });
      return { exitCode: 0 };
    }
    const config = await readEffectiveConfig({ files: context.files, repository, homePath: context.env.get('HOME') ?? '/', env: context.env });
    const logAllRefUpdates = getConfigValue({ config, key: 'core.logallrefupdates' }) !== 'false';
    const identity = resolveGitReflogIdentity({ env: context.env, config });
    const timestamp = resolveGitTimestamp({ env: context.env, role: 'COMMITTER' });
    const message = `Branch: renamed ${oldRefName} to ${newRefName}`;
    if (!await renameRef({
      files: context.files,
      repository,
      oldRefName,
      newRefName,
      reflog: logAllRefUpdates ? { identity, timestamp, message } : undefined,
    }))
      throw new Error(`branch '${oldName}' not found`);
    if (renamingCurrent) {
      await setHeadSymbolic({ files: context.files, repository, refName: newRefName });
      if (logAllRefUpdates) {
        const headLogPath = joinPath({ base: repository.gitDirPath, child: 'logs/HEAD' });
        const zero = '0000000000000000000000000000000000000000';
        await appendReflog({
          files: context.files, path: headLogPath, oldObjectId: objectId, newObjectId: zero, identity, timestamp, message,
        });
        await appendReflog({
          files: context.files, path: headLogPath, oldObjectId: zero, newObjectId: objectId, identity, timestamp, message,
        });
      }
    }
    await renameLocalConfigSection({
      files: context.files,
      repository,
      section: 'branch',
      oldSubsection: oldName,
      newSubsection: newName,
    });
    return { exitCode: 0 };
  }
  if (isBranchDeleteMode({ mode: deleteMode })) {
    if (listOnly)
      throw new Error('options are incompatible');
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
    if (operands.length === 0)
      throw new Error('branch name required');
    const deleteConfig = !deletingRemoteTrackingBranches && requiresMergedBranch({ mode: deleteMode })
      ? await readEffectiveConfig({
        files: context.files,
        repository,
        homePath: context.env.get('HOME') ?? '/',
        env: context.env,
      })
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
      const kind = deletingRemoteTrackingBranches ? 'remote-tracking branch' : 'branch';
      await context.text().print({ text: `Deleted ${kind} ${name} (was ${objectId.slice(0, 7)}).\n` });
    }
    return { exitCode };
  }
  if (operands.length === 0 || listOnly) {
    const patterns = listOnly ? operands : [];
    if (listMode === 'local' || listMode === 'all') {
      if (patterns.length === 0 && currentBranch === undefined && head.objectId !== undefined) {
        await context.text().print({ text: '* (no branch)\n' });
      }
      const refs = await listRefs({ files: context.files, repository, prefix: 'refs/heads' });
      for (const ref of refs) {
        const name = ref.refName.slice('refs/heads/'.length);
        if (!matchesBranchPatterns({ name, patterns }))
          continue;
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
        if (!matchesBranchPatterns({ name: displayName, patterns }))
          continue;
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
  if (operands.length > 2)
    throw new Error('too many arguments');
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
    if (head.objectId === undefined)
      throw new Error(`not a valid object name: '${startDescription}'`);
    startObjectId = head.objectId;
  }
  await readCommit({ files: context.files, repository, objectId: startObjectId });
  const config = await readEffectiveConfig({ files: context.files, repository, homePath: context.env.get('HOME') ?? '/', env: context.env });
  const reflog = getConfigValue({ config, key: 'core.logallrefupdates' }) === 'false'
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
