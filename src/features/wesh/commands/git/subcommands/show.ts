import type { WeshCommandContext, WeshCommandResult } from "@/features/wesh/types";
import { readCommit } from "@/features/wesh/commands/git/commits";
import { readEffectiveConfig } from "@/features/wesh/commands/git/config";
import { writeRevisionPatch, writeRevisionStat } from "@/features/wesh/commands/git/diff/revision";
import { writeHandleBytes } from "@/features/wesh/commands/git/files";
import { quoteNonAsciiFromConfig } from "@/features/wesh/commands/git/path-output";
import { readObject } from "@/features/wesh/commands/git/objects";
import { discoverRepositoryFromContext } from "@/features/wesh/commands/git/repository";
import { resolveRevision, resolveRevisionPath } from "@/features/wesh/commands/git/revision";
import { parseAnnotatedTagObject } from "@/features/wesh/commands/git/tag-object";
import { formatLogDate, parseAuthorForLog } from "@/features/wesh/commands/git/log-format";
import { analyzeArgvShortForm, defineArgvCatalog } from '@/features/wesh/argv-v2';

const SHOW_SHORT_ARGV_CATALOG = defineArgvCatalog<'no-patch'>({
  nonExecutableLongOptions: [],
  definitions: [{ semantic: 'no-patch', forms: [{ kind: 'short', name: 's', value: { kind: 'none' } }] }],
});

export async function runShow({ context, args }: {
    context: WeshCommandContext;
    args: readonly string[];
}): Promise<WeshCommandResult> {
  const repository = await discoverRepositoryFromContext({ context });
  const showConfig = await readEffectiveConfig({ files: context.files, repository, homePath: context.env.get('HOME') ?? '/', cwd: context.cwd, env: context.env });
  const showQuoteNonAscii = quoteNonAsciiFromConfig({ config: showConfig });
  let diffMode: 'patch' | 'no-patch' | 'stat' = 'patch';
  let optionTerminated = false;
  const operands: string[] = [];
  for (const arg of args) {
    if (optionTerminated)
      throw new Error('show pathspecs are not supported yet');
    if (arg === '--') {
      optionTerminated = true;
      continue;
    }
    if (arg.startsWith('-') && !arg.startsWith('--') && arg.length > 1) {
      let bodyOffset = 1;
      while (bodyOffset < arg.length) {
        const analysis = analyzeArgvShortForm({ token: arg, bodyOffset, prefix: '-', catalog: SHOW_SHORT_ARGV_CATALOG });
        switch (analysis.kind) {
        case 'unknown':
          throw new Error(`unsupported show argument: ${arg}`);
        case 'matched':
          break;
        default: {
          const _ex: never = analysis;
          throw new Error(`Unhandled show short-option analysis: ${JSON.stringify(_ex)}`);
        }
        }
        switch (analysis.value.kind) {
        case 'none':
          diffMode = 'no-patch';
          break;
        case 'inline':
        case 'following-required':
        case 'following-optional':
          throw new Error(`Show -s unexpectedly claimed a value: ${analysis.value.kind}`);
        default: {
          const _ex: never = analysis.value;
          throw new Error(`Unhandled show -s value: ${JSON.stringify(_ex)}`);
        }
        }
        bodyOffset = analysis.nextBodyOffset;
      }
      continue;
    }
    if (arg === '--no-patch')
      diffMode = 'no-patch';
    else if (arg === '--stat') {
      diffMode = 'stat';
    } else if (arg === '--no-color') {
      // Output is uncolored by Wesh Git.
    } else if (arg.startsWith('-'))
      throw new Error(`unsupported show argument: ${arg}`);
    else
      operands.push(arg);
  }
  if (operands.length > 1)
    throw new Error('too many revisions specified');
  const expression = operands[0] ?? 'HEAD';
  if (expression.includes(':')) {
    const resolved = await resolveRevisionPath({ files: context.files, repository, expression });
    const object = await readObject({ files: context.files, repository, objectId: resolved.objectId });
    switch (object.type) {
    case 'blob':
      await writeHandleBytes({ handle: context.stdout, bytes: object.body });
      return { exitCode: 0 };
    case 'tree':
    case 'commit':
    case 'tag':
      throw new Error(`object ${resolved.objectId} is not a blob`);
    default: {
      const _ex: never = object.type;
      throw new Error(`Unhandled show object type: ${_ex}`);
    }
    }
  }
  let objectId = await resolveRevision({ files: context.files, repository, expression });
  let object = await readObject({ files: context.files, repository, objectId });
  while (object.type === 'tag') {
    const tag = parseAnnotatedTagObject({ body: object.body });
    const tagger = parseAuthorForLog({ author: tag.tagger });
    await context.text().print({
      text: `tag ${tag.name}\nTagger: ${tagger.identity}\nDate:   ${formatLogDate({ timestamp: tagger.timestamp, timezone: tagger.timezone })}\n\n${tag.message.trimEnd()}\n\n`,
    });
    objectId = tag.targetObjectId;
    object = await readObject({ files: context.files, repository, objectId });
  }
  switch (object.type) {
  case 'commit':
    break;
  case 'blob':
  case 'tree':
    throw new Error(`object ${objectId} is not a commit`);
  default: {
    const _ex: never = object.type;
    throw new Error(`Unhandled show object type: ${_ex}`);
  }
  }
  const commit = await readCommit({ files: context.files, repository, objectId });
  const author = parseAuthorForLog({ author: commit.author });
  const message = commit.message.trimEnd().split('\n').map(line => `    ${line}\n`).join('');
  await context.text().print({
    text: `commit ${objectId}\nAuthor: ${author.identity}\nDate:   ${formatLogDate({ timestamp: author.timestamp, timezone: author.timezone })}\n\n${message}\n`,
  });
  switch (diffMode) {
  case 'no-patch':
    break;
  case 'stat':
    await writeRevisionStat({
      context,
      repository,
      leftRevision: commit.parentObjectIds[0],
      rightRevision: objectId,
      pathOperands: [],
      quoteNonAscii: showQuoteNonAscii,
    });
    break;
  case 'patch':
    await writeRevisionPatch({
      context,
      repository,
      leftRevision: commit.parentObjectIds[0],
      rightRevision: objectId,
      pathOperands: [],
      quoteNonAscii: showQuoteNonAscii,
    });
    break;
  default: {
    const _ex: never = diffMode;
    throw new Error(`Unhandled show diff mode: ${_ex}`);
  }
  }
  return { exitCode: 0 };
}

export const TEST_ONLY = {
};
