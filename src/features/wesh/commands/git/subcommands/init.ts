import { normalizePath } from "@/features/wesh/path";
import type { WeshCommandContext, WeshCommandResult } from "@/features/wesh/types";
import { initializeBareRepository, initializeRepository, joinPath } from "@/features/wesh/commands/git/repository";
import { defineArgvCatalog, parseStandardArgv, type StandardArgvAction, type StandardArgvPolicy } from '@/features/wesh/argv-v2';
import { parseConfig, readGlobalConfigEntries } from "@/features/wesh/commands/git/config";
import { pathExists, readFileText } from "@/features/wesh/commands/git/files";
import { GitUsageError } from "@/features/wesh/commands/git/errors";
import { formatGitAmbiguousLongOption } from '@/features/wesh/commands/git/argv-diagnostics';
const INIT_ARGV_CATALOG = defineArgvCatalog<StandardArgvAction<never>>({
  nonExecutableLongOptions: [
    'template',
    'no-template',
    'no-bare',
    'shared',
    'no-quiet',
    'separate-git-dir',
    'no-separate-git-dir',
    'initial-branch',
    'no-initial-branch',
    'object-format',
    'no-object-format',
    'ref-format',
    'no-ref-format',
  ],
  definitions: [
    {
      semantic: { kind: 'effects', effects: [{ key: 'quiet', value: true }] },
      forms: [
        { kind: 'short', name: 'q', value: { kind: 'none' } },
        { kind: 'long', name: 'quiet', value: { kind: 'none' } },
      ],
    },
    {
      semantic: { kind: 'effects', effects: [{ key: 'bare', value: true }] },
      forms: [{ kind: 'long', name: 'bare', value: { kind: 'none' } }],
    },
  ],
});

const INIT_ARGV_POLICY: StandardArgvPolicy = {
  longNameMatch: 'unique-prefix',
  optionBoundary: 'continue',
  occurrenceRetention: 'none',
};


async function preflightTargetConfig({ context, targetPath, bare }: {
  context: WeshCommandContext,
  targetPath: string,
  bare: boolean,
}): Promise<void> {
  const configPath = joinPath({
    base: targetPath,
    child: bare ? 'config' : '.git/config',
  });
  if (!await pathExists({ files: context.files, path: configPath })) return;
  parseConfig({ text: await readFileText({ files: context.files, path: configPath }) });
}

export async function runInit({ context, args }: {
  context: WeshCommandContext,
  args: readonly string[],
}): Promise<WeshCommandResult> {
  await readGlobalConfigEntries({
    files: context.files,
    homePath: context.env.get('HOME') ?? '/',
    cwd: context.cwd,
    env: context.env,
  });
  const parsed = parseStandardArgv({ args, catalog: INIT_ARGV_CATALOG, policy: INIT_ARGV_POLICY });
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
      throw new Error(`Unhandled init argv diagnostic: ${JSON.stringify(_ex)}`);
    }
    }
  }
  const quiet = parsed.optionValues.quiet === true;
  const bare = parsed.optionValues.bare === true;
  const operands = parsed.positionals;
  if (operands.length > 1) throw new GitUsageError({ message: 'usage: git init [-q | --quiet] [--bare] [<directory>]', prefix: 'none' });
  const targetPath = normalizePath({ cwd: context.cwd, path: operands[0] ?? '.' });
  await preflightTargetConfig({ context, targetPath, bare });
  const { repository, reinitialized } = bare
    ? await initializeBareRepository({ files: context.files, targetPath })
    : await initializeRepository({ files: context.files, targetPath });
  if (!quiet) {
    await context.text().print({
      text: `${reinitialized ? 'Reinitialized existing' : 'Initialized empty'} Git repository in ${repository.gitDirPath}/\n`,
    });
  }
  return { exitCode: 0 };
}

export const TEST_ONLY = {
};
