import { parseStandardArgv, type StandardArgvParserSpec } from '@/services/wesh/argv';
import { writeCommandHelp, writeCommandUsageError } from '@/services/wesh/commands/_shared/usage';
import { detectFileClassification, statFileTarget } from './detect';
import { formatFileClassification, formatFileMime } from './format';
import type { WeshCommandContext, WeshCommandDefinition, WeshCommandResult } from '@/services/wesh/types';

const fileArgvSpec: StandardArgvParserSpec = {
  options: [
    {
      kind: 'flag',
      short: 'b',
      long: 'brief',
      effects: [{ key: 'brief', value: true }],
      help: { summary: 'do not prepend filenames to output lines' },
    },
    {
      kind: 'flag',
      short: 'i',
      long: 'mime',
      effects: [{ key: 'outputMode', value: 'mime' }],
      help: { summary: 'output MIME type strings' },
    },
    {
      kind: 'flag',
      short: undefined,
      long: 'mime-type',
      effects: [{ key: 'outputMode', value: 'mime' }],
      help: { summary: 'output only the MIME type string' },
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

async function describePath({
  context,
  path,
  brief,
  outputMode,
}: {
  context: WeshCommandContext;
  path: string;
  brief: boolean;
  outputMode: 'description' | 'mime';
}): Promise<{ ok: true } | { ok: false }> {
  try {
    const target = await statFileTarget({
      context,
      path,
    });
    const classification = await detectFileClassification({
      context,
      target,
    });
    const description = (() => {
      switch (outputMode) {
      case 'description':
        return formatFileClassification({ classification });
      case 'mime':
        return formatFileMime({ classification });
      default: {
        const _ex: never = outputMode;
        throw new Error(`Unhandled file output mode: ${_ex}`);
      }
      }
    })();
    const text = brief ? `${description}\n` : `${path}: ${description}\n`;
    await context.text().print({ text });
    return { ok: true };
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    await context.text().error({ text: `file: cannot open '${path}' (${message})\n` });
    return { ok: false };
  }
}

export const fileCommandDefinition: WeshCommandDefinition = {
  meta: {
    name: 'file',
    description: 'Determine file type',
    usage: 'file [-b] [-i] [--brief] [--mime] [--mime-type] [--help] FILE...',
  },
  fn: async ({ context }: { context: WeshCommandContext }): Promise<WeshCommandResult> => {
    const parsed = parseStandardArgv({
      args: context.args,
      spec: fileArgvSpec,
    });

    const diagnostic = parsed.diagnostics[0];
    if (diagnostic !== undefined) {
      await writeCommandUsageError({
        context,
        command: 'file',
        message: `file: ${diagnostic.message}`,
        argvSpec: fileArgvSpec,
      });
      return { exitCode: 2 };
    }

    if (parsed.optionValues.help === true) {
      await writeCommandHelp({
        context,
        command: 'file',
        argvSpec: fileArgvSpec,
      });
      return { exitCode: 0 };
    }

    if (parsed.positionals.length === 0) {
      await writeCommandUsageError({
        context,
        command: 'file',
        message: 'file: missing file operand',
        argvSpec: fileArgvSpec,
      });
      return { exitCode: 1 };
    }

    let exitCode = 0;
    for (const path of parsed.positionals) {
      const result = await describePath({
        context,
        path,
        brief: parsed.optionValues.brief === true,
        outputMode: parsed.optionValues.outputMode === 'mime' ? 'mime' : 'description',
      });
      if (!result.ok) {
        exitCode = 1;
      }
    }

    return { exitCode };
  },
};
