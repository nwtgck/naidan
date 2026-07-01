import { CALCULATOR_LIMITS } from '@/features/calculator/logic/limits';
import { NumericLimitError } from './numeric-limit-error';

export type Decimal = Readonly<{
  coefficient: bigint,
  exponent: number,
}>;

export type DecimalRoundingMode = 'half_even' | 'half_away_from_zero';

const POWERS_OF_TEN: bigint[] = [1n];

export function absoluteBigInt({ value }: { value: bigint }): bigint {
  return value < 0n ? -value : value;
}

export function decimalDigitCount({ value }: { value: bigint }): number {
  return absoluteBigInt({ value }).toString().length;
}

export function compareScaledIntegerMagnitudes({
  leftCoefficient,
  leftExponent,
  rightCoefficient,
  rightExponent,
}: {
  leftCoefficient: bigint,
  leftExponent: number,
  rightCoefficient: bigint,
  rightExponent: number,
}): number {
  if (leftCoefficient < 0n || rightCoefficient < 0n) {
    throw new Error('Scaled magnitude comparison requires non-negative coefficients.');
  }
  if (leftCoefficient === 0n) return rightCoefficient === 0n ? 0 : -1;
  if (rightCoefficient === 0n) return 1;
  const leftDigits = leftCoefficient.toString();
  const rightDigits = rightCoefficient.toString();
  const leftAdjustedLength = leftDigits.length + leftExponent;
  const rightAdjustedLength = rightDigits.length + rightExponent;
  if (leftAdjustedLength !== rightAdjustedLength) {
    return leftAdjustedLength < rightAdjustedLength ? -1 : 1;
  }
  const comparisonLength = Math.max(leftDigits.length, rightDigits.length);
  for (let index = 0; index < comparisonLength; index += 1) {
    const leftDigit = index < leftDigits.length ? leftDigits.charCodeAt(index) : 48;
    const rightDigit = index < rightDigits.length ? rightDigits.charCodeAt(index) : 48;
    if (leftDigit !== rightDigit) return leftDigit < rightDigit ? -1 : 1;
  }
  return 0;
}

function ensureExponentAllowed({ exponent }: { exponent: number }): void {
  if (!Number.isSafeInteger(exponent)
    || Math.abs(exponent) > CALCULATOR_LIMITS.maximumExponentMagnitude) {
    throw new NumericLimitError({
      reason: 'exponent',
      message: `Decimal exponent exceeds ${CALCULATOR_LIMITS.maximumExponentMagnitude}.`,
    });
  }
}

function ensureCoefficientAllowed({ coefficient }: { coefficient: bigint }): void {
  if (decimalDigitCount({ value: coefficient }) > CALCULATOR_LIMITS.maximumCoefficientDigits) {
    throw new NumericLimitError({
      reason: 'coefficient_digits',
      message: `Decimal coefficient exceeds ${CALCULATOR_LIMITS.maximumCoefficientDigits} digits.`,
    });
  }
}

export function powerOfTen({ exponent, reason }: {
  exponent: number,
  reason: 'alignment' | 'materialized_integer',
}): bigint {
  if (!Number.isSafeInteger(exponent) || exponent < 0) {
    throw new Error(`Invalid non-negative power-of-ten exponent: ${exponent}`);
  }
  const maximum = (() => {
    switch (reason) {
    case 'alignment': return CALCULATOR_LIMITS.maximumAlignmentDigits;
    case 'materialized_integer': return CALCULATOR_LIMITS.maximumMaterializedIntegerDigits;
    default: {
      const _exhaustive: never = reason;
      throw new Error(`Unhandled power-of-ten reason: ${String(_exhaustive)}`);
    }
    }
  })();
  if (exponent > maximum) {
    throw new NumericLimitError({
      reason,
      message: `Materializing 10^${exponent} exceeds the ${maximum}-place ${reason} limit.`,
    });
  }
  while (POWERS_OF_TEN.length <= exponent) {
    POWERS_OF_TEN.push(POWERS_OF_TEN[POWERS_OF_TEN.length - 1]! * 10n);
  }
  return POWERS_OF_TEN[exponent]!;
}

