import { normalizePath } from "@/features/wesh/path";
import type { WeshCommandContext, WeshCommandResult } from "@/features/wesh/types";
import { readCommit } from "@/features/wesh/commands/git/commits";
import { readEffectiveConfig, setLocalConfigValue } from "@/features/wesh/commands/git/config";
import { pathExists } from "@/features/wesh/commands/git/files";
import { assertLocalRepositoryLocation } from "@/features/wesh/commands/git/local-transport";
import { resolveGitReflogIdentity, resolveGitTimestamp } from "@/features/wesh/commands/git/identity";
import { forceReplaceIndexAndWorktree } from "@/features/wesh/commands/git/index-worktree";
import { transferReachableObjects } from "@/features/wesh/commands/git/object-transfer";
import { branchNameFromHead, listRefs, moveHeadReference, readHead, setHeadSymbolic, writeRef, writeSymbolicRef } from "@/features/wesh/commands/git/refs";
import { discoverRepositoryAtPath, initializeRepository } from "@/features/wesh/commands/git/repository";
import { peelToCommitObjectId } from "@/features/wesh/commands/git/revision";
import { readTreeIntoIndex } from "@/features/wesh/commands/git/tree";
import { resolveContentConfigForContext } from "@/features/wesh/commands/git/content-config";
import { assertSupportedCloneContentPolicy } from "@/features/wesh/commands/git/content-policy";

