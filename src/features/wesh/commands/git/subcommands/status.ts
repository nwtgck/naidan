import { GitUsageError } from '@/features/wesh/commands/git/errors';
import { formatGitAmbiguousLongOption } from '@/features/wesh/commands/git/argv-diagnostics';
import type { WeshCommandContext, WeshCommandResult } from "@/features/wesh/types";
import { collectStatus, type GitStatus, type GitStatusEntry } from "@/features/wesh/commands/git/status";
import { formatPorcelainV1Branch, printLongStatus, renderPorcelainV1, renderPorcelainV2, renderShortStatus } from "@/features/wesh/commands/git/status-output";
import { assertSupportedRepositoryContentPolicy } from "@/features/wesh/commands/git/content-policy";
import { matchRepositoryPaths } from "@/features/wesh/commands/git/pathspec";
import { defineArgvCatalog, parseStandardArgv, type StandardArgvAction, type StandardArgvPolicy } from '@/features/wesh/argv-v2';

type StatusDeferredSemantic = 'short' | 'porcelain' | 'branch' | 'nul';

const STATUS_ARGV_CATALOG = defineArgvCatalog<StandardArgvAction<StatusDeferredSemantic>>({
  nonExecutableLongOptions: [
    'verbose',
    'no-verbose',
    'no-short',
    'no-branch',
    'show-stash',
    'no-show-stash',
    'ahead-behind',
    'no-ahead-behind',
    'no-porcelain',
    'long',
    'no-long',
    'null',
    'no-null',
    'untracked-files',
    'no-untracked-files',
    'ignored',
    'no-ignored',
    'ignore-submodules',
    'no-ignore-submodules',
    'column',
    'no-column',
    'no-renames',
    'renames',
    'find-renames',
  ],
  definitions: [
    {
      semantic: { kind: 'deferred', tag: 'short' },
      forms: [
        { kind: 'short', name: 's', value: { kind: 'none' } },
        { kind: 'long', name: 'short', value: { kind: 'none' } },
      ],
    },
    {
      semantic: { kind: 'deferred', tag: 'porcelain' },
      forms: [{ kind: 'long', name: 'porcelain', value: { kind: 'optional-inline' } }],
    },
    {
      semantic: { kind: 'deferred', tag: 'branch' },
      forms: [
        { kind: 'short', name: 'b', value: { kind: 'none' } },
        { kind: 'long', name: 'branch', value: { kind: 'none' } },
      ],
    },
    {
      semantic: { kind: 'deferred', tag: 'nul' },
      forms: [{ kind: 'short', name: 'z', value: { kind: 'none' } }],
    },
  ],
});

const STATUS_ARGV_POLICY: StandardArgvPolicy = {
  longNameMatch: 'unique-prefix',
  optionBoundary: 'continue',
  occurrenceRetention: 'none',
};

function statusWithPathspec({ context, status, operands }: {
  context: WeshCommandContext,
  status: GitStatus,
  operands: readonly string[],
}): GitStatus {
  if (operands.length === 0) return status;
  const matches = matchRepositoryPaths({
    repository: status.repository,
    cwd: context.cwd,
    operands,
    availablePaths: status.entries.map(entry => entry.path),
  });
  const selected = new Set([...matches.values()].flat());
  const entries: GitStatusEntry[] = [];
  for (const entry of status.entries) {
    if (!selected.has(entry.path)) continue;
    if (entry.renameSourcePath === undefined || selected.has(entry.renameSourcePath)) {
      entries.push(entry);
      continue;
    }
    entries.push({
      ...entry,
      headObjectId: undefined,
      headMode: undefined,
      renameSourcePath: undefined,
    });
  }
  return { ...status, entries };
}


export async function runStatus({ context, args }: {
    context: WeshCommandContext;
    args: readonly string[];
}): Promise<WeshCommandResult> {
  await assertSupportedRepositoryContentPolicy({ context });
  const parsed = parseStandardArgv({ args, catalog: STATUS_ARGV_CATALOG, policy: STATUS_ARGV_POLICY });
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
      throw new Error(`Unhandled status argv diagnostic: ${JSON.stringify(_ex)}`);
    }
    }
  }
  let format: 'long' | 'short' | 'porcelain-v1' | 'porcelain-v2' = 'long';
  let branch = false;
  let nul = false;
  for (const occurrence of parsed.deferred) {
    switch (occurrence.semantic.tag) {
    case 'short':
      format = 'short';
      break;
    case 'porcelain':
      switch (occurrence.value.kind) {
      case 'none':
        format = 'porcelain-v1';
        break;
      case 'inline':
        switch (occurrence.value.rawValue) {
        case 'v1':
          format = 'porcelain-v1';
          break;
        case 'v2':
          format = 'porcelain-v2';
          break;
        default:
          throw new GitUsageError({ message: `unknown option: ${args[occurrence.argvIndex]}` });
        }
        break;
      case 'next-argv':
        throw new Error('Status --porcelain unexpectedly claimed a following value');
      default: {
        const _ex: never = occurrence.value;
        throw new Error(`Unhandled status porcelain value: ${JSON.stringify(_ex)}`);
      }
      }
      break;
    case 'branch':
      branch = true;
      break;
    case 'nul':
      nul = true;
      break;
    default: {
      const _ex: never = occurrence.semantic.tag;
      throw new Error(`Unhandled status deferred semantic: ${_ex}`);
    }
    }
  }
  if (nul && format === 'long')
    format = 'porcelain-v1';
  const status = statusWithPathspec({
    context,
    status: await collectStatus({ context }),
    operands: parsed.positionals,
  });
  const text = context.text();
  const separator = nul ? '\0' : '\n';
  switch (format) {
  case 'short':
  case 'porcelain-v1':
    if (branch)
      await text.print({ text: `## ${formatPorcelainV1Branch({ status })}${separator}` });
    await text.print({ text: format === 'short' && !nul
      ? renderShortStatus({ context, repository: status.repository, entries: status.entries, quoteNonAscii: status.quoteNonAscii })
      : renderPorcelainV1({ entries: status.entries, nul, quoteNonAscii: status.quoteNonAscii }) });
    return { exitCode: 0 };
  case 'porcelain-v2':
    if (branch) {
      await text.print({ text: `# branch.oid ${status.headObjectId ?? '(initial)'}${separator}` });
      await text.print({ text: `# branch.head ${status.branchName ?? '(detached)'}${separator}` });
      if (status.upstreamName !== undefined) {
        await text.print({ text: `# branch.upstream ${status.upstreamName}${separator}` });
      }
      if (status.ahead !== undefined && status.behind !== undefined) {
        await text.print({ text: `# branch.ab +${status.ahead} -${status.behind}${separator}` });
      }
    }
    await text.print({ text: renderPorcelainV2({ context, repository: status.repository, entries: status.entries, nul, quoteNonAscii: status.quoteNonAscii }) });
    return { exitCode: 0 };
  case 'long':
    break;
  default: {
    const _ex: never = format;
    throw new Error(`Unhandled status format: ${_ex}`);
  }
  }
  await printLongStatus({ context, status });
  return { exitCode: 0 };
}

export const TEST_ONLY = {
};
