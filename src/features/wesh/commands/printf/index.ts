import type { StandardArgvParserSpec } from '@/features/wesh/argv';
import { encodeCommandDataText } from '@/features/wesh/commands/_shared/data-codec';
import { resolveCharacterLocaleMode, type WeshCharacterLocaleMode } from '@/features/wesh/commands/_shared/locale';
import { writeCommandHelp, writeCommandUsageError } from '@/features/wesh/commands/_shared/usage';
import type { WeshCommandContext, WeshCommandDefinition, WeshCommandResult } from '@/features/wesh/types';
import { writeAllBytesToHandle } from '@/features/wesh/utils/fs';

type PrintfConversionSpec =
  | 's'
  | 'b'
  | 'c'
  | 'd'
  | 'i'
  | 'u'
  | 'o'
  | 'x'
  | 'X'
  | 'f'
  | 'F'
  | 'e'
  | 'E'
  | 'g'
  | 'G'
  | 'q';

type PrintfFlags = {
  readonly alternate: boolean,
  readonly zeroPad: boolean,
  readonly leftAlign: boolean,
  readonly showSign: boolean,
  readonly leadingSpace: boolean,
};

type PrintfToken =
  | { kind: 'literal', text: string }
  | {
    kind: 'conversion',
    spec: PrintfConversionSpec,
    flags: PrintfFlags,
    width: number | undefined,
    widthFromArgument: boolean,
    precision: number | undefined,
    precisionFromArgument: boolean,
  };

type PrintfConversionToken = Extract<PrintfToken, { kind: 'conversion' }>;
type PrintfIntegerConversionSpec = 'd' | 'i' | 'u' | 'o' | 'x' | 'X';
type PrintfFloatConversionSpec = 'f' | 'F' | 'e' | 'E' | 'g' | 'G';
type PrintfIntegerConversionToken = Omit<PrintfConversionToken, 'spec'> & {
  spec: PrintfIntegerConversionSpec,
};
type PrintfFloatConversionToken = Omit<PrintfConversionToken, 'spec'> & {
  spec: PrintfFloatConversionSpec,
};

const printfArgvSpec: StandardArgvParserSpec = {
  options: [
    { kind: 'flag', short: undefined, long: 'help', effects: [{ key: 'help', value: true }], help: { summary: 'display this help and exit', category: 'common' } },
  ],
  allowShortFlagBundles: false,
  stopAtDoubleDash: true,
  treatSingleDashAsPositional: true,
  specialTokenParsers: [],
};

const UTF8_ENCODER = new TextEncoder();
const PRINTF_MAX_FIELD_WIDTH = 1_000_000;
const PRINTF_MAX_FLOAT_PRECISION = 100;
const PRINTF_MAX_OTHER_PRECISION = 1_000_000;

const PRINTF_CONVERSION_SPECS = new Set<PrintfConversionSpec>([
  's',
  'b',
  'c',
  'd',
  'i',
  'u',
  'o',
  'x',
  'X',
  'f',
  'F',
  'e',
  'E',
  'g',
  'G',
  'q',
]);

function decodePrintfEscapes({
  text,
  stopOnControlC,
}: {
  text: string,
  stopOnControlC: boolean,
}): { text: string, bytes: Uint8Array, stopped: boolean } {
  let output = '';
  const byteChunks: Uint8Array[] = [];
  let textBuffer = '';

  const flushTextBuffer = (): void => {
    if (textBuffer.length === 0) return;
    byteChunks.push(encodeCommandDataText({ text: textBuffer }));
    textBuffer = '';
  };
  const appendText = ({ text }: { text: string }): void => {
    output += text;
    textBuffer += text;
  };
  const appendByte = ({ byte }: { byte: number }): void => {
    flushTextBuffer();
    output += String.fromCharCode(byte);
    byteChunks.push(Uint8Array.of(byte));
  };
  const finish = ({ stopped }: { stopped: boolean }): { text: string, bytes: Uint8Array, stopped: boolean } => {
    flushTextBuffer();
    const byteLength = byteChunks.reduce((total, chunk) => total + chunk.byteLength, 0);
    const bytes = new Uint8Array(byteLength);
    let offset = 0;
    for (const chunk of byteChunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return { text: output, bytes, stopped };
  };

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (char !== '\\') {
      appendText({ text: char ?? '' });
      continue;
    }

    const next = text[index + 1];
    if (next === undefined) {
      appendText({ text: '\\' });
      continue;
    }

    index += 1;
    switch (next) {
    case 'a':
      appendByte({ byte: 0x07 });
      continue;
    case 'b':
      appendByte({ byte: 0x08 });
      continue;
    case 'c':
      if (stopOnControlC) {
        return finish({ stopped: true });
      }
      appendText({ text: '\\c' });
      continue;
    case 'e':
      appendByte({ byte: 0x1b });
      continue;
    case 'f':
      appendByte({ byte: 0x0c });
      continue;
    case 'n':
      appendByte({ byte: 0x0a });
      continue;
    case 'r':
      appendByte({ byte: 0x0d });
      continue;
    case 't':
      appendByte({ byte: 0x09 });
      continue;
    case 'v':
      appendByte({ byte: 0x0b });
      continue;
    case '\\':
      appendByte({ byte: 0x5c });
      continue;
    case '"':
      appendByte({ byte: 0x22 });
      continue;
    case '0': {
      let octal = '0';
      while (octal.length < 4) {
        const digit = text[index + 1];
        if (digit === undefined || !/^[0-7]$/.test(digit)) {
          break;
        }
        index += 1;
        octal += digit;
      }
      appendByte({ byte: Number.parseInt(octal, 8) & 0xff });
      continue;
    }
    case 'x':
    case 'u':
    case 'U': {
      let digitCount: number;
      switch (next) {
      case 'x':
        digitCount = 2;
        break;
      case 'u':
        digitCount = 4;
        break;
      case 'U':
        digitCount = 8;
        break;
      default: {
        const _ex: never = next;
        throw new Error(`Unhandled printf escape: ${_ex}`);
      }
      }
      let digits = '';
      while (digits.length < digitCount) {
        const digit = text[index + 1];
        if (digit === undefined || !/^[0-9a-fA-F]$/.test(digit)) {
          break;
        }
        index += 1;
        digits += digit;
      }
      if (digits.length === 0) {
        appendText({ text: `\\${next}` });
        continue;
      }
      const codePoint = Number.parseInt(digits, 16);
      switch (next) {
      case 'x':
        appendByte({ byte: codePoint & 0xff });
        break;
      case 'u':
      case 'U':
        appendText({ text: String.fromCodePoint(codePoint) });
        break;
      default: {
        const _ex: never = next;
        throw new Error(`Unhandled printf escape: ${_ex}`);
      }
      }
      continue;
    }
    default:
      appendText({ text: `\\${next}` });
      continue;
    }
  }

  return finish({ stopped: false });
}

