import type { WeshCommandContext, WeshCommandResult } from "@/features/wesh/types";
import { parseLogArguments } from './arguments';
import type { GitLogDecorationMode } from './arguments';
import { commitSubject } from "@/features/wesh/commands/git/commits";
import { testAnyGitBasicRegex } from '@/features/wesh/commands/git/basic-regex';
import { getDiffRenameLimitConfigValue, getDiffRenamesConfigMode, readEffectiveConfig } from "@/features/wesh/commands/git/config";
import { revisionDiffMatchesSearch, writeRevisionNameOnly, writeRevisionNameStatus, writeRevisionPatch, writeRevisionStat } from "@/features/wesh/commands/git/diff/revision";
import { GIT_DEFAULT_RENAME_LIMIT } from "@/features/wesh/commands/git/renames";
import { quoteNonAsciiFromConfig } from "@/features/wesh/commands/git/path-output";
import { findMergeBases } from "@/features/wesh/commands/git/graph";
import { collectCommitHistory, collectFollowHistory, collectGraphCommitHistory, collectPathLimitedHistory, formatCommitTemplate } from "@/features/wesh/commands/git/history";
import type { GitFollowHistoryCommit, GitHistoryCommit } from "@/features/wesh/commands/git/history";
import { renderGitLogGraph } from "./graph";
import { branchNameFromHead, listRefs, readHead } from "@/features/wesh/commands/git/refs";
import type { GitHeadState, GitListedRef } from "@/features/wesh/commands/git/refs";
import { discoverRepository, discoverRepositoryFromContext } from "@/features/wesh/commands/git/repository";
import { peelToCommitObjectId, resolveCommitRevision } from "@/features/wesh/commands/git/revision";
import { formatLogDate, parseAuthorForLog } from "@/features/wesh/commands/git/log-format";

interface LogReferenceCache {
  head: GitHeadState | undefined,
  refs: GitListedRef[] | undefined,
  peeledCommitObjectIds: Map<string, string | undefined>,
}

function createLogReferenceCache(): LogReferenceCache {
  return {
    head: undefined,
    refs: undefined,
    peeledCommitObjectIds: new Map<string, string | undefined>(),
  };
}

function isFollowHistoryCommit(entry: GitHistoryCommit): entry is GitFollowHistoryCommit {
  return 'followPath' in entry && 'parentFollowPath' in entry;
}

async function readCachedLogHead({ context, repository, cache }: {
  context: WeshCommandContext,
  repository: Awaited<ReturnType<typeof discoverRepository>>,
  cache: LogReferenceCache,
}): Promise<GitHeadState> {
  if (cache.head !== undefined) return cache.head;
  const head = await readHead({ files: context.files, repository });
  cache.head = head;
  return head;
}

async function readCachedLogRefs({ context, repository, cache }: {
  context: WeshCommandContext,
  repository: Awaited<ReturnType<typeof discoverRepository>>,
  cache: LogReferenceCache,
}): Promise<GitListedRef[]> {
  if (cache.refs !== undefined) return cache.refs;
  const refs = await listRefs({ files: context.files, repository, prefix: 'refs' });
  cache.refs = refs;
  return refs;
}

async function tryPeelCachedLogRef({ context, repository, cache, objectId }: {
  context: WeshCommandContext,
  repository: Awaited<ReturnType<typeof discoverRepository>>,
  cache: LogReferenceCache,
  objectId: string,
}): Promise<string | undefined> {
  if (cache.peeledCommitObjectIds.has(objectId)) return cache.peeledCommitObjectIds.get(objectId);
  let peeled: string | undefined;
  try {
    peeled = await peelToCommitObjectId({ files: context.files, repository, objectId });
  } catch {
    peeled = undefined;
  }
  cache.peeledCommitObjectIds.set(objectId, peeled);
  return peeled;
}

