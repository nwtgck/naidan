import type { WeshCommandContext, WeshCommandResult } from "@/features/wesh/types";
import { getConfigValue, readEffectiveConfig, setLocalConfigValue } from "@/features/wesh/commands/git/config";
import { deleteLocalRemoteBranch, pushLocalBranch } from "@/features/wesh/commands/git/local-transport";
import { branchNameFromHead, readHead } from "@/features/wesh/commands/git/refs";
import { discoverRepositoryFromContext } from "@/features/wesh/commands/git/repository";
import { expandGitShortOptions } from "@/features/wesh/commands/git/short-options";

export async function runPush({ context, args }: {
  context: WeshCommandContext,
  args: readonly string[],
}): Promise<WeshCommandResult> {
  let setUpstream = false;
  let forceWithLease = false;
  let deleteBranch = false;
  let quiet = false;
  const operands: string[] = [];
  let parsingOptions = true;
  const normalizedArgs = expandGitShortOptions({ args, flagOptions: ['u', 'q'], valueOptions: [] });
  for (const arg of normalizedArgs) {
    if (parsingOptions && arg === '--') {
      parsingOptions = false;
      continue;
    }
    if (parsingOptions && (arg === '-u' || arg === '--set-upstream')) setUpstream = true;
    else if (parsingOptions && arg === '--force-with-lease') forceWithLease = true;
    else if (parsingOptions && arg === '--delete') deleteBranch = true;
    else if (parsingOptions && (arg === '-q' || arg === '--quiet')) quiet = true;
    else if (parsingOptions && arg.startsWith('-')) throw new Error(`unknown option: ${arg}`);
    else operands.push(arg);
  }
  const repository = await discoverRepositoryFromContext({ context });
  const head = await readHead({ files: context.files, repository });
  const currentBranch = branchNameFromHead({ head });
  const config = await readEffectiveConfig({ files: context.files, repository, homePath: context.env.get('HOME') ?? '/', env: context.env });
  // TODO: Real Git's pre-push hook is active only when executable. Correct hook gating needs executable-mode visibility from the filesystem layer.
  const configuredRemote = currentBranch === undefined
    ? undefined
    : getConfigValue({ config, key: `branch.${currentBranch}.remote` });
  const remoteName = operands[0] ?? configuredRemote ?? 'origin';

  if (deleteBranch) {
    if (operands.length !== 2) throw new Error('usage: git push --delete <remote> <branch>');
    const branchName = operands[1]!;
    const result = await deleteLocalRemoteBranch({
      files: context.files,
      repository,
      remoteName,
      branchName,
      forceWithLease,
      config,
    });
    if (!quiet) {
      await context.text().error({ text: `To ${result.remotePath}\n - [deleted]         ${branchName}\n` });
    }
    return { exitCode: 0 };
  }
  if (operands.length > 2) throw new Error('too many arguments');
  if (currentBranch === undefined && operands.length < 2) throw new Error('You are not currently on a branch.');
  const refspec = operands[1] ?? currentBranch!;
  const colonIndex = refspec.indexOf(':');
  const sourceBranch = (colonIndex < 0 ? refspec : refspec.slice(0, colonIndex)).replace(/^refs\/heads\//u, '');
  const destinationBranch = (colonIndex < 0 ? refspec : refspec.slice(colonIndex + 1)).replace(/^refs\/heads\//u, '');
  if (sourceBranch.length === 0 || destinationBranch.length === 0) throw new Error(`invalid refspec '${refspec}'`);
  const result = await pushLocalBranch({
    files: context.files,
    repository,
    remoteName,
    sourceBranch,
    destinationBranch,
    forceWithLease,
    config,
  });
  if (setUpstream) {
    await setLocalConfigValue({ files: context.files, repository, key: `branch.${sourceBranch}.remote`, value: remoteName });
    await setLocalConfigValue({
      files: context.files,
      repository,
      key: `branch.${sourceBranch}.merge`,
      value: `refs/heads/${destinationBranch}`,
    });
    await context.text().print({ text: `branch '${sourceBranch}' set up to track '${remoteName}/${destinationBranch}'.\n` });
  }
  if (!quiet) {
    let updateLine: string;
    if (result.oldObjectId === undefined) {
      updateLine = ` * [new branch]      ${sourceBranch} -> ${destinationBranch}\n`;
    } else if (result.oldObjectId === result.newObjectId) {
      updateLine = ` = [up to date]      ${sourceBranch} -> ${destinationBranch}\n`;
    } else if (result.forced) {
      updateLine = ` + ${result.oldObjectId.slice(0, 7)}...${result.newObjectId.slice(0, 7)} ${sourceBranch} -> ${destinationBranch} (forced update)\n`;
    } else {
      updateLine = `   ${result.oldObjectId.slice(0, 7)}..${result.newObjectId.slice(0, 7)}  ${sourceBranch} -> ${destinationBranch}\n`;
    }
    await context.text().error({ text: `To ${result.remotePath}\n${updateLine}` });
  }
  return { exitCode: 0 };
}

export const TEST_ONLY = {
};
