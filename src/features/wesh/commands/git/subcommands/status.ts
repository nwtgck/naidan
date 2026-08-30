import { GitUsageError } from '@/features/wesh/commands/git/errors';
import type { WeshCommandContext, WeshCommandResult } from "@/features/wesh/types";
import { collectStatus } from "@/features/wesh/commands/git/status";
import { formatPorcelainV1Branch, printLongStatus, renderPorcelainV1, renderPorcelainV2, renderShortStatus } from "@/features/wesh/commands/git/status-output";
import { assertSupportedRepositoryContentPolicy } from "@/features/wesh/commands/git/content-policy";
import { defineArgvCatalog, parseStandardArgv, type StandardArgvAction, type StandardArgvPolicy } from '@/features/wesh/argv-v2';

type StatusDeferredSemantic = 'short' | 'porcelain' | 'branch' | 'nul';

const STATUS_ARGV_CATALOG = defineArgvCatalog<StandardArgvAction<StatusDeferredSemantic>>({
  nonExecutableLongOptions: [],
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
  longNameMatch: 'exact',
  optionBoundary: 'first-positional',
  occurrenceRetention: 'none',
};


export async function runStatus({ context, args }: {
    context: WeshCommandContext;
    args: readonly string[];
}): Promise<WeshCommandResult> {
  await assertSupportedRepositoryContentPolicy({ context });
  const separatorIndex = args.indexOf('--');
  if (separatorIndex >= 0 && separatorIndex !== args.length - 1)
    throw new Error('status pathspecs are not supported yet');
  const parsedArgs = separatorIndex < 0 ? args : args.slice(0, separatorIndex);
  const parsed = parseStandardArgv({ args: parsedArgs, catalog: STATUS_ARGV_CATALOG, policy: STATUS_ARGV_POLICY });
  const diagnostic = parsed.diagnostics[0];
  if (diagnostic !== undefined) {
    throw new GitUsageError({ message: `unknown option: ${parsedArgs[diagnostic.argvIndex] ?? diagnostic.option}` });
  }
  if (parsed.positionals.length > 0)
    throw new GitUsageError({ message: `unknown option: ${parsed.positionals[0]}` });

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
          throw new GitUsageError({ message: `unknown option: ${parsedArgs[occurrence.argvIndex]}` });
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
  const status = await collectStatus({ context });
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
