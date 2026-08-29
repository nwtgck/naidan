import { GitUsageError } from '@/features/wesh/commands/git/errors';
import type { WeshCommandContext, WeshCommandResult } from '@/features/wesh/types';
import { readEffectiveConfig } from '@/features/wesh/commands/git/config';
import { readIndex, readIndexRaw } from '@/features/wesh/commands/git/index-file';
import { matchRepositoryPaths } from '@/features/wesh/commands/git/pathspec';
import { quoteGitPath, quoteNonAsciiFromConfig } from '@/features/wesh/commands/git/path-output';
import { relativeToWorktree, discoverRepositoryFromContext } from '@/features/wesh/commands/git/repository';
import { writeHandleBytes } from '@/features/wesh/commands/git/files';
import { expandGitShortOptions } from '@/features/wesh/commands/git/short-options';

const textEncoder = new TextEncoder();

function startsWithBytes({ bytes, prefix }: { bytes: Uint8Array, prefix: Uint8Array }): boolean {
  if (prefix.byteLength > bytes.byteLength) return false;
  for (let index = 0; index < prefix.byteLength; index += 1) {
    if (bytes[index] !== prefix[index]) return false;
  }
  return true;
}

export async function runLsFiles({ context, args }: {
  context: WeshCommandContext,
  args: readonly string[],
}): Promise<WeshCommandResult> {
  let stage = false;
  let nul = false;
  let fullName = false;
  let parsingOptions = true;
  const operands: string[] = [];
  const normalizedArgs = expandGitShortOptions({ args, flagOptions: ['s', 'c', 'z'], valueOptions: [] });
  for (const arg of normalizedArgs) {
    if (parsingOptions && arg === '--') {
      parsingOptions = false;
      continue;
    }
    if (parsingOptions && (arg === '-s' || arg === '--stage')) {
      stage = true;
      continue;
    }
    if (parsingOptions && (arg === '-c' || arg === '--cached')) continue;
    if (parsingOptions && arg === '--full-name') {
      fullName = true;
      continue;
    }
    if (parsingOptions && arg === '-z') {
      nul = true;
      continue;
    }
    if (parsingOptions && arg.startsWith('-')) throw new GitUsageError({ message: `unknown option: ${arg}` });
    operands.push(arg);
  }

  const repository = await discoverRepositoryFromContext({ context });
  const cwdRelative = relativeToWorktree({ repository, absolutePath: context.cwd });
  if (nul && operands.length === 0) {
    let entries = await readIndexRaw({ files: context.files, repository });
    const cwdPrefix = cwdRelative.length === 0 ? new Uint8Array() : textEncoder.encode(`${cwdRelative}/`);
    if (cwdPrefix.byteLength > 0) {
      entries = entries.filter(entry => startsWithBytes({ bytes: entry.pathBytes, prefix: cwdPrefix }));
    }
    for (const entry of entries) {
      if (stage) {
        await writeHandleBytes({
          handle: context.stdout,
          bytes: textEncoder.encode(`${entry.mode.toString(8)} ${entry.objectId} ${entry.stage}\t`),
        });
      }
      const pathBytes = fullName || cwdPrefix.byteLength === 0
        ? entry.pathBytes
        : entry.pathBytes.subarray(cwdPrefix.byteLength);
      await writeHandleBytes({ handle: context.stdout, bytes: pathBytes });
      await writeHandleBytes({ handle: context.stdout, bytes: Uint8Array.of(0) });
    }
    return { exitCode: 0 };
  }

  const config = await readEffectiveConfig({ files: context.files, repository, homePath: context.env.get('HOME') ?? '/', cwd: context.cwd, env: context.env });
  const quoteNonAscii = quoteNonAsciiFromConfig({ config });
  let entries = await readIndex({ files: context.files, repository });
  if (operands.length > 0) {
    const matches = matchRepositoryPaths({
      repository,
      cwd: context.cwd,
      operands,
      availablePaths: entries.map(entry => entry.path),
    });
    const selected = new Set([...matches.values()].flat());
    entries = entries.filter(entry => selected.has(entry.path));
  } else if (cwdRelative.length > 0) {
    entries = entries.filter(entry => entry.path.startsWith(`${cwdRelative}/`));
  }
  const displayPath = ({ path }: { path: string }): string => {
    if (fullName || cwdRelative.length === 0) return path;
    const cwdSegments = cwdRelative.split('/');
    const pathSegments = path.split('/');
    let shared = 0;
    while (shared < cwdSegments.length && shared < pathSegments.length && cwdSegments[shared] === pathSegments[shared]) {
      shared += 1;
    }
    return [...cwdSegments.slice(shared).map(() => '..'), ...pathSegments.slice(shared)].join('/');
  };
  const separator = nul ? '\0' : '\n';
  for (const entry of entries) {
    const prefix = stage ? `${entry.mode.toString(8)} ${entry.objectId} ${entry.stage}\t` : '';
    const path = displayPath({ path: entry.path });
    const outputPath = nul ? path : quoteGitPath({ path, quoteNonAscii, quoteSpaces: false });
    await context.text().print({ text: `${prefix}${outputPath}${separator}` });
  }
  return { exitCode: 0 };
}

export const TEST_ONLY = {
};
