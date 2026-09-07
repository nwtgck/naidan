import { CommandDataStreamDecoder, decodeCommandDataBytes } from '@/features/wesh/commands/_shared/data-codec';
import { resolveCharacterLocaleMode } from '@/features/wesh/commands/_shared/locale';
import { stripLeadingCLocaleAndTrailingBlankWhitespace } from '@/features/wesh/commands/_shared/numeric-whitespace';
import type { WeshCommandContext, WeshCommandImplementation, WeshCommandResult } from '@/features/wesh/types';
import { parseStandardArgv, type ArgvOptionOccurrence, type StandardArgvParserSpec } from '@/features/wesh/argv';
import { writeCommandHelp, writeCommandUsageError } from '@/features/wesh/commands/_shared/usage';
import { stopStandardOptionParsingAtFirstPositional } from '@/features/wesh/commands/_shared/argv';

function parseReadUnsignedInteger({
  value,
  invalidMessage,
}: {
  value: string,
  invalidMessage: string,
}): { ok: true, value: number } | { ok: false, message: string } {
  const numericText = stripLeadingCLocaleAndTrailingBlankWhitespace({ value });
  if (!/^(?:0|[1-9]\d*)$/u.test(numericText)) {
    return { ok: false, message: invalidMessage };
  }

  const parsed = Number(numericText);
  return Number.isSafeInteger(parsed)
    ? { ok: true, value: parsed }
    : { ok: false, message: invalidMessage };
}

const readArgvSpec: StandardArgvParserSpec = {
  options: [
    { kind: 'flag', short: 'r', long: undefined, effects: [{ key: 'rawMode', value: true }], help: { summary: 'do not treat backslash as an escape character' } },
    {
      kind: 'value',
      short: 'd',
      long: undefined,
      key: 'delimiter',
      valueName: 'delimiter',
      allowAttachedValue: true,
      help: { summary: 'continue until the first character of DELIM is read', valueName: 'DELIM' },
      parseValue: undefined,
    },
    {
      kind: 'value',
      short: 'n',
      long: undefined,
      key: 'maximumCharacters',
      valueName: 'nchars',
      allowAttachedValue: true,
      help: { summary: 'return after reading NCHARS rather than waiting for a delimiter', valueName: 'NCHARS' },
      parseValue: ({ value }) => parseReadUnsignedInteger({
        value,
        invalidMessage: `${value}: invalid number`,
      }),
    },
    {
      kind: 'value',
      short: 'N',
      long: undefined,
      key: 'exactCharacters',
      valueName: 'nchars',
      allowAttachedValue: true,
      help: { summary: 'return only after reading exactly NCHARS, unless EOF is reached', valueName: 'NCHARS' },
      parseValue: ({ value }) => parseReadUnsignedInteger({
        value,
        invalidMessage: `${value}: invalid number`,
      }),
    },
    {
      kind: 'value',
      short: 'p',
      long: undefined,
      key: 'prompt',
      valueName: 'prompt',
      allowAttachedValue: true,
      help: { summary: 'output the string PROMPT without a trailing newline before attempting to read', valueName: 'PROMPT' },
      parseValue: undefined,
    },
    {
      kind: 'flag',
      short: 's',
      long: undefined,
      effects: [{ key: 'silent', value: true }],
      help: { summary: 'do not echo input coming from a terminal', category: 'advanced' },
    },
    {
      kind: 'value',
      short: 'u',
      long: undefined,
      key: 'fd',
      valueName: 'fd',
      allowAttachedValue: true,
      help: { summary: 'read from file descriptor fd' },
      parseValue: ({ value }) => parseReadUnsignedInteger({
        value,
        invalidMessage: `invalid file descriptor '${value}'`,
      }),
    },
    { kind: 'flag', short: undefined, long: 'help', effects: [{ key: 'help', value: true }], help: { summary: 'display this help and exit', category: 'common' } },
  ],
  allowShortFlagBundles: true,
  stopAtDoubleDash: true,
  treatSingleDashAsPositional: true,
  specialTokenParsers: [],
};

function isIfsWhitespace({
  char,
}: {
  char: string,
}): boolean {
  return char === ' ' || char === '\t' || char === '\n';
}

function isShellIdentifier({
  value,
}: {
  value: string,
}): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(value);
}

type ReadCharacterLimit =
  | { kind: 'maximum', count: number }
  | { kind: 'exact', count: number };

function getReadCharacterLimit({
  occurrences,
}: {
  occurrences: ArgvOptionOccurrence[],
}): ReadCharacterLimit | undefined {
  let count: number | undefined;
  let exactMode = false;

  for (const occurrence of occurrences) {
    if (occurrence.kind !== 'value' || typeof occurrence.value !== 'number') {
      continue;
    }

    switch (occurrence.key) {
    case 'maximumCharacters':
      count = occurrence.value;
      break;
    case 'exactCharacters':
      count = occurrence.value;
      exactMode = true;
      break;
    default:
      break;
    }
  }

  if (count === undefined) {
    return undefined;
  }

  return {
    kind: exactMode ? 'exact' : 'maximum',
    count,
  };
}

