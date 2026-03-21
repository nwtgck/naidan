import { parseStandardArgv, type StandardArgvParserSpec } from '@/services/wesh/argv';
import { writeCommandHelp, writeCommandUsageError } from '@/services/wesh/commands/_shared/usage';
import type { WeshCommandContext, WeshCommandDefinition, WeshCommandResult, WeshFileHandle } from '@/services/wesh/types';

interface TrOptions {
  deleteMode: boolean;
  squeezeRepeats: boolean;
  complement: boolean;
  truncateSet1: boolean;
}

const TR_CHARACTER_CLASS_NAMES = [
  'alnum',
  'alpha',
  'blank',
  'cntrl',
  'digit',
  'graph',
  'lower',
  'print',
  'punct',
  'space',
  'upper',
  'xdigit',
  'ascii',
] as const;

type TrCharacterClassName = typeof TR_CHARACTER_CLASS_NAMES[number];

const trArgvSpec: StandardArgvParserSpec = {
  options: [
    {
      kind: 'flag',
      short: undefined,
      long: 'help',
      effects: [{ key: 'help', value: true }],
      help: { summary: 'display this help and exit', category: 'common' },
    },
    {
      kind: 'flag',
      short: 'd',
      long: 'delete',
      effects: [{ key: 'deleteMode', value: true }],
      help: { summary: 'delete characters in SET1, do not translate', category: 'common' },
    },
    {
      kind: 'flag',
      short: 's',
      long: 'squeeze-repeats',
      effects: [{ key: 'squeezeRepeats', value: true }],
      help: { summary: 'replace each input sequence of a repeated character with one occurrence', category: 'common' },
    },
    {
      kind: 'flag',
      short: 'c',
      long: 'complement',
      effects: [{ key: 'complement', value: true }],
      help: { summary: 'use the complement of SET1', category: 'common' },
    },
    {
      kind: 'flag',
      short: 'C',
      long: undefined,
      effects: [{ key: 'complement', value: true }],
      help: { summary: 'same as -c', category: 'advanced' },
    },
    {
      kind: 'flag',
      short: 't',
      long: 'truncate-set1',
      effects: [{ key: 'truncateSet1', value: true }],
      help: { summary: 'truncate SET1 to the length of SET2', category: 'advanced' },
    },
  ],
  allowShortFlagBundles: true,
  stopAtDoubleDash: true,
  treatSingleDashAsPositional: true,
  specialTokenParsers: [],
};

const ASCII_PRINTABLE_CLASS_NAMES = new Set<string>(TR_CHARACTER_CLASS_NAMES);

function createAsciiRange({
  start,
  end,
}: {
  start: number;
  end: number;
}): string[] {
  const result: string[] = [];
  for (let code = start; code <= end; code++) {
    result.push(String.fromCharCode(code));
  }
  return result;
}

function isTrCharacterClassName(name: string): boolean {
  return ASCII_PRINTABLE_CLASS_NAMES.has(name);
}

function expandCharacterClass({
  name,
}: {
  name: TrCharacterClassName;
}): string[] {
  switch (name) {
  case 'alnum':
    return [
      ...createAsciiRange({ start: 48, end: 57 }),
      ...createAsciiRange({ start: 65, end: 90 }),
      ...createAsciiRange({ start: 97, end: 122 }),
    ];
  case 'alpha':
    return [
      ...createAsciiRange({ start: 65, end: 90 }),
      ...createAsciiRange({ start: 97, end: 122 }),
    ];
  case 'blank':
    return [' ', '\t'];
  case 'cntrl':
    return [
      ...createAsciiRange({ start: 0, end: 31 }),
      String.fromCharCode(127),
    ];
  case 'digit':
    return createAsciiRange({ start: 48, end: 57 });
  case 'graph':
    return createAsciiRange({ start: 33, end: 126 });
  case 'lower':
    return createAsciiRange({ start: 97, end: 122 });
  case 'print':
    return createAsciiRange({ start: 32, end: 126 });
  case 'punct':
    return [
      ...createAsciiRange({ start: 33, end: 47 }),
      ...createAsciiRange({ start: 58, end: 64 }),
      ...createAsciiRange({ start: 91, end: 96 }),
      ...createAsciiRange({ start: 123, end: 126 }),
    ];
  case 'space':
    return [' ', '\t', '\n', '\r', '\v', '\f'];
  case 'upper':
    return createAsciiRange({ start: 65, end: 90 });
  case 'xdigit':
    return [
      ...createAsciiRange({ start: 48, end: 57 }),
      ...createAsciiRange({ start: 65, end: 70 }),
      ...createAsciiRange({ start: 97, end: 102 }),
    ];
  case 'ascii':
    return createAsciiRange({ start: 0, end: 127 });
  default: {
    const _ex: never = name;
    throw new Error(`Unhandled character class: ${_ex}`);
  }
  }
}