export function createDecimal({ coefficient, exponent }: {
  coefficient: bigint,
  exponent: number,
}): Decimal {
  if (coefficient === 0n) return { coefficient: 0n, exponent: 0 };
  let normalizedCoefficient = coefficient;
  let normalizedExponent = exponent;
  while (normalizedCoefficient % 10n === 0n) {
    normalizedCoefficient /= 10n;
    normalizedExponent += 1;
  }
  ensureExponentAllowed({ exponent: normalizedExponent });
  ensureCoefficientAllowed({ coefficient: normalizedCoefficient });
  return { coefficient: normalizedCoefficient, exponent: normalizedExponent };
}

function parseBoundedExponent({ text }: { text: string }): number {
  const negative = text.startsWith('-');
  const unsigned = text.startsWith('+') || negative ? text.slice(1) : text;
  const canonical = unsigned.replace(/^0+/u, '') || '0';
  const maximum = String(CALCULATOR_LIMITS.maximumExponentMagnitude);
  if (canonical.length > maximum.length
    || (canonical.length === maximum.length && canonical > maximum)) {
    throw new NumericLimitError({
      reason: 'exponent',
      message: `Decimal exponent exceeds ${CALCULATOR_LIMITS.maximumExponentMagnitude}.`,
    });
  }
  const value = Number(canonical);
  return negative ? -value : value;
}

export function parseDecimalLiteral({ literal }: { literal: string }): Decimal {
  const match = /^(?<integer>\d*)(?:\.(?<fraction>\d*))?(?:[eE](?<exponent>[+-]?\d+))?$/u.exec(literal);
  if (match === null || match.groups === undefined) {
    throw new Error(`Invalid validated decimal literal: ${literal}`);
  }
  const integer = match.groups.integer ?? '';
  const fraction = match.groups.fraction ?? '';
  if (integer.length === 0 && fraction.length === 0) {
    throw new Error(`Invalid validated decimal literal without digits: ${literal}`);
  }
  const explicitExponent = match.groups.exponent === undefined
    ? 0
    : parseBoundedExponent({ text: match.groups.exponent });
  const combined = `${integer}${fraction}`.replace(/^0+/u, '');
  if (combined.length === 0) return createDecimal({ coefficient: 0n, exponent: 0 });
  const trailingZeroCount = combined.length - combined.replace(/0+$/u, '').length;
  const coefficientText = trailingZeroCount === 0 ? combined : combined.slice(0, -trailingZeroCount);
  if (coefficientText.length > CALCULATOR_LIMITS.maximumCoefficientDigits) {
    throw new NumericLimitError({
      reason: 'coefficient_digits',
      message: `Numeric literal exceeds ${CALCULATOR_LIMITS.maximumCoefficientDigits} significant digits.`,
    });
  }
  return createDecimal({
    coefficient: BigInt(coefficientText),
    exponent: explicitExponent - fraction.length + trailingZeroCount,
  });
}

export function negateDecimal({ decimal }: { decimal: Decimal }): Decimal {
  return { coefficient: -decimal.coefficient, exponent: decimal.exponent };
}

export function absoluteDecimal({ decimal }: { decimal: Decimal }): Decimal {
  return decimal.coefficient < 0n ? negateDecimal({ decimal }) : decimal;
}

export function adjustedDecimalExponent({ decimal }: { decimal: Decimal }): number {
  if (decimal.coefficient === 0n) return 0;
  return decimalDigitCount({ value: decimal.coefficient }) + decimal.exponent - 1;
}

function compareAbsoluteDecimals({ left, right }: { left: Decimal, right: Decimal }): number {
  return compareScaledIntegerMagnitudes({
    leftCoefficient: absoluteBigInt({ value: left.coefficient }),
    leftExponent: left.exponent,
    rightCoefficient: absoluteBigInt({ value: right.coefficient }),
    rightExponent: right.exponent,
  });
}

export function compareDecimals({ left, right }: { left: Decimal, right: Decimal }): number {
  if (left.coefficient === 0n) return right.coefficient === 0n ? 0 : right.coefficient < 0n ? 1 : -1;
  if (right.coefficient === 0n) return left.coefficient < 0n ? -1 : 1;
  if (left.coefficient < 0n && right.coefficient >= 0n) return -1;
  if (left.coefficient >= 0n && right.coefficient < 0n) return 1;
  const comparison = compareAbsoluteDecimals({
    left: absoluteDecimal({ decimal: left }),
    right: absoluteDecimal({ decimal: right }),
  });
  return left.coefficient < 0n ? -comparison : comparison;
}

