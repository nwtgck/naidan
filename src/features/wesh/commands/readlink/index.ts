import { defineArgvCatalog, defineArgvHelpPresentation, parseStandardArgv, type ArgvOptionDefinition, type StandardArgvAction, type StandardArgvPolicy, HELP_EARLY_EXIT_OPTIONS, stopArgvAtFirstEarlyExit, formatArgvOptionHelp, formatArgvUsageSummary } from '@/features/wesh/argv-v2';
import type { WeshCommandContext, WeshCommandImplementation, WeshCommandResult } from '@/features/wesh/types';
import { writeCommandHelp, writeCommandUsageError } from '@/features/wesh/commands/_shared/usage-output';
import {
  canonicalizeExistingPath,
  canonicalizePathAllowingMissingComponents,
  canonicalizePathAllowingMissingLeaf,
  resolvePath,
} from '@/features/wesh/path';

type ReadlinkMode = 'link' | 'canonicalize' | 'existing' | 'missing';

const readlinkCanonicalizeOption = {
  semantic: { kind: 'effects', effects: [{ key: 'mode', value: 'canonicalize' }] },
  forms: [
    { kind: 'short', name: 'f', value: { kind: 'none' } },
    { kind: 'long', name: 'canonicalize', value: { kind: 'none' } },
  ],
} as const satisfies ArgvOptionDefinition<StandardArgvAction<never>>;
const readlinkExistingOption = {
  semantic: { kind: 'effects', effects: [{ key: 'mode', value: 'existing' }] },
  forms: [
    { kind: 'short', name: 'e', value: { kind: 'none' } },
    { kind: 'long', name: 'canonicalize-existing', value: { kind: 'none' } },
  ],
} as const satisfies ArgvOptionDefinition<StandardArgvAction<never>>;
const readlinkMissingOption = {
  semantic: { kind: 'effects', effects: [{ key: 'mode', value: 'missing' }] },
  forms: [
    { kind: 'short', name: 'm', value: { kind: 'none' } },
    { kind: 'long', name: 'canonicalize-missing', value: { kind: 'none' } },
  ],
} as const satisfies ArgvOptionDefinition<StandardArgvAction<never>>;
const readlinkQuietOption = {
  semantic: { kind: 'effects', effects: [{ key: 'diagnosticMode', value: 'quiet' }] },
  forms: [
    { kind: 'short', name: 'q', value: { kind: 'none' } },
    { kind: 'long', name: 'quiet', value: { kind: 'none' } },
  ],
} as const satisfies ArgvOptionDefinition<StandardArgvAction<never>>;
const readlinkSilentOption = {
  semantic: { kind: 'effects', effects: [{ key: 'diagnosticMode', value: 'quiet' }] },
  forms: [
    { kind: 'short', name: 's', value: { kind: 'none' } },
    { kind: 'long', name: 'silent', value: { kind: 'none' } },
  ],
} as const satisfies ArgvOptionDefinition<StandardArgvAction<never>>;
const readlinkVerboseOption = {
  semantic: { kind: 'effects', effects: [{ key: 'diagnosticMode', value: 'verbose' }] },
  forms: [
    { kind: 'short', name: 'v', value: { kind: 'none' } },
    { kind: 'long', name: 'verbose', value: { kind: 'none' } },
  ],
} as const satisfies ArgvOptionDefinition<StandardArgvAction<never>>;
const readlinkNoNewlineOption = {
  semantic: { kind: 'effects', effects: [{ key: 'noNewline', value: true }] },
  forms: [
    { kind: 'short', name: 'n', value: { kind: 'none' } },
    { kind: 'long', name: 'no-newline', value: { kind: 'none' } },
  ],
} as const satisfies ArgvOptionDefinition<StandardArgvAction<never>>;
const readlinkZeroOption = {
  semantic: { kind: 'effects', effects: [{ key: 'zero', value: true }] },
  forms: [
    { kind: 'short', name: 'z', value: { kind: 'none' } },
    { kind: 'long', name: 'zero', value: { kind: 'none' } },
  ],
} as const satisfies ArgvOptionDefinition<StandardArgvAction<never>>;
const readlinkHelpOption = {
  semantic: { kind: 'effects', effects: [{ key: 'help', value: true }] },
  forms: [{ kind: 'long', name: 'help', value: { kind: 'none' } }],
} as const satisfies ArgvOptionDefinition<StandardArgvAction<never>>;

