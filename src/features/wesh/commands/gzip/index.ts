import type { WeshCommandImplementation, WeshCommandResult, WeshCommandContext, WeshEntryRef } from '@/features/wesh/types';
import {
  defineArgvCatalog,
  defineArgvHelpPresentation,
  formatArgvOptionHelp,
  formatArgvUsageSummary,
  HELP_EARLY_EXIT_OPTIONS,
  parseStandardArgv,
  stopArgvAtFirstEarlyExit,
  type StandardArgvAction,
  type StandardArgvPolicy,
} from '@/features/wesh/argv';
import { openCommandInputStream } from '@/features/wesh/commands/_shared/binary-input';
import { basenamePath } from '@/features/wesh/commands/_shared/path';
import { getGzipSuffixDiagnostic } from '@/features/wesh/commands/_shared/gzip-suffix';
import { getPathErrorReason } from '@/features/wesh/commands/_shared/path-errors';
import { decompressGzipInputs } from './decompression';
import { writeCommandHelp, writeCommandUsageError } from '@/features/wesh/commands/_shared/usage-output';
import { resolvePath } from '@/features/wesh/path';
import { writeAllStreamToFile, writeAllStreamToHandle } from '@/features/wesh/utils/fs';
import { pipeThroughBufferSourceTransform } from '@/features/wesh/utils/stream';
import { addNamedGzipHeader } from './header';
import { pathExists as pathEntryExists, unlinkForcedOutputSymlink } from './filesystem';
import { executeGzipListCommand } from './list';

const gzipOptions = [
  {
    semantic: { kind: 'effects', effects: [{ key: 'stdout', value: true }] },
    forms: [
      { kind: 'short', name: 'c', value: { kind: 'none' } },
      { kind: 'long', name: 'stdout', value: { kind: 'none' } },
    ],
    help: { summary: 'write on standard output, keep original files unchanged', category: 'common' },
  },
  {
    semantic: { kind: 'effects', effects: [{ key: 'decompress', value: true }] },
    forms: [
      { kind: 'short', name: 'd', value: { kind: 'none' } },
      { kind: 'long', name: 'decompress', value: { kind: 'none' } },
    ],
    help: { summary: 'decompress', category: 'common' },
  },
  {
    semantic: { kind: 'effects', effects: [{ key: 'force', value: true }] },
    forms: [
      { kind: 'short', name: 'f', value: { kind: 'none' } },
      { kind: 'long', name: 'force', value: { kind: 'none' } },
    ],
    help: { summary: 'force overwrite of output files', category: 'common' },
  },
  {
    semantic: { kind: 'effects', effects: [{ key: 'keep', value: true }] },
    forms: [
      { kind: 'short', name: 'k', value: { kind: 'none' } },
      { kind: 'long', name: 'keep', value: { kind: 'none' } },
    ],
    help: { summary: 'keep input files unchanged', category: 'common' },
  },
  {
    semantic: { kind: 'effects', effects: [{ key: 'list', value: true }] },
    forms: [
      { kind: 'short', name: 'l', value: { kind: 'none' } },
      { kind: 'long', name: 'list', value: { kind: 'none' } },
    ],
    help: { summary: 'list compressed file contents', category: 'common' },
  },
  {
    semantic: { kind: 'effects', effects: [{ key: 'noName', value: true }] },
    forms: [
      { kind: 'short', name: 'n', value: { kind: 'none' } },
      { kind: 'long', name: 'no-name', value: { kind: 'none' } },
    ],
    help: { summary: 'do not save the original name and timestamp', category: 'common' },
  },
  {
    semantic: { kind: 'effects', effects: [{ key: 'quiet', value: true }] },
    forms: [
      { kind: 'short', name: 'q', value: { kind: 'none' } },
      { kind: 'long', name: 'quiet', value: { kind: 'none' } },
    ],
    help: { summary: 'suppress warning messages', category: 'common' },
  },
  {
    semantic: { kind: 'effects', effects: [{ key: 'recursive', value: true }] },
    forms: [
      { kind: 'short', name: 'r', value: { kind: 'none' } },
      { kind: 'long', name: 'recursive', value: { kind: 'none' } },
    ],
    help: { summary: 'operate recursively on directories', category: 'common' },
  },
  {
    semantic: { kind: 'required-value', key: 'suffix', parse: undefined },
    forms: [
      { kind: 'short', name: 'S', value: { kind: 'required-attached-or-following', missingValueName: 'SUF' } },
      { kind: 'long', name: 'suffix', value: { kind: 'required', missingValueName: 'SUF' } },
    ],
    help: { summary: 'use suffix SUF on compressed files', valueName: 'SUF' },
  },
  {
    semantic: { kind: 'effects', effects: [{ key: 'test', value: true }] },
    forms: [
      { kind: 'short', name: 't', value: { kind: 'none' } },
      { kind: 'long', name: 'test', value: { kind: 'none' } },
    ],
    help: { summary: 'test compressed file integrity', category: 'common' },
  },
  {
    semantic: { kind: 'effects', effects: [{ key: 'help', value: true }] },
    forms: [{ kind: 'long', name: 'help', value: { kind: 'none' } }],
    help: { summary: 'display this help and exit', category: 'common' },
  },
] as const;
const gzipArgvCatalog = defineArgvCatalog<StandardArgvAction<never>>({
  definitions: gzipOptions.map(({ semantic, forms }) => ({ semantic, forms })),
  nonExecutableLongOptions: [],
});
const gzipArgvHelp = defineArgvHelpPresentation({
  catalog: gzipArgvCatalog,
  rows: gzipOptions.map(({ forms, help }) => ({ forms, ...help })),
});
const gzipArgvPolicy: StandardArgvPolicy = {
  longNameMatch: 'exact',
  optionBoundary: 'continue',
  occurrenceRetention: 'none',
};

