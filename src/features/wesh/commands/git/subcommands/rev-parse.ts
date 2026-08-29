import type { WeshCommandContext, WeshCommandResult } from "@/features/wesh/types";
import { assertRepositoryHasUsableWorktree, repositoryCwdIsInsideWorktree, repositoryHasWorktree, discoverRepositoryFromContext } from "@/features/wesh/commands/git/repository";
import { resolveRevision, resolveRevisionPath } from "@/features/wesh/commands/git/revision";
import { readEffectiveConfig } from "@/features/wesh/commands/git/config";

function relativePath({ from, to }: { from: string, to: string }): string {
  const fromParts = from.split('/').filter(Boolean);
  const toParts = to.split('/').filter(Boolean);
  let shared = 0;
  while (shared < fromParts.length && shared < toParts.length && fromParts[shared] === toParts[shared]) shared += 1;
  const parts = [...fromParts.slice(shared).map(() => '..'), ...toParts.slice(shared)];
  return parts.length === 0 ? '.' : parts.join('/');
}

export async function runRevParse({ context, args }: {
  context: WeshCommandContext,
  args: readonly string[],
}): Promise<WeshCommandResult> {
  const repository = await discoverRepositoryFromContext({ context });
  await readEffectiveConfig({
    files: context.files,
    repository,
    homePath: context.env.get('HOME') ?? '/',
    cwd: context.cwd,
    env: context.env,
  });
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
      const explicitGitDir = context.env.get('GIT_DIR');
      const relative = explicitGitDir !== undefined
        ? explicitGitDir
        : context.cwd === repository.gitDirPath
          ? '.'
          : repository.gitDirPath === `${repository.worktreePath}/.git` && context.cwd === repository.worktreePath
            ? '.git'
            : repository.gitDirPath;
      await context.text().print({ text: `${relative}\n` });
      printedSpecial = true;
      continue;
    }
    if (arg === '--git-common-dir') {
      const explicitGitDir = context.env.get('GIT_DIR');
      const relative = explicitGitDir !== undefined && repository.commonDirPath === repository.gitDirPath
        ? explicitGitDir
        : context.cwd === repository.commonDirPath
          ? '.'
          : repository.commonDirPath === repository.gitDirPath
            && repositoryCwdIsInsideWorktree({ context, repository })
            ? relativePath({ from: context.cwd, to: repository.commonDirPath })
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
      const rawLength = arg.slice('--short='.length);
      const match = /^[\t\n\v\f\r ]*([+-]?[0-9]+)/u.exec(rawLength);
      const parsed = match === null ? 0n : BigInt(match[1]!);
      const requestedLength = parsed < -2147483648n || parsed > 2147483647n ? 0 : Number(parsed);
      shortLength = Math.min(40, Math.max(4, requestedLength));
      continue;
    }
    if (arg.startsWith('-')) {
      if (!verify && shortLength === undefined) {
        await context.text().print({ text: `${arg}\n` });
        printedSpecial = true;
      }
      continue;
    }
    expressions.push(arg);
  }
  if ((verify || shortLength !== undefined) && expressions.length !== 1)
    throw new Error('Needed a single revision');
  if (!printedSpecial && expressions.length === 0 && pathArguments === undefined)
    return { exitCode: 0 };
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
