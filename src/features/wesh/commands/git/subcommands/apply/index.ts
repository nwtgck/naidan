import type { WeshCommandContext, WeshCommandResult } from '@/features/wesh/types';
import { readPatchInput } from '@/features/wesh/commands/git/subcommands/apply/patch/filesystem';
import { parsePatchDocument } from '@/features/wesh/commands/git/subcommands/apply/patch/parser';
import type { TextPatchSection } from '@/features/wesh/commands/git/subcommands/apply/patch/types';
import { writeIndex } from '@/features/wesh/commands/git/index-file';
import { replaceTrackedWorktreePaths } from '@/features/wesh/commands/git/worktree';
import { readWorktreeContentConfig } from '@/features/wesh/commands/git/config';
import { discoverRepositoryFromContext } from '@/features/wesh/commands/git/repository';
import { parseApplyArguments } from './arguments';
import { planIndexChanges, planWorktreeChanges, validateIndexMatchesWorktree, writePlannedObjects } from './planning';
import { assertSupportedRepositoryContentPolicy } from "@/features/wesh/commands/git/content-policy";

export async function runApply({ context, args }: {
  context: WeshCommandContext,
  args: readonly string[],
}): Promise<WeshCommandResult> {
  await assertSupportedRepositoryContentPolicy({ context });
  const parsedArgs = parseApplyArguments({ args });
  const repository = await discoverRepositoryFromContext({ context });
  const patchBytes = await readPatchInput({ context, path: parsedArgs.inputPath, cwd: context.cwd });
  const parsedDocument = parsePatchDocument({ bytes: patchBytes, forcedFormat: undefined, binary: false });
  const sections: TextPatchSection[] = [];
  for (const section of parsedDocument.sections) {
    switch (section.kind) {
    case 'text':
      sections.push(section);
      break;
    case 'ed':
      throw new Error('ed patches are not supported by git apply');
    default: {
      const _ex: never = section;
      throw new Error(`Unhandled patch section: ${JSON.stringify(_ex)}`);
    }
    }
  }
  if (sections.length === 0) throw new Error('No valid patches in input');

  try {
    if (!parsedArgs.cached && !parsedArgs.index) {
      const plan = await planWorktreeChanges({ context, repository, sections, reverse: parsedArgs.reverse });
      if (parsedArgs.check) return { exitCode: 0 };
      const written = await writePlannedObjects({ context, repository, plan });
      await replaceTrackedWorktreePaths({
        files: context.files,
        repository,
        previousEntries: plan.originalEntries,
        targetEntries: written.entries,
        paths: written.touchedPaths,
        contentConfig: await readWorktreeContentConfig({ files: context.files, repository, homePath: context.env.get('HOME') ?? '/', env: context.env }),
      });
      return { exitCode: 0 };
    }

    const plan = await planIndexChanges({ context, repository, sections, reverse: parsedArgs.reverse });
    if (parsedArgs.index) {
      await validateIndexMatchesWorktree({
        context,
        repository,
        originalEntries: plan.originalEntries,
        validationPaths: plan.validationPaths,
        worktreeAbsentPaths: plan.worktreeAbsentPaths,
      });
    }
    if (parsedArgs.check) return { exitCode: 0 };

    const written = await writePlannedObjects({ context, repository, plan });
    if (parsedArgs.index) {
      await replaceTrackedWorktreePaths({
        files: context.files,
        repository,
        previousEntries: plan.originalEntries,
        targetEntries: written.entries,
        paths: written.touchedPaths,
        contentConfig: await readWorktreeContentConfig({ files: context.files, repository, homePath: context.env.get('HOME') ?? '/', env: context.env }),
      });
    }
    await writeIndex({ files: context.files, repository, entries: written.entries });
    return { exitCode: 0 };
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    await context.text().error({ text: `error: ${message}\n` });
    return { exitCode: 1 };
  }
}

export const TEST_ONLY = {
};