function shouldRoundUp({ quotient, remainder, divisor, mode }: {
  quotient: bigint,
  remainder: bigint,
  divisor: bigint,
  mode: DecimalRoundingMode,
}): boolean {
  const doubled = remainder * 2n;
  if (doubled < divisor) return false;
  if (doubled > divisor) return true;
  return mode === 'half_away_from_zero' || quotient % 2n !== 0n;
}

export function roundDecimalToSignificantDigits({ decimal, significantDigits, mode }: {
  decimal: Decimal,
  significantDigits: number,
  mode: DecimalRoundingMode,
}): Decimal {
  if (!Number.isInteger(significantDigits) || significantDigits < 1) {
    throw new Error(`Invalid significant digit count: ${significantDigits}`);
  }
  if (decimal.coefficient === 0n) return decimal;
  const digits = decimalDigitCount({ value: decimal.coefficient });
  if (digits <= significantDigits) return decimal;
  const droppedDigits = digits - significantDigits;
  const divisor = powerOfTen({ exponent: droppedDigits, reason: 'alignment' });
  const absolute = absoluteBigInt({ value: decimal.coefficient });
  let quotient = absolute / divisor;
  const remainder = absolute % divisor;
  if (shouldRoundUp({ quotient, remainder, divisor, mode })) quotient += 1n;
  return createDecimal({
    coefficient: decimal.coefficient < 0n ? -quotient : quotient,
    exponent: decimal.exponent + droppedDigits,
  });
}

export function roundDecimalToDecimalPlaces({ decimal, decimalPlaces, mode }: {
  decimal: Decimal,
  decimalPlaces: number,
  mode: DecimalRoundingMode,
}): Decimal {
  if (!Number.isSafeInteger(decimalPlaces)) throw new Error(`Invalid decimal place count: ${decimalPlaces}`);
  const targetExponent = -decimalPlaces;
  if (decimal.coefficient === 0n || decimal.exponent >= targetExponent) return decimal;
  const droppedDigits = targetExponent - decimal.exponent;
  const digits = decimalDigitCount({ value: decimal.coefficient });
  if (droppedDigits > digits + 1) return createDecimal({ coefficient: 0n, exponent: 0 });
  const divisor = powerOfTen({ exponent: droppedDigits, reason: 'alignment' });
  const absolute = absoluteBigInt({ value: decimal.coefficient });
  let quotient = absolute / divisor;
  const remainder = absolute % divisor;
  if (shouldRoundUp({ quotient, remainder, divisor, mode })) quotient += 1n;
  return createDecimal({
    coefficient: decimal.coefficient < 0n ? -quotient : quotient,
    exponent: targetExponent,
  });
}

export function addApproximateDecimals({ left, right, significantDigits }: {
  left: Decimal,
  right: Decimal,
  significantDigits: number,
}): Decimal {
  const roundedLeft = roundDecimalToSignificantDigits({ decimal: left, significantDigits, mode: 'half_even' });
  const roundedRight = roundDecimalToSignificantDigits({ decimal: right, significantDigits, mode: 'half_even' });
  if (roundedLeft.coefficient === 0n) return roundedRight;
  if (roundedRight.coefficient === 0n) return roundedLeft;
  const gap = Math.abs(
    adjustedDecimalExponent({ decimal: roundedLeft }) - adjustedDecimalExponent({ decimal: roundedRight }),
  );
  if (gap > significantDigits + 1) {
    return compareAbsoluteDecimals({
      left: absoluteDecimal({ decimal: roundedLeft }),
      right: absoluteDecimal({ decimal: roundedRight }),
    }) >= 0 ? roundedLeft : roundedRight;
  }
  const targetExponent = Math.min(roundedLeft.exponent, roundedRight.exponent);
  const leftCoefficient = roundedLeft.coefficient * powerOfTen({
    exponent: roundedLeft.exponent - targetExponent,
    reason: 'alignment',
  });
  const rightCoefficient = roundedRight.coefficient * powerOfTen({
    exponent: roundedRight.exponent - targetExponent,
    reason: 'alignment',
  });
  return roundDecimalToSignificantDigits({
    decimal: createDecimal({ coefficient: leftCoefficient + rightCoefficient, exponent: targetExponent }),
    significantDigits,
    mode: 'half_even',
  });
}