function isPrintfConversionSpec(value: string): value is PrintfConversionSpec {
  return PRINTF_CONVERSION_SPECS.has(value as PrintfConversionSpec);
}

function getPrintfPrecisionLimit({
  spec,
}: {
  spec: PrintfConversionSpec,
}): number {
  switch (spec) {
  case 'e':
  case 'E':
  case 'f':
  case 'F':
  case 'g':
  case 'G':
    return PRINTF_MAX_FLOAT_PRECISION;
  case 'b':
  case 'c':
  case 'd':
  case 'i':
  case 'o':
  case 'q':
  case 's':
  case 'u':
  case 'x':
  case 'X':
    return PRINTF_MAX_OTHER_PRECISION;
  default: {
    const _ex: never = spec;
    throw new Error(`Unhandled printf conversion spec: ${_ex}`);
  }
  }
}

function parsePrintfFormat({
  format,
}: {
  format: string,
}): { ok: true, tokens: PrintfToken[] } | { ok: false, message: string } {
  const tokens: PrintfToken[] = [];
  let literal = '';

  const flushLiteral = (): void => {
    if (literal.length === 0) {
      return;
    }
    tokens.push({ kind: 'literal', text: literal });
    literal = '';
  };

  for (let index = 0; index < format.length; index += 1) {
    const char = format[index];
    if (char !== '%') {
      literal += char;
      continue;
    }

    const next = format[index + 1];
    if (next === undefined) {
      return { ok: false, message: "printf: invalid format character '%'" };
    }

    if (next === '%') {
      literal += '%';
      index += 1;
      continue;
    }

    flushLiteral();
    let cursor = index + 1;
    let alternate = false;
    let zeroPad = false;
    let leftAlign = false;
    let showSign = false;
    let leadingSpace = false;

    while (cursor < format.length) {
      const flag = format[cursor];
      switch (flag) {
      case '#':
        alternate = true;
        cursor += 1;
        continue;
      case '0':
        zeroPad = true;
        cursor += 1;
        continue;
      case '-':
        leftAlign = true;
        cursor += 1;
        continue;
      case '+':
        showSign = true;
        cursor += 1;
        continue;
      case ' ':
        leadingSpace = true;
        cursor += 1;
        continue;
      default:
        break;
      }
      break;
    }

    let widthFromArgument = false;
    let width: number | undefined;
    if (format[cursor] === '*') {
      widthFromArgument = true;
      cursor += 1;
    } else {
      let widthText = '';
      while (/^[0-9]$/.test(format[cursor] ?? '')) {
        widthText += format[cursor];
        cursor += 1;
      }
      width = widthText.length === 0 ? undefined : Number.parseInt(widthText, 10);
    }

    let precisionFromArgument = false;
    let precision: number | undefined;
    if (format[cursor] === '.') {
      cursor += 1;
      if (format[cursor] === '*') {
        precisionFromArgument = true;
        cursor += 1;
      } else {
        let precisionText = '';
        while (/^[0-9]$/.test(format[cursor] ?? '')) {
          precisionText += format[cursor];
          cursor += 1;
        }
        precision = precisionText.length === 0 ? 0 : Number.parseInt(precisionText, 10);
      }
    }

    // Bash accepts C printf length modifiers but its string-backed builtin has
    // no narrower/wider argument types to select, so the modifiers do not
    // change the resulting conversion. Consume one valid modifier here while
    // keeping the conversion token itself representation-neutral.
    const lengthModifier = format[cursor];
    let hasLengthModifier = false;
    switch (lengthModifier) {
    case 'h':
    case 'l':
      hasLengthModifier = true;
      cursor += format[cursor + 1] === lengthModifier ? 2 : 1;
      break;
    case 'j':
    case 'z':
    case 't':
    case 'L':
      hasLengthModifier = true;
      cursor += 1;
      break;
    default:
      break;
    }

    const spec = format[cursor];
    if (spec === undefined) {
      return { ok: false, message: 'printf: missing format character' };
    }
    if (!isPrintfConversionSpec(spec)) {
      return { ok: false, message: `printf: invalid format character '${spec}'` };
    }
    if (hasLengthModifier) {
      switch (spec) {
      case 'd':
      case 'i':
      case 'u':
      case 'o':
      case 'x':
      case 'X':
      case 'f':
      case 'F':
      case 'e':
      case 'E':
      case 'g':
      case 'G':
        break;
      case 'b':
      case 'c':
      case 'q':
      case 's':
        return { ok: false, message: `printf: invalid format character '${spec}'` };
      default: {
        const _ex: never = spec;
        throw new Error(`Unhandled printf conversion spec: ${_ex}`);
      }
      }
    }
    if (width !== undefined && (!Number.isFinite(width) || width > PRINTF_MAX_FIELD_WIDTH)) {
      return { ok: false, message: `printf: field width exceeds safety limit ${PRINTF_MAX_FIELD_WIDTH}` };
    }
    const precisionLimit = getPrintfPrecisionLimit({ spec });
    if (precision !== undefined && (!Number.isFinite(precision) || precision > precisionLimit)) {
      return { ok: false, message: `printf: precision exceeds safety limit ${precisionLimit}` };
    }

    tokens.push({
      kind: 'conversion',
      spec,
      flags: {
        alternate,
        zeroPad,
        leftAlign,
        showSign,
        leadingSpace,
      },
      width,
      widthFromArgument,
      precision,
      precisionFromArgument,
    });
    index = cursor;
  }

  flushLiteral();
  return { ok: true, tokens };
}

