import { GitUsageError } from '@/features/wesh/commands/git/errors';
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
import { analyzeArgvShortForm, defineArgvCatalog } from '@/features/wesh/argv-v2';

type StashPushShortSemantic = 'include-untracked' | 'message';

const STASH_PUSH_SHORT_ARGV_CATALOG = defineArgvCatalog<StashPushShortSemantic>({
  nonExecutableLongOptions: [],
  definitions: [
    { semantic: 'include-untracked', forms: [{ kind: 'short', name: 'u', value: { kind: 'none' } }] },
    { semantic: 'message', forms: [{ kind: 'short', name: 'm', value: { kind: 'required-attached-or-following', missingValueName: 'message' } }] },
  ],
});

const STASH_SHOW_SHORT_ARGV_CATALOG = defineArgvCatalog<'patch'>({
  nonExecutableLongOptions: [],
  definitions: [{ semantic: 'patch', forms: [{ kind: 'short', name: 'p', value: { kind: 'none' } }] }],
});

export async function runStash({ context, args }: {
    context: WeshCommandContext;
    args: readonly string[];
}): Promise<WeshCommandResult> {
  const subcommand = args[0] === undefined || args[0].startsWith('-') ? 'push' : args[0];
  await assertSupportedRepositoryContentPolicy({ context, cleanMutation: subcommand === 'push' });
  const rawRest = subcommand === 'push' && (args[0] === undefined || args[0].startsWith('-')) ? args : args.slice(1);
  const rest = rawRest;
  const repository = await discoverRepositoryFromContext({ context });
  switch (subcommand) {
  case 'push': {
    let includeUntracked = false;
    let message: string | undefined;
    let parsingOptions = true;
    const pathOperands: string[] = [];
    for (let index = 0; index < rest.length; index += 1) {
      const arg = rest[index]!;
      if (parsingOptions && arg === '--') {
        parsingOptions = false;
        continue;
      }
      if (!parsingOptions) {
        pathOperands.push(arg);
        continue;
      }
      if (arg.startsWith('-') && !arg.startsWith('--') && arg.length > 1) {
        let bodyOffset = 1;
        while (bodyOffset < arg.length) {
          const analysis = analyzeArgvShortForm({ token: arg, bodyOffset, prefix: '-', catalog: STASH_PUSH_SHORT_ARGV_CATALOG });
          switch (analysis.kind) {
          case 'unknown':
            throw new GitUsageError({ message: `unknown option: ${arg}` });
          case 'matched':
            break;
          default: {
            const _ex: never = analysis;
            throw new Error(`Unhandled stash push short-option analysis: ${JSON.stringify(_ex)}`);
          }
          }
          switch (analysis.semantic) {
          case 'include-untracked':
            switch (analysis.value.kind) {
            case 'none':
              includeUntracked = true;
              break;
            case 'inline':
            case 'following-required':
            case 'following-optional':
              throw new Error(`Stash -u unexpectedly claimed a value: ${analysis.value.kind}`);
            default: {
              const _ex: never = analysis.value;
              throw new Error(`Unhandled stash -u value: ${JSON.stringify(_ex)}`);
            }
            }
            break;
          case 'message':
            switch (analysis.value.kind) {
            case 'inline':
              message = analysis.value.rawValue;
              break;
            case 'following-required': {
              const value = rest[index + 1];
              if (value === undefined)
                throw new GitUsageError({ message: `option '${analysis.option}' requires a value` });
              message = value;
              index += 1;
              break;
            }
            case 'none':
            case 'following-optional':
              throw new Error(`Stash -m produced invalid value claim: ${analysis.value.kind}`);
            default: {
              const _ex: never = analysis.value;
              throw new Error(`Unhandled stash -m value: ${JSON.stringify(_ex)}`);
            }
            }
            break;
          default: {
            const _ex: never = analysis.semantic;
            throw new Error(`Unhandled stash push short semantic: ${_ex}`);
          }
          }
          bodyOffset = analysis.nextBodyOffset;
        }
      } else if (arg === '--include-untracked') {
        includeUntracked = true;
      } else if (arg === '--message') {
        const value = rest[index + 1];
        if (value === undefined)
          throw new GitUsageError({ message: `option '${arg}' requires a value` });
        message = value;
        index += 1;
      } else if (arg.startsWith('--message=')) {
        message = arg.slice('--message='.length);
      } else {
        throw new GitUsageError({ message: `unknown option: ${arg}` });
      }
    }
    if (pathOperands.length > 0)
      throw new Error('stash push pathspecs are not supported yet');
    const config = await readEffectiveConfig({ files: context.files, repository, homePath: context.env.get('HOME') ?? '/', cwd: context.cwd, env: context.env });
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
    const listArgs = rest.at(-1) === '--' ? rest.slice(0, -1) : rest;
    if (listArgs.length !== 0)
      throw new Error('stash list arguments are not supported yet');
    for (const entry of await listStashes({ files: context.files, repository })) {
      await context.text().print({ text: `stash@{${entry.index}}: ${entry.message}\n` });
    }
    return { exitCode: 0 };
  }
  case 'drop': {
    const operands = rest.filter(arg => arg !== '--');
    if (operands.length > 1 || rest.filter(arg => arg === '--').length > 1)
      throw new Error('Too many revisions specified');
    const index = parseStashIndex({ expression: operands[0] });
    const dropped = await dropStash({ files: context.files, repository, index });
    await context.text().print({ text: `Dropped stash@{${index}} (${dropped.objectId})\n` });
    return { exitCode: 0 };
  }
  case 'clear':
    if (rest.length > 1 || (rest.length === 1 && rest[0] !== '--'))
      throw new Error('stash clear does not take arguments');
    await clearStashes({ files: context.files, repository });
    return { exitCode: 0 };
  case 'apply':
  case 'pop': {
    let restoreIndex = false;
    let parsingOptions = true;
    const operands: string[] = [];
    for (const arg of rest) {
      if (parsingOptions && arg === '--') {
        parsingOptions = false;
        continue;
      }
      if (parsingOptions && arg === '--index')
        restoreIndex = true;
      else if (parsingOptions && arg.startsWith('-'))
        throw new GitUsageError({ message: `unknown option: ${arg}` });
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
    let showStat = false;
    let showPatch = true;
    let patchExplicitlyRequested = false;
    let parsingOptions = true;
    for (const arg of rest) {
      if (parsingOptions && arg === '--') {
        parsingOptions = false;
        continue;
      }
      if (parsingOptions && arg.startsWith('-') && !arg.startsWith('--') && arg.length > 1) {
        let bodyOffset = 1;
        while (bodyOffset < arg.length) {
          const analysis = analyzeArgvShortForm({ token: arg, bodyOffset, prefix: '-', catalog: STASH_SHOW_SHORT_ARGV_CATALOG });
          switch (analysis.kind) {
          case 'unknown':
            throw new GitUsageError({ message: `unknown option: ${arg}` });
          case 'matched':
            break;
          default: {
            const _ex: never = analysis;
            throw new Error(`Unhandled stash show short-option analysis: ${JSON.stringify(_ex)}`);
          }
          }
          switch (analysis.value.kind) {
          case 'none':
            showPatch = true;
            patchExplicitlyRequested = true;
            break;
          case 'inline':
          case 'following-required':
          case 'following-optional':
            throw new Error(`Stash show -p unexpectedly claimed a value: ${analysis.value.kind}`);
          default: {
            const _ex: never = analysis.value;
            throw new Error(`Unhandled stash show -p value: ${JSON.stringify(_ex)}`);
          }
          }
          bodyOffset = analysis.nextBodyOffset;
        }
        continue;
      }
      if (parsingOptions && arg === '--patch') {
        showPatch = true;
        patchExplicitlyRequested = true;
        continue;
      }
      if (parsingOptions && arg === '--no-color')
        continue;
      if (parsingOptions && arg === '--stat') {
        showStat = true;
        if (!patchExplicitlyRequested)
          showPatch = false;
        continue;
      }
      if (parsingOptions && arg.startsWith('-'))
        throw new GitUsageError({ message: `unknown option: ${arg}` });
      if (expression !== undefined)
        throw new Error('Too many revisions specified');
      expression = arg;
    }
    const stash = await resolveStash({ files: context.files, repository, expression });
    const commit = await readCommit({ files: context.files, repository, objectId: stash.objectId });
    const baseObjectId = commit.parentObjectIds[0];
    if (baseObjectId === undefined)
      throw new Error('stash commit has invalid parents');
    const stashShowConfig = await readEffectiveConfig({ files: context.files, repository, homePath: context.env.get('HOME') ?? '/', cwd: context.cwd, env: context.env });
    const stashShowQuoteNonAscii = quoteNonAsciiFromConfig({ config: stashShowConfig });
    if (showStat) {
      await writeRevisionStat({ context, repository, leftRevision: baseObjectId, rightRevision: stash.objectId, pathOperands: [], quoteNonAscii: stashShowQuoteNonAscii });
    }
    if (showPatch) {
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