type GzipCompressionSettings = {
  readonly writeToStdout: boolean,
  readonly force: boolean,
  readonly noName: boolean,
  readonly keepInput: boolean,
  readonly suffix: string,
};

function mergeCompressionExitCode({
  current,
  next,
}: {
  current: number,
  next: number,
}): number {
  return Math.max(current, next);
}

async function compressGzipInput({
  context,
  input,
  fullPathOverride,
  settings,
}: {
  context: WeshCommandContext,
  input: string,
  fullPathOverride?: string,
  settings: GzipCompressionSettings,
}): Promise<number> {
  const text = context.text();
  const {
    writeToStdout,
    force,
    noName,
    keepInput,
    suffix,
  } = settings;

  try {
    const fullPath = input === '-'
      ? undefined
      : fullPathOverride ?? resolvePath({
        cwd: context.cwd,
        path: input,
      });
    const outputPath = fullPath === undefined ? undefined : `${fullPath}${suffix}`;
    if (fullPath !== undefined) {
      const inputStat = await context.files.lstat({ path: fullPath });
      const effectiveInputType = await (async () => {
        switch (inputStat.type) {
        case 'symlink': {
          if (!writeToStdout && !force) {
            throw new Error('Too many levels of symbolic links');
          }
          return (await context.files.stat({ path: fullPath })).type;
        }
        case 'directory':
        case 'file':
        case 'fifo':
        case 'chardev':
          return inputStat.type;
        default: {
          const _exhaustiveCheck: never = inputStat.type;
          throw new Error(`Unhandled file type: ${String(_exhaustiveCheck)}`);
        }
        }
      })();
      switch (effectiveInputType) {
      case 'directory':
        await text.error({ text: `gzip: ${input} is a directory -- ignored\n` });
        return 2;
      case 'file':
      case 'fifo':
      case 'chardev':
        break;
      case 'symlink':
        throw new Error('Unexpected unresolved symbolic link');
      default: {
        const _exhaustiveCheck: never = effectiveInputType;
        throw new Error(`Unhandled file type: ${String(_exhaustiveCheck)}`);
      }
      }
    }

    if (
      !writeToStdout
      && outputPath !== undefined
      && await pathEntryExists({ context, path: outputPath })
      && !force
    ) {
      await text.error({ text: `gzip: ${input}${suffix} already exists; not overwritten\n` });
      return 2;
    }

    let compressedStream = pipeThroughBufferSourceTransform({
      source: await openCommandInputStream({
        context,
        input: fullPath ?? input,
      }),
      transform: new CompressionStream('gzip'),
    });
    if (fullPath !== undefined && !noName) {
      const stat = await context.files.stat({ path: fullPath });
      compressedStream = addNamedGzipHeader({
        stream: compressedStream,
        fileName: basenamePath({ path: input, suffix: undefined }),
        mtime: stat.mtime,
      });
    }

    if (writeToStdout || input === '-') {
      await writeAllStreamToHandle({
        stream: compressedStream,
        handle: context.stdout,
        closeHandle: false,
      });
      return 0;
    }

    if (fullPath === undefined || outputPath === undefined) {
      throw new Error('named gzip input unexpectedly lacked an output path');
    }
    if (force) {
      await unlinkForcedOutputSymlink({ context, path: outputPath });
    }
    await writeAllStreamToFile({
      files: context.files,
      path: outputPath,
      stream: compressedStream,
      mode: 'truncate',
    });
    if (!keepInput) {
      await context.files.unlink({ path: fullPath });
    }
    return 0;
  } catch (error: unknown) {
    const message = getPathErrorReason({ error })
      ?? (error instanceof Error ? error.message : String(error));
    await text.error({ text: `gzip: ${input}: ${message}\n` });
    return 1;
  }
}

