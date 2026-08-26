import type { StandardArgvParserSpec } from '@/features/wesh/argv';
import type { WeshCommandContext, WeshCommandDefinition, WeshCommandResult } from '@/features/wesh/types';
import { stripLeadingCLocaleWhitespace } from '@/features/wesh/commands/_shared/numeric-whitespace';
import { writeCommandHelp, writeCommandUsageError } from '@/features/wesh/commands/_shared/usage';
import { createBufferedTextWriter } from '@/features/wesh/utils/io';

interface SeqParsedArgs {
  help: boolean,
  separator: string,
  equalWidth: boolean,
  format: string | undefined,
  positionals: string[],
  diagnostic: string | undefined,
}

type SeqPrintfConversion = 'f' | 'F' | 'e' | 'E' | 'g' | 'G';
type SeqSignMode = 'minus-only' | 'always' | 'space';

interface SeqPrintfSpec {
  kind: 'printf',
  prefix: string,
  suffix: string,
  conversion: SeqPrintfConversion,
  width: number | undefined,
  zeroPad: boolean,
  leftAlign: boolean,
  signMode: SeqSignMode,
  precision: number | undefined,
}

type SeqFormatSpec =
  | { kind: 'plain' }
  | SeqPrintfSpec;

interface SeqDecimal {
  coefficient: bigint,
  scale: number,
  negativeZero: boolean,
  printWidth: number,
}

interface SeqPlan {
  first: bigint,
  increment: bigint,
  last: bigint,
  count: number,
  scale: number,
  outputPrecision: number,
  firstInputWidth: number,
  firstInputPrecision: number,
  lastInputWidth: number,
  lastInputPrecision: number,
  firstIsNegativeZero: boolean,
  lastIsNegativeZero: boolean,
}

interface SeqValue {
  coefficient: bigint,
  scale: number,
  negativeZero: boolean,
}

const MAXIMUM_DECIMAL_SCALE = 10_000;
const MAXIMUM_SEQUENCE_VALUES = 1_000_001;
const DECIMAL_OPERAND_PATTERN = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/u;
const HEXADECIMAL_INTEGER_OPERAND_PATTERN = /^[+-]?0[xX][0-9a-fA-F]+$/u;

const seqArgvSpec: StandardArgvParserSpec = {
  options: [
    { kind: 'flag', short: undefined, long: 'help', effects: [{ key: 'help', value: true }], help: { summary: 'display this help and exit', category: 'common' } },
    { kind: 'value', short: 's', long: 'separator', key: 'separator', valueName: 'STRING', allowAttachedValue: true, parseValue: undefined, help: { summary: 'use STRING to separate numbers', valueName: 'STRING', category: 'common' } },
    { kind: 'flag', short: 'w', long: 'equal-width', effects: [{ key: 'equalWidth', value: true }], help: { summary: 'equalize width by padding with leading zeroes', category: 'common' } },
    { kind: 'value', short: 'f', long: 'format', key: 'format', valueName: 'FORMAT', allowAttachedValue: true, parseValue: undefined, help: { summary: 'use printf style floating-point FORMAT', valueName: 'FORMAT', category: 'advanced' } },
  ],
  allowShortFlagBundles: false,
  stopAtDoubleDash: true,
  treatSingleDashAsPositional: true,
  specialTokenParsers: [],
};

function isNumericOperand({
  value,
}: {
  value: string,
}): boolean {
  return DECIMAL_OPERAND_PATTERN.test(value) || HEXADECIMAL_INTEGER_OPERAND_PATTERN.test(value);
}

function powerOfTen({
  exponent,
}: {
  exponent: number,
}): bigint {
  return 10n ** BigInt(exponent);
}

function getSeqDecimalPrintWidth({
  numericText,
}: {
  numericText: string,
}): number {
  const arg = numericText.startsWith('+') ? numericText.slice(1) : numericText;
  if (HEXADECIMAL_INTEGER_OPERAND_PATTERN.test(arg)) {
    return 0;
  }

  let width = arg.length;
  const decimalPointIndex = arg.indexOf('.');
  const lowerExponentIndex = arg.indexOf('e');
  const upperExponentIndex = arg.indexOf('E');
  const exponentIndex = lowerExponentIndex >= 0 ? lowerExponentIndex : upperExponentIndex;
  const fractionLength = decimalPointIndex < 0
    ? 0
    : (exponentIndex >= 0 ? exponentIndex : arg.length) - decimalPointIndex - 1;

  if (decimalPointIndex >= 0) {
    if (fractionLength === 0) {
      width -= 1;
    } else if (decimalPointIndex === 0 || !/[0-9]/u.test(arg[decimalPointIndex - 1]!)) {
      width += 1;
    }
  }

  if (exponentIndex >= 0) {
    let exponent = Number(arg.slice(exponentIndex + 1));
    let precision = fractionLength;
    precision += exponent < 0
      ? -exponent
      : -Math.min(precision, exponent);

    width -= arg.length - exponentIndex;
    if (exponent < 0) {
      if (decimalPointIndex >= 0) {
        if (exponentIndex === decimalPointIndex + 1) {
          width += 1;
        }
      } else {
        width += 1;
      }
      exponent = -exponent;
    } else {
      if (decimalPointIndex >= 0 && precision === 0 && fractionLength > 0) {
        width -= 1;
      }
      exponent -= Math.min(fractionLength, exponent);
    }
    width += exponent;
  }

  return width;
}