function expandCharacterClassIfPresent({
  name,
}: {
  name: string;
}): string[] | undefined {
  if (!isTrCharacterClassName(name)) {
    return undefined;
  }

  return expandCharacterClass({ name: name as TrCharacterClassName });
}

function parseEscapeSequence({
  source,
  index,
}: {
  source: string;
  index: number;
}): { chars: string[]; nextIndex: number } {
  const next = source[index + 1];
  if (next === undefined) {
    return { chars: ['\\'], nextIndex: index };
  }

  if (next >= '0' && next <= '7') {
    let digits = next;
    let cursor = index + 2;
    while (digits.length < 3 && cursor < source.length) {
      const digit = source[cursor];
      if (digit === undefined || digit < '0' || digit > '7') break;
      digits += digit;
      cursor++;
    }

    const parsed = Number.parseInt(digits, 8);
    return {
      chars: [String.fromCharCode(parsed)],
      nextIndex: cursor - 1,
    };
  }

  switch (next) {
  case 'a':
    return { chars: ['\u0007'], nextIndex: index + 1 };
  case 'b':
    return { chars: ['\b'], nextIndex: index + 1 };
  case 'f':
    return { chars: ['\f'], nextIndex: index + 1 };
  case 'n':
    return { chars: ['\n'], nextIndex: index + 1 };
  case 'r':
    return { chars: ['\r'], nextIndex: index + 1 };
  case 't':
    return { chars: ['\t'], nextIndex: index + 1 };
  case 'v':
    return { chars: ['\v'], nextIndex: index + 1 };
  case '\\':
    return { chars: ['\\'], nextIndex: index + 1 };
  default:
    return { chars: [next], nextIndex: index + 1 };
  }
}

function expandTrSet({
  source,
}: {
  source: string;
}): string[] {
  if (source.length === 0) {
    return [];
  }

  if (source.startsWith('[') && source.endsWith(']') && source[1] !== ':') {
    return expandTrSet({ source: source.slice(1, -1) });
  }

  const result: string[] = [];

  for (let index = 0; index < source.length; index++) {
    const current = source[index];
    if (current === undefined) continue;

    if (current === '\\') {
      const escaped = parseEscapeSequence({ source, index });
      result.push(...escaped.chars);
      index = escaped.nextIndex;
      continue;
    }

    if (current === '[' && source[index + 1] === ':') {
      const classEnd = source.indexOf(':]', index + 2);
      if (classEnd !== -1) {
        const className = source.slice(index + 2, classEnd);
        const classChars = expandCharacterClassIfPresent({ name: className });
        if (classChars !== undefined) {
          result.push(...classChars);
          index = classEnd + 1;
          continue;
        }
      }
    }

    const next = source[index + 1];
    const nextNext = source[index + 2];
    if (current !== '-' && next === '-' && nextNext !== undefined && nextNext !== ']') {
      const startCode = current.charCodeAt(0);
      const endCode = nextNext.charCodeAt(0);
      if (startCode <= endCode) {
        result.push(...createAsciiRange({ start: startCode, end: endCode }));
        index += 2;
        continue;
      }
    }

    result.push(current);
  }

  return result;
}

function complementAsciiSet({
  source,
}: {
  source: string[];
}): string[] {
  const excluded = new Set(source);
  const result: string[] = [];
  for (let code = 0; code <= 255; code++) {
    const char = String.fromCharCode(code);
    if (excluded.has(char)) continue;
    result.push(char);
  }
  return result;
}

function buildTranslationMap({
  set1,
  set2,
  truncateSet1,
}: {
  set1: string[];
  set2: string[];
  truncateSet1: boolean;
}): Map<string, string> {
  const map = new Map<string, string>();
  const effectiveSet1 = truncateSet1 ? set1.slice(0, set2.length) : set1;

  for (let index = 0; index < effectiveSet1.length; index++) {
    const from = effectiveSet1[index];
    if (from === undefined) continue;

    const to = set2[index] ?? set2[set2.length - 1] ?? from;
    map.set(from, to);
  }

  return map;
}