function joinRecursiveDisplayPath({
  parent,
  childName,
}: {
  parent: string,
  childName: string,
}): string {
  if (parent === '/') {
    return `/${childName}`;
  }
  return `${parent.replace(/\/+$/, '')}/${childName}`;
}

async function compressGzipRecursiveEntry({
  context,
  entry,
  displayPath,
  settings,
}: {
  context: WeshCommandContext,
  entry: WeshEntryRef,
  displayPath: string,
  settings: GzipCompressionSettings,
}): Promise<number> {
  const text = context.text();
  switch (entry.type) {
  case 'file':
    return compressGzipInput({
      context,
      input: displayPath,
      fullPathOverride: entry.fullPath,
      settings,
    });
  case 'symlink':
    await text.error({ text: `gzip: ${displayPath}: Too many levels of symbolic links\n` });
    return 1;
  case 'fifo':
  case 'chardev':
    await text.error({ text: `gzip: ${displayPath} is not a directory or a regular file - ignored\n` });
    return 2;
  case 'directory': {
    let children: WeshEntryRef[];
    try {
      children = [];
      for await (const child of context.files.readDirEntry({ entry })) {
        children.push(child);
      }
    } catch (error: unknown) {
      const message = getPathErrorReason({ error })
        ?? (error instanceof Error ? error.message : String(error));
      await text.error({ text: `gzip: ${displayPath}: ${message}\n` });
      return 1;
    }

    let exitCode = 0;
    for (const child of children) {
      const childExitCode = await compressGzipRecursiveEntry({
        context,
        entry: child,
        displayPath: joinRecursiveDisplayPath({
          parent: displayPath,
          childName: child.name,
        }),
        settings,
      });
      exitCode = mergeCompressionExitCode({
        current: exitCode,
        next: childExitCode,
      });
    }
    return exitCode;
  }
  default: {
    const _exhaustiveCheck: never = entry;
    throw new Error(`Unhandled entry type: ${String(((_exhaustiveCheck satisfies never) as { readonly type: string }).type)}`);
  }
  }
}