function parseSeqDecimal({
  value,
}: {
  value: string,
}): { ok: true, decimal: SeqDecimal } | { ok: false, message: string } {
  const numericText = stripLeadingCLocaleWhitespace({ value });
  const hexadecimalMatch = /^([+-]?)0[xX]([0-9a-fA-F]+)$/u.exec(numericText);
  if (hexadecimalMatch !== null) {
    const sign = hexadecimalMatch[1] ?? '';
    const digits = hexadecimalMatch[2] ?? '0';
    let coefficient = BigInt(`0x${digits}`);
    if (sign === '-') {
      coefficient = -coefficient;
    }
    return {
      ok: true,
      decimal: {
        coefficient,
        scale: 0,
        negativeZero: sign === '-' && coefficient === 0n,
        printWidth: 0,
      },
    };
  }

  const match = /^([+-]?)(?:(\d+)(?:\.(\d*))?|\.(\d+))(?:[eE]([+-]?\d+))?$/u.exec(numericText);
  if (match === null) {
    return { ok: false, message: `invalid floating point argument: '${value}'` };
  }

  const sign = match[1] ?? '';
  const integerPart = match[2] ?? '';
  const fractionPart = match[2] === undefined ? (match[4] ?? '') : (match[3] ?? '');
  const exponentText = match[5] ?? '0';
  const exponent = Number(exponentText);
  if (!Number.isSafeInteger(exponent)) {
    return { ok: false, message: `invalid floating point argument: '${value}'` };
  }

  let scale = fractionPart.length - exponent;
  if (Math.abs(scale) > MAXIMUM_DECIMAL_SCALE) {
    return { ok: false, message: `invalid floating point argument: '${value}'` };
  }

  const digits = `${integerPart}${fractionPart}`.replace(/^0+(?=\d)/u, '') || '0';
  if (digits.length + Math.max(0, -scale) > MAXIMUM_DECIMAL_SCALE) {
    return { ok: false, message: `invalid floating point argument: '${value}'` };
  }

  let coefficient = BigInt(digits);
  if (scale < 0) {
    coefficient *= powerOfTen({ exponent: -scale });
    scale = 0;
  }
  if (sign === '-') {
    coefficient = -coefficient;
  }

  return {
    ok: true,
    decimal: {
      coefficient,
      scale,
      negativeZero: sign === '-' && coefficient === 0n,
      printWidth: getSeqDecimalPrintWidth({ numericText }),
    },
  };
}

function parseSeqArgs({
  args,
}: {
  args: string[],
}): SeqParsedArgs {
  const parsed: SeqParsedArgs = {
    help: false,
    separator: '\n',
    equalWidth: false,
    format: undefined,
    positionals: [],
    diagnostic: undefined,
  };

  let optionsDone = false;
  for (let index = 0; index < args.length; index++) {
    const token = args[index];
    if (token === undefined) continue;

    if (!optionsDone && token === '--') {
      optionsDone = true;
      continue;
    }

    if (!optionsDone && token === '--help') {
      parsed.help = true;
      return parsed;
    }

    if (!optionsDone && token === '--equal-width') {
      parsed.equalWidth = true;
      continue;
    }

    if (!optionsDone && (token === '--separator' || token.startsWith('--separator='))) {
      const value = token.startsWith('--separator=') ? token.slice('--separator='.length) : args[index + 1];
      if (value === undefined) {
        parsed.diagnostic = 'seq: option requires a value for STRING';
        break;
      }
      parsed.separator = value;
      if (token === '--separator') {
        index += 1;
      }
      continue;
    }

    if (!optionsDone && (token === '--format' || token.startsWith('--format='))) {
      const value = token.startsWith('--format=') ? token.slice('--format='.length) : args[index + 1];
      if (value === undefined) {
        parsed.diagnostic = 'seq: option requires a value for FORMAT';
        break;
      }
      parsed.format = value;
      if (token === '--format') {
        index += 1;
      }
      continue;
    }

    if (!optionsDone && token.startsWith('--')) {
      parsed.diagnostic = `seq: unrecognized option '${token}'`;
      break;
    }

    if (
      !optionsDone
      && token.length > 1
      && token.startsWith('-')
      && !isNumericOperand({ value: token })
    ) {
      let optionIndex = 1;
      let consumedFollowingArgument = false;
      while (optionIndex < token.length) {
        const option = token[optionIndex]!;
        switch (option) {
        case 'w':
          parsed.equalWidth = true;
          optionIndex += 1;
          break;
        case 's':
        case 'f': {
          const attachedValue = token.slice(optionIndex + 1);
          const value = attachedValue.length > 0
            ? attachedValue
            : args[index + 1];
          if (value === undefined) {
            switch (option) {
            case 's':
              parsed.diagnostic = 'seq: option requires a value for STRING';
              break;
            case 'f':
              parsed.diagnostic = 'seq: option requires a value for FORMAT';
              break;
            default: {
              const _ex: never = option;
              throw new Error(`Unhandled seq value option: ${_ex}`);
            }
            }
            optionIndex = token.length;
            break;
          }
          switch (option) {
          case 's':
            parsed.separator = value;
            break;
          case 'f':
            parsed.format = value;
            break;
          default: {
            const _ex: never = option;
            throw new Error(`Unhandled seq value option: ${_ex}`);
          }
          }
          consumedFollowingArgument = attachedValue.length === 0;
          optionIndex = token.length;
          break;
        }
        default:
          parsed.diagnostic = `seq: invalid option -- '${option}'`;
          optionIndex = token.length;
          break;
        }
      }
      if (parsed.diagnostic !== undefined) {
        break;
      }
      if (consumedFollowingArgument) {
        index += 1;
      }
      continue;
    }

    parsed.positionals.push(token);
    optionsDone = true;
  }

  return parsed;
}

