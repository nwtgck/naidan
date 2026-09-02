import { formatGitAmbiguousLongOption } from '@/features/wesh/commands/git/argv-diagnostics';
import { GitUsageError } from '@/features/wesh/commands/git/errors';
import type { WeshCommandContext, WeshCommandResult } from "@/features/wesh/types";
import { readEffectiveConfig } from "@/features/wesh/commands/git/config";
import { sortGitUtf8Strings } from "@/features/wesh/commands/git/utf8-order";
import { fetchLocalRemote } from "@/features/wesh/commands/git/local-transport";
import { discoverRepositoryFromContext } from "@/features/wesh/commands/git/repository";
import { defineArgvCatalog, parseStandardArgv, type StandardArgvAction, type StandardArgvPolicy } from '@/features/wesh/argv-v2';

const FETCH_ARGV_CATALOG = defineArgvCatalog<StandardArgvAction<never>>({
  nonExecutableLongOptions: [
    'verbose', 'no-verbose', 'no-quiet', 'no-all', 'set-upstream', 'no-set-upstream',
    'append', 'no-append', 'atomic', 'no-atomic', 'upload-pack', 'no-upload-pack',
    'force', 'no-force', 'multiple', 'no-multiple', 'tags', 'no-tags', 'jobs', 'no-jobs',
    'prefetch', 'no-prefetch', 'no-prune', 'prune-tags', 'no-prune-tags',
    'recurse-submodules', 'no-recurse-submodules', 'dry-run', 'no-dry-run',
    'porcelain', 'no-porcelain', 'write-fetch-head', 'no-write-fetch-head', 'keep', 'no-keep',
    'update-head-ok', 'no-update-head-ok', 'progress', 'no-progress', 'depth', 'no-depth',
    'shallow-since', 'no-shallow-since', 'shallow-exclude', 'no-shallow-exclude',
    'deepen', 'no-deepen', 'unshallow', 'refetch', 'update-shallow', 'no-update-shallow',
    'refmap', 'server-option', 'no-server-option', 'ipv4', 'ipv6',
    'negotiation-tip', 'no-negotiation-tip', 'negotiate-only', 'no-negotiate-only',
    'filter', 'no-filter', 'auto-maintenance', 'no-auto-maintenance', 'auto-gc', 'no-auto-gc',
    'show-forced-updates', 'no-show-forced-updates', 'write-commit-graph', 'no-write-commit-graph',
    'stdin', 'no-stdin',
  ],
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
  longNameMatch: 'unique-prefix',
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
    switch (diagnostic.kind) {
    case 'ambiguous_long_option':
      throw new GitUsageError({
        message: formatGitAmbiguousLongOption({
          option: diagnostic.option,
          candidateOptions: diagnostic.candidateOptions,
        }),
      });
    case 'unknown_short_option':
    case 'unknown_long_option':
    case 'missing_option_value':
    case 'unexpected_option_value':
    case 'invalid_option_value':
      throw new GitUsageError({ message: `unknown option: ${args[diagnostic.argvIndex] ?? diagnostic.option}` });
    default: {
      const _ex: never = diagnostic;
      throw new Error(`Unhandled argv diagnostic: ${JSON.stringify(_ex)}`);
    }
    }
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
