import type { WeshCommandContext, WeshCommandResult } from "@/features/wesh/types";
import { readCommit } from "@/features/wesh/commands/git/commits";
import { readEffectiveConfig } from "@/features/wesh/commands/git/config";
import { writeRevisionPatch, writeRevisionStat } from "@/features/wesh/commands/git/diff/revision";
import { quoteNonAsciiFromConfig } from "@/features/wesh/commands/git/path-output";
import { discoverRepositoryFromContext } from "@/features/wesh/commands/git/repository";
import { applyStash, clearStashes, createStash, dropStash, listStashes, parseStashIndex, resolveStash } from "./operation";
import { resolveContentConfigForContext } from "@/features/wesh/commands/git/content-config";
import { collectStatus } from "@/features/wesh/commands/git/status";
import { printLongStatus } from "@/features/wesh/commands/git/status-output";
import { assertSupportedRepositoryContentPolicy } from "@/features/wesh/commands/git/content-policy";

export async function runStash({ context, args }: {
    context: WeshCommandContext;
    args: readonly string[];
}): Promise<WeshCommandResult> {
  const subcommand = args[0] === undefined || args[0].startsWith('-') ? 'push' : args[0];
  await assertSupportedRepositoryContentPolicy({ context, cleanMutation: subcommand === 'push' });
  const rest = subcommand === 'push' && (args[0] === undefined || args[0].startsWith('-')) ? args : args.slice(1);
  const repository = await discoverRepositoryFromContext({ context });
  switch (subcommand) {
  case 'push': {
    let includeUntracked = false;
    let message: string | undefined;
    for (let index = 0; index < rest.length; index += 1) {
      const arg = rest[index]!;
      if (arg === '-u' || arg === '--include-untracked') {
        includeUntracked = true;
      } else if (arg === '-m' || arg === '--message') {
        const value = rest[index + 1];
        if (value === undefined)
          throw new Error(`option '${arg}' requires a value`);
        message = value;
        index += 1;
      } else if (arg.startsWith('--message=')) {
        message = arg.slice('--message='.length);
      } else {
        throw new Error(`unknown option: ${arg}`);
      }
    }
    const config = await readEffectiveConfig({ files: context.files, repository, homePath: context.env.get('HOME') ?? '/', env: context.env });
    const created = await createStash({
      files: context.files,
      repository,
      config,
      env: context.env,
      message,
      includeUntracked,
    });
    if (created === undefined) {
      await context.text().print({ text: 'No local changes to save\n' });
      return { exitCode: 0 };
    }
    await context.text().print({ text: `Saved working directory and index state ${created.subject}\n` });
    return { exitCode: 0 };
  }
  case 'list': {
    if (rest.length !== 0)
      throw new Error('stash list arguments are not supported yet');
    for (const entry of await listStashes({ files: context.files, repository })) {
      await context.text().print({ text: `stash@{${entry.index}}: ${entry.message}\n` });
    }
    return { exitCode: 0 };
  }
  case 'drop': {
    if (rest.length > 1)
      throw new Error('Too many revisions specified');
    const index = parseStashIndex({ expression: rest[0] });
    const dropped = await dropStash({ files: context.files, repository, index });
    await context.text().print({ text: `Dropped stash@{${index}} (${dropped.objectId})\n` });
    return { exitCode: 0 };
  }
  case 'clear':
    if (rest.length !== 0)
      throw new Error('stash clear does not take arguments');
    await clearStashes({ files: context.files, repository });
    return { exitCode: 0 };
  case 'apply':
  case 'pop': {
    let restoreIndex = false;
    const operands: string[] = [];
    for (const arg of rest) {
      if (arg === '--index')
        restoreIndex = true;
      else if (arg.startsWith('-'))
        throw new Error(`unknown option: ${arg}`);
      else
        operands.push(arg);
    }
    if (operands.length > 1)
      throw new Error('Too many revisions specified');
    const stashIndex = parseStashIndex({ expression: operands[0] });
    const applied = await applyStash({
      files: context.files,
      repository,
      expression: operands[0],
      restoreIndex,
      contentConfig: await resolveContentConfigForContext({ context, repository }),
    });
    await printLongStatus({ context, status: await collectStatus({ context }) });
    switch (subcommand) {
    case 'apply':
      break;
    case 'pop':
      await dropStash({ files: context.files, repository, index: stashIndex });
      await context.text().print({ text: `Dropped refs/stash@{${stashIndex}} (${applied.objectId})\n` });
      break;
    default: {
      const _ex: never = subcommand;
      throw new Error(`Unhandled stash apply command: ${_ex}`);
    }
    }
    return { exitCode: 0 };
  }
  case 'show': {
    let expression: string | undefined;
    let stat = false;
    for (const arg of rest) {
      if (arg === '-p' || arg === '--patch' || arg === '--no-color')
        continue;
      if (arg === '--stat') {
        stat = true;
        continue;
      }
      if (arg.startsWith('-'))
        throw new Error(`unknown option: ${arg}`);
      if (expression !== undefined)
        throw new Error('Too many revisions specified');
      expression = arg;
    }
    const stash = await resolveStash({ files: context.files, repository, expression });
    const commit = await readCommit({ files: context.files, repository, objectId: stash.objectId });
    const baseObjectId = commit.parentObjectIds[0];
    if (baseObjectId === undefined)
      throw new Error('stash commit has invalid parents');
    const stashShowConfig = await readEffectiveConfig({ files: context.files, repository, homePath: context.env.get('HOME') ?? '/', env: context.env });
    const stashShowQuoteNonAscii = quoteNonAsciiFromConfig({ config: stashShowConfig });
    if (stat) {
      await writeRevisionStat({ context, repository, leftRevision: baseObjectId, rightRevision: stash.objectId, pathOperands: [], quoteNonAscii: stashShowQuoteNonAscii });
    } else {
      await writeRevisionPatch({ context, repository, leftRevision: baseObjectId, rightRevision: stash.objectId, pathOperands: [], quoteNonAscii: stashShowQuoteNonAscii });
    }
    return { exitCode: 0 };
  }
  default:
    throw new Error(`unknown subcommand: ${subcommand}`);
  }
}

export const TEST_ONLY = {
};
