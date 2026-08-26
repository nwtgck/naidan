import type { WeshCommandContext, WeshCommandResult } from "@/features/wesh/types";
import { collectStatus } from "@/features/wesh/commands/git/status";
import { formatPorcelainV1Branch, printLongStatus, renderPorcelainV1, renderPorcelainV2, renderShortStatus } from "@/features/wesh/commands/git/status-output";
import { assertSupportedRepositoryContentPolicy } from "@/features/wesh/commands/git/content-policy";
import { expandGitShortOptions } from "@/features/wesh/commands/git/short-options";

export async function runStatus({ context, args }: {
    context: WeshCommandContext;
    args: readonly string[];
}): Promise<WeshCommandResult> {
  await assertSupportedRepositoryContentPolicy({ context });
  let format: 'long' | 'short' | 'porcelain-v1' | 'porcelain-v2' = 'long';
  let branch = false;
  let nul = false;
  const normalizedArgs = expandGitShortOptions({ args, flagOptions: ['s', 'b', 'z'], valueOptions: [] });
  const separatorIndex = normalizedArgs.indexOf('--');
  const optionArgs = separatorIndex < 0 ? normalizedArgs : normalizedArgs.slice(0, separatorIndex);
  if (separatorIndex >= 0 && separatorIndex !== normalizedArgs.length - 1)
    throw new Error('status pathspecs are not supported yet');
  for (const arg of optionArgs) {
    switch (arg) {
    case '-s':
    case '--short':
      format = 'short';
      break;
    case '--porcelain':
    case '--porcelain=v1':
      format = 'porcelain-v1';
      break;
    case '--porcelain=v2':
      format = 'porcelain-v2';
      break;
    case '-b':
    case '--branch':
      branch = true;
      break;
    case '-z':
      nul = true;
      break;
    default:
      throw new Error(`unknown option: ${arg}`);
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
