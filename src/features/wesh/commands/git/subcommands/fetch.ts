import { GitUsageError } from '@/features/wesh/commands/git/errors';
import type { WeshCommandContext, WeshCommandResult } from "@/features/wesh/types";
import { readEffectiveConfig } from "@/features/wesh/commands/git/config";
import { sortGitUtf8Strings } from "@/features/wesh/commands/git/utf8-order";
import { fetchLocalRemote } from "@/features/wesh/commands/git/local-transport";
import { discoverRepositoryFromContext } from "@/features/wesh/commands/git/repository";
import { defineArgvCatalog, parseStandardArgv, type StandardArgvAction, type StandardArgvPolicy } from '@/features/wesh/argv-v2';

const FETCH_ARGV_CATALOG = defineArgvCatalog<StandardArgvAction<never>>({
  nonExecutableLongOptions: [],
  definitions: [
    {
      semantic: { kind: 'effects', effects: [{ key: 'prune', value: true }] },
      forms: [
        { kind: 'short', name: 'p', value: { kind: 'none' } },
        { kind: 'long', name: 'prune', value: { kind: 'none' } },
      ],
    },
    {
      semantic: { kind: 'effects', effects: [{ key: 'quiet', value: true }] },
      forms: [
        { kind: 'short', name: 'q', value: { kind: 'none' } },
        { kind: 'long', name: 'quiet', value: { kind: 'none' } },
      ],
    },
    {
      semantic: { kind: 'effects', effects: [{ key: 'all', value: true }] },
      forms: [{ kind: 'long', name: 'all', value: { kind: 'none' } }],
    },
  ],
});

const FETCH_ARGV_POLICY: StandardArgvPolicy = {
  longNameMatch: 'exact',
  optionBoundary: 'continue',
  occurrenceRetention: 'none',
};

export async function runFetch({ context, args }: {
  context: WeshCommandContext,
  args: readonly string[],
}): Promise<WeshCommandResult> {
  const parsed = parseStandardArgv({ args, catalog: FETCH_ARGV_CATALOG, policy: FETCH_ARGV_POLICY });
  const diagnostic = parsed.diagnostics[0];
  if (diagnostic !== undefined) {
    throw new GitUsageError({ message: `unknown option: ${args[diagnostic.argvIndex] ?? diagnostic.option}` });
  }
  const quiet = parsed.optionValues.quiet === true;
  const all = parsed.optionValues.all === true;
  const prune = parsed.optionValues.prune === true;
  const operands = parsed.positionals;
  if (operands.length > 1) throw new Error('too many arguments');
  if (all && operands.length > 0) throw new Error('fetch --all does not take a repository argument');
  const repository = await discoverRepositoryFromContext({ context });
  const config = await readEffectiveConfig({
    files: context.files,
    repository,
    homePath: context.env.get('HOME') ?? '/',
    cwd: context.cwd,
    env: context.env,
  });
  let remoteNames: string[];
  if (all) {
    const names = new Set<string>();
    for (const key of config.keys()) {
      const match = /^remote\.(.+)\.url$/u.exec(key);
      if (match !== null) names.add(match[1]!);
    }
    remoteNames = sortGitUtf8Strings({ values: names });
  } else {
    remoteNames = [operands[0] ?? 'origin'];
  }

  for (const remoteName of remoteNames) {
    const result = await fetchLocalRemote({ files: context.files, repository, remoteName, prune, config });
    if (quiet) continue;
    const changed = result.branchUpdates.filter(update => update.oldObjectId !== update.newObjectId);
    if (changed.length > 0 || result.prunedBranches.length > 0) await context.text().error({ text: `From ${result.sourcePath}\n` });
    for (const update of changed) {
      if (update.oldObjectId === undefined) {
        await context.text().error({
          text: ` * [new branch]      ${update.branchName} -> ${result.remoteName}/${update.branchName}\n`,
        });
      } else {
        await context.text().error({
          text: `   ${update.oldObjectId.slice(0, 7)}..${update.newObjectId.slice(0, 7)}  ${update.branchName} -> ${result.remoteName}/${update.branchName}\n`,
        });
      }
    }
    for (const deleted of result.prunedBranches) {
      await context.text().error({
        text: ` - [deleted]         (none)     -> ${result.remoteName}/${deleted.branchName}\n`,
      });
    }
  }
  return { exitCode: 0 };
}

export const TEST_ONLY = {
};