type PrintfNumericIssue = {
  readonly kind: 'expected-numeric' | 'not-completely-converted',
  readonly value: string,
};

type ParsedPrintfNumericValue<T> = {
  readonly value: T,
  readonly issue: PrintfNumericIssue | undefined,
  readonly ignoredCharacterSuffix: boolean,
  readonly negativeNan?: boolean,
};

const PRINTF_C_WHITESPACE_PREFIX = /^[\t\n\v\f\r ]+/u;

function parsePrintfCharacterConstant({
  value,
  localeMode,
}: {
  value: string,
  localeMode: WeshCharacterLocaleMode,
}): { readonly value: number, readonly ignoredCharacterSuffix: boolean } | undefined {
  if (!(value.startsWith("'") || value.startsWith('"')) || value.length < 2) {
    return undefined;
  }

  const characterText = value.slice(1);
  switch (localeMode) {
  case 'ascii': {
    const bytes = UTF8_ENCODER.encode(characterText);
    return {
      value: bytes[0] ?? 0,
      ignoredCharacterSuffix: bytes.length > 1,
    };
  }
  case 'unicode': {
    const characters = Array.from(characterText);
    return {
      value: characters[0]?.codePointAt(0) ?? 0,
      ignoredCharacterSuffix: characters.length > 1,
    };
  }
  default: {
    const _ex: never = localeMode;
    throw new Error(`Unhandled locale mode: ${_ex}`);
  }
  }
}

function parseIntegerValue({
  value,
  localeMode,
}: {
  value: string | undefined,
  localeMode: WeshCharacterLocaleMode,
}): ParsedPrintfNumericValue<bigint> {
  if (value === undefined) {
    return { value: 0n, issue: undefined, ignoredCharacterSuffix: false };
  }

  const normalized = value.replace(PRINTF_C_WHITESPACE_PREFIX, '');
  const characterConstant = parsePrintfCharacterConstant({ value: normalized, localeMode });
  if (characterConstant !== undefined) {
    return {
      value: BigInt(characterConstant.value),
      issue: undefined,
      ignoredCharacterSuffix: characterConstant.ignoredCharacterSuffix,
    };
  }

  const match = normalized.match(/^[+-]?(?:0[xX][0-9a-fA-F]+|0[0-7]*|[1-9][0-9]*|0)/u);
  if (match === null) {
    return {
      value: 0n,
      issue: { kind: 'expected-numeric', value },
      ignoredCharacterSuffix: false,
    };
  }

  const numericPrefix = match[0];
  let parsed: bigint;
  try {
    const sign = numericPrefix.startsWith('-') ? -1n : 1n;
    const unsigned = numericPrefix.replace(/^[+-]/u, '');
    if (/^0[xX]/u.test(unsigned)) {
      parsed = sign * BigInt(unsigned);
    } else if (/^0[0-7]+$/u.test(unsigned)) {
      parsed = sign * BigInt(`0o${unsigned.slice(1)}`);
    } else {
      parsed = BigInt(numericPrefix);
    }
  } catch {
    parsed = 0n;
  }

  return {
    value: parsed,
    issue: numericPrefix.length === normalized.length
      ? undefined
      : { kind: 'not-completely-converted', value },
    ignoredCharacterSuffix: false,
  };
}

function parseHexFloat({ value }: { value: string }): number {
  const sign = value.startsWith('-') ? -1 : 1;
  const unsigned = value.replace(/^[+-]/u, '').slice(2);
  const [mantissaText, exponentText] = unsigned.split(/[pP]/u, 2);
  const [integerText = '', fractionText = ''] = mantissaText!.split('.', 2);
  let magnitude = integerText.length === 0 ? 0 : Number.parseInt(integerText, 16);
  for (let index = 0; index < fractionText.length; index += 1) {
    magnitude += Number.parseInt(fractionText[index]!, 16) / (16 ** (index + 1));
  }
  return sign * magnitude * (2 ** Number(exponentText ?? 0));
}

function parseFloatValue({
  value,
  localeMode,
}: {
  value: string | undefined,
  localeMode: WeshCharacterLocaleMode,
}): ParsedPrintfNumericValue<number> {
  if (value === undefined) {
    return { value: 0, issue: undefined, ignoredCharacterSuffix: false };
  }

  const normalized = value.replace(PRINTF_C_WHITESPACE_PREFIX, '');
  const characterConstant = parsePrintfCharacterConstant({ value: normalized, localeMode });
  if (characterConstant !== undefined) {
    return {
      value: characterConstant.value,
      issue: undefined,
      ignoredCharacterSuffix: characterConstant.ignoredCharacterSuffix,
    };
  }

  const match = normalized.match(/^[+-]?(?:(?:0[xX](?:[0-9a-fA-F]+(?:\.[0-9a-fA-F]*)?|\.[0-9a-fA-F]+)(?:[pP][+-]?[0-9]+)?)|(?:[0-9]+(?:\.[0-9]*)?|\.[0-9]+)(?:[eE][+-]?[0-9]+)?|inf(?:inity)?|nan(?:\([^)]*\))?)/iu);
  if (match === null) {
    return {
      value: 0,
      issue: { kind: 'expected-numeric', value },
      ignoredCharacterSuffix: false,
    };
  }

  const numericPrefix = match[0];
  let parsed: number;
  let negativeNan = false;
  if (/^[+-]?0[xX]/u.test(numericPrefix)) {
    parsed = parseHexFloat({ value: numericPrefix });
  } else if (/^[+-]?inf(?:inity)?$/iu.test(numericPrefix)) {
    parsed = numericPrefix.startsWith('-') ? -Number.POSITIVE_INFINITY : Number.POSITIVE_INFINITY;
  } else if (/^[+-]?nan/iu.test(numericPrefix)) {
    parsed = Number.NaN;
    negativeNan = numericPrefix.startsWith('-');
  } else {
    parsed = Number(numericPrefix);
  }

  return {
    value: parsed,
    issue: numericPrefix.length === normalized.length
      ? undefined
      : { kind: 'not-completely-converted', value },
    ignoredCharacterSuffix: false,
    negativeNan,
  };
}