function parseSeqFormatSpec({
  format,
}: {
  format: string,
}): { ok: true, spec: SeqFormatSpec } | { ok: false, message: string } {
  if (format.length === 0) {
    return { ok: true, spec: { kind: 'plain' } };
  }

  let prefix = '';
  let suffix = '';
  let placeholder: Omit<SeqPrintfSpec, 'prefix' | 'suffix'> | undefined;
  let readingSuffix = false;

  for (let index = 0; index < format.length; index++) {
    const char = format[index];
    if (char !== '%') {
      if (readingSuffix) {
        suffix += char;
      } else {
        prefix += char;
      }
      continue;
    }

    const next = format[index + 1];
    if (next === undefined) {
      return { ok: false, message: "seq: invalid format string: ends with '%'" };
    }

    if (next === '%') {
      if (readingSuffix) {
        suffix += '%';
      } else {
        prefix += '%';
      }
      index += 1;
      continue;
    }

    if (placeholder !== undefined) {
      return { ok: false, message: 'seq: invalid format string: multiple conversion specifications' };
    }

    let cursor = index + 1;
    let zeroPad = false;
    let leftAlign = false;
    let signMode: SeqSignMode = 'minus-only';
    while (cursor < format.length) {
      const flag = format[cursor];
      if (flag === '0') {
        zeroPad = true;
      } else if (flag === '-') {
        leftAlign = true;
      } else if (flag === '+') {
        signMode = 'always';
      } else if (flag === ' ' && signMode !== 'always') {
        signMode = 'space';
      } else {
        break;
      }
      cursor += 1;
    }

    let widthText = '';
    while (cursor < format.length && /[0-9]/u.test(format[cursor] ?? '')) {
      widthText += format[cursor];
      cursor += 1;
    }

    let precision: number | undefined;
    if (format[cursor] === '.') {
      cursor += 1;
      let precisionText = '';
      while (cursor < format.length && /[0-9]/u.test(format[cursor] ?? '')) {
        precisionText += format[cursor];
        cursor += 1;
      }
      precision = precisionText.length === 0 ? 0 : Number(precisionText);
      if (!Number.isSafeInteger(precision) || precision > 100) {
        return { ok: false, message: 'seq: invalid format string: precision out of range' };
      }
    }

    const conversion = format[cursor];
    if (conversion === undefined || !['f', 'F', 'e', 'E', 'g', 'G'].includes(conversion)) {
      return { ok: false, message: `seq: invalid format string: unsupported conversion '${conversion ?? '%'}'` };
    }

    const width = widthText.length > 0 ? Number(widthText) : undefined;
    if (width !== undefined && (!Number.isSafeInteger(width) || width > 1_000_000)) {
      return { ok: false, message: 'seq: invalid format string: width out of range' };
    }

    placeholder = {
      kind: 'printf',
      conversion: conversion as SeqPrintfConversion,
      width,
      zeroPad: zeroPad && !leftAlign,
      leftAlign,
      signMode,
      precision,
    };
    readingSuffix = true;
    index = cursor;
  }

  if (placeholder === undefined) {
    return { ok: false, message: 'seq: invalid format string: missing conversion specification' };
  }

  return { ok: true, spec: { prefix, suffix, ...placeholder } };
}

function applyPrintfSign({
  text,
  negative,
  signMode,
}: {
  text: string,
  negative: boolean,
  signMode: SeqSignMode,
}): string {
  if (negative) {
    return text.startsWith('-') ? text : `-${text}`;
  }
  if (text.startsWith('+')) {
    return text;
  }
  switch (signMode) {
  case 'minus-only':
    return text;
  case 'always':
    return `+${text}`;
  case 'space':
    return ` ${text}`;
  default: {
    const _ex: never = signMode;
    throw new Error(`Unhandled seq sign mode: ${_ex}`);
  }
  }
}