const readlinkArgvCatalog = defineArgvCatalog<StandardArgvAction<never>>({
  nonExecutableLongOptions: ['version'],
  definitions: [
    readlinkCanonicalizeOption, readlinkExistingOption, readlinkMissingOption,
    readlinkQuietOption, readlinkSilentOption, readlinkVerboseOption,
    readlinkNoNewlineOption, readlinkZeroOption, readlinkHelpOption,
  ],
});
const readlinkArgvHelp = defineArgvHelpPresentation({
  catalog: readlinkArgvCatalog,
  rows: [
    { forms: readlinkCanonicalizeOption.forms, summary: 'canonicalize the path and resolve symlinks' },
    { forms: readlinkExistingOption.forms, summary: 'canonicalize the path, requiring every component to exist' },
    { forms: readlinkMissingOption.forms, summary: 'canonicalize the path, without requiring components to exist' },
    { forms: readlinkQuietOption.forms, summary: 'suppress most error messages' },
    { forms: readlinkSilentOption.forms, summary: 'suppress most error messages' },
    { forms: readlinkVerboseOption.forms, summary: 'report error messages' },
    { forms: readlinkNoNewlineOption.forms, summary: 'do not print the trailing delimiter for one operand' },
    { forms: readlinkZeroOption.forms, summary: 'end each output line with NUL, not newline' },
    { forms: readlinkHelpOption.forms, summary: 'display this help and exit', category: 'common' },
  ],
});
const readlinkArgvPolicy: StandardArgvPolicy = {
  longNameMatch: 'unique-prefix',
  optionBoundary: 'continue',
  occurrenceRetention: 'none',
};

function describeReadlinkError({
  error,
}: {
  error: unknown;
}): string {
  const message = error instanceof Error ? error.message : String(error);
  if (
    message.includes('Not a symbolic link')
    || message === 'Invalid argument'
    || message.startsWith('Invalid argument:')
  ) {
    return 'Invalid argument';
  }
  if (
    (error instanceof DOMException && error.name === 'NotFoundError')
    || message.includes('NotFoundError')
    || message.startsWith('Path not found:')
    || message === 'No such file or directory'
  ) {
    return 'No such file or directory';
  }
  if (message.includes('Too many levels of symbolic links')) {
    return 'Too many levels of symbolic links';
  }
  if (message.includes('Not a directory')) return 'Not a directory';
  return message;
}

async function resolveOperand({
  context,
  operand,
  mode,
}: {
  context: WeshCommandContext;
  operand: string;
  mode: ReadlinkMode;
}): Promise<string> {
  if (operand.length === 0) {
    throw new Error('No such file or directory');
  }

  switch (mode) {
  case 'link': {
    if (operand.length > 1 && operand.endsWith('/')) {
      throw new Error(`Not a symbolic link: ${operand}`);
    }
    const inputPath = resolvePath({ cwd: context.cwd, path: operand });
    return context.files.readlink({ path: inputPath });
  }
  case 'canonicalize':
    return canonicalizePathAllowingMissingLeaf({ context, path: operand });
  case 'existing':
    return canonicalizeExistingPath({ context, path: operand });
  case 'missing':
    return canonicalizePathAllowingMissingComponents({ context, path: operand });
  default: {
    const _exhaustive: never = mode;
    throw new Error(`Unsupported readlink mode: ${_exhaustive}`);
  }
  }
}

export const readlinkCommandImplementation: WeshCommandImplementation = {
  fn: async ({ context }: { context: WeshCommandContext }): Promise<WeshCommandResult> => {
    const parsed = parseStandardArgv({
      args: stopArgvAtFirstEarlyExit({
        args: context.args,
        catalog: readlinkArgvCatalog,
        policy: readlinkArgvPolicy,
        earlyExitOptions: HELP_EARLY_EXIT_OPTIONS,
      }),
      catalog: readlinkArgvCatalog,
      policy: readlinkArgvPolicy,
    });

    const diagnostic = parsed.diagnostics[0];
    const text = context.text();
    if (diagnostic !== undefined) {
      await writeCommandUsageError({
        context,
        command: 'readlink',
        message: `readlink: ${diagnostic.message}`,
        usageSummary: formatArgvUsageSummary({ presentation: readlinkArgvHelp }),
      });
      return { exitCode: 1 };
    }

    if (parsed.optionValues.help === true) {
      await writeCommandHelp({
        context,
        command: 'readlink',
        optionLines: formatArgvOptionHelp({ presentation: readlinkArgvHelp }),
      });
      return { exitCode: 0 };
    }

    if (parsed.positionals.length === 0) {
      await writeCommandUsageError({
        context,
        command: 'readlink',
        message: 'readlink: missing operand',
        usageSummary: formatArgvUsageSummary({ presentation: readlinkArgvHelp }),
      });
      return { exitCode: 1 };
    }

    const mode = (parsed.optionValues.mode as ReadlinkMode | undefined) ?? 'link';
    const verbose = parsed.optionValues.diagnosticMode === 'verbose';
    const zero = parsed.optionValues.zero === true;
    const requestedNoNewline = parsed.optionValues.noNewline === true;
    const noNewline = requestedNoNewline && parsed.positionals.length === 1;
    if (requestedNoNewline && parsed.positionals.length > 1) {
      await text.error({ text: 'readlink: ignoring --no-newline with multiple arguments\n' });
    }

    const terminator = noNewline ? '' : zero ? '\0' : '\n';
    let exitCode = 0;
    for (const operand of parsed.positionals) {
      try {
        const output = await resolveOperand({ context, operand, mode });
        await text.print({ text: `${output}${terminator}` });
      } catch (error: unknown) {
        exitCode = 1;
        if (verbose) {
          await text.error({
            text: `readlink: ${operand}: ${describeReadlinkError({ error })}\n`,
          });
        }
      }
    }

    return { exitCode };
  },
};

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