function logDecorationRefName({ refName, mode }: {
    refName: string;
    mode: Exclude<GitLogDecorationMode, 'none'>;
}): string {
  switch (mode) {
  case 'full':
    return refName;
  case 'short':
    break;
  default: {
    const _ex: never = mode;
    throw new Error(`Unhandled log decoration mode: ${_ex}`);
  }
  }
  for (const prefix of ['refs/heads/', 'refs/remotes/', 'refs/tags/']) {
    if (refName.startsWith(prefix))
      return refName.slice(prefix.length);
  }
  return refName;
}
async function collectLogDecorations({ context, repository, mode, cache }: {
    context: WeshCommandContext;
    repository: Awaited<ReturnType<typeof discoverRepository>>;
    mode: Exclude<GitLogDecorationMode, 'none'>;
    cache: LogReferenceCache;
}): Promise<Map<string, string>> {
  const labelsByObjectId = new Map<string, string[]>();
  const add = ({ objectId, label }: {
        objectId: string;
        label: string;
    }) => {
    const labels = labelsByObjectId.get(objectId) ?? [];
    labels.push(label);
    labelsByObjectId.set(objectId, labels);
  };
  const head = await readCachedLogHead({ context, repository, cache });
  if (head.objectId !== undefined) {
    add({
      objectId: head.objectId,
      label: head.symbolicRef === undefined
        ? 'HEAD'
        : `HEAD -> ${logDecorationRefName({ refName: head.symbolicRef, mode })}`,
    });
  }
  const refs = await readCachedLogRefs({ context, repository, cache });
  const tags = refs.filter(ref => ref.refName.startsWith('refs/tags/'));
  for (const ref of [...tags].reverse()) {
    const objectId = await tryPeelCachedLogRef({ context, repository, cache, objectId: ref.objectId });
    if (objectId === undefined) continue;
    add({
      objectId,
      label: `tag: ${logDecorationRefName({ refName: ref.refName, mode })}`,
    });
  }
  const remoteRefs = refs.filter(ref => ref.refName.startsWith('refs/remotes/'));
  for (const ref of [...remoteRefs].reverse()) {
    add({ objectId: ref.objectId, label: logDecorationRefName({ refName: ref.refName, mode }) });
  }
  const localRefs = refs.filter(ref => ref.refName.startsWith('refs/heads/'));
  for (const ref of [...localRefs].reverse()) {
    if (ref.refName === head.symbolicRef)
      continue;
    add({ objectId: ref.objectId, label: logDecorationRefName({ refName: ref.refName, mode }) });
  }
  const miscellaneousRefs = refs.filter(ref =>
    !ref.refName.startsWith('refs/heads/')
      && !ref.refName.startsWith('refs/remotes/')
      && !ref.refName.startsWith('refs/tags/'),
  );
  for (const ref of [...miscellaneousRefs].reverse()) {
    const objectId = await tryPeelCachedLogRef({ context, repository, cache, objectId: ref.objectId });
    if (objectId === undefined) continue;
    add({ objectId, label: logDecorationRefName({ refName: ref.refName, mode }) });
  }
  return new Map([...labelsByObjectId].map(([objectId, labels]) => [objectId, ` (${labels.join(', ')})`]));
}
export async function runLog({ context, args }: {
    context: WeshCommandContext;
    args: readonly string[];
}): Promise<WeshCommandResult> {
  const {
    format,
    oneline,
    decorationMode,
    graph,
    maxCount,
    allRefs,
    showStat,
    showPatch,
    nameOnly,
    nameStatus,
    follow,
    sinceTimestamp,
    untilTimestamp,
    grepPatterns,
    pickaxeString,
    pickaxeRegex,
    revisionTerms,
    pathOperands,
  } = parseLogArguments({ args });
  const repository = await discoverRepositoryFromContext({ context });
  const referenceCache = createLogReferenceCache();
  const logConfig = await readEffectiveConfig({ files: context.files, repository, homePath: context.env.get('HOME') ?? '/', cwd: context.cwd, env: context.env });
  const logQuoteNonAscii = quoteNonAsciiFromConfig({ config: logConfig });
  const diffRenamesMode = getDiffRenamesConfigMode({ config: logConfig });
  const detectRenames = diffRenamesMode !== 'disabled';
  const detectCopies = diffRenamesMode === 'copies';
  const renameLimit = getDiffRenameLimitConfigValue({ config: logConfig }) ?? GIT_DEFAULT_RENAME_LIMIT;
  const includeExpressions: string[] = [];
  const excludeExpressions: string[] = [];
  const symmetricRanges: Array<{
        left: string;
        right: string;
    }> = [];
  for (const term of revisionTerms) {
    const symmetricIndex = term.indexOf('...');
    if (symmetricIndex >= 0) {
      symmetricRanges.push({
        left: term.slice(0, symmetricIndex) || 'HEAD',
        right: term.slice(symmetricIndex + 3) || 'HEAD',
      });
      continue;
    }
    const rangeIndex = term.indexOf('..');
    if (rangeIndex >= 0) {
      const left = term.slice(0, rangeIndex) || 'HEAD';
      const right = term.slice(rangeIndex + 2) || 'HEAD';
      excludeExpressions.push(left);
      includeExpressions.push(right);
    } else if (term.startsWith('^')) {
      if (term.length === 1)
        throw new Error('empty excluded revision');
      excludeExpressions.push(term.slice(1));
    } else {
      includeExpressions.push(term);
    }
  }
  const includeObjectIds: string[] = [];
  const excludeObjectIds: string[] = [];
  if (allRefs) {
    const head = await readCachedLogHead({ context, repository, cache: referenceCache });
    if (head.objectId !== undefined) includeObjectIds.push(head.objectId);
    for (const ref of await readCachedLogRefs({ context, repository, cache: referenceCache })) {
      const objectId = await tryPeelCachedLogRef({ context, repository, cache: referenceCache, objectId: ref.objectId });
      if (objectId !== undefined) includeObjectIds.push(objectId);
    }
  }
  for (const expression of includeExpressions) {
    includeObjectIds.push(await resolveCommitRevision({ files: context.files, repository, expression }));
  }
  for (const range of symmetricRanges) {
    const leftObjectId = await resolveCommitRevision({ files: context.files, repository, expression: range.left });
    const rightObjectId = await resolveCommitRevision({ files: context.files, repository, expression: range.right });
    includeObjectIds.push(leftObjectId, rightObjectId);
    const bases = await findMergeBases({
      files: context.files,
      repository,
      cache: undefined,
      leftObjectId,
      rightObjectId,
    });
    excludeObjectIds.push(...bases);
  }
  if (includeObjectIds.length === 0 && !allRefs) {
    const head = await readCachedLogHead({ context, repository, cache: referenceCache });
    if (head.objectId === undefined) {
      const branchName = branchNameFromHead({ head }) ?? 'HEAD';
      await context.text().error({ text: `fatal: your current branch '${branchName}' does not have any commits yet\n` });
      return { exitCode: 128 };
    }
    includeObjectIds.push(head.objectId);
  }
  excludeObjectIds.push(...await Promise.all(excludeExpressions.map(expression => resolveCommitRevision({
    files: context.files,
    repository,
    expression,
  }))));
  const history = follow
    ? await collectFollowHistory({
      files: context.files,
      repository,
      includeObjectIds,
      excludeObjectIds,
      cwd: context.cwd,
      pathOperand: pathOperands[0]!,
      renameLimit,
    })
    : pathOperands.length === 0
      ? await (graph ? collectGraphCommitHistory : collectCommitHistory)({
        files: context.files,
        repository,
        includeObjectIds,
        excludeObjectIds,
      })
      : await collectPathLimitedHistory({
        files: context.files,
        repository,
        includeObjectIds,
        excludeObjectIds,
        cwd: context.cwd,
        pathOperands,
      });
  let decorations: Map<string, string>;
  switch (decorationMode) {
  case 'none':
    decorations = new Map<string, string>();
    break;
  case 'short':
  case 'full':
    decorations = await collectLogDecorations({ context, repository, mode: decorationMode, cache: referenceCache });
    break;
  default: {
    const _ex: never = decorationMode;
    throw new Error(`Unhandled log decoration mode: ${_ex}`);
  }
  }
  if (graph) {
    const graphHistory = history.slice(0, maxCount);
    const graphEntries = graphHistory.map((entry, entryIndex) => {
      const decoration = decorations.get(entry.objectId) ?? '';
      if (format !== undefined) {
        const formatted = oneline
          ? `${entry.objectId.slice(0, 7)}${decoration} ${commitSubject({ commit: entry.commit })}`
          : formatCommitTemplate({ objectId: entry.objectId, commit: entry.commit, format });
        return {
          objectId: entry.objectId,
          parentObjectIds: entry.commit.parentObjectIds,
          lines: formatted.split('\n'),
        };
      }
      const author = parseAuthorForLog({ author: entry.commit.author });
      const messageLines = entry.commit.message.replace(/\n+$/u, '').split('\n').map(line => `    ${line}`);
      const lines = [
        `commit ${entry.objectId}${decoration}`,
        ...(entry.commit.parentObjectIds.length > 1
          ? [`Merge: ${entry.commit.parentObjectIds.map(parent => parent.slice(0, 7)).join(' ')}`]
          : []),
        `Author: ${author.identity}`,
        `Date:   ${formatLogDate({ timestamp: author.timestamp, timezone: author.timezone })}`,
        '',
        ...messageLines,
      ];
      if (entryIndex + 1 < graphHistory.length)
        lines.push('');
      return {
        objectId: entry.objectId,
        parentObjectIds: entry.commit.parentObjectIds,
        lines,
      };
    });
    await context.text().print({ text: renderGitLogGraph({ entries: graphEntries }) });
    return { exitCode: 0 };
  }
  let count = 0;
  for (const entry of history) {
    const committerTimestamp = parseAuthorForLog({ author: entry.commit.committer }).timestamp;
    if (sinceTimestamp !== undefined && committerTimestamp < sinceTimestamp)
      continue;
    if (untilTimestamp !== undefined && committerTimestamp > untilTimestamp)
      continue;
    if (grepPatterns.length > 0 && !entry.commit.message.split('\n').some(
      line => testAnyGitBasicRegex({ regexes: grepPatterns, value: line }),
    ))
      continue;
    const entryPathOperands = isFollowHistoryCommit(entry)
      ? entry.parentFollowPath !== undefined && entry.parentFollowPath !== entry.followPath
        ? [entry.followPath, entry.parentFollowPath]
        : [entry.followPath]
      : pathOperands;
    if (pickaxeString !== undefined || pickaxeRegex !== undefined) {
      if (entry.commit.parentObjectIds.length > 1)
        continue;
      const search = pickaxeString !== undefined
        ? { type: 'string' as const, bytes: new TextEncoder().encode(pickaxeString) }
        : { type: 'regex' as const, pattern: pickaxeRegex! };
      if (!await revisionDiffMatchesSearch({
        context,
        repository,
        leftRevision: entry.commit.parentObjectIds[0],
        rightRevision: entry.objectId,
        pathOperands: entryPathOperands,
        search,
        detectRenames,
        detectCopies,
        renameLimit,
      }))
        continue;
    }
    if (count >= maxCount)
      break;
    const decoration = decorations.get(entry.objectId) ?? '';
    if (format !== undefined) {
      const formatted = oneline
        ? `${entry.objectId.slice(0, 7)}${decoration} ${commitSubject({ commit: entry.commit })}`
        : formatCommitTemplate({ objectId: entry.objectId, commit: entry.commit, format });
      if (format !== '')
        await context.text().print({ text: `${formatted}\n` });
    } else {
      const author = parseAuthorForLog({ author: entry.commit.author });
      const message = entry.commit.message.replace(/\n+$/u, '').split('\n').map(line => `    ${line}`).join('\n');
      await context.text().print({
        text: `commit ${entry.objectId}${decoration}\nAuthor: ${author.identity}\nDate:   ${formatLogDate({ timestamp: author.timestamp, timezone: author.timezone })}\n\n${message}\n\n`,
      });
    }
    if (format !== undefined && format !== '' && (nameOnly || nameStatus))
      await context.text().print({ text: '\n' });
    if (entry.commit.parentObjectIds.length <= 1) {
      const leftRevision = entry.commit.parentObjectIds[0];
      if (showStat) {
        await writeRevisionStat({
          context,
          repository,
          leftRevision,
          rightRevision: entry.objectId,
          pathOperands: entryPathOperands,
          quoteNonAscii: logQuoteNonAscii,
          detectRenames,
        });
      }
      if (showPatch) {
        await writeRevisionPatch({
          context,
          repository,
          leftRevision,
          rightRevision: entry.objectId,
          pathOperands: entryPathOperands,
          quoteNonAscii: logQuoteNonAscii,
          detectRenames,
        });
      }
      if (nameOnly) {
        await writeRevisionNameOnly({
          context,
          repository,
          leftRevision,
          rightRevision: entry.objectId,
          pathOperands: entryPathOperands,
          quoteNonAscii: logQuoteNonAscii,
          detectRenames,
        });
      }
      if (nameStatus) {
        await writeRevisionNameStatus({
          context,
          repository,
          leftRevision,
          rightRevision: entry.objectId,
          pathOperands: entryPathOperands,
          quoteNonAscii: logQuoteNonAscii,
          detectRenames,
        });
      }
    }
    count += 1;
  }
  return { exitCode: 0 };
}

export const TEST_ONLY = {
};
