import { formatGitAmbiguousLongOption } from '@/features/wesh/commands/git/argv-diagnostics';
import { GitUsageError } from '@/features/wesh/commands/git/errors';
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
import { defineArgvCatalog, parseStandardArgv, type StandardArgvAction, type StandardArgvPolicy } from '@/features/wesh/argv-v2';

type CommitDeferredSemantic = 'message' | 'file';

const COMMIT_ARGV_CATALOG = defineArgvCatalog<StandardArgvAction<CommitDeferredSemantic>>({
  nonExecutableLongOptions: [
    'quiet', 'no-quiet', 'verbose', 'no-verbose',
    'no-file', 'author', 'no-author', 'date', 'no-date', 'no-message',
    'reedit-message', 'no-reedit-message', 'reuse-message', 'no-reuse-message',
    'fixup', 'no-fixup', 'squash', 'no-squash', 'reset-author', 'no-reset-author',
    'trailer', 'signoff', 'no-signoff', 'template', 'no-template', 'edit',
    'cleanup', 'no-cleanup', 'status', 'no-status', 'gpg-sign', 'no-gpg-sign',
    'no-all', 'include', 'no-include', 'interactive', 'no-interactive', 'patch', 'no-patch',
    'only', 'no-only', 'no-verify', 'verify', 'dry-run', 'no-dry-run', 'short', 'no-short',
    'branch', 'no-branch', 'ahead-behind', 'no-ahead-behind', 'porcelain', 'no-porcelain',
    'long', 'no-long', 'null', 'no-null', 'no-amend', 'no-post-rewrite', 'post-rewrite',
    'untracked-files', 'no-untracked-files', 'pathspec-from-file', 'no-pathspec-from-file',
    'pathspec-file-nul', 'no-pathspec-file-nul', 'allow-empty-message',
  ],
  definitions: [
    {
      semantic: { kind: 'effects', effects: [{ key: 'all', value: true }] },
      forms: [
        { kind: 'short', name: 'a', value: { kind: 'none' } },
        { kind: 'long', name: 'all', value: { kind: 'none' } },
      ],
    },
    {
      semantic: { kind: 'deferred', tag: 'message' },
      forms: [
        { kind: 'short', name: 'm', value: { kind: 'required-attached-or-following', missingValueName: 'message' } },
        { kind: 'long', name: 'message', value: { kind: 'required', missingValueName: 'message' } },
      ],
    },
    {
      semantic: { kind: 'deferred', tag: 'file' },
      forms: [
        { kind: 'short', name: 'F', value: { kind: 'required-attached-or-following', missingValueName: 'file' } },
        { kind: 'long', name: 'file', value: { kind: 'required', missingValueName: 'file' } },
      ],
    },
    {
      semantic: { kind: 'effects', effects: [{ key: 'amend', value: true }] },
      forms: [{ kind: 'long', name: 'amend', value: { kind: 'none' } }],
    },
    {
      semantic: { kind: 'effects', effects: [{ key: 'noEdit', value: true }] },
      forms: [{ kind: 'long', name: 'no-edit', value: { kind: 'none' } }],
    },
    {
      semantic: { kind: 'effects', effects: [{ key: 'allowEmpty', value: true }] },
      forms: [{ kind: 'long', name: 'allow-empty', value: { kind: 'none' } }],
    },
  ],
});

const COMMIT_ARGV_POLICY: StandardArgvPolicy = {
  longNameMatch: 'unique-prefix',
  optionBoundary: 'first-positional',
  occurrenceRetention: 'none',
};


export async function runCommit({ context, args }: {
    context: WeshCommandContext;
    args: readonly string[];
}): Promise<WeshCommandResult> {
  const separatorIndex = args.indexOf('--');
  if (separatorIndex >= 0 && separatorIndex !== args.length - 1)
    throw new Error('commit pathspecs are not supported yet');
  const parsedArgs = separatorIndex < 0 ? args : args.slice(0, separatorIndex);
  const parsed = parseStandardArgv({ args: parsedArgs, catalog: COMMIT_ARGV_CATALOG, policy: COMMIT_ARGV_POLICY });
  const diagnostic = parsed.diagnostics[0];
  if (diagnostic !== undefined) {
    switch (diagnostic.kind) {
    case 'missing_option_value':
      throw new GitUsageError({ message: `option '${diagnostic.option}' requires a value` });
    case 'ambiguous_long_option':
      throw new GitUsageError({
        message: formatGitAmbiguousLongOption({
          option: diagnostic.option,
          candidateOptions: diagnostic.candidateOptions,
        }),
      });
    case 'unknown_short_option':
    case 'unknown_long_option':
    case 'unexpected_option_value':
    case 'invalid_option_value':
      throw new GitUsageError({ message: `unknown option: ${parsedArgs[diagnostic.argvIndex] ?? diagnostic.option}` });
    default: {
      const _ex: never = diagnostic;
      throw new Error(`Unhandled commit argv diagnostic: ${JSON.stringify(_ex)}`);
    }
    }
  }
  if (parsed.positionals.length > 0)
    throw new GitUsageError({ message: `unknown option: ${parsed.positionals[0]}` });
  let message: string | undefined;
  let messageFile: string | undefined;
  for (const occurrence of parsed.deferred) {
    const value = (() => {
      switch (occurrence.value.kind) {
      case 'inline':
      case 'next-argv':
        return occurrence.value.rawValue;
      case 'none':
        throw new Error(`Commit ${occurrence.semantic.tag} option did not claim a value`);
      default: {
        const _ex: never = occurrence.value;
        throw new Error(`Unhandled commit deferred value: ${JSON.stringify(_ex)}`);
      }
      }
    })();
    switch (occurrence.semantic.tag) {
    case 'message':
      message = appendMessageParagraph({ current: message, value });
      break;
    case 'file':
      messageFile = value;
      break;
    default: {
      const _ex: never = occurrence.semantic.tag;
      throw new Error(`Unhandled commit deferred semantic: ${_ex}`);
    }
    }
  }
  const all = parsed.optionValues.all === true;
  const amend = parsed.optionValues.amend === true;
  const noEdit = parsed.optionValues.noEdit === true;
  const allowEmpty = parsed.optionValues.allowEmpty === true;
  if (all) await assertSupportedRepositoryContentPolicy({ context, cleanMutation: true });
  if (message !== undefined && messageFile !== undefined)
    throw new Error('options -m and -F cannot be used together');
  const repository = await discoverRepositoryFromContext({ context });
  const config = await readEffectiveConfig({
    files: context.files,
    repository,
    homePath: context.env.get('HOME') ?? '/',
    cwd: context.cwd,
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
