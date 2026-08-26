import { normalizePath } from "@/features/wesh/path";
import type { WeshCommandContext, WeshCommandResult } from "@/features/wesh/types";
import { initializeBareRepository, initializeRepository } from "@/features/wesh/commands/git/repository";
import { expandGitShortOptions } from "@/features/wesh/commands/git/short-options";

export async function runInit({ context, args }: {
  context: WeshCommandContext,
  args: readonly string[],
}): Promise<WeshCommandResult> {
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
    else if (parsingOptions && arg.startsWith('-')) throw new Error(`unknown option: ${arg}`);
    else operands.push(arg);
  }
  if (operands.length > 1) throw new Error('too many arguments');
  const targetPath = normalizePath({ cwd: context.cwd, path: operands[0] ?? '.' });
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