function concatenateByteChunks({ chunks }: { chunks: readonly Uint8Array[] }): Uint8Array {
  const byteLength = chunks.reduce((total, chunk) => total + chunk.byteLength, 0);
  const result = new Uint8Array(byteLength);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}

function applyByteWidth({
  bytes,
  width,
  flags,
}: {
  bytes: Uint8Array,
  width: number | undefined,
  flags: PrintfFlags,
}): Uint8Array {
  if (width === undefined || bytes.byteLength >= width) {
    return bytes;
  }

  const padding = new Uint8Array(width - bytes.byteLength);
  padding.fill(0x20);
  return flags.leftAlign
    ? concatenateByteChunks({ chunks: [bytes, padding] })
    : concatenateByteChunks({ chunks: [padding, bytes] });
}

function applyNonNumericTextWidth({
  text,
  width,
  flags,
}: {
  text: string,
  width: number | undefined,
  flags: PrintfFlags,
}): string {
  if (width === undefined || text.length >= width) {
    return text;
  }

  const padding = ' '.repeat(width - text.length);
  return flags.leftAlign ? `${text}${padding}` : `${padding}${text}`;
}

function applyWidth({
  text,
  width,
  flags,
  numericPrefixLength,
  zeroPad = flags.zeroPad,
}: {
  text: string,
  width: number | undefined,
  flags: PrintfFlags,
  numericPrefixLength: number,
  zeroPad?: boolean,
}): string {
  if (width === undefined || text.length >= width) {
    return text;
  }

  const paddingLength = width - text.length;
  if (flags.leftAlign) {
    return `${text}${' '.repeat(paddingLength)}`;
  }
  if (zeroPad) {
    return `${text.slice(0, numericPrefixLength)}${'0'.repeat(paddingLength)}${text.slice(numericPrefixLength)}`;
  }
  return `${' '.repeat(paddingLength)}${text}`;
}

function signedPrefix({
  negative,
  flags,
}: {
  negative: boolean,
  flags: PrintfFlags,
}): string {
  if (negative) {
    return '-';
  }
  if (flags.showSign) {
    return '+';
  }
  if (flags.leadingSpace) {
    return ' ';
  }
  return '';
}

function formatIntegerConversion({
  token,
  parsed,
}: {
  token: PrintfIntegerConversionToken,
  parsed: bigint,
}): string {
  const format = (() => {
    switch (token.spec) {
    case 'd':
    case 'i':
      return { radix: 10, isSigned: true, uppercase: false };
    case 'u':
      return { radix: 10, isSigned: false, uppercase: false };
    case 'o':
      return { radix: 8, isSigned: false, uppercase: false };
    case 'x':
      return { radix: 16, isSigned: false, uppercase: false };
    case 'X':
      return { radix: 16, isSigned: false, uppercase: true };
    default: {
      const _ex: never = token.spec;
      throw new Error(`Unhandled integer conversion: ${_ex}`);
    }
    }
  })();
  const normalized = format.isSigned ? parsed : BigInt.asUintN(64, parsed);
  const negative = format.isSigned && normalized < 0n;
  const magnitude = negative ? -normalized : normalized;

  let digits = magnitude.toString(format.radix);
  if (format.uppercase) {
    digits = digits.toUpperCase();
  }
  if (token.precision === 0 && magnitude === 0n) {
    digits = '';
  } else if (token.precision !== undefined) {
    digits = digits.padStart(token.precision, '0');
  }

  let basePrefix = '';
  if (token.flags.alternate) {
    switch (token.spec) {
    case 'o':
      if (!digits.startsWith('0')) basePrefix = '0';
      break;
    case 'x':
      if (magnitude !== 0n) basePrefix = '0x';
      break;
    case 'X':
      if (magnitude !== 0n) basePrefix = '0X';
      break;
    case 'd':
    case 'i':
    case 'u':
      break;
    default: {
      const _ex: never = token.spec;
      throw new Error(`Unhandled integer conversion: ${_ex}`);
    }
    }
  }
  const sign = format.isSigned ? signedPrefix({ negative, flags: token.flags }) : '';
  const text = `${sign}${basePrefix}${digits}`;
  return applyWidth({
    text,
    width: token.width,
    flags: token.flags,
    numericPrefixLength: sign.length + basePrefix.length,
    // As in C/Bash printf, an explicit integer precision disables the `0`
    // field-width flag. Precision zero-padding has already been applied to the
    // digit sequence above, so applying width zero-padding as well would alter
    // the conversion result rather than merely its field alignment.
    zeroPad: token.flags.zeroPad && token.precision === undefined,
  });
}

function greatestCommonDivisor({ left, right }: { left: bigint, right: bigint }): bigint {
  let a = left < 0n ? -left : left;
  let b = right < 0n ? -right : right;
  while (b !== 0n) {
    const remainder = a % b;
    a = b;
    b = remainder;
  }
  return a;
}

function decomposePositiveFiniteDouble({ value }: { value: number }): {
  readonly significand: bigint,
  readonly exponent2: number,
} {
  const buffer = new ArrayBuffer(8);
  const view = new DataView(buffer);
  view.setFloat64(0, value, false);
  const high = view.getUint32(0, false);
  const low = view.getUint32(4, false);
  const exponentBits = (high >>> 20) & 0x7ff;
  const fraction = (BigInt(high & 0x000f_ffff) << 32n) | BigInt(low);
  if (exponentBits === 0) {
    return {
      significand: fraction,
      exponent2: -1074,
    };
  }
  return {
    significand: (1n << 52n) | fraction,
    exponent2: exponentBits - 1023 - 52,
  };
}