export function multiplyApproximateDecimals({ left, right, significantDigits }: {
  left: Decimal,
  right: Decimal,
  significantDigits: number,
}): Decimal {
  const roundedLeft = roundDecimalToSignificantDigits({ decimal: left, significantDigits, mode: 'half_even' });
  const roundedRight = roundDecimalToSignificantDigits({ decimal: right, significantDigits, mode: 'half_even' });
  return roundDecimalToSignificantDigits({
    decimal: createDecimal({
      coefficient: roundedLeft.coefficient * roundedRight.coefficient,
      exponent: roundedLeft.exponent + roundedRight.exponent,
    }),
    significantDigits,
    mode: 'half_even',
  });
}

function adjustedRatioExponent({ numerator, denominator, decimalExponent }: {
  numerator: bigint,
  denominator: bigint,
  decimalExponent: number,
}): number {
  const numeratorDigits = decimalDigitCount({ value: numerator });
  const denominatorDigits = decimalDigitCount({ value: denominator });
  const base = numeratorDigits - denominatorDigits;
  const lower = base >= 0
    ? compareScaledIntegerMagnitudes({
      leftCoefficient: numerator,
      leftExponent: 0,
      rightCoefficient: denominator,
      rightExponent: base,
    }) < 0
    : compareScaledIntegerMagnitudes({
      leftCoefficient: numerator,
      leftExponent: -base,
      rightCoefficient: denominator,
      rightExponent: 0,
    }) < 0;
  return decimalExponent + base + (lower ? -1 : 0);
}

export function divideIntegerRatioToDecimal({ numerator, denominator, decimalExponent, significantDigits }: {
  numerator: bigint,
  denominator: bigint,
  decimalExponent: number,
  significantDigits: number,
}): Decimal {
  if (denominator <= 0n) throw new Error('Decimal ratio denominator must be positive.');
  if (numerator === 0n) return createDecimal({ coefficient: 0n, exponent: 0 });
  const negative = numerator < 0n;
  const absoluteNumerator = absoluteBigInt({ value: numerator });
  const adjustedExponent = adjustedRatioExponent({ numerator: absoluteNumerator, denominator, decimalExponent });
  const shift = decimalExponent + significantDigits - 1 - adjustedExponent;
  const scaledNumerator = shift >= 0
    ? absoluteNumerator * powerOfTen({ exponent: shift, reason: 'materialized_integer' })
    : absoluteNumerator;
  const scaledDenominator = shift >= 0
    ? denominator
    : denominator * powerOfTen({ exponent: -shift, reason: 'materialized_integer' });
  let quotient = scaledNumerator / scaledDenominator;
  const remainder = scaledNumerator % scaledDenominator;
  if (shouldRoundUp({ quotient, remainder, divisor: scaledDenominator, mode: 'half_even' })) quotient += 1n;
  return createDecimal({
    coefficient: negative ? -quotient : quotient,
    exponent: adjustedExponent - significantDigits + 1,
  });
}

export function divideApproximateDecimals({ numerator, denominator, significantDigits }: {
  numerator: Decimal,
  denominator: Decimal,
  significantDigits: number,
}): Decimal {
  if (denominator.coefficient === 0n) throw new Error('Cannot divide Decimal by zero.');
  const sign = denominator.coefficient < 0n ? -1n : 1n;
  return divideIntegerRatioToDecimal({
    numerator: numerator.coefficient * sign,
    denominator: absoluteBigInt({ value: denominator.coefficient }),
    decimalExponent: numerator.exponent - denominator.exponent,
    significantDigits,
  });
}