async function compressGzipRecursiveOperand({
  context,
  input,
  settings,
}: {
  context: WeshCommandContext,
  input: string,
  settings: GzipCompressionSettings,
}): Promise<number> {
  if (input === '-') {
    return compressGzipInput({ context, input, settings });
  }

  const text = context.text();
  try {
    const fullPath = resolvePath({ cwd: context.cwd, path: input });
    const entry = await context.files.resolveEntry({
      path: fullPath,
      finalSymlinkTreatment: 'no-follow',
    });
    return compressGzipRecursiveEntry({
      context,
      entry,
      displayPath: input,
      settings,
    });
  } catch (error: unknown) {
    const message = getPathErrorReason({ error })
      ?? (error instanceof Error ? error.message : String(error));
    await text.error({ text: `gzip: ${input}: ${message}\n` });
    return 1;
  }
}

export const gzipCommandImplementation: WeshCommandImplementation = {
  fn: async ({ context }: { context: WeshCommandContext }): Promise<WeshCommandResult> => {
    const parsed = parseStandardArgv({
      args: stopArgvAtFirstEarlyExit({
        args: context.args,
        catalog: gzipArgvCatalog,
        policy: gzipArgvPolicy,
        earlyExitOptions: HELP_EARLY_EXIT_OPTIONS,
      }),
      catalog: gzipArgvCatalog,
      policy: gzipArgvPolicy,
    });

    const text = context.text();
    const diagnostic = parsed.diagnostics[0];
    if (diagnostic !== undefined) {
      await writeCommandUsageError({
        context,
        command: 'gzip',
        message: `gzip: ${diagnostic.message}`,
        usageSummary: formatArgvUsageSummary({ presentation: gzipArgvHelp }),
      });
      return { exitCode: 1 };
    }

    if (parsed.optionValues.help === true) {
      await writeCommandHelp({
        context,
        command: 'gzip',
        optionLines: formatArgvOptionHelp({ presentation: gzipArgvHelp }),
      });
      return { exitCode: 0 };
    }

    const writeToStdout = parsed.optionValues.stdout === true;
    const force = parsed.optionValues.force === true;
    const noName = parsed.optionValues.noName === true;
    const keepInput = parsed.optionValues.keep === true || writeToStdout;
    const quiet = parsed.optionValues.quiet === true;
    const recursive = parsed.optionValues.recursive === true;
    const suffix = typeof parsed.optionValues.suffix === 'string' ? parsed.optionValues.suffix : '.gz';
    const suffixDiagnostic = getGzipSuffixDiagnostic({ suffix });
    if (suffixDiagnostic !== undefined) {
      await text.error({ text: suffixDiagnostic });
      return { exitCode: 1 };
    }
    const testOnly = parsed.optionValues.test === true;
    const inputs = parsed.positionals.length > 0 ? parsed.positionals : ['-'];
    if (parsed.optionValues.list === true) {
      return executeGzipListCommand({
        context,
        inputs,
        quiet,
        suffix,
      });
    }
    if (parsed.optionValues.decompress === true || testOnly) {
      if (recursive) {
        await writeCommandUsageError({
          context,
          command: 'gzip',
          message: 'gzip: recursive decompression is not supported',
          usageSummary: formatArgvUsageSummary({ presentation: gzipArgvHelp }),
        });
        return { exitCode: 1 };
      }
      return decompressGzipInputs({
        context,
        inputs,
        writeToStdout,
        force,
        quiet,
        testOnly,
        keepInput: keepInput || testOnly,
        suffix,
      });
    }

    const settings: GzipCompressionSettings = {
      writeToStdout,
      force,
      noName,
      keepInput,
      suffix,
    };
    let exitCode = 0;

    for (const input of inputs) {
      const inputExitCode = recursive
        ? await compressGzipRecursiveOperand({ context, input, settings })
        : await compressGzipInput({ context, input, settings });
      exitCode = mergeCompressionExitCode({
        current: exitCode,
        next: inputExitCode,
      });
    }

    return { exitCode };
  },
};

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
