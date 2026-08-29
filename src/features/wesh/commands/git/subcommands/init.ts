import { normalizePath } from "@/features/wesh/path";
import type { WeshCommandContext, WeshCommandResult } from "@/features/wesh/types";
import { initializeBareRepository, initializeRepository, joinPath } from "@/features/wesh/commands/git/repository";
import { expandGitShortOptions } from "@/features/wesh/commands/git/short-options";
import { parseConfig, readGlobalConfigEntries } from "@/features/wesh/commands/git/config";
import { pathExists, readFileText } from "@/features/wesh/commands/git/files";
import { GitUsageError } from "@/features/wesh/commands/git/errors";

async function preflightTargetConfig({ context, targetPath, bare }: {
  context: WeshCommandContext,
  targetPath: string,
  bare: boolean,
}): Promise<void> {
  const configPath = joinPath({
    base: targetPath,
    child: bare ? 'config' : '.git/config',
  });
  if (!await pathExists({ files: context.files, path: configPath })) return;
  parseConfig({ text: await readFileText({ files: context.files, path: configPath }) });
}

export async function runInit({ context, args }: {
  context: WeshCommandContext,
  args: readonly string[],
}): Promise<WeshCommandResult> {
  await readGlobalConfigEntries({
    files: context.files,
    homePath: context.env.get('HOME') ?? '/',
    cwd: context.cwd,
    env: context.env,
  });
  let quiet = false;
  let bare = false;
  const operands: string[] = [];
  let parsingOptions = true;
  const normalizedArgs = expandGitShortOptions({ args, flagOptions: ['q'], valueOptions: [] });
  for (const arg of normalizedArgs) {
    if (parsingOptions && arg === '--') {
      parsingOptions = false;
      continue;
    }
    if (parsingOptions && (arg === '-q' || arg === '--quiet')) quiet = true;
    else if (parsingOptions && arg === '--bare') bare = true;
    else if (parsingOptions && arg.startsWith('-')) throw new GitUsageError({ message: `unknown option: ${arg}` });
    else operands.push(arg);
  }
  if (operands.length > 1) throw new GitUsageError({ message: 'usage: git init [-q | --quiet] [--bare] [<directory>]', prefix: 'none' });
  const targetPath = normalizePath({ cwd: context.cwd, path: operands[0] ?? '.' });
  await preflightTargetConfig({ context, targetPath, bare });
  const { repository, reinitialized } = bare
    ? await initializeBareRepository({ files: context.files, targetPath })
    : await initializeRepository({ files: context.files, targetPath });
  if (!quiet) {
    await context.text().print({
      text: `${reinitialized ? 'Reinitialized existing' : 'Initialized empty'} Git repository in ${repository.gitDirPath}/\n`,
    });
  }
  return { exitCode: 0 };
}

export const TEST_ONLY = {
};
