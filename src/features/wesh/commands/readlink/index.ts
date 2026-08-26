import type { WeshCommandContext, WeshCommandDefinition, WeshCommandResult } from '@/features/wesh/types';
import { parseStandardArgv, type StandardArgvParserSpec } from '@/features/wesh/argv';
import { STANDARD_HELP_EARLY_EXIT_OPTIONS, stopStandardArgvAtFirstEarlyExit } from '@/features/wesh/commands/_shared/argv';
import { writeCommandHelp, writeCommandUsageError } from '@/features/wesh/commands/_shared/usage';
import {
  canonicalizeExistingPath,
  canonicalizePathAllowingMissingComponents,
  canonicalizePathAllowingMissingLeaf,
  resolvePath,
} from '@/features/wesh/path';

type ReadlinkMode = 'link' | 'canonicalize' | 'existing' | 'missing';

const readlinkArgvSpec: StandardArgvParserSpec = {
  options: [
    {
      kind: 'flag',
      short: 'f',
      long: 'canonicalize',
      effects: [{ key: 'mode', value: 'canonicalize' }],
      help: { summary: 'canonicalize the path and resolve symlinks' },
    },
    {
      kind: 'flag',
      short: 'e',
      long: 'canonicalize-existing',
      effects: [{ key: 'mode', value: 'existing' }],
      help: { summary: 'canonicalize the path, requiring every component to exist' },
    },
    {
      kind: 'flag',
      short: 'm',
      long: 'canonicalize-missing',
      effects: [{ key: 'mode', value: 'missing' }],
      help: { summary: 'canonicalize the path, without requiring components to exist' },
    },
    {
      kind: 'flag',
      short: 'q',
      long: 'quiet',
      effects: [{ key: 'diagnosticMode', value: 'quiet' }],
      help: { summary: 'suppress most error messages' },
    },
    {
      kind: 'flag',
      short: 's',
      long: 'silent',
      effects: [{ key: 'diagnosticMode', value: 'quiet' }],
      help: { summary: 'suppress most error messages' },
    },
    {
      kind: 'flag',
      short: 'v',
      long: 'verbose',
      effects: [{ key: 'diagnosticMode', value: 'verbose' }],
      help: { summary: 'report error messages' },
    },
    {
      kind: 'flag',
      short: 'n',
      long: 'no-newline',
      effects: [{ key: 'noNewline', value: true }],
      help: { summary: 'do not print the trailing delimiter for one operand' },
    },
    {
      kind: 'flag',
      short: 'z',
      long: 'zero',
      effects: [{ key: 'zero', value: true }],
      help: { summary: 'end each output line with NUL, not newline' },
    },
    {
      kind: 'flag',
      short: undefined,
      long: 'help',
      effects: [{ key: 'help', value: true }],
      help: { summary: 'display this help and exit', category: 'common' },
    },
  ],
  allowShortFlagBundles: true,
  stopAtDoubleDash: true,
  treatSingleDashAsPositional: true,
  specialTokenParsers: [],
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

export const readlinkCommandDefinition: WeshCommandDefinition = {
  meta: {
    name: 'readlink',
    description: 'Print value of a symbolic link or canonical file name',
    usage: 'readlink [OPTION]... FILE...',
  },
  fn: async ({ context }: { context: WeshCommandContext }): Promise<WeshCommandResult> => {
    const parsed = parseStandardArgv({
      args: stopStandardArgvAtFirstEarlyExit({
        args: context.args,
        spec: readlinkArgvSpec,
        earlyExitOptions: STANDARD_HELP_EARLY_EXIT_OPTIONS,
      }),
      spec: readlinkArgvSpec,
    });

    const diagnostic = parsed.diagnostics[0];
    const text = context.text();
    if (diagnostic !== undefined) {
      await writeCommandUsageError({
        context,
        command: 'readlink',
        message: `readlink: ${diagnostic.message}`,
        argvSpec: readlinkArgvSpec,
      });
      return { exitCode: 1 };
    }

    if (parsed.optionValues.help === true) {
      await writeCommandHelp({
        context,
        command: 'readlink',
        argvSpec: readlinkArgvSpec,
      });
      return { exitCode: 0 };
    }

    if (parsed.positionals.length === 0) {
      await writeCommandUsageError({
        context,
        command: 'readlink',
        message: 'readlink: missing operand',
        argvSpec: readlinkArgvSpec,
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
