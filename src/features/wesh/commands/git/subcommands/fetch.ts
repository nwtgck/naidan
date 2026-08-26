import type { WeshCommandContext, WeshCommandResult } from "@/features/wesh/types";
import { readEffectiveConfig } from "@/features/wesh/commands/git/config";
import { sortGitUtf8Strings } from "@/features/wesh/commands/git/utf8-order";
import { fetchLocalRemote } from "@/features/wesh/commands/git/local-transport";
import { discoverRepositoryFromContext } from "@/features/wesh/commands/git/repository";
import { expandGitShortOptions } from "@/features/wesh/commands/git/short-options";

export async function runFetch({ context, args }: {
  context: WeshCommandContext,
  args: readonly string[],
}): Promise<WeshCommandResult> {
  let quiet = false;
  let all = false;
  let prune = false;
  const operands: string[] = [];
  let parsingOptions = true;
  const normalizedArgs = expandGitShortOptions({ args, flagOptions: ['p', 'q'], valueOptions: [] });
  for (const arg of normalizedArgs) {
    if (parsingOptions && arg === '--') {
      parsingOptions = false;
      continue;
    }
    if (parsingOptions && (arg === '-q' || arg === '--quiet')) quiet = true;
    else if (parsingOptions && arg === '--all') all = true;
    else if (parsingOptions && (arg === '--prune' || arg === '-p')) prune = true;
    else if (parsingOptions && arg.startsWith('-')) throw new Error(`unknown option: ${arg}`);
    else operands.push(arg);
  }
  if (operands.length > 1) throw new Error('too many arguments');
  if (all && operands.length > 0) throw new Error('fetch --all does not take a repository argument');
  const repository = await discoverRepositoryFromContext({ context });
  const config = await readEffectiveConfig({
    files: context.files,
    repository,
    homePath: context.env.get('HOME') ?? '/',
    env: context.env,
  });
  let remoteNames: string[];
  if (all) {
    const names = new Set<string>();
    for (const key of config.keys()) {
      const match = /^remote\.(.+)\.url$/u.exec(key);
      if (match !== null) names.add(match[1]!);
    }
    remoteNames = sortGitUtf8Strings({ values: names });
  } else {
    remoteNames = [operands[0] ?? 'origin'];
  }

  for (const remoteName of remoteNames) {
    const result = await fetchLocalRemote({ files: context.files, repository, remoteName, prune, config });
    if (quiet) continue;
    const changed = result.branchUpdates.filter(update => update.oldObjectId !== update.newObjectId);
    if (changed.length > 0 || result.prunedBranches.length > 0) await context.text().error({ text: `From ${result.sourcePath}\n` });
    for (const update of changed) {
      if (update.oldObjectId === undefined) {
        await context.text().error({
          text: ` * [new branch]      ${update.branchName} -> ${result.remoteName}/${update.branchName}\n`,
        });
      } else {
        await context.text().error({
          text: `   ${update.oldObjectId.slice(0, 7)}..${update.newObjectId.slice(0, 7)}  ${update.branchName} -> ${result.remoteName}/${update.branchName}\n`,
        });
      }
    }
    for (const deleted of result.prunedBranches) {
      await context.text().error({
        text: ` - [deleted]         (none)     -> ${result.remoteName}/${deleted.branchName}\n`,
      });
    }
  }
  return { exitCode: 0 };
}

export const TEST_ONLY = {
};
