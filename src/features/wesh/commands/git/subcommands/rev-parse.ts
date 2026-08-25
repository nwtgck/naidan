import type { WeshCommandContext, WeshCommandResult } from "@/features/wesh/types";
import { assertRepositoryHasUsableWorktree, repositoryCwdIsInsideWorktree, repositoryHasWorktree, discoverRepositoryFromContext } from "@/features/wesh/commands/git/repository";
import { resolveRevision, resolveRevisionPath } from "@/features/wesh/commands/git/revision";

export async function runRevParse({ context, args }: {
  context: WeshCommandContext,
  args: readonly string[],
}): Promise<WeshCommandResult> {
  const repository = await discoverRepositoryFromContext({ context });
  let short = false;
  let verify = false;
  let printedSpecial = false;
  const expressions: string[] = [];
  for (const arg of args) {
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
      short = true;
      continue;
    }
    if (arg.startsWith('-')) throw new Error(`unknown option: ${arg}`);
    expressions.push(arg);
  }
  if (!printedSpecial && expressions.length === 0) throw new Error('no revision specified');
  if (verify && expressions.length !== 1) throw new Error('--verify requires a single revision');
  for (const expression of expressions) {
    const objectId = expression.includes(':')
      ? (await resolveRevisionPath({ files: context.files, repository, expression })).objectId
      : await resolveRevision({ files: context.files, repository, expression });
    await context.text().print({ text: `${short ? objectId.slice(0, 7) : objectId}\n` });
  }
  return { exitCode: 0 };
}

export const TEST_ONLY = {
};
