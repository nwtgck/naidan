import { formatGitAmbiguousLongOption } from '@/features/wesh/commands/git/argv-diagnostics';
import { GitUsageError } from '@/features/wesh/commands/git/errors';
import type { WeshCommandContext, WeshCommandResult } from '@/features/wesh/types';
import { getBooleanConfigValue, readEffectiveConfig } from '@/features/wesh/commands/git/config';
import type { GitConfig } from '@/features/wesh/commands/git/config';
import { resolveGitIdentity, resolveGitTimestamp } from '@/features/wesh/commands/git/identity';
import { readObject, writeObject } from '@/features/wesh/commands/git/objects';
import { createRef, deleteRef, listRefs, readRef } from '@/features/wesh/commands/git/refs';
import { discoverRepositoryFromContext } from '@/features/wesh/commands/git/repository';
import type { GitRepository } from '@/features/wesh/commands/git/repository';
import { resolveRevision } from '@/features/wesh/commands/git/revision';
import { compareGitUtf8Strings } from '@/features/wesh/commands/git/utf8-order';
import { defineArgvCatalog, parseStandardArgv, type StandardArgvAction, type StandardArgvPolicy } from '@/features/wesh/argv-v2';
import { appendMessageParagraph, cleanupMessage } from '@/features/wesh/commands/git/commit-message';

type TagDeferredSemantic = 'message';

const TAG_ARGV_CATALOG = defineArgvCatalog<StandardArgvAction<TagDeferredSemantic>>({
  nonExecutableLongOptions: [
    'list', 'verify', 'no-annotate', 'file', 'no-file', 'trailer', 'edit', 'no-edit',
    'sign', 'no-sign', 'cleanup', 'no-cleanup', 'local-user', 'no-local-user',
    'force', 'no-force', 'create-reflog', 'no-create-reflog', 'column', 'no-column',
    'contains', 'no-contains', 'merged', 'no-merged', 'omit-empty', 'no-omit-empty',
    'sort', 'no-sort', 'points-at', 'no-points-at', 'format', 'no-format',
    'color', 'no-color', 'ignore-case', 'no-ignore-case',
  ],
  definitions: [
    {
      semantic: { kind: 'effects', effects: [{ key: 'annotated', value: true }] },
      forms: [
        { kind: 'short', name: 'a', value: { kind: 'none' } },
        { kind: 'long', name: 'annotate', value: { kind: 'none' } },
      ],
    },
    {
      semantic: { kind: 'effects', effects: [{ key: 'deleteMode', value: true }] },
      forms: [
        { kind: 'short', name: 'd', value: { kind: 'none' } },
        { kind: 'long', name: 'delete', value: { kind: 'none' } },
      ],
    },
    {
      semantic: { kind: 'deferred', tag: 'message' },
      forms: [
        { kind: 'short', name: 'm', value: { kind: 'required-attached-or-following', missingValueName: 'message' } },
        { kind: 'long', name: 'message', value: { kind: 'required', missingValueName: 'message' } },
      ],
    },
  ],
});

const TAG_ARGV_POLICY: StandardArgvPolicy = {
  longNameMatch: 'unique-prefix',
  optionBoundary: 'continue',
  occurrenceRetention: 'none',
};


const textEncoder = new TextEncoder();

function tagObjectType({ type }: { type: 'blob' | 'tree' | 'commit' | 'tag' }): string {
  switch (type) {
  case 'blob':
  case 'tree':
  case 'commit':
  case 'tag':
    return type;
  default: {
    const _ex: never = type;
    throw new Error(`Unhandled tag target type: ${_ex}`);
  }
  }
}

async function createAnnotatedTag({ context, repository, config, name, targetObjectId, message }: {
  context: WeshCommandContext,
  repository: GitRepository,
  config: GitConfig,
  name: string,
  targetObjectId: string,
  message: string,
}): Promise<string> {
  const identity = resolveGitIdentity({ env: context.env, config, role: 'COMMITTER' });
  const timestamp = resolveGitTimestamp({ env: context.env, role: 'COMMITTER' });
  const target = await readObject({ files: context.files, repository, objectId: targetObjectId });
  const normalizedMessage = message.endsWith('\n') ? message : `${message}\n`;
  const body = textEncoder.encode([
    `object ${targetObjectId}`,
    `type ${tagObjectType({ type: target.type })}`,
    `tag ${name}`,
    `tagger ${identity.name} <${identity.email}> ${timestamp}`,
    '',
    normalizedMessage,
  ].join('\n'));
  return writeObject({ files: context.files, repository, type: 'tag', body });
}