function applyPrintfWidth({
  text,
  spec,
}: {
  text: string,
  spec: SeqPrintfSpec,
}): string {
  if (spec.width === undefined || text.length >= spec.width) {
    return text;
  }
  if (spec.leftAlign) {
    return text.padEnd(spec.width, ' ');
  }
  if (!spec.zeroPad) {
    return text.padStart(spec.width, ' ');
  }
  if (text.startsWith('-') || text.startsWith('+') || text.startsWith(' ')) {
    return `${text[0]}${text.slice(1).padStart(spec.width - 1, '0')}`;
  }
  return text.padStart(spec.width, '0');
}

interface BinaryRational {
  numerator: bigint,
  denominator: bigint,
}

interface LongDoubleValue {
  numerator: bigint,
  denominator: bigint,
  negativeZero: boolean,
}

function bitLength({ value }: { value: bigint }): number {
  return value === 0n ? 0 : value.toString(2).length;
}

function compareRationalToPowerOfTwo({
  numerator,
  denominator,
  exponent,
}: {
  numerator: bigint,
  denominator: bigint,
  exponent: number,
}): number {
  const left = exponent >= 0 ? numerator : numerator << BigInt(-exponent);
  const right = exponent >= 0 ? denominator << BigInt(exponent) : denominator;
  return left < right ? -1 : left > right ? 1 : 0;
}

function divideRoundedToEven({
  numerator,
  denominator,
}: {
  numerator: bigint,
  denominator: bigint,
}): bigint {
  const quotient = numerator / denominator;
  const remainder = numerator % denominator;
  const doubledRemainder = remainder * 2n;
  if (doubledRemainder > denominator || (doubledRemainder === denominator && quotient % 2n !== 0n)) {
    return quotient + 1n;
  }
  return quotient;
}

function quantizeLongDoubleRational({
  numerator: signedNumerator,
  denominator,
  negativeZero = false,
}: {
  numerator: bigint,
  denominator: bigint,
  negativeZero?: boolean,
}): LongDoubleValue {
  const negative = signedNumerator < 0n;
  const numerator = negative ? -signedNumerator : signedNumerator;
  if (numerator === 0n) {
    return { numerator: 0n, denominator: 1n, negativeZero };
  }
  let exponent = bitLength({ value: numerator }) - bitLength({ value: denominator });
  while (compareRationalToPowerOfTwo({ numerator, denominator, exponent }) < 0) exponent -= 1;
  while (compareRationalToPowerOfTwo({ numerator, denominator, exponent: exponent + 1 }) >= 0) exponent += 1;

  const minimumNormalExponent = -16_382;
  const effectiveExponent = Math.max(exponent, minimumNormalExponent);
  const shift = 63 - effectiveExponent;
  const scaledNumerator = shift >= 0 ? numerator << BigInt(shift) : numerator;
  const scaledDenominator = shift >= 0 ? denominator : denominator << BigInt(-shift);
  let significand = divideRoundedToEven({
    numerator: scaledNumerator,
    denominator: scaledDenominator,
  });
  let roundedExponent = effectiveExponent;
  if (significand >= 1n << 64n) {
    significand >>= 1n;
    roundedExponent += 1;
  }
  if (roundedExponent > 16_383) {
    throw new Error('seq: value is too large for the selected format');
  }
  const binaryExponent = roundedExponent - 63;
  const roundedNumerator = binaryExponent >= 0
    ? significand << BigInt(binaryExponent)
    : significand;
  return {
    numerator: negative ? -roundedNumerator : roundedNumerator,
    denominator: binaryExponent >= 0 ? 1n : 1n << BigInt(-binaryExponent),
    negativeZero: false,
  };
}

function seqValueToLongDouble({ value }: { value: SeqValue }): LongDoubleValue {
  return quantizeLongDoubleRational({
    numerator: value.coefficient,
    denominator: powerOfTen({ exponent: value.scale }),
    negativeZero: value.negativeZero,
  });
}

function seqDecimalToLongDouble({ decimal }: { decimal: SeqDecimal }): LongDoubleValue {
  return quantizeLongDoubleRational({
    numerator: decimal.coefficient,
    denominator: powerOfTen({ exponent: decimal.scale }),
    negativeZero: decimal.negativeZero,
  });
}

function addLongDoubleValues({
  left,
  right,
}: {
  left: LongDoubleValue,
  right: LongDoubleValue,
}): LongDoubleValue {
  return quantizeLongDoubleRational({
    numerator: left.numerator * right.denominator + right.numerator * left.denominator,
    denominator: left.denominator * right.denominator,
    negativeZero: left.negativeZero && right.negativeZero,
  });
}

function multiplyLongDoubleByInteger({
  value,
  multiplier,
}: {
  value: LongDoubleValue,
  multiplier: number,
}): LongDoubleValue {
  return quantizeLongDoubleRational({
    numerator: value.numerator * BigInt(multiplier),
    denominator: value.denominator,
    negativeZero: multiplier === 0 && (value.numerator < 0n || value.negativeZero),
  });
}