function exactHalfEvenRoundedValue({
  value,
  decimalPlaces,
}: {
  value: number,
  decimalPlaces: number,
}): number | undefined {
  if (!(value > 0) || !Number.isFinite(value) || !Number.isInteger(decimalPlaces)) {
    return undefined;
  }

  const { significand, exponent2 } = decomposePositiveFiniteDouble({ value });
  let numerator = significand;
  let denominator = 1n;
  if (decimalPlaces >= 0) {
    numerator *= 5n ** BigInt(decimalPlaces);
  } else {
    denominator *= 5n ** BigInt(-decimalPlaces);
  }

  const power2 = exponent2 + decimalPlaces;
  if (power2 >= 0) {
    numerator <<= BigInt(power2);
  } else {
    denominator <<= BigInt(-power2);
  }

  const divisor = greatestCommonDivisor({ left: numerator, right: denominator });
  numerator /= divisor;
  denominator /= divisor;
  if (denominator !== 2n || numerator % 2n !== 1n) {
    return undefined;
  }

  const lower = numerator / 2n;
  const rounded = lower % 2n === 0n ? lower : lower + 1n;
  return Number(rounded) * (10 ** -decimalPlaces);
}

function formatFixedHalfEven({
  value,
  fractionDigits,
}: {
  value: number,
  fractionDigits: number,
}): string {
  const adjusted = exactHalfEvenRoundedValue({ value, decimalPlaces: fractionDigits });
  return (adjusted ?? value).toFixed(fractionDigits);
}

function formatExponentialHalfEven({
  value,
  fractionDigits,
}: {
  value: number,
  fractionDigits: number,
}): string {
  if (value === 0) {
    return value.toExponential(fractionDigits);
  }
  const exponent = Math.floor(Math.log10(value));
  const adjusted = exactHalfEvenRoundedValue({
    value,
    decimalPlaces: fractionDigits - exponent,
  });
  return (adjusted ?? value).toExponential(fractionDigits);
}

function normalizeExponent({ text, uppercase }: { text: string, uppercase: boolean }): string {
  const normalized = text.replace(/e([+-])(\d+)$/i, (_match, sign: string, digits: string) => (
    `e${sign}${digits.padStart(2, '0')}`
  ));
  return uppercase ? normalized.toUpperCase() : normalized;
}

function trimFloatingZeros({ text }: { text: string }): string {
  const exponentIndex = text.search(/[eE]/);
  const mantissa = exponentIndex === -1 ? text : text.slice(0, exponentIndex);
  const exponent = exponentIndex === -1 ? '' : text.slice(exponentIndex);
  const trimmedMantissa = mantissa.includes('.')
    ? mantissa.replace(/0+$/, '').replace(/\.$/, '')
    : mantissa;
  return `${trimmedMantissa}${exponent}`;
}

function ensureFloatingDecimalPoint({ text }: { text: string }): string {
  const exponentIndex = text.search(/[eE]/);
  const mantissa = exponentIndex === -1 ? text : text.slice(0, exponentIndex);
  if (mantissa.includes('.')) {
    return text;
  }
  return exponentIndex === -1
    ? `${text}.`
    : `${mantissa}.${text.slice(exponentIndex)}`;
}

function formatGeneralFloat({
  value,
  precision,
  alternate,
  uppercase,
}: {
  value: number,
  precision: number,
  alternate: boolean,
  uppercase: boolean,
}): string {
  if (value === 0) {
    const zero = precision > 1 && alternate ? `0.${'0'.repeat(precision - 1)}` : '0';
    return uppercase ? zero.toUpperCase() : zero;
  }

  const originalExponent = Math.floor(Math.log10(Math.abs(value)));
  const decimalPlaces = precision - originalExponent - 1;
  const exactTieRounded = exactHalfEvenRoundedValue({ value, decimalPlaces });
  const roundedValue = exactTieRounded ?? Number(value.toPrecision(precision));
  const roundedExponent = Math.floor(Math.log10(Math.abs(roundedValue)));

  let rendered: string;
  if (roundedExponent < -4 || roundedExponent >= precision) {
    rendered = normalizeExponent({
      text: roundedValue.toExponential(Math.max(0, precision - 1)),
      uppercase,
    });
  } else {
    const fractionDigits = Math.max(0, precision - roundedExponent - 1);
    rendered = roundedValue.toFixed(fractionDigits);
  }

  if (!alternate) {
    rendered = trimFloatingZeros({ text: rendered });
  }
  return uppercase ? rendered.toUpperCase() : rendered;
}

function formatFloatConversion({
  token,
  parsed,
  negativeNan,
}: {
  token: PrintfFloatConversionToken,
  parsed: number,
  negativeNan: boolean,
}): string {
  const negative = negativeNan || parsed < 0 || Object.is(parsed, -0);
  const magnitude = negative ? -parsed : parsed;
  const uppercase = (() => {
    switch (token.spec) {
    case 'f':
    case 'e':
    case 'g':
      return false;
    case 'F':
    case 'E':
    case 'G':
      return true;
    default: {
      const _ex: never = token.spec;
      throw new Error(`Unhandled floating-point conversion: ${_ex}`);
    }
    }
  })();

  let body: string;
  if (Number.isNaN(magnitude)) {
    body = uppercase ? 'NAN' : 'nan';
  } else if (!Number.isFinite(magnitude)) {
    body = uppercase ? 'INF' : 'inf';
  } else {
    switch (token.spec) {
    case 'f':
    case 'F':
      body = formatFixedHalfEven({ value: magnitude, fractionDigits: token.precision ?? 6 });
      break;
    case 'e':
    case 'E':
      body = normalizeExponent({
        text: formatExponentialHalfEven({ value: magnitude, fractionDigits: token.precision ?? 6 }),
        uppercase,
      });
      break;
    case 'g':
    case 'G':
      body = formatGeneralFloat({
        value: magnitude,
        precision: token.precision === 0 ? 1 : token.precision ?? 6,
        alternate: token.flags.alternate,
        uppercase,
      });
      break;
    default: {
      const _ex: never = token.spec;
      throw new Error(`Unhandled floating-point conversion: ${_ex}`);
    }
    }
    if (token.flags.alternate) {
      body = ensureFloatingDecimalPoint({ text: body });
    }
  }

  const sign = signedPrefix({ negative, flags: token.flags });
  return applyWidth({
    text: `${sign}${body}`,
    width: token.width,
    flags: token.flags,
    numericPrefixLength: sign.length,
    // Bash/glibc pad NaN and infinity with spaces even when `0` is present.
    // Finite floating-point conversions continue to use zero field padding.
    zeroPad: token.flags.zeroPad && Number.isFinite(magnitude),
  });
}

