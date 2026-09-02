import { formatGitAmbiguousLongOption } from '@/features/wesh/commands/git/argv-diagnostics';
import { GitUsageError } from '@/features/wesh/commands/git/errors';
import type { WeshCommandContext, WeshCommandResult } from '@/features/wesh/types';
import { readEffectiveConfig } from '@/features/wesh/commands/git/config';
import { readIndex, readIndexRaw } from '@/features/wesh/commands/git/index-file';
import { matchRepositoryPaths } from '@/features/wesh/commands/git/pathspec';
import { quoteGitPath, quoteNonAsciiFromConfig } from '@/features/wesh/commands/git/path-output';
import { relativeToWorktree, discoverRepositoryFromContext } from '@/features/wesh/commands/git/repository';
import { writeHandleBytes } from '@/features/wesh/commands/git/files';
import { defineArgvCatalog, parseStandardArgv, type StandardArgvAction, type StandardArgvPolicy } from '@/features/wesh/argv-v2';

const LS_FILES_ARGV_CATALOG = defineArgvCatalog<StandardArgvAction<never>>({
  nonExecutableLongOptions: [
    'no-cached', 'deleted', 'no-deleted', 'modified', 'no-modified', 'others', 'no-others',
    'ignored', 'no-ignored', 'no-stage', 'killed', 'no-killed', 'directory', 'no-directory',
    'eol', 'no-eol', 'empty-directory', 'no-empty-directory', 'unmerged', 'no-unmerged',
    'resolve-undo', 'no-resolve-undo', 'exclude', 'exclude-from',
    'exclude-per-directory', 'no-exclude-per-directory', 'exclude-standard',
    'recurse-submodules', 'no-recurse-submodules', 'error-unmatch', 'no-error-unmatch',
    'with-tree', 'no-with-tree', 'abbrev', 'no-abbrev', 'debug', 'no-debug',
    'deduplicate', 'no-deduplicate', 'sparse', 'no-sparse', 'format',
  ],
  definitions: [
    {
      semantic: { kind: 'effects', effects: [{ key: 'stage', value: true }] },
      forms: [
        { kind: 'short', name: 's', value: { kind: 'none' } },
        { kind: 'long', name: 'stage', value: { kind: 'none' } },
      ],
    },
    {
      semantic: { kind: 'effects', effects: [{ key: 'cached', value: true }] },
      forms: [
        { kind: 'short', name: 'c', value: { kind: 'none' } },
        { kind: 'long', name: 'cached', value: { kind: 'none' } },
      ],
    },
    {
      semantic: { kind: 'effects', effects: [{ key: 'nul', value: true }] },
      forms: [{ kind: 'short', name: 'z', value: { kind: 'none' } }],
    },
    {
      semantic: { kind: 'effects', effects: [{ key: 'fullName', value: true }] },
      forms: [{ kind: 'long', name: 'full-name', value: { kind: 'none' } }],
    },
  ],
});

const LS_FILES_ARGV_POLICY: StandardArgvPolicy = {
  longNameMatch: 'unique-prefix',
  optionBoundary: 'continue',
  occurrenceRetention: 'none',
};

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
  const parsed = parseStandardArgv({ args, catalog: LS_FILES_ARGV_CATALOG, policy: LS_FILES_ARGV_POLICY });
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
  const stage = parsed.optionValues.stage === true;
  const nul = parsed.optionValues.nul === true;
  const fullName = parsed.optionValues.fullName === true;
  const operands = parsed.positionals;


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