function compareLongDoubleValues({
  left,
  right,
}: {
  left: LongDoubleValue,
  right: LongDoubleValue,
}): number {
  const leftScaled = left.numerator * right.denominator;
  const rightScaled = right.numerator * left.denominator;
  return leftScaled < rightScaled ? -1 : leftScaled > rightScaled ? 1 : 0;
}

function formattedLongDoubleNumericValue({
  rendered,
  spec,
}: {
  rendered: string,
  spec: SeqPrintfSpec,
}): LongDoubleValue | undefined {
  const suffixStart = rendered.length - spec.suffix.length;
  const numericText = rendered.slice(spec.prefix.length, suffixStart);
  const parsed = parseSeqDecimal({ value: numericText });
  return parsed.ok ? seqDecimalToLongDouble({ decimal: parsed.decimal }) : undefined;
}

function shouldPrintOutOfRangeValue({
  value,
  previousValue,
  lastValue,
  spec,
}: {
  value: LongDoubleValue,
  previousValue: LongDoubleValue,
  lastValue: LongDoubleValue,
  spec: SeqPrintfSpec,
}): boolean {
  const rendered = formatLongDoubleValue({ value, spec });
  const parsed = formattedLongDoubleNumericValue({ rendered, spec });
  return parsed !== undefined
    && compareLongDoubleValues({ left: parsed, right: lastValue }) === 0
    && formatLongDoubleValue({ value: previousValue, spec }) !== rendered;
}

function* iterateLongDoubleSeqValues({
  first,
  increment,
  last,
  spec,
}: {
  first: SeqDecimal,
  increment: SeqDecimal,
  last: SeqDecimal,
  spec: SeqPrintfSpec,
}): Iterable<LongDoubleValue> {
  const firstValue = seqDecimalToLongDouble({ decimal: first });
  const incrementValue = seqDecimalToLongDouble({ decimal: increment });
  const lastValue = seqDecimalToLongDouble({ decimal: last });
  if (incrementValue.numerator === 0n) {
    throw new Error('seq: invalid zero increment');
  }
  const increasing = incrementValue.numerator > 0n;
  let previousValue: LongDoubleValue | undefined;
  for (let index = 0; index < MAXIMUM_SEQUENCE_VALUES; index++) {
    const value = index === 0
      ? firstValue
      : addLongDoubleValues({
        left: firstValue,
        right: multiplyLongDoubleByInteger({ value: incrementValue, multiplier: index }),
      });
    const comparison = compareLongDoubleValues({ left: value, right: lastValue });
    if (increasing ? comparison > 0 : comparison < 0) {
      if (previousValue !== undefined && shouldPrintOutOfRangeValue({
        value,
        previousValue,
        lastValue,
        spec,
      })) {
        yield value;
      }
      return;
    }
    yield value;
    previousValue = value;
  }
  throw new Error('seq: sequence contains too many values');
}

function compareRationalToPowerOfTen({
  rational,
  exponent,
}: {
  rational: BinaryRational,
  exponent: number,
}): number {
  const left = exponent >= 0
    ? rational.numerator
    : rational.numerator * powerOfTen({ exponent: -exponent });
  const right = exponent >= 0
    ? rational.denominator * powerOfTen({ exponent })
    : rational.denominator;
  return left < right ? -1 : left > right ? 1 : 0;
}

function decimalExponent({
  rational,
}: {
  rational: BinaryRational,
}): number {
  let exponent = rational.numerator.toString().length - rational.denominator.toString().length;
  while (compareRationalToPowerOfTen({ rational, exponent }) < 0) {
    exponent -= 1;
  }
  while (compareRationalToPowerOfTen({ rational, exponent: exponent + 1 }) >= 0) {
    exponent += 1;
  }
  return exponent;
}

function roundBinaryRational({
  rational,
  decimalShift,
}: {
  rational: BinaryRational,
  decimalShift: number,
}): bigint {
  const numerator = decimalShift >= 0
    ? rational.numerator * powerOfTen({ exponent: decimalShift })
    : rational.numerator;
  const denominator = decimalShift >= 0
    ? rational.denominator
    : rational.denominator * powerOfTen({ exponent: -decimalShift });
  return divideRoundedToEven({ numerator, denominator });
}

function formatFixedRational({
  rational,
  precision,
}: {
  rational: BinaryRational,
  precision: number,
}): string {
  const rounded = roundBinaryRational({ rational, decimalShift: precision });
  const digits = rounded.toString().padStart(precision + 1, '0');
  return precision === 0
    ? digits
    : `${digits.slice(0, -precision)}.${digits.slice(-precision)}`;
}

interface RoundedSignificantDigits {
  digits: string,
  exponent: number,
}

function roundToSignificantDigits({
  rational,
  precision,
}: {
  rational: BinaryRational,
  precision: number,
}): RoundedSignificantDigits {
  if (rational.numerator === 0n) {
    return { digits: '0'.repeat(precision), exponent: 0 };
  }
  let exponent = decimalExponent({ rational });
  let rounded = roundBinaryRational({
    rational,
    decimalShift: precision - 1 - exponent,
  });
  const overflowThreshold = powerOfTen({ exponent: precision });
  if (rounded >= overflowThreshold) {
    rounded /= 10n;
    exponent += 1;
  }
  return {
    digits: rounded.toString().padStart(precision, '0'),
    exponent,
  };
}