function quoteForBashPrintf({
  source,
  localeMode,
}: {
  source: string,
  localeMode: WeshCharacterLocaleMode,
}): string {
  if (source.length === 0) {
    return "''";
  }

  const hasSurrogateEscapes = Array.from(source).some((character) => {
    const codeUnit = character.charCodeAt(0);
    return codeUnit >= 0xdc80 && codeUnit <= 0xdcff;
  });
  if (hasSurrogateEscapes) {
    const escaped = Array.from(encodeCommandDataText({ text: source })).map((byte) => {
      switch (byte) {
      case 0x07:
        return '\\a';
      case 0x08:
        return '\\b';
      case 0x1b:
        return '\\E';
      case 0x0c:
        return '\\f';
      case 0x0a:
        return '\\n';
      case 0x0d:
        return '\\r';
      case 0x09:
        return '\\t';
      case 0x0b:
        return '\\v';
      case 0x5c:
        return '\\\\';
      case 0x27:
        return "\\'";
      default:
        if (byte < 0x20 || byte === 0x7f || byte >= 0x80) {
          return `\\${byte.toString(8).padStart(3, '0')}`;
        }
        return String.fromCharCode(byte);
      }
    }).join('');
    return `$'${escaped}'`;
  }

  const sourceBytes = UTF8_ENCODER.encode(source);
  if (localeMode === 'ascii' && sourceBytes.some(byte => byte >= 0x80)) {
    const escaped = Array.from(sourceBytes).map((byte) => {
      switch (byte) {
      case 0x07:
        return '\\a';
      case 0x08:
        return '\\b';
      case 0x1b:
        return '\\E';
      case 0x0c:
        return '\\f';
      case 0x0a:
        return '\\n';
      case 0x0d:
        return '\\r';
      case 0x09:
        return '\\t';
      case 0x0b:
        return '\\v';
      case 0x5c:
        return '\\\\';
      case 0x27:
        return "\\'";
      default:
        if (byte < 0x20 || byte === 0x7f || byte >= 0x80) {
          return `\\${byte.toString(8).padStart(3, '0')}`;
        }
        return String.fromCharCode(byte);
      }
    }).join('');
    return `$'${escaped}'`;
  }

  if (Array.from(source).some((char) => {
    const codePoint = char.codePointAt(0) ?? 0;
    return codePoint < 0x20
      || (codePoint >= 0x7f && codePoint <= 0x9f)
      || codePoint === 0x2028
      || codePoint === 0x2029;
  })) {
    const escaped = Array.from(source).map((char) => {
      switch (char) {
      case '\u0007':
        return '\\a';
      case '\b':
        return '\\b';
      case '\u001b':
        return '\\E';
      case '\f':
        return '\\f';
      case '\n':
        return '\\n';
      case '\r':
        return '\\r';
      case '\t':
        return '\\t';
      case '\v':
        return '\\v';
      case '\\':
        return '\\\\';
      case "'":
        return "\\'";
      default: {
        const codePoint = char.codePointAt(0) ?? 0;
        if (codePoint < 0x20 || codePoint === 0x7f) {
          return `\\x${codePoint.toString(16).padStart(2, '0')}`;
        }
        if (
          (codePoint >= 0x80 && codePoint <= 0x9f)
          || codePoint === 0x2028
          || codePoint === 0x2029
        ) {
          return Array.from(UTF8_ENCODER.encode(char), byte => (
            `\\${byte.toString(8).padStart(3, '0')}`
          )).join('');
        }
        return char;
      }
      }
    }).join('');
    return `$'${escaped}'`;
  }

  return Array.from(source).map((char, index) => {
    const codePoint = char.codePointAt(0) ?? 0;
    const safeUnicode = localeMode === 'unicode'
      && codePoint > 0x9f
      && codePoint !== 0x2028
      && codePoint !== 0x2029;
    const safeEverywhere = /^[A-Za-z0-9_@%+=:./-]$/u.test(char) || safeUnicode;
    const safeAfterFirstCharacter = index > 0 && (char === '#' || char === '~');
    return safeEverywhere || safeAfterFirstCharacter ? char : `\\${char}`;
  }).join('');
}