export function powerApproximateDecimalInteger({ base, exponent, significantDigits, consumeOperation }: {
  base: Decimal,
  exponent: number,
  significantDigits: number,
  consumeOperation: () => void,
}): Decimal {
  if (!Number.isSafeInteger(exponent)) throw new Error(`Invalid Decimal exponent: ${exponent}`);
  if (exponent === 0) return createDecimal({ coefficient: 1n, exponent: 0 });
  let remaining = Math.abs(exponent);
  let factor = roundDecimalToSignificantDigits({ decimal: base, significantDigits, mode: 'half_even' });
  let result = createDecimal({ coefficient: 1n, exponent: 0 });
  while (remaining > 0) {
    consumeOperation();
    if (remaining % 2 === 1) result = multiplyApproximateDecimals({ left: result, right: factor, significantDigits });
    remaining = Math.floor(remaining / 2);
    if (remaining > 0) factor = multiplyApproximateDecimals({ left: factor, right: factor, significantDigits });
  }
  return exponent > 0
    ? result
    : divideApproximateDecimals({
      numerator: createDecimal({ coefficient: 1n, exponent: 0 }),
      denominator: result,
      significantDigits,
    });
}

export function integerRootFloor({ value, degree, consumeOperation }: {
  value: bigint,
  degree: 2 | 3,
  consumeOperation: () => void,
}): bigint {
  if (value < 0n) throw new Error('Integer root requires a non-negative value.');
  if (value < 2n) return value;
  const bitLength = value.toString(2).length;
  let current = 1n << BigInt(Math.ceil(bitLength / degree));
  while (true) {
    consumeOperation();
    const divisor = degree === 2 ? current : current * current;
    const next = (BigInt(degree - 1) * current + value / divisor) / BigInt(degree);
    if (next >= current) {
      while ((degree === 2 ? current * current : current * current * current) > value) {
        consumeOperation();
        current -= 1n;
      }
      while (true) {
        const upper = current + 1n;
        const upperPower = degree === 2 ? upper * upper : upper * upper * upper;
        if (upperPower > value) return current;
        consumeOperation();
        current = upper;
      }
    }
    current = next;
  }
}

export function rootApproximateDecimal({ decimal, degree, significantDigits, consumeOperation }: {
  decimal: Decimal,
  degree: 2 | 3,
  significantDigits: number,
  consumeOperation: () => void,
}): Decimal {
  if (decimal.coefficient === 0n) return decimal;
  const negative = decimal.coefficient < 0n;
  if (negative && degree === 2) throw new Error('Square root requires a non-negative Decimal.');
  const absolute = absoluteDecimal({ decimal });
  const exponentRemainder = ((absolute.exponent % degree) + degree) % degree;
  const adjustedCoefficient = absolute.coefficient * powerOfTen({
    exponent: exponentRemainder,
    reason: 'alignment',
  });
  const adjustedExponent = (absolute.exponent - exponentRemainder) / degree;
  const baseRootDigits = Math.floor((decimalDigitCount({ value: adjustedCoefficient }) - 1) / degree) + 1;
  const scaleDigits = Math.max(0, significantDigits - baseRootDigits);
  const scaled = adjustedCoefficient * powerOfTen({
    exponent: degree * scaleDigits,
    reason: 'materialized_integer',
  });
  const root = integerRootFloor({ value: scaled, degree, consumeOperation });
  const droppedDigits = Math.max(0, decimalDigitCount({ value: root }) - significantDigits);
  const divisor = powerOfTen({ exponent: droppedDigits, reason: 'alignment' });
  let rounded = root / divisor;
  const midpointBase = rounded * 2n + 1n;
  const left = scaled * BigInt(2 ** degree);
  const midpointPowerWithoutScale = degree === 2
    ? midpointBase * midpointBase
    : midpointBase * midpointBase * midpointBase;
  const midpointPower = midpointPowerWithoutScale * powerOfTen({
    exponent: droppedDigits * degree,
    reason: 'materialized_integer',
  });
  if (left > midpointPower || (left === midpointPower && rounded % 2n !== 0n)) rounded += 1n;
  return createDecimal({
    coefficient: negative ? -rounded : rounded,
    exponent: adjustedExponent - scaleDigits + droppedDigits,
  });
}