function formatExponentialRational({
  rational,
  precision,
}: {
  rational: BinaryRational,
  precision: number,
}): string {
  const rounded = roundToSignificantDigits({ rational, precision: precision + 1 });
  const fraction = precision === 0 ? '' : `.${rounded.digits.slice(1).padEnd(precision, '0')}`;
  const exponentSign = rounded.exponent < 0 ? '-' : '+';
  const exponentDigits = Math.abs(rounded.exponent).toString().padStart(2, '0');
  return `${rounded.digits[0]}${fraction}e${exponentSign}${exponentDigits}`;
}

function trimFixedFraction({ text }: { text: string }): string {
  return text.includes('.')
    ? text.replace(/0+$/u, '').replace(/\.$/u, '')
    : text;
}

function formatGeneralNumber({
  rational,
  precision,
}: {
  rational: BinaryRational,
  precision: number,
}): string {
  if (rational.numerator === 0n) {
    return '0';
  }
  const rounded = roundToSignificantDigits({ rational, precision });
  if (rounded.exponent < -4 || rounded.exponent >= precision) {
    const mantissa = trimFixedFraction({
      text: precision === 1
        ? rounded.digits[0]!
        : `${rounded.digits[0]}.${rounded.digits.slice(1)}`,
    });
    const exponentSign = rounded.exponent < 0 ? '-' : '+';
    const exponentDigits = Math.abs(rounded.exponent).toString().padStart(2, '0');
    return `${mantissa}e${exponentSign}${exponentDigits}`;
  }

  const decimalPosition = rounded.exponent + 1;
  if (decimalPosition <= 0) {
    return trimFixedFraction({
      text: `0.${'0'.repeat(-decimalPosition)}${rounded.digits}`,
    });
  }
  if (decimalPosition >= rounded.digits.length) {
    return `${rounded.digits}${'0'.repeat(decimalPosition - rounded.digits.length)}`;
  }
  return trimFixedFraction({
    text: `${rounded.digits.slice(0, decimalPosition)}.${rounded.digits.slice(decimalPosition)}`,
  });
}

function formatLongDoubleValue({
  value,
  spec,
}: {
  value: LongDoubleValue,
  spec: SeqFormatSpec,
}): string {
  const negative = value.numerator < 0n || (value.numerator === 0n && value.negativeZero);
  const rational: BinaryRational = {
    numerator: value.numerator < 0n ? -value.numerator : value.numerator,
    denominator: value.denominator,
  };
  switch (spec.kind) {
  case 'plain':
    throw new Error('seq: plain formatting must use exact decimal values');
  case 'printf': {
    let text: string;
    switch (spec.conversion) {
    case 'f':
    case 'F':
      text = formatFixedRational({ rational, precision: spec.precision ?? 6 });
      break;
    case 'e':
    case 'E':
      text = formatExponentialRational({ rational, precision: spec.precision ?? 6 });
      break;
    case 'g':
    case 'G': {
      const precision = spec.precision === 0 ? 1 : (spec.precision ?? 6);
      text = formatGeneralNumber({ rational, precision });
      break;
    }
    default: {
      const _ex: never = spec.conversion;
      throw new Error(`Unhandled seq conversion: ${_ex}`);
    }
    }

    if (spec.conversion === 'F' || spec.conversion === 'E' || spec.conversion === 'G') {
      text = text.toUpperCase();
    }

    text = applyPrintfSign({ text, negative, signMode: spec.signMode });
    text = applyPrintfWidth({ text, spec });
    return `${spec.prefix}${text}${spec.suffix}`;
  }
  default: {
    const _ex: never = spec;
    throw new Error(`Unhandled seq spec: ${_ex}`);
  }
  }
}

function alignDecimal({
  decimal,
  scale,
}: {
  decimal: SeqDecimal,
  scale: number,
}): bigint {
  return decimal.coefficient * powerOfTen({ exponent: scale - decimal.scale });
}

