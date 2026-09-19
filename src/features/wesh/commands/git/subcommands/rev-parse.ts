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
  let singleRevisionMode = false;
  const singleRevisionExpressions: string[] = [];
  const printRevision = async ({ expression, outputLength }: {
    expression: string,
    outputLength: number | undefined,
  }): Promise<void> => {
    const objectId = expression.includes(':')
      ? (await resolveRevisionPath({ files: context.files, repository, expression })).objectId
      : await resolveRevision({ files: context.files, repository, expression });
    await context.text().print({ text: `${outputLength === undefined ? objectId : objectId.slice(0, outputLength)}\n` });
  };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    if (arg === '--') {
      if (!singleRevisionMode) {
        await context.text().print({ text: '--\n' });
        for (const pathArgument of args.slice(index + 1))
          await context.text().print({ text: `${pathArgument}\n` });
      }
      break;
    }
    if (arg === '--is-inside-work-tree') {
      await context.text().print({ text: repositoryCwdIsInsideWorktree({ context, repository }) ? 'true\n' : 'false\n' });
      continue;
    }
    if (arg === '--is-bare-repository') {
      await context.text().print({ text: repositoryHasWorktree({ repository }) ? 'false\n' : 'true\n' });
      continue;
    }
    if (arg === '--verify') {
      singleRevisionMode = true;
      continue;
    }
    if (arg === '--show-toplevel') {
      assertRepositoryHasUsableWorktree({ context, repository });
      await context.text().print({ text: `${repository.worktreePath}\n` });
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
      continue;
    }
    if (arg === '--short') {
      singleRevisionMode = true;
      shortLength = 7;
      continue;
    }
    if (arg.startsWith('--short=')) {
      const rawLength = arg.slice('--short='.length);
      const match = /^[\t\n\v\f\r ]*([+-]?[0-9]+)/u.exec(rawLength);
      const parsed = match === null ? 0n : BigInt(match[1]!);
      const requestedLength = parsed < -2147483648n || parsed > 2147483647n ? 0 : Number(parsed);
      singleRevisionMode = true;
      shortLength = Math.min(40, Math.max(4, requestedLength));
      continue;
    }
    if (arg.startsWith('-')) {
      if (!singleRevisionMode)
        await context.text().print({ text: `${arg}\n` });
      continue;
    }
    if (singleRevisionMode)
      singleRevisionExpressions.push(arg);
    else
      await printRevision({ expression: arg, outputLength: undefined });
  }
  if (singleRevisionMode) {
    if (singleRevisionExpressions.length !== 1)
      throw new Error('Needed a single revision');
    await printRevision({ expression: singleRevisionExpressions[0]!, outputLength: shortLength });
  }
  return { exitCode: 0 };
}

export const TEST_ONLY = {
};