function formatPrintfToken({
  token,
  value,
  localeMode,
}: {
  token: PrintfToken,
  value: string | undefined,
  localeMode: WeshCharacterLocaleMode,
}): {
  readonly text: string,
  readonly bytes: Uint8Array,
  readonly stopped: boolean,
  readonly numericIssue?: PrintfNumericIssue,
  readonly ignoredCharacterSuffix?: boolean,
} {
  switch (token.kind) {
  case 'literal':
    return decodePrintfEscapes({ text: token.text, stopOnControlC: true });
  case 'conversion':
    switch (token.spec) {
    case 's': {
      const source = value ?? '';
      const sourceBytes = encodeCommandDataText({ text: source });
      const bytes = token.precision === undefined
        ? sourceBytes
        : sourceBytes.slice(0, token.precision);
      const text = token.precision === undefined
        ? source
        : Array.from(source).slice(0, token.precision).join('');
      return {
        text: applyNonNumericTextWidth({ text, width: token.width, flags: token.flags }),
        bytes: applyByteWidth({ bytes, width: token.width, flags: token.flags }),
        stopped: false,
      };
    }
    case 'b': {
      const decoded = decodePrintfEscapes({ text: value ?? '', stopOnControlC: true });
      const bytes = token.precision === undefined
        ? decoded.bytes
        : decoded.bytes.slice(0, token.precision);
      return {
        text: applyNonNumericTextWidth({
          text: token.precision === undefined ? decoded.text : decoded.text.slice(0, token.precision),
          width: token.width,
          flags: token.flags,
        }),
        bytes: applyByteWidth({ bytes, width: token.width, flags: token.flags }),
        stopped: decoded.stopped,
      };
    }
    case 'c': {
      const source = value === undefined || value.length === 0 ? '\0' : value;
      const sourceBytes = encodeCommandDataText({ text: source });
      const bytes = sourceBytes.slice(0, 1);
      const text = value === undefined || value.length === 0 ? '\0' : Array.from(value)[0]!;
      return {
        text: applyNonNumericTextWidth({ text, width: token.width, flags: token.flags }),
        bytes: applyByteWidth({ bytes, width: token.width, flags: token.flags }),
        stopped: false,
      };
    }
    case 'd':
    case 'i':
    case 'u':
    case 'o':
    case 'x':
    case 'X': {
      const parsed = parseIntegerValue({ value, localeMode });
      const text = formatIntegerConversion({ token: { ...token, spec: token.spec }, parsed: parsed.value });
      return {
        text,
        bytes: UTF8_ENCODER.encode(text),
        stopped: false,
        numericIssue: parsed.issue,
        ignoredCharacterSuffix: parsed.ignoredCharacterSuffix,
      };
    }
    case 'f':
    case 'F':
    case 'e':
    case 'E':
    case 'g':
    case 'G': {
      const parsed = parseFloatValue({ value, localeMode });
      const text = formatFloatConversion({
        token: { ...token, spec: token.spec },
        parsed: parsed.value,
        negativeNan: parsed.negativeNan === true,
      });
      return {
        text,
        bytes: UTF8_ENCODER.encode(text),
        stopped: false,
        numericIssue: parsed.issue,
        ignoredCharacterSuffix: parsed.ignoredCharacterSuffix,
      };
    }
    case 'q': {
      const quoted = quoteForBashPrintf({ source: value ?? '', localeMode });
      const quotedBytes = UTF8_ENCODER.encode(quoted);
      const bytes = token.precision === undefined
        ? quotedBytes
        : quotedBytes.slice(0, token.precision);
      const text = token.precision === undefined
        ? quoted
        : Array.from(quoted).slice(0, token.precision).join('');
      return {
        text: applyNonNumericTextWidth({ text, width: token.width, flags: token.flags }),
        bytes: applyByteWidth({ bytes, width: token.width, flags: token.flags }),
        stopped: false,
      };
    }
    default: {
      const _ex: never = token.spec;
      throw new Error(`Unhandled printf spec: ${_ex}`);
    }
    }
  default: {
    const _ex: never = token;
    throw new Error(`Unhandled printf token: ${_ex}`);
  }
  }
}

function isShellIdentifier({ value }: { value: string }): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*$/u.test(value);
}