function createSeqPlan({
  first,
  increment,
  last,
}: {
  first: SeqDecimal,
  increment: SeqDecimal,
  last: SeqDecimal,
}): { ok: true, plan: SeqPlan } | { ok: false, message: string } {
  const scale = Math.max(first.scale, increment.scale, last.scale);
  const outputPrecision = Math.max(first.scale, increment.scale);
  const alignedFirst = alignDecimal({ decimal: first, scale });
  const alignedIncrement = alignDecimal({ decimal: increment, scale });
  const alignedLast = alignDecimal({ decimal: last, scale });
  if (alignedIncrement === 0n) {
    return { ok: false, message: 'seq: invalid zero increment' };
  }

  const distance = alignedIncrement > 0n
    ? alignedLast - alignedFirst
    : alignedFirst - alignedLast;
  if (distance < 0n) {
    return {
      ok: true,
      plan: {
        first: alignedFirst,
        increment: alignedIncrement,
        last: alignedLast,
        count: 0,
        scale,
        outputPrecision,
        firstInputWidth: first.printWidth,
        firstInputPrecision: first.scale,
        lastInputWidth: last.printWidth,
        lastInputPrecision: last.scale,
        firstIsNegativeZero: first.negativeZero,
        lastIsNegativeZero: last.negativeZero,
      },
    };
  }

  const positiveIncrement = alignedIncrement > 0n ? alignedIncrement : -alignedIncrement;
  const count = distance / positiveIncrement + 1n;
  if (count > BigInt(MAXIMUM_SEQUENCE_VALUES)) {
    return { ok: false, message: 'seq: sequence contains too many values' };
  }

  return {
    ok: true,
    plan: {
      first: alignedFirst,
      increment: alignedIncrement,
      last: alignedLast,
      count: Number(count),
      scale,
      outputPrecision,
      firstInputWidth: first.printWidth,
      firstInputPrecision: first.scale,
      lastInputWidth: last.printWidth,
      lastInputPrecision: last.scale,
      firstIsNegativeZero: first.negativeZero,
      lastIsNegativeZero: last.negativeZero,
    },
  };
}

function formatExactDecimal({
  value,
  precision,
}: {
  value: SeqValue,
  precision: number,
}): string {
  const negative = value.coefficient < 0n || (value.coefficient === 0n && value.negativeZero);
  const absolute = value.coefficient < 0n ? -value.coefficient : value.coefficient;
  const scaleDifference = precision - value.scale;
  const scaled = scaleDifference >= 0
    ? absolute * powerOfTen({ exponent: scaleDifference })
    : absolute / powerOfTen({ exponent: -scaleDifference });
  const digits = scaled.toString();
  const sign = negative ? '-' : '';
  if (precision === 0) {
    return `${sign}${digits}`;
  }
  const padded = digits.padStart(precision + 1, '0');
  return `${sign}${padded.slice(0, -precision)}.${padded.slice(-precision)}`;
}

function padEqualWidth({
  value,
  width,
}: {
  value: string,
  width: number,
}): string {
  if (value.length >= width) {
    return value;
  }

  if (value.startsWith('-') || value.startsWith('+')) {
    return `${value[0]}${value.slice(1).padStart(width - 1, '0')}`;
  }

  return value.padStart(width, '0');
}

function equalWidthForSeqPlan({
  plan,
}: {
  plan: SeqPlan,
}): number {
  if (plan.count === 0) {
    return 0;
  }

  let firstWidth = plan.firstInputWidth + (plan.outputPrecision - plan.firstInputPrecision);
  let lastWidth = plan.lastInputWidth + (plan.outputPrecision - plan.lastInputPrecision);
  if (plan.lastInputPrecision > 0 && plan.outputPrecision === 0) {
    lastWidth -= 1;
  }
  if (plan.lastInputPrecision === 0 && plan.outputPrecision > 0) {
    lastWidth += 1;
  }
  if (plan.firstInputPrecision === 0 && plan.outputPrecision > 0) {
    firstWidth += 1;
  }

  return Math.max(firstWidth, lastWidth);
}

function exactZeroIndexForSeqPlan({
  plan,
}: {
  plan: SeqPlan,
}): number | undefined {
  const distanceToZero = -plan.first;
  if (distanceToZero % plan.increment !== 0n) {
    return undefined;
  }
  const index = distanceToZero / plan.increment;
  return index >= 0n && index < BigInt(plan.count)
    ? Number(index)
    : undefined;
}

function generatedExactZeroIsNegative({
  plan,
  index,
}: {
  plan: SeqPlan,
  index: number,
}): boolean {
  if (index === 0) {
    return plan.firstIsNegativeZero;
  }

  const firstValue = quantizeLongDoubleRational({
    numerator: plan.first,
    denominator: powerOfTen({ exponent: plan.scale }),
    negativeZero: plan.firstIsNegativeZero,
  });
  const incrementValue = quantizeLongDoubleRational({
    numerator: plan.increment,
    denominator: powerOfTen({ exponent: plan.scale }),
  });
  const generatedValue = addLongDoubleValues({
    left: firstValue,
    right: multiplyLongDoubleByInteger({ value: incrementValue, multiplier: index }),
  });
  return generatedValue.numerator < 0n
    || (generatedValue.numerator === 0n && generatedValue.negativeZero);
}

function* iterateSeqValues({
  plan,
}: {
  plan: SeqPlan,
}): Iterable<SeqValue> {
  const exactZeroIndex = exactZeroIndexForSeqPlan({ plan });
  let coefficient = plan.first;
  for (let index = 0; index < plan.count; index++) {
    yield {
      coefficient,
      scale: plan.scale,
      negativeZero: index === exactZeroIndex && generatedExactZeroIsNegative({ plan, index }),
    };
    coefficient += plan.increment;
  }
}

