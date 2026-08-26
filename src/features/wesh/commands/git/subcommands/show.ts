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
import { expandGitShortOptions } from "@/features/wesh/commands/git/short-options";

export async function runShow({ context, args }: {
    context: WeshCommandContext;
    args: readonly string[];
}): Promise<WeshCommandResult> {
  const repository = await discoverRepositoryFromContext({ context });
  const showConfig = await readEffectiveConfig({ files: context.files, repository, homePath: context.env.get('HOME') ?? '/', env: context.env });
  const showQuoteNonAscii = quoteNonAsciiFromConfig({ config: showConfig });
  let diffMode: 'patch' | 'no-patch' | 'stat' = 'patch';
  let optionTerminated = false;
  const operands: string[] = [];
  const normalizedArgs = expandGitShortOptions({ args, flagOptions: ['s'], valueOptions: [] });
  for (const arg of normalizedArgs) {
    if (optionTerminated)
      throw new Error('show pathspecs are not supported yet');
    if (arg === '--') {
      optionTerminated = true;
    } else if (arg === '--no-patch' || arg === '-s')
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
