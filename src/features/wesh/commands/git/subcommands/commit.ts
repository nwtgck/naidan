import { normalizePath } from "@/features/wesh/path";
import type { WeshCommandContext, WeshCommandResult } from "@/features/wesh/types";
import { readTextFromHandle } from "@/features/wesh/commands/_shared/text";
import { createCommit, parseCommitAuthor, readCommit } from "@/features/wesh/commands/git/commits";
import { getBooleanConfigValue, readEffectiveConfig } from "@/features/wesh/commands/git/config";
import { readFileText } from "@/features/wesh/commands/git/files";
import { resolveGitIdentity, resolveGitTimestamp } from "@/features/wesh/commands/git/identity";
import { readIndex, writeIndex } from "@/features/wesh/commands/git/index-file";
import { branchNameFromHead, readHead, updateHead } from "@/features/wesh/commands/git/refs";
import { discoverRepositoryFromContext } from "@/features/wesh/commands/git/repository";
import { writeTreeFromIndex } from "@/features/wesh/commands/git/tree";
import { stageWorktreePaths } from "@/features/wesh/commands/git/stage";
import { resolveContentConfigForContext } from "@/features/wesh/commands/git/content-config";
import { appendMessageParagraph, cleanupMessage, firstLine } from "@/features/wesh/commands/git/commit-message";
import { assertSupportedRepositoryContentPolicy } from "@/features/wesh/commands/git/content-policy";
import { expandGitShortOptions } from "@/features/wesh/commands/git/short-options";

export async function runCommit({ context, args }: {
    context: WeshCommandContext;
    args: readonly string[];
}): Promise<WeshCommandResult> {
  const normalizedArgs = expandGitShortOptions({ args, flagOptions: ['a'], valueOptions: ['m', 'F'] });
  if (normalizedArgs.includes('-a') || normalizedArgs.includes('--all')) await assertSupportedRepositoryContentPolicy({ context, cleanMutation: true });
  let message: string | undefined;
  let messageFile: string | undefined;
  let allowEmpty = false;
  let all = false;
  let amend = false;
  let noEdit = false;
  for (let index = 0; index < normalizedArgs.length; index += 1) {
    const arg = normalizedArgs[index]!;
    if (arg === '--') {
      if (index !== normalizedArgs.length - 1)
        throw new Error('commit pathspecs are not supported yet');
      break;
    }
    if (arg === '-m' || arg === '--message') {
      const value = normalizedArgs[index + 1];
      if (value === undefined)
        throw new Error(`option '${arg}' requires a value`);
      message = appendMessageParagraph({ current: message, value });
      index += 1;
    } else if (arg.startsWith('--message=')) {
      const value = arg.slice('--message='.length);
      message = appendMessageParagraph({ current: message, value });
    } else if (arg === '-F' || arg === '--file') {
      const value = normalizedArgs[index + 1];
      if (value === undefined)
        throw new Error(`option '${arg}' requires a value`);
      messageFile = value;
      index += 1;
    } else if (arg.startsWith('--file=')) {
      messageFile = arg.slice('--file='.length);
    } else if (arg === '-a' || arg === '--all') {
      all = true;
    } else if (arg === '--amend') {
      amend = true;
    } else if (arg === '--no-edit') {
      noEdit = true;
    } else if (arg === '--allow-empty') {
      allowEmpty = true;
    } else {
      throw new Error(`unknown option: ${arg}`);
    }
  }
  if (message !== undefined && messageFile !== undefined)
    throw new Error('options -m and -F cannot be used together');
  const repository = await discoverRepositoryFromContext({ context });
  const config = await readEffectiveConfig({
    files: context.files,
    repository,
    homePath: context.env.get('HOME') ?? '/',
    env: context.env,
  });
  if (getBooleanConfigValue({ config, key: 'commit.gpgsign' }) === true) {
    throw new Error('commit signing is not supported yet');
  }
  // TODO: Real Git ignores non-executable hooks and runs executable hooks. Do not treat hook-file existence alone as activation; correct hook gating needs executable-mode visibility from the filesystem layer.
  if (messageFile !== undefined) {
    message = messageFile === '-'
      ? await readTextFromHandle({ handle: context.stdin })
      : await readFileText({ files: context.files, path: normalizePath({ cwd: context.cwd, path: messageFile }) });
  }
  const head = await readHead({ files: context.files, repository });
  const previousCommit = head.objectId === undefined
    ? undefined
    : await readCommit({ files: context.files, repository, objectId: head.objectId });
  if (amend && previousCommit === undefined)
    throw new Error('You have nothing to amend.');
  const reusePreviousMessage = message === undefined && amend && noEdit;
  if (reusePreviousMessage)
    message = previousCommit!.message;
  if (message === undefined)
    throw new Error('no commit message specified');
  if (!reusePreviousMessage) {
    message = cleanupMessage({ text: message });
    if (message.length === 0)
      throw new Error('Aborting commit due to empty commit message.');
  }
  const authorOverride = amend ? parseCommitAuthor({ value: previousCommit!.author }) : undefined;
  if (authorOverride === undefined)
    resolveGitIdentity({ env: context.env, config, role: 'AUTHOR' });
  resolveGitIdentity({ env: context.env, config, role: 'COMMITTER' });
  if (authorOverride === undefined)
    resolveGitTimestamp({ env: context.env, role: 'AUTHOR' });
  resolveGitTimestamp({ env: context.env, role: 'COMMITTER' });
  let indexEntries = await readIndex({ files: context.files, repository });
  if (all) {
    indexEntries = await stageWorktreePaths({
      files: context.files,
      repository,
      currentEntries: indexEntries,
      paths: indexEntries.map(entry => entry.path),
      trackedOnly: true,
      contentConfig: await resolveContentConfigForContext({ context, repository }),
    });
    await writeIndex({ files: context.files, repository, entries: indexEntries });
  }
  const treeObjectId = await writeTreeFromIndex({ files: context.files, repository, entries: indexEntries });
  if (!amend && previousCommit !== undefined && !allowEmpty && previousCommit.treeObjectId === treeObjectId) {
    await context.text().print({ text: 'nothing to commit, working tree clean\n' });
    return { exitCode: 1 };
  }
  const created = await createCommit({
    files: context.files,
    repository,
    config,
    env: context.env,
    treeObjectId,
    parentObjectIds: amend ? previousCommit!.parentObjectIds : head.objectId === undefined ? [] : [head.objectId],
    message,
    authorOverride,
  });
  const reflogPrefix = amend
    ? 'commit (amend)'
    : head.objectId === undefined ? 'commit (initial)' : 'commit';
  await updateHead({
    files: context.files,
    repository,
    objectId: created.objectId,
    reflog: {
      identity: created.committerIdentity,
      timestamp: created.committerTimestamp,
      message: `${reflogPrefix}: ${firstLine({ text: message })}`,
    },
  });
  const objectId = created.objectId;
  const updatedHead = await readHead({ files: context.files, repository });
  const branchName = branchNameFromHead({ head: updatedHead });
  const rootMarker = head.objectId === undefined ? ' (root-commit)' : '';
  await context.text().print({
    text: `[${branchName ?? 'detached HEAD'}${rootMarker} ${objectId.slice(0, 7)}] ${firstLine({ text: message })}\n`,
  });
  return { exitCode: 0 };
}

export const TEST_ONLY = {
};
