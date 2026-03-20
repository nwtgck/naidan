import { parseStandardArgv, type ArgvOptionOccurrence, type StandardArgvParserSpec } from '@/services/wesh/argv';
import { writeCommandHelp, writeCommandUsageError } from '@/services/wesh/commands/_shared/usage';
import {
  parseXargsInsertInput,
  parseXargsNullDelimitedInput,
  parseXargsStandardInput,
} from '@/services/wesh/commands/xargs/parse-input';
import type { WeshCommandContext, WeshCommandDefinition, WeshCommandResult, WeshFileHandle } from '@/services/wesh/types';

const DEFAULT_MAX_CHARS = 131072;

const xargsArgvSpec: StandardArgvParserSpec = {
  options: [
    {
      kind: 'flag',
      short: '0',
      long: 'null',
      effects: [{ key: 'nullDelimited', value: true }],
      help: { summary: 'input items are terminated by NUL, not whitespace', category: 'common' },
    },
    {
      kind: 'value',
      short: 'n',
      long: 'max-args',
      key: 'maxArgs',
      valueName: 'MAX',
      allowAttachedValue: false,
      parseValue: ({ value }) => /^\d+$/.test(value) && Number(value) > 0
        ? { ok: true, value: Number(value) }
        : { ok: false, message: `invalid max-args value '${value}'` },
      help: { summary: 'use at most MAX arguments per command line', valueName: 'MAX', category: 'common' },
    },
    {
      kind: 'value',
      short: 'I',
      long: 'replace',
      key: 'replace',
      valueName: 'REPLSTR',
      allowAttachedValue: false,
      parseValue: undefined,
      help: { summary: 'replace REPLSTR in initial arguments with each input item', valueName: 'REPLSTR', category: 'common' },
    },
    {
      kind: 'flag',
      short: 'r',
      long: 'no-run-if-empty',
      effects: [{ key: 'noRunIfEmpty', value: true }],
      help: { summary: 'do not run command if there is no input', category: 'common' },
    },
    {
      kind: 'flag',
      short: 't',
      long: undefined,
      effects: [{ key: 'trace', value: true }],
      help: { summary: 'print command line before executing it', category: 'common' },
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

function shellQuote({
  text,
}: {
  text: string;
}): string {
  return /^[A-Za-z0-9_./-]+$/.test(text) ? text : `'${text.replaceAll('\'', `'\\''`)}'`;
}

async function readAllInput({
  handle,
}: {
  handle: WeshFileHandle;
}): Promise<string> {
  const decoder = new TextDecoder();
  const chunks: string[] = [];

  while (true) {
    const buffer = new Uint8Array(4096);
    const { bytesRead } = await handle.read({ buffer });
    if (bytesRead === 0) break;
    chunks.push(decoder.decode(buffer.subarray(0, bytesRead), { stream: true }));
  }

  chunks.push(decoder.decode());
  return chunks.join('');
}

function isValueOccurrence(
  occurrence: ArgvOptionOccurrence,
  key: string,
): occurrence is Extract<ArgvOptionOccurrence, { kind: 'value' }> {
  return occurrence.kind === 'value' && occurrence.key === key;
}

function getLastValueOccurrence({
  occurrences,
  key,
}: {
  occurrences: ArgvOptionOccurrence[];
  key: string;
}): Extract<ArgvOptionOccurrence, { kind: 'value' }> | undefined {
  return [...occurrences].reverse().find((occurrence) => isValueOccurrence(occurrence, key));
}

function buildBatches({
  items,
  initialArgs,
  maxArgs,
}: {
  items: string[];
  initialArgs: string[];
  maxArgs: number | undefined;
}): string[][] {
  const batches: string[][] = [];
  let currentBatch: string[] = [];
  let currentChars = initialArgs.join(' ').length;

  for (const item of items) {
    const nextCount = currentBatch.length + 1;
    const nextChars = currentChars + (currentBatch.length > 0 ? 1 : 0) + item.length;
    const exceedsMaxArgs = maxArgs !== undefined && nextCount > maxArgs;
    const exceedsMaxChars = nextChars > DEFAULT_MAX_CHARS;

    if (currentBatch.length > 0 && (exceedsMaxArgs || exceedsMaxChars)) {
      batches.push(currentBatch);
      currentBatch = [];
      currentChars = initialArgs.join(' ').length;
    }

    currentBatch.push(item);
    currentChars += (currentBatch.length > 1 ? 1 : 0) + item.length;
  }

  if (currentBatch.length > 0) {
    batches.push(currentBatch);
  }

  return batches;
}

function replaceTemplateArgs({
  args,
  placeholder,
  value,
}: {
  args: string[];
  placeholder: string;
  value: string;
}): string[] {
  let replaced = false;
  const nextArgs = args.map((arg) => {
    if (!arg.includes(placeholder)) return arg;
    replaced = true;
    return arg.replaceAll(placeholder, value);
  });

  return replaced ? nextArgs : [...args, value];
}

async function runCommand({
  context,
  command,
  args,
  trace,
}: {
  context: WeshCommandContext;
  command: string;
  args: string[];
  trace: boolean;
}): Promise<WeshCommandResult> {
  if (trace) {
    await context.text().error({
      text: `${[command, ...args].map((item) => shellQuote({ text: item })).join(' ')}\n`,
    });
  }

  return context.executeCommand({
    command,
    args,
    stdin: context.stdin,
    stdout: context.stdout,
    stderr: context.stderr,
  });
}

export const xargsCommandDefinition: WeshCommandDefinition = {
  meta: {
    name: 'xargs',
    description: 'Build and run command lines from standard input',
    usage: 'xargs [-0rt] [-n MAX] [-I REPLSTR] [COMMAND [INITIAL-ARGS]...]',
  },
  fn: async ({ context }: { context: WeshCommandContext }): Promise<WeshCommandResult> => {
    const parsed = parseStandardArgv({
      args: context.args,
      spec: xargsArgvSpec,
    });

    const diagnostic = parsed.diagnostics[0];
    if (diagnostic !== undefined) {
      await writeCommandUsageError({
        context,
        command: 'xargs',
        message: `xargs: ${diagnostic.message}`,
        argvSpec: xargsArgvSpec,
      });
      return { exitCode: 2 };
    }

    if (parsed.optionValues.help === true) {
      await writeCommandHelp({
        context,
        command: 'xargs',
        argvSpec: xargsArgvSpec,
      });
      return { exitCode: 0 };
    }

    const rawInput = await readAllInput({ handle: context.stdin });
    const replaceOccurrence = getLastValueOccurrence({
      occurrences: parsed.occurrences,
      key: 'replace',
    });
    const replaceValue = replaceOccurrence?.value;
    const maxArgsOccurrence = getLastValueOccurrence({
      occurrences: parsed.occurrences,
      key: 'maxArgs',
    });
    const maxArgs = typeof maxArgsOccurrence?.value === 'number' ? maxArgsOccurrence.value : undefined;

    const items = (() => {
      if (typeof replaceValue === 'string') {
        return parseXargsInsertInput({ text: rawInput });
      }

      if (parsed.optionValues.nullDelimited === true) {
        return parseXargsNullDelimitedInput({ text: rawInput });
      }

      return parseXargsStandardInput({ text: rawInput });
    })();

    if (!items.ok) {
      await context.text().error({ text: `${items.message}\n` });
      return { exitCode: 1 };
    }

    const [command = 'echo', ...initialArgs] = parsed.positionals;
    if (parsed.optionValues.noRunIfEmpty === true && items.items.length === 0) {
      return { exitCode: 0 };
    }

    let lastExitCode = 0;
    if (typeof replaceValue === 'string') {
      const values = items.items.length === 0 ? [''] : items.items;
      for (const value of values) {
        const result = await runCommand({
          context,
          command,
          args: replaceTemplateArgs({
            args: initialArgs,
            placeholder: replaceValue,
            value,
          }),
          trace: parsed.optionValues.trace === true,
        });
        if (result.exitCode !== 0) {
          lastExitCode = result.exitCode;
        }
      }

      return { exitCode: lastExitCode };
    }

    const batches = buildBatches({
      items: items.items,
      initialArgs,
      maxArgs,
    });
    const effectiveBatches = batches.length === 0 ? [[]] : batches;
    for (const batch of effectiveBatches) {
      const result = await runCommand({
        context,
        command,
        args: [...initialArgs, ...batch],
        trace: parsed.optionValues.trace === true,
      });
      if (result.exitCode !== 0) {
        lastExitCode = result.exitCode;
      }
    }

    return { exitCode: lastExitCode };
  },
};