export async function runTag({ context, args }: {
  context: WeshCommandContext,
  args: readonly string[],
}): Promise<WeshCommandResult> {
  const repository = await discoverRepositoryFromContext({ context });
  const config = await readEffectiveConfig({
    files: context.files,
    repository,
    homePath: context.env.get('HOME') ?? '/',
    cwd: context.cwd,
    env: context.env,
  });
  const parsed = parseStandardArgv({ args, catalog: TAG_ARGV_CATALOG, policy: TAG_ARGV_POLICY });
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
      throw new GitUsageError({ message: `unsupported tag argument: ${args[diagnostic.argvIndex] ?? diagnostic.option}` });
    default: {
      const _ex: never = diagnostic;
      throw new Error(`Unhandled tag argv diagnostic: ${JSON.stringify(_ex)}`);
    }
    }
  }

  let annotated = parsed.optionValues.annotated === true;
  const deleteMode = parsed.optionValues.deleteMode === true;
  let message: string | undefined;
  for (const occurrence of parsed.deferred) {
    switch (occurrence.semantic.tag) {
    case 'message': {
      const value = (() => {
        switch (occurrence.value.kind) {
        case 'inline':
        case 'next-argv':
          return occurrence.value.rawValue;
        case 'none':
          throw new Error('Tag message option did not claim a value');
        default: {
          const _ex: never = occurrence.value;
          throw new Error(`Unhandled tag message value: ${JSON.stringify(_ex)}`);
        }
        }
      })();
      message = appendMessageParagraph({ current: message, value });
      annotated = true;
      break;
    }
    default: {
      const _ex: never = occurrence.semantic.tag;
      throw new Error(`Unhandled tag deferred semantic: ${_ex}`);
    }
    }
  }
  const operands = parsed.positionals;


  if (message !== undefined) message = cleanupMessage({ text: message });

  if (deleteMode) {
    if (annotated || message !== undefined) throw new Error('tag delete cannot be combined with annotation options');
    if (operands.length === 0) return { exitCode: 0 };
    let exitCode = 0;
    for (const name of operands) {
      const refName = `refs/tags/${name}`;
      const oldObjectId = await readRef({ files: context.files, repository, refName });
      if (oldObjectId === undefined) {
        await context.text().error({ text: `error: tag '${name}' not found.\n` });
        exitCode = 1;
        continue;
      }
      await deleteRef({ files: context.files, repository, refName });
      await context.text().print({ text: `Deleted tag '${name}' (was ${oldObjectId.slice(0, 7)})\n` });
    }
    return { exitCode };
  }

  if (operands.length === 0) {
    if (annotated || message !== undefined) throw new GitUsageError({ message: 'usage: git tag [-a] [-m <msg>] <tagname> [<object>]', prefix: 'none' });
    const refs = await listRefs({ files: context.files, repository, prefix: 'refs/tags' });
    for (const ref of refs.sort((left, right) => compareGitUtf8Strings({ left: left.refName, right: right.refName }))) {
      await context.text().print({ text: `${ref.refName.slice('refs/tags/'.length)}\n` });
    }
    return { exitCode: 0 };
  }
  if (operands.length > 2) throw new Error('too many arguments');
  if (getBooleanConfigValue({ config, key: 'tag.gpgsign' }) === true) {
    throw new Error('tag signing is not supported yet');
  }
  const name = operands[0]!;
  const refName = `refs/tags/${name}`;
  if (await readRef({ files: context.files, repository, refName }) !== undefined) {
    throw new Error(`tag '${name}' already exists`);
  }
  if (annotated && message === undefined) {
    throw new Error('annotated tag message editor is not supported; use -m <message>');
  }
  const targetObjectId = await resolveRevision({
    files: context.files,
    repository,
    expression: operands[1] ?? 'HEAD',
  });
  const refObjectId = annotated
    ? await createAnnotatedTag({ context, repository, config, name, targetObjectId, message: message! })
    : targetObjectId;
  await createRef({ files: context.files, repository, refName, objectId: refObjectId });
  return { exitCode: 0 };
}

export const TEST_ONLY = {
};