export const printfCommandDefinition: WeshCommandDefinition = {
  meta: {
    name: 'printf',
    description: 'Format and print data',
    usage: 'printf [-v var] FORMAT [ARGUMENT]...',
  },
  fn: async ({ context }: { context: WeshCommandContext }): Promise<WeshCommandResult> => {
    if (context.args.length === 1 && context.args[0] === '--help') {
      await writeCommandHelp({
        context,
        command: 'printf',
        argvSpec: printfArgvSpec,
      });
      return { exitCode: 0 };
    }

    if (context.args.length === 0) {
      await writeCommandUsageError({
        context,
        command: 'printf',
        message: 'printf: missing format operand',
        argvSpec: printfArgvSpec,
      });
      return { exitCode: 1 };
    }

    let normalizedArgs = context.args;
    let variableName: string | undefined;
    const firstArgument = normalizedArgs[0];
    if (firstArgument === '--') {
      normalizedArgs = normalizedArgs.slice(1);
    } else if (firstArgument === '-v') {
      variableName = normalizedArgs[1];
      if (variableName === undefined) {
        await writeCommandUsageError({
          context,
          command: 'printf',
          message: 'printf: -v: option requires an argument',
          argvSpec: printfArgvSpec,
        });
        return { exitCode: 2 };
      }
      normalizedArgs = normalizedArgs.slice(2);
    } else if (firstArgument?.startsWith('-v') === true && firstArgument.length > 2) {
      variableName = firstArgument.slice(2);
      normalizedArgs = normalizedArgs.slice(1);
    } else if (firstArgument?.startsWith('-') === true && firstArgument.length > 1) {
      await writeCommandUsageError({
        context,
        command: 'printf',
        message: `printf: ${firstArgument}: invalid option`,
        argvSpec: printfArgvSpec,
      });
      return { exitCode: 2 };
    }

    if (variableName !== undefined) {
      const formatCandidate = normalizedArgs[0];
      if (formatCandidate === '--') {
        normalizedArgs = normalizedArgs.slice(1);
      } else if (formatCandidate?.startsWith('-') === true && formatCandidate.length > 1) {
        await writeCommandUsageError({
          context,
          command: 'printf',
          message: `printf: ${formatCandidate}: invalid option`,
          argvSpec: printfArgvSpec,
        });
        return { exitCode: 2 };
      }
    }

    if (variableName !== undefined && !isShellIdentifier({ value: variableName })) {
      await context.text().error({
        text: `printf: \`${variableName}': not a valid identifier\n`,
      });
      return { exitCode: 2 };
    }

    const [format, ...args] = normalizedArgs;
    if (format === undefined) {
      await writeCommandUsageError({
        context,
        command: 'printf',
        message: 'printf: missing format operand',
        argvSpec: printfArgvSpec,
      });
      return { exitCode: variableName === undefined ? 1 : 2 };
    }

    if (variableName !== undefined) {
      context.setEnv({ key: variableName, value: '' });
    }

    const parsed = parsePrintfFormat({ format });
    if (!parsed.ok) {
      await writeCommandUsageError({
        context,
        command: 'printf',
        message: parsed.message,
        argvSpec: printfArgvSpec,
      });
      return { exitCode: 1 };
    }

    const conversionCount = parsed.tokens.reduce((count, token) => {
      switch (token.kind) {
      case 'literal':
        return count;
      case 'conversion':
        return count + 1;
      default: {
        const _ex: never = token;
        throw new Error(`Unhandled printf token: ${((_ex satisfies never) as { readonly kind: string }).kind}`);
      }
      }
    }, 0);
    let argIndex = 0;
    let didRunCycle = false;
    let exitCode = 0;
    let variableOutput = '';
    const localeMode = resolveCharacterLocaleMode({ env: context.env });

    const reportNumericStatus = async ({
      ignoredCharacterSuffix,
      numericIssue,
    }: {
      ignoredCharacterSuffix: boolean | undefined,
      numericIssue: PrintfNumericIssue | undefined,
    }): Promise<void> => {
      if (ignoredCharacterSuffix === true) {
        await context.text().error({
          text: 'printf: warning: character(s) following character constant have been ignored\n',
        });
      }
      if (numericIssue === undefined) {
        return;
      }

      let message: string;
      switch (numericIssue.kind) {
      case 'expected-numeric':
        message = 'expected a numeric value';
        break;
      case 'not-completely-converted':
        message = 'value not completely converted';
        break;
      default: {
        const _ex: never = numericIssue.kind;
        throw new Error(`Unhandled numeric issue: ${_ex}`);
      }
      }
      await context.text().error({
        text: `printf: '${numericIssue.value}': ${message}\n`,
      });
      exitCode = 1;
    };

    const emitFormatted = async ({
      text,
      bytes,
    }: {
      text: string,
      bytes: Uint8Array,
    }): Promise<void> => {
      if (variableName === undefined) {
        await writeAllBytesToHandle({ handle: context.stdout, data: bytes });
        return;
      }
      variableOutput += text;
    };

    const commitVariableOutput = (): void => {
      if (variableName !== undefined) {
        context.setEnv({ key: variableName, value: variableOutput });
      }
    };

    const takeArgument = (): string | undefined => {
      const value = args[argIndex];
      if (argIndex < args.length) {
        argIndex += 1;
      }
      return value;
    };

    while (conversionCount === 0 ? !didRunCycle : argIndex < args.length || !didRunCycle) {
      didRunCycle = true;
      for (const token of parsed.tokens) {
        let value: string | undefined;
        let resolvedToken: PrintfToken = token;
        switch (token.kind) {
        case 'literal':
          value = undefined;
          break;
        case 'conversion': {
          let resolvedWidth = token.width;
          let resolvedPrecision = token.precision;
          let resolvedFlags = token.flags;

          if (token.widthFromArgument) {
            const parsedWidth = parseIntegerValue({ value: takeArgument(), localeMode });
            if (parsedWidth.ignoredCharacterSuffix || parsedWidth.issue !== undefined) {
              await reportNumericStatus({
                ignoredCharacterSuffix: parsedWidth.ignoredCharacterSuffix,
                numericIssue: parsedWidth.issue,
              });
            }
            const widthMagnitude = parsedWidth.value < 0n ? -parsedWidth.value : parsedWidth.value;
            if (widthMagnitude > BigInt(PRINTF_MAX_FIELD_WIDTH)) {
              await context.text().error({
                text: `printf: field width exceeds safety limit ${PRINTF_MAX_FIELD_WIDTH}\n`,
              });
              commitVariableOutput();
              return { exitCode: 1 };
            }
            resolvedWidth = Number(widthMagnitude);
            if (parsedWidth.value < 0n && !resolvedFlags.leftAlign) {
              resolvedFlags = { ...resolvedFlags, leftAlign: true };
            }
          }

          if (token.precisionFromArgument) {
            const parsedPrecision = parseIntegerValue({ value: takeArgument(), localeMode });
            if (parsedPrecision.ignoredCharacterSuffix || parsedPrecision.issue !== undefined) {
              await reportNumericStatus({
                ignoredCharacterSuffix: parsedPrecision.ignoredCharacterSuffix,
                numericIssue: parsedPrecision.issue,
              });
            }
            if (parsedPrecision.value < 0n) {
              // C/Bash treat a negative dynamic precision as if precision was omitted.
              resolvedPrecision = undefined;
            } else {
              const precisionLimit = getPrintfPrecisionLimit({ spec: token.spec });
              if (parsedPrecision.value > BigInt(precisionLimit)) {
                await context.text().error({
                  text: `printf: precision exceeds safety limit ${precisionLimit}\n`,
                });
                commitVariableOutput();
                return { exitCode: 1 };
              }
              resolvedPrecision = Number(parsedPrecision.value);
            }
          }

          value = takeArgument();
          if (token.widthFromArgument || token.precisionFromArgument) {
            resolvedToken = {
              ...token,
              flags: resolvedFlags,
              width: resolvedWidth,
              widthFromArgument: false,
              precision: resolvedPrecision,
              precisionFromArgument: false,
            };
          }
          break;
        }
        default: {
          const _ex: never = token;
          throw new Error(`Unhandled printf token: ${((_ex satisfies never) as { readonly kind: string }).kind}`);
        }
        }
        const formatted = formatPrintfToken({ token: resolvedToken, value, localeMode });
        if (formatted.ignoredCharacterSuffix || formatted.numericIssue !== undefined) {
          await reportNumericStatus({
            ignoredCharacterSuffix: formatted.ignoredCharacterSuffix,
            numericIssue: formatted.numericIssue,
          });
        }
        await emitFormatted({ text: formatted.text, bytes: formatted.bytes });
        if (formatted.stopped) {
          commitVariableOutput();
          return { exitCode: 0 };
        }
      }
      if (conversionCount === 0 || argIndex >= args.length) {
        break;
      }
    }

    commitVariableOutput();
    return { exitCode };
  },
};

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