function localCloneDestinationName({ sourcePath }: {
    sourcePath: string;
}): string {
  const trimmed = sourcePath.replace(/\/+$/u, '');
  const basename = trimmed.slice(trimmed.lastIndexOf('/') + 1).replace(/\.git$/u, '');
  if (basename.length === 0)
    throw new Error(`cannot derive destination directory from '${sourcePath}'`);
  return basename;
}
async function assertCloneDestinationAvailable({ context, destinationPath, displayName }: {
    context: WeshCommandContext;
    destinationPath: string;
    displayName: string;
}): Promise<boolean> {
  if (!await pathExists({ files: context.files, path: destinationPath }))
    return false;
  const stat = await context.files.stat({ path: destinationPath });
  switch (stat.type) {
  case 'directory': {
    for await (const _entry of context.files.readDir({ path: destinationPath })) {
      void _entry;
      throw new Error(`destination path '${displayName}' already exists and is not an empty directory.`);
    }
    return true;
  }
  case 'file':
  case 'fifo':
  case 'chardev':
  case 'symlink':
    throw new Error(`destination path '${displayName}' already exists and is not an empty directory.`);
  default: {
    const _ex: never = stat.type;
    throw new Error(`Unhandled clone destination type: ${_ex}`);
  }
  }
}
async function cleanupCloneDestination({ context, destinationPath, removeRoot }: {
    context: WeshCommandContext;
    destinationPath: string;
    removeRoot: boolean;
}): Promise<void> {
  const removeRecursively = async ({ path }: {
        path: string;
    }): Promise<void> => {
    if (!await pathExists({ files: context.files, path }))
      return;
    const stat = await context.files.lstat({ path });
    switch (stat.type) {
    case 'directory':
      for await (const entry of context.files.readDir({ path })) {
        await removeRecursively({ path: entry.fullPath });
      }
      await context.files.rmdir({ path });
      return;
    case 'file':
    case 'fifo':
    case 'chardev':
    case 'symlink':
      await context.files.unlink({ path });
      return;
    default: {
      const _ex: never = stat.type;
      throw new Error(`Unhandled clone cleanup entry type: ${_ex}`);
    }
    }
  };
  if (removeRoot) {
    await removeRecursively({ path: destinationPath });
    return;
  }
  if (!await pathExists({ files: context.files, path: destinationPath }))
    return;
  for await (const entry of context.files.readDir({ path: destinationPath })) {
    await removeRecursively({ path: entry.fullPath });
  }
}
import { parseCloneArguments } from "./arguments";
export async function runClone({ context, args }: {
    context: WeshCommandContext;
    args: readonly string[];
}): Promise<WeshCommandResult> {
  await assertSupportedCloneContentPolicy({ context });
  const { quiet, branchOption, depthOption, operands } = parseCloneArguments({ args });
  const sourceLocation = operands[0]!;
  assertLocalRepositoryLocation({ location: sourceLocation });
  const sourcePath = normalizePath({ cwd: context.cwd, path: sourceLocation });
  const { repository: sourceRepository } = await discoverRepositoryAtPath({ files: context.files, path: sourcePath });
  const sourceHead = await readHead({ files: context.files, repository: sourceRepository });
  const sourceSymbolicBranch = branchNameFromHead({ head: sourceHead });
  const sourceHeads = await listRefs({ files: context.files, repository: sourceRepository, prefix: 'refs/heads' });
  const sourceTags = await listRefs({ files: context.files, repository: sourceRepository, prefix: 'refs/tags' });
  const matchingDetachedHeadRefs = sourceHead.objectId === undefined
    ? []
    : sourceHeads.filter(ref => ref.objectId === sourceHead.objectId);
  const sourceDefaultBranch = sourceSymbolicBranch
        ?? (matchingDetachedHeadRefs.length === 1
          ? matchingDetachedHeadRefs[0]!.refName.slice('refs/heads/'.length)
          : undefined);
  let checkoutBranch = sourceDefaultBranch;
  let checkoutObjectId = sourceHead.objectId;
  if (branchOption !== undefined) {
    const branchRef = sourceHeads.find(ref => ref.refName === `refs/heads/${branchOption}`);
    if (branchRef !== undefined) {
      checkoutBranch = branchOption;
      checkoutObjectId = branchRef.objectId;
    } else {
      const tagRef = sourceTags.find(ref => ref.refName === `refs/tags/${branchOption}`);
      if (tagRef === undefined)
        throw new Error(`Remote branch ${branchOption} not found in upstream origin`);
      checkoutBranch = undefined;
      checkoutObjectId = await peelToCommitObjectId({
        files: context.files,
        repository: sourceRepository,
        objectId: tagRef.objectId,
      });
    }
  }
  const destinationOperand = operands[1] ?? localCloneDestinationName({ sourcePath });
  const destinationPath = normalizePath({ cwd: context.cwd, path: destinationOperand });
  const destinationExisted = await assertCloneDestinationAvailable({ context, destinationPath, displayName: destinationOperand });
  if (!quiet)
    await context.text().error({ text: `Cloning into '${destinationOperand}'...\n` });
  if (depthOption !== undefined) {
    await context.text().error({ text: 'warning: --depth is ignored in local clones; use file:// instead.\n' });
  }
  try {
    const { repository: destinationRepository } = await initializeRepository({
      files: context.files,
      targetPath: destinationPath,
    });
    const rootObjectIds = [...sourceHeads, ...sourceTags].map(ref => ref.objectId);
    if (sourceHead.objectId !== undefined)
      rootObjectIds.push(sourceHead.objectId);
    await transferReachableObjects({
      files: context.files,
      sourceRepository,
      destinationRepository,
      rootObjectIds,
    });
    for (const ref of sourceHeads) {
      const branchName = ref.refName.slice('refs/heads/'.length);
      await writeRef({
        files: context.files,
        repository: destinationRepository,
        refName: `refs/remotes/origin/${branchName}`,
        objectId: ref.objectId,
      });
    }
    for (const ref of sourceTags) {
      await writeRef({ files: context.files, repository: destinationRepository, refName: ref.refName, objectId: ref.objectId });
    }
    if (checkoutBranch !== undefined) {
      if (checkoutObjectId !== undefined) {
        await writeRef({
          files: context.files,
          repository: destinationRepository,
          refName: `refs/heads/${checkoutBranch}`,
          objectId: checkoutObjectId,
        });
      }
      await setHeadSymbolic({ files: context.files, repository: destinationRepository, refName: `refs/heads/${checkoutBranch}` });
    } else if (checkoutObjectId !== undefined) {
      const config = await readEffectiveConfig({ files: context.files, repository: destinationRepository, homePath: context.env.get('HOME') ?? '/', cwd: context.cwd, env: context.env });
      await moveHeadReference({
        files: context.files,
        repository: destinationRepository,
        target: { type: 'detached', objectId: checkoutObjectId },
        reflog: {
          identity: resolveGitReflogIdentity({ env: context.env, config }),
          timestamp: resolveGitTimestamp({ env: context.env, role: 'COMMITTER' }),
          message: `clone: from ${sourcePath}`,
        },
      });
    }
    if (sourceDefaultBranch !== undefined && sourceHead.objectId !== undefined) {
      await writeSymbolicRef({
        files: context.files,
        repository: destinationRepository,
        refName: 'refs/remotes/origin/HEAD',
        targetRefName: `refs/remotes/origin/${sourceDefaultBranch}`,
      });
    }
    await setLocalConfigValue({ files: context.files, repository: destinationRepository, key: 'remote.origin.url', value: sourcePath, valuePattern: undefined });
    await setLocalConfigValue({
      files: context.files,
      repository: destinationRepository,
      key: 'remote.origin.fetch',
      value: '+refs/heads/*:refs/remotes/origin/*',
      valuePattern: undefined,
    });
    if (checkoutBranch !== undefined) {
      await setLocalConfigValue({ files: context.files, repository: destinationRepository, key: `branch.${checkoutBranch}.remote`, value: 'origin', valuePattern: undefined });
      await setLocalConfigValue({
        files: context.files,
        repository: destinationRepository,
        key: `branch.${checkoutBranch}.merge`,
        value: `refs/heads/${checkoutBranch}`,
        valuePattern: undefined,
      });
    }
    if (checkoutObjectId === undefined) {
      await context.text().error({ text: 'warning: You appear to have cloned an empty repository.\n' });
    } else {
      const sourceCommit = await readCommit({ files: context.files, repository: destinationRepository, objectId: checkoutObjectId });
      const targetEntries = await readTreeIntoIndex({
        files: context.files,
        repository: destinationRepository,
        treeObjectId: sourceCommit.treeObjectId,
      });
      await forceReplaceIndexAndWorktree({
        files: context.files,
        repository: destinationRepository,
        currentIndexEntries: [],
        targetEntries,
        contentConfig: await resolveContentConfigForContext({ context, repository: destinationRepository }),
      });
    }
  } catch (error) {
    await cleanupCloneDestination({ context, destinationPath, removeRoot: !destinationExisted });
    throw error;
  }
  if (!quiet)
    await context.text().error({ text: 'done.\n' });
  return { exitCode: 0 };
}

export const TEST_ONLY = {
};