async function readHandleText({
  handle,
}: {
  handle: WeshFileHandle;
}): Promise<string> {
  const decoder = new TextDecoder();
  const buffer = new Uint8Array(4096);
  let text = '';

  while (true) {
    const { bytesRead } = await handle.read({ buffer });
    if (bytesRead === 0) break;
    text += decoder.decode(buffer.subarray(0, bytesRead), { stream: true });
  }

  text += decoder.decode();
  return text;
}

function resolveTrOptions({
  parsed,
}: {
  parsed: ReturnType<typeof parseStandardArgv>;
}): TrOptions {
  return {
    deleteMode: parsed.optionValues.deleteMode === true,
    squeezeRepeats: parsed.optionValues.squeezeRepeats === true,
    complement: parsed.optionValues.complement === true,
    truncateSet1: parsed.optionValues.truncateSet1 === true,
  };
}

function transformText({
  text,
  set1,
  set2,
  options,
}: {
  text: string;
  set1: string[];
  set2: string[];
  options: TrOptions;
}): string {
  const effectiveSet1 = options.complement ? complementAsciiSet({ source: set1 }) : set1;
  const deleteSet = new Set(effectiveSet1);
  const translationMap = options.deleteMode ? new Map<string, string>() : buildTranslationMap({
    set1: effectiveSet1,
    set2,
    truncateSet1: options.truncateSet1,
  });
  const squeezeSet = options.squeezeRepeats
    ? new Set<string>(options.deleteMode || set2.length === 0 ? effectiveSet1 : set2)
    : undefined;

  let output = '';
  let lastOutputChar: string | undefined;

  for (const char of text) {
    if (options.deleteMode && deleteSet.has(char)) {
      continue;
    }

    const translated = options.deleteMode ? char : translationMap.get(char) ?? char;
    if (squeezeSet !== undefined && squeezeSet.has(translated) && translated === lastOutputChar) {
      continue;
    }

    output += translated;
    lastOutputChar = translated;
  }

  return output;
}

export const trCommandDefinition: WeshCommandDefinition = {
  meta: {
    name: 'tr',
    description: 'Translate or delete characters',
    usage: 'tr [OPTION]... SET1 [SET2]',
  },
  fn: async ({ context }: { context: WeshCommandContext }): Promise<WeshCommandResult> => {
    const parsed = parseStandardArgv({
      args: context.args,
      spec: trArgvSpec,
    });

    const diagnostic = parsed.diagnostics[0];
    if (diagnostic !== undefined) {
      await writeCommandUsageError({
        context,
        command: 'tr',
        message: `tr: ${diagnostic.message}`,
        argvSpec: trArgvSpec,
      });
      return { exitCode: 1 };
    }

    if (parsed.optionValues.help === true) {
      await writeCommandHelp({
        context,
        command: 'tr',
        argvSpec: trArgvSpec,
      });
      return { exitCode: 0 };
    }

    if (parsed.positionals.length < 1) {
      await writeCommandUsageError({
        context,
        command: 'tr',
        message: 'tr: missing operand',
        argvSpec: trArgvSpec,
      });
      return { exitCode: 1 };
    }

    if (parsed.positionals.length > 2) {
      await writeCommandUsageError({
        context,
        command: 'tr',
        message: `tr: extra operand '${parsed.positionals[2]}'`,
        argvSpec: trArgvSpec,
      });
      return { exitCode: 1 };
    }

    const options = resolveTrOptions({ parsed });
    const set1 = expandTrSet({ source: parsed.positionals[0] ?? '' });
    const set2Raw = parsed.positionals[1];
    if (!options.deleteMode && !options.squeezeRepeats && set2Raw === undefined) {
      await writeCommandUsageError({
        context,
        command: 'tr',
        message: 'tr: missing operand',
        argvSpec: trArgvSpec,
      });
      return { exitCode: 1 };
    }

    const set2 = set2Raw === undefined ? [] : expandTrSet({ source: set2Raw });
    const inputText = await readHandleText({ handle: context.stdin });
    const outputText = transformText({
      text: inputText,
      set1,
      set2,
      options,
    });

    await context.text().print({ text: outputText });
    return { exitCode: 0 };
  },
};