export function truncateDecimalToInteger({ decimal, mode }: {
  decimal: Decimal,
  mode: 'floor' | 'ceil' | 'trunc' | 'round_half_away',
}): Decimal {
  if (decimal.coefficient === 0n || decimal.exponent >= 0) return decimal;
  const droppedDigits = -decimal.exponent;
  const digits = decimalDigitCount({ value: decimal.coefficient });
  if (droppedDigits > digits) {
    switch (mode) {
    case 'floor':
      return createDecimal({ coefficient: decimal.coefficient < 0n ? -1n : 0n, exponent: 0 });
    case 'ceil':
      return createDecimal({ coefficient: decimal.coefficient > 0n ? 1n : 0n, exponent: 0 });
    case 'trunc':
    case 'round_half_away':
      return createDecimal({ coefficient: 0n, exponent: 0 });
    default: {
      const _exhaustive: never = mode;
      throw new Error(`Unhandled Decimal integer rounding mode: ${String(_exhaustive)}`);
    }
    }
  }
  const divisor = powerOfTen({ exponent: droppedDigits, reason: 'alignment' });
  const absolute = absoluteBigInt({ value: decimal.coefficient });
  let quotient = absolute / divisor;
  const remainder = absolute % divisor;
  switch (mode) {
  case 'floor':
    if (decimal.coefficient < 0n && remainder !== 0n) quotient += 1n;
    break;
  case 'ceil':
    if (decimal.coefficient > 0n && remainder !== 0n) quotient += 1n;
    break;
  case 'trunc':
    break;
  case 'round_half_away':
    if (remainder * 2n >= divisor) quotient += 1n;
    break;
  default: {
    const _exhaustive: never = mode;
    throw new Error(`Unhandled Decimal integer rounding mode: ${String(_exhaustive)}`);
  }
  }
  return createDecimal({ coefficient: decimal.coefficient < 0n ? -quotient : quotient, exponent: 0 });
}

export function serializeDecimalExact({ decimal }: { decimal: Decimal }): string {
  if (decimal.coefficient === 0n) return '0';
  const negative = decimal.coefficient < 0n;
  const digits = absoluteBigInt({ value: decimal.coefficient }).toString();
  let body: string;
  if (decimal.exponent >= 0) {
    const length = digits.length + decimal.exponent + (negative ? 1 : 0);
    if (length > CALCULATOR_LIMITS.maximumOutputLength) return serializeDecimal({ decimal });
    body = `${digits}${'0'.repeat(decimal.exponent)}`;
  } else {
    const decimalPoint = digits.length + decimal.exponent;
    const length = decimalPoint > 0
      ? digits.length + 1 + (negative ? 1 : 0)
      : 2 - decimalPoint + digits.length + (negative ? 1 : 0);
    if (length > CALCULATOR_LIMITS.maximumOutputLength) return serializeDecimal({ decimal });
    body = decimalPoint > 0
      ? `${digits.slice(0, decimalPoint)}.${digits.slice(decimalPoint)}`
      : `0.${'0'.repeat(-decimalPoint)}${digits}`;
  }
  return negative ? `-${body}` : body;
}

export function serializeDecimal({ decimal }: { decimal: Decimal }): string {
  if (decimal.coefficient === 0n) return '0';
  const negative = decimal.coefficient < 0n;
  const digits = absoluteBigInt({ value: decimal.coefficient }).toString();
  const adjusted = digits.length + decimal.exponent - 1;
  let body: string;
  const plainLength = decimal.exponent >= 0
    ? digits.length + decimal.exponent
    : Math.max(1, digits.length + decimal.exponent) + 1 + Math.max(0, -(digits.length + decimal.exponent));
  if (adjusted >= -6 && adjusted <= 20 && plainLength <= CALCULATOR_LIMITS.maximumOutputLength) {
    if (decimal.exponent >= 0) body = `${digits}${'0'.repeat(decimal.exponent)}`;
    else {
      const decimalPoint = digits.length + decimal.exponent;
      body = decimalPoint > 0
        ? `${digits.slice(0, decimalPoint)}.${digits.slice(decimalPoint)}`
        : `0.${'0'.repeat(-decimalPoint)}${digits}`;
    }
  } else {
    body = digits.length === 1 ? `${digits}e${adjusted}` : `${digits[0]}.${digits.slice(1)}e${adjusted}`;
  }
  const result = negative ? `-${body}` : body;
  if (result.length > CALCULATOR_LIMITS.maximumOutputLength) {
    throw new NumericLimitError({
      reason: 'output_length',
      message: `Calculator output exceeds ${CALCULATOR_LIMITS.maximumOutputLength} characters.`,
    });
  }
  return result;
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = { shouldRoundUp };