function assignReadValues({
  line,
  ifs,
  namesCount,
}: {
  line: string,
  ifs: string,
  namesCount: number,
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

  let remainder = line.slice(index);
  while (
    remainder.length > 0
    && whitespaceDelimiters.has(remainder.at(-1) ?? '')
  ) {
    remainder = remainder.slice(0, -1);
  }
  values.push(remainder);
  while (values.length < namesCount) {
    values.push('');
  }

  return values;
}

export const readCommandImplementation: WeshCommandImplementation = {
  fn: async ({ context }: { context: WeshCommandContext }): Promise<WeshCommandResult> => {
    const parsed = parseStandardArgv({
      args: stopStandardOptionParsingAtFirstPositional({ args: context.args, spec: readArgvSpec }),
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
    const characterLimit = getReadCharacterLimit({ occurrences: parsed.occurrences });
    const delimiterValue = parsed.optionValues.delimiter;
    const delimiter = typeof delimiterValue === 'string'
      ? Array.from(delimiterValue)[0] ?? '\0'
      : '\n';
    const prompt = typeof parsed.optionValues.prompt === 'string' ? parsed.optionValues.prompt : undefined;
    const variableNames = parsed.positionals;
    const ifs = context.env.get('IFS') ?? ' \t\n';

    const inputHandle = context.getFileDescriptor({ fd });
    if (inputHandle === undefined) {
      await context.text().error({ text: `read: ${fd}: bad file descriptor\n` });
      return { exitCode: 1 };
    }

    if (prompt !== undefined && (await inputHandle.stat()).type === 'chardev') {
      await context.text().print({ text: prompt });
    }

    const characterLocaleMode = resolveCharacterLocaleMode({ env: context.env });
    const decoder = new CommandDataStreamDecoder();
    const buffer = new Uint8Array(1);
    const pendingCharacters: Array<{
      readonly value: string;
      readonly delimiterEligible: boolean;
    }> = [];
    let reachedEndOfInput = false;
    let line = '';
    let assignedCharacterCount = 0;
    let completed = characterLimit?.count === 0;

    const pushDecodedCharacters = ({ text }: { text: string }): void => {
      const characters = Array.from(text);
      const finalCharacterFollowsMalformedPrefix = characters.length > 1
        && characters.slice(0, -1).some((character) => {
          const codeUnit = character.charCodeAt(0);
          return codeUnit >= 0xdc80 && codeUnit <= 0xdcff;
        });
      for (let index = 0; index < characters.length; index += 1) {
        pendingCharacters.push({
          value: characters[index]!,
          delimiterEligible: !(finalCharacterFollowsMalformedPrefix && index === characters.length - 1),
        });
      }
    };

    const finishDecodedInput = (): string => {
      switch (characterLocaleMode) {
      case 'ascii':
        return '';
      case 'unicode':
        return decoder.finish();
      default: {
        const _ex: never = characterLocaleMode;
        throw new Error(`Unhandled locale mode: ${_ex}`);
      }
      }
    };
    const decodeInputBytes = ({ bytes }: { bytes: Uint8Array }): string => {
      switch (characterLocaleMode) {
      case 'ascii':
        return decodeCommandDataBytes({ bytes });
      case 'unicode':
        return decoder.write({ bytes });
      default: {
        const _ex: never = characterLocaleMode;
        throw new Error(`Unhandled locale mode: ${_ex}`);
      }
      }
    };

    // Read one byte at a time so the underlying descriptor remains positioned
    // immediately after the delimiter or requested character count. A delimiter
    // byte that completes an invalid multibyte sequence is data in Bash rather
    // than a record terminator, so retain that origin metadata per character.
    const readCharacter = async (): Promise<{
      readonly value: string;
      readonly delimiterEligible: boolean;
    } | undefined> => {
      while (pendingCharacters.length === 0) {
        if (reachedEndOfInput) {
          return undefined;
        }

        const { bytesRead } = await inputHandle.read({ buffer });
        if (bytesRead === 0) {
          reachedEndOfInput = true;
          pushDecodedCharacters({ text: finishDecodedInput() });
          continue;
        }

        const bytes = buffer.subarray(0, bytesRead);
        pushDecodedCharacters({ text: decodeInputBytes({ bytes }) });
      }

      return pendingCharacters.shift();
    };

    const appendToLine = ({ value }: { value: string }): void => {
      line += value;
      assignedCharacterCount += Array.from(value).length;
      if (
        characterLimit !== undefined
        && assignedCharacterCount >= characterLimit.count
      ) {
        completed = true;
      }
    };

    while (!completed) {
      const char = await readCharacter();
      if (char === undefined) {
        break;
      }

      if (characterLimit?.kind !== 'exact' && char.delimiterEligible && char.value === delimiter) {
        completed = true;
        break;
      }

      if (!rawMode && char.value === '\\') {
        const nextChar = await readCharacter();
        if (nextChar === undefined) {
          appendToLine({ value: '\\' });
          break;
        }
        if (nextChar.value === '\n') {
          continue;
        }
        appendToLine({ value: nextChar.value });
        continue;
      }

      appendToLine({ value: char.value });
    }

    const names = variableNames.length > 0 ? variableNames : ['REPLY'];

    if (variableNames.length === 0) {
      context.setEnv({
        key: 'REPLY',
        value: line,
      });
      return { exitCode: completed ? 0 : 1 };
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

      if (!isShellIdentifier({ value: name })) {
        await context.text().error({
          text: `read: \`${name}': not a valid identifier\n`,
        });
        return { exitCode: 1 };
      }

      context.setEnv({
        key: name,
        value: fields[index] ?? '',
      });
    }

    return { exitCode: completed ? 0 : 1 };
  },
};

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
