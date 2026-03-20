import type { WeshCommandContext, WeshCommandDefinition, WeshCommandResult } from '@/services/wesh/types';
import { parseStandardArgv, type StandardArgvParserSpec } from '@/services/wesh/argv';
import { writeCommandHelp, writeCommandUsageError } from '@/services/wesh/commands/_shared/usage';

const readArgvSpec: StandardArgvParserSpec = {
  options: [
    { kind: 'flag', short: 'r', long: undefined, effects: [{ key: 'rawMode', value: true }], help: { summary: 'do not treat backslash as an escape character' } },
    {
      kind: 'value',
      short: 'u',
      long: undefined,
      key: 'fd',
      valueName: 'fd',
      allowAttachedValue: false,
      help: { summary: 'read from file descriptor fd' },
      parseValue: ({ value }) => /^\d+$/.test(value)
        ? { ok: true, value: parseInt(value, 10) }
        : { ok: false, message: `invalid file descriptor '${value}'` },
    },
    { kind: 'flag', short: undefined, long: 'help', effects: [{ key: 'help', value: true }], help: { summary: 'display this help and exit', category: 'common' } },
  ],
  allowShortFlagBundles: false,
  stopAtDoubleDash: true,
  treatSingleDashAsPositional: true,
  specialTokenParsers: [],
};

function isIfsWhitespace({
  char,
}: {
  char: string;
}): boolean {
  return char === ' ' || char === '\t' || char === '\n';
}

function assignReadValues({
  line,
  ifs,
  namesCount,
}: {
  line: string;
  ifs: string;
  namesCount: number;
}): string[] {
  if (namesCount <= 0) {
    return [];
  }

  if (ifs.length === 0) {
    return [line, ...Array.from({ length: Math.max(namesCount - 1, 0) }, () => '')];
  }

  const ifsCharacters = new Set(ifs.split(''));
  const whitespaceDelimiters = new Set(ifs.split('').filter((char) => isIfsWhitespace({ char })));
  const values: string[] = [];
  let index = 0;

  const skipIfsWhitespace = () => {
    while (index < line.length && whitespaceDelimiters.has(line[index] ?? '')) {
      index += 1;
    }
  };

  skipIfsWhitespace();

  while (values.length < namesCount - 1) {
    if (index >= line.length) {
      values.push('');
      continue;
    }

    const leadingChar = line[index];
    if (leadingChar !== undefined && ifsCharacters.has(leadingChar) && !whitespaceDelimiters.has(leadingChar)) {
      values.push('');
      index += 1;
      skipIfsWhitespace();
      continue;
    }

    let current = '';
    while (index < line.length) {
      const char = line[index];
      if (char === undefined || ifsCharacters.has(char)) {
        break;
      }
      current += char;
      index += 1;
    }
    values.push(current);

    if (index >= line.length) {
      continue;
    }

    const delimiter = line[index];
    if (delimiter !== undefined && whitespaceDelimiters.has(delimiter)) {
      skipIfsWhitespace();
      continue;
    }

    index += 1;
    skipIfsWhitespace();
  }

  if (values.length >= namesCount) {
    return values.slice(0, namesCount);
  }

  values.push(line.slice(index));
  while (values.length < namesCount) {
    values.push('');
  }

  return values;
}

export const readCommandDefinition: WeshCommandDefinition = {
  meta: {
    name: 'read',
    description: 'Read a line from standard input or a file descriptor into shell variables',
    usage: 'read [-r] [-u fd] [name...]',
  },
  fn: async ({ context }: { context: WeshCommandContext }): Promise<WeshCommandResult> => {
    const parsed = parseStandardArgv({
      args: context.args,
      spec: readArgvSpec,
    });

    const diagnostic = parsed.diagnostics[0];
    if (diagnostic !== undefined) {
      await writeCommandUsageError({
        context,
        command: 'read',
        message: `read: ${diagnostic.message}`,
        argvSpec: readArgvSpec,
      });
      return { exitCode: 1 };
    }

    if (parsed.optionValues.help === true) {
      await writeCommandHelp({
        context,
        command: 'read',
        argvSpec: readArgvSpec,
      });
      return { exitCode: 0 };
    }

    const fdValue = parsed.optionValues.fd;
    const fd = typeof fdValue === 'number' ? fdValue : 0;
    const rawMode = parsed.optionValues.rawMode === true;
    const variableNames = parsed.positionals;
    const ifs = context.env.get('IFS') ?? ' \t\n';

    const inputHandle = context.getFileDescriptor({ fd });
    if (inputHandle === undefined) {
      await context.text().error({ text: `read: ${fd}: bad file descriptor\n` });
      return { exitCode: 1 };
    }

    const decoder = new TextDecoder();
    const buffer = new Uint8Array(1);
    let line = '';
    let didRead = false;
    let endedWithNewline = false;

    while (true) {
      const { bytesRead } = await inputHandle.read({ buffer });
      if (bytesRead === 0) {
        break;
      }
      didRead = true;

      const chunk = decoder.decode(buffer.subarray(0, bytesRead));
      const char = chunk[0];
      if (char === undefined) {
        continue;
      }

      if (char === '\n') {
        endedWithNewline = true;
        break;
      }

      if (!rawMode && char === '\\') {
        const nextRead = await inputHandle.read({ buffer });
        if (nextRead.bytesRead === 0) {
          line += '\\';
          break;
        }
        didRead = true;

        const nextChar = decoder.decode(buffer.subarray(0, nextRead.bytesRead))[0];
        if (nextChar === '\n') {
          continue;
        }
        line += nextChar ?? '';
        continue;
      }

      line += char;
    }

    const names = variableNames.length > 0 ? variableNames : ['REPLY'];
    if (variableNames.length === 0) {
      context.setEnv({
        key: 'REPLY',
        value: line,
      });
      return { exitCode: didRead && endedWithNewline ? 0 : 1 };
    }

    const fields = assignReadValues({
      line,
      ifs,
      namesCount: names.length,
    });

    for (let index = 0; index < names.length; index++) {
      const name = names[index];
      if (name === undefined) {
        continue;
      }

      context.setEnv({
        key: name,
        value: fields[index] ?? '',
      });
    }

    return { exitCode: didRead && endedWithNewline ? 0 : 1 };
  },
};
