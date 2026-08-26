import type { WeshCommandContext, WeshCommandResult } from "@/features/wesh/types";
import { assertRepositoryHasUsableWorktree, repositoryCwdIsInsideWorktree, repositoryHasWorktree, discoverRepositoryFromContext } from "@/features/wesh/commands/git/repository";
import { resolveRevision, resolveRevisionPath } from "@/features/wesh/commands/git/revision";

export async function runRevParse({ context, args }: {
  context: WeshCommandContext,
  args: readonly string[],
}): Promise<WeshCommandResult> {
  const repository = await discoverRepositoryFromContext({ context });
  let shortLength: number | undefined;
  let verify = false;
  let printedSpecial = false;
  const expressions: string[] = [];
  let pathArguments: readonly string[] | undefined;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    if (arg === '--') {
      if (!verify && shortLength === undefined)
        pathArguments = args.slice(index + 1);
      break;
    }
    if (arg === '--is-inside-work-tree') {
      await context.text().print({ text: repositoryCwdIsInsideWorktree({ context, repository }) ? 'true\n' : 'false\n' });
      printedSpecial = true;
      continue;
    }
    if (arg === '--is-bare-repository') {
      await context.text().print({ text: repositoryHasWorktree({ repository }) ? 'false\n' : 'true\n' });
      printedSpecial = true;
      continue;
    }
    if (arg === '--verify') {
      verify = true;
      continue;
    }
    if (arg === '--show-toplevel') {
      assertRepositoryHasUsableWorktree({ context, repository });
      await context.text().print({ text: `${repository.worktreePath}\n` });
      printedSpecial = true;
      continue;
    }
    if (arg === '--git-dir') {
      const relative = context.cwd === repository.gitDirPath
        ? '.'
        : repository.gitDirPath === `${repository.worktreePath}/.git` && context.cwd === repository.worktreePath
          ? '.git'
          : repository.gitDirPath;
      await context.text().print({ text: `${relative}\n` });
      printedSpecial = true;
      continue;
    }
    if (arg === '--git-common-dir') {
      const relative = context.cwd === repository.commonDirPath
        ? '.'
        : repository.commonDirPath === `${repository.worktreePath}/.git` && context.cwd === repository.worktreePath
          ? '.git'
          : repository.commonDirPath;
      await context.text().print({ text: `${relative}\n` });
      printedSpecial = true;
      continue;
    }
    if (arg === '--short') {
      shortLength = 7;
      continue;
    }
    if (arg.startsWith('--short=')) {
      const match = /^([0-9]+)/u.exec(arg.slice('--short='.length));
      const requestedLength = match === null ? 0 : Number.parseInt(match[1]!, 10);
      shortLength = Math.min(40, Math.max(4, requestedLength));
      continue;
    }
    if (arg.startsWith('-')) throw new Error(`unknown option: ${arg}`);
    expressions.push(arg);
  }
  if (!printedSpecial && expressions.length === 0 && pathArguments === undefined)
    throw new Error('no revision specified');
  if ((verify || shortLength !== undefined) && expressions.length !== 1)
    throw new Error('Needed a single revision');
  for (const expression of expressions) {
    const objectId = expression.includes(':')
      ? (await resolveRevisionPath({ files: context.files, repository, expression })).objectId
      : await resolveRevision({ files: context.files, repository, expression });
    await context.text().print({ text: `${shortLength === undefined ? objectId : objectId.slice(0, shortLength)}\n` });
  }
  if (pathArguments !== undefined) {
    await context.text().print({ text: '--\n' });
    for (const pathArgument of pathArguments)
      await context.text().print({ text: `${pathArgument}\n` });
  }
  return { exitCode: 0 };
}

export const TEST_ONLY = {
};