export const seqCommandDefinition: WeshCommandDefinition = {
  meta: {
    name: 'seq',
    description: 'Print a sequence of numbers',
    usage: 'seq [OPTION]... LAST | seq [OPTION]... FIRST LAST | seq [OPTION]... FIRST INCREMENT LAST',
  },
  fn: async ({ context }: { context: WeshCommandContext }): Promise<WeshCommandResult> => {
    const parsed = parseSeqArgs({ args: context.args });
    if (parsed.diagnostic !== undefined) {
      await writeCommandUsageError({
        context,
        command: 'seq',
        message: parsed.diagnostic,
        argvSpec: seqArgvSpec,
      });
      return { exitCode: 1 };
    }

    if (parsed.help) {
      await writeCommandHelp({
        context,
        command: 'seq',
        argvSpec: seqArgvSpec,
      });
      return { exitCode: 0 };
    }

    const operands = parsed.positionals;
    if (operands.length === 0) {
      await writeCommandUsageError({
        context,
        command: 'seq',
        message: 'seq: missing operand',
        argvSpec: seqArgvSpec,
      });
      return { exitCode: 1 };
    }

    if (operands.length > 3) {
      await writeCommandUsageError({
        context,
        command: 'seq',
        message: 'seq: extra operand',
        argvSpec: seqArgvSpec,
      });
      return { exitCode: 1 };
    }

    const parsedOperands = operands.map((operand) => parseSeqDecimal({ value: operand }));
    const failedOperand = parsedOperands.find((operand) => !operand.ok);
    if (failedOperand !== undefined && !failedOperand.ok) {
      await writeCommandUsageError({
        context,
        command: 'seq',
        message: failedOperand.message,
        argvSpec: seqArgvSpec,
      });
      return { exitCode: 1 };
    }

    const decimals = parsedOperands.map((operand) => {
      if (!operand.ok) {
        throw new Error('Validated seq operand unexpectedly failed');
      }
      return operand.decimal;
    });
    const one: SeqDecimal = { coefficient: 1n, scale: 0, negativeZero: false, printWidth: 1 };
    const first = operands.length > 1 ? (decimals[0] ?? one) : one;
    const increment = operands.length > 2 ? (decimals[1] ?? one) : one;
    const last = operands.length === 1
      ? (decimals[0] ?? one)
      : operands.length === 2
        ? (decimals[1] ?? one)
        : (decimals[2] ?? one);

    const planned = createSeqPlan({ first, increment, last });
    if (!planned.ok) {
      await writeCommandUsageError({
        context,
        command: 'seq',
        message: planned.message,
        argvSpec: seqArgvSpec,
      });
      return { exitCode: 1 };
    }

    if (parsed.equalWidth && parsed.format !== undefined) {
      await writeCommandUsageError({
        context,
        command: 'seq',
        message: 'seq: format string may not be specified when printing equal width strings',
        argvSpec: seqArgvSpec,
      });
      return { exitCode: 1 };
    }

    let formatSpec: SeqFormatSpec = { kind: 'plain' };
    if (parsed.format !== undefined) {
      const parsedFormat = parseSeqFormatSpec({ format: parsed.format });
      if (!parsedFormat.ok) {
        await writeCommandUsageError({
          context,
          command: 'seq',
          message: parsedFormat.message,
          argvSpec: seqArgvSpec,
        });
        return { exitCode: 1 };
      }
      formatSpec = parsedFormat.spec;
    }

    const renderValue = ({ value }: { value: SeqValue }): string => {
      if (parsed.format === undefined) {
        return formatExactDecimal({ value, precision: planned.plan.outputPrecision });
      }
      return formatLongDoubleValue({ value: seqValueToLongDouble({ value }), spec: formatSpec });
    };

    const equalWidth = parsed.equalWidth
      ? equalWidthForSeqPlan({ plan: planned.plan })
      : undefined;

    const writer = createBufferedTextWriter({
      handle: context.stdout,
      maxBufferLength: 16 * 1024,
    });
    let wroteValue = false;
    try {
      if (parsed.format === undefined) {
        for (const value of iterateSeqValues({ plan: planned.plan })) {
          if (wroteValue) await writer.write({ text: parsed.separator });
          const rendered = renderValue({ value });
          await writer.write({
            text: equalWidth === undefined
              ? rendered
              : padEqualWidth({ value: rendered, width: equalWidth }),
          });
          wroteValue = true;
        }
      } else {
        const printfSpec = (() => {
          switch (formatSpec.kind) {
          case 'printf':
            return formatSpec;
          case 'plain':
            throw new Error('seq: formatted iteration requires printf format');
          default: {
            const _ex: never = formatSpec;
            throw new Error(`Unhandled seq format: ${((_ex satisfies never) as { readonly kind: string }).kind}`);
          }
          }
        })();
        for (const value of iterateLongDoubleSeqValues({
          first,
          increment,
          last,
          spec: printfSpec,
        })) {
          if (wroteValue) await writer.write({ text: parsed.separator });
          await writer.write({ text: formatLongDoubleValue({ value, spec: printfSpec }) });
          wroteValue = true;
        }
      }
      if (wroteValue) {
        await writer.write({ text: '\n' });
      }
    } finally {
      await writer.flush();
    }

    return { exitCode: 0 };
  },
};

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
  equalWidthForSeqPlan,
};
