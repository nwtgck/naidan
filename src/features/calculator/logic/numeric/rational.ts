import { CALCULATOR_LIMITS } from '@/features/calculator/logic/limits';
import {
  absoluteBigInt,
  createDecimal,
  decimalDigitCount,
  compareScaledIntegerMagnitudes,
  divideIntegerRatioToDecimal,
  integerRootFloor,
  powerOfTen,
  roundDecimalToDecimalPlaces,
  roundDecimalToSignificantDigits,
  serializeDecimalExact,
  truncateDecimalToInteger,
  type Decimal,
} from './decimal';
import { NumericLimitError } from './numeric-limit-error';

export type Rational = Readonly<{
  numerator: bigint,
  denominator: bigint,
  decimalExponent: number,
}>;

function greatestCommonDivisor({ left, right }: { left: bigint, right: bigint }): bigint {
  let a = absoluteBigInt({ value: left });
  let b = absoluteBigInt({ value: right });
  let iterations = 0;
  while (b !== 0n) {
    iterations += 1;
    if (iterations > CALCULATOR_LIMITS.maximumInternalNumericIterations) {
      throw new NumericLimitError({
        reason: 'iterations',
        message: `Rational normalization exceeds ${CALCULATOR_LIMITS.maximumInternalNumericIterations} internal iterations.`,
      });
    }
    [a, b] = [b, a % b];
  }
  return a;
}

function ensureRationalDigitsAllowed({ numerator, denominator }: {
  numerator: bigint,
  denominator: bigint,
}): void {
  if (decimalDigitCount({ value: numerator }) > CALCULATOR_LIMITS.maximumCoefficientDigits) {
    throw new NumericLimitError({
      reason: 'coefficient_digits',
      message: `Rational numerator exceeds ${CALCULATOR_LIMITS.maximumCoefficientDigits} digits.`,
    });
  }
  if (decimalDigitCount({ value: denominator }) > CALCULATOR_LIMITS.maximumDenominatorDigits) {
    throw new NumericLimitError({
      reason: 'denominator_digits',
      message: `Rational denominator exceeds ${CALCULATOR_LIMITS.maximumDenominatorDigits} digits.`,
    });
  }
}

function ensureExponentAllowed({ exponent }: { exponent: number }): void {
  if (!Number.isSafeInteger(exponent)
    || Math.abs(exponent) > CALCULATOR_LIMITS.maximumExponentMagnitude) {
    throw new NumericLimitError({
      reason: 'exponent',
      message: `Rational decimal exponent exceeds ${CALCULATOR_LIMITS.maximumExponentMagnitude}.`,
    });
  }
}

export function createRational({ numerator, denominator, decimalExponent }: {
  numerator: bigint,
  denominator: bigint,
  decimalExponent: number,
}): Rational {
  if (denominator === 0n) throw new Error('Rational denominator must not be zero.');
  if (numerator === 0n) return { numerator: 0n, denominator: 1n, decimalExponent: 0 };
  let normalizedNumerator = denominator < 0n ? -numerator : numerator;
  let normalizedDenominator = denominator < 0n ? -denominator : denominator;
  let normalizedExponent = decimalExponent;
  const divisor = greatestCommonDivisor({ left: normalizedNumerator, right: normalizedDenominator });
  normalizedNumerator /= divisor;
  normalizedDenominator /= divisor;
  while (normalizedNumerator % 10n === 0n) {
    normalizedNumerator /= 10n;
    normalizedExponent += 1;
  }
  while (normalizedDenominator % 10n === 0n) {
    normalizedDenominator /= 10n;
    normalizedExponent -= 1;
  }
  ensureExponentAllowed({ exponent: normalizedExponent });
  ensureRationalDigitsAllowed({ numerator: normalizedNumerator, denominator: normalizedDenominator });
  return {
    numerator: normalizedNumerator,
    denominator: normalizedDenominator,
    decimalExponent: normalizedExponent,
  };
}

export function rationalFromDecimal({ decimal }: { decimal: Decimal }): Rational {
  return createRational({
    numerator: decimal.coefficient,
    denominator: 1n,
    decimalExponent: decimal.exponent,
  });
}

export function negateRational({ rational }: { rational: Rational }): Rational {
  return { ...rational, numerator: -rational.numerator };
}

export function absoluteRational({ rational }: { rational: Rational }): Rational {
  return rational.numerator < 0n ? negateRational({ rational }) : rational;
}

function adjustedRationalExponent({ rational }: { rational: Rational }): number {
  if (rational.numerator === 0n) return 0;
  const numeratorDigits = decimalDigitCount({ value: rational.numerator });
  const denominatorDigits = decimalDigitCount({ value: rational.denominator });
  const base = numeratorDigits - denominatorDigits;
  const absoluteNumerator = absoluteBigInt({ value: rational.numerator });
  const lower = base >= 0
    ? compareScaledIntegerMagnitudes({
      leftCoefficient: absoluteNumerator,
      leftExponent: 0,
      rightCoefficient: rational.denominator,
      rightExponent: base,
    }) < 0
    : compareScaledIntegerMagnitudes({
      leftCoefficient: absoluteNumerator,
      leftExponent: -base,
      rightCoefficient: rational.denominator,
      rightExponent: 0,
    }) < 0;
  return rational.decimalExponent + base + (lower ? -1 : 0);
}

function ensureCrossProductAllowed({ factors }: { factors: readonly bigint[] }): void {
  const estimatedDigits = factors.reduce((sum, factor) => sum + decimalDigitCount({ value: factor }), 0);
  if (estimatedDigits > CALCULATOR_LIMITS.maximumCrossMultiplicationDigits) {
    throw new NumericLimitError({
      reason: 'cross_multiplication',
      message: `Rational cross multiplication exceeds ${CALCULATOR_LIMITS.maximumCrossMultiplicationDigits} digits.`,
    });
  }
}

function compareAbsoluteRationals({ left, right }: { left: Rational, right: Rational }): number {
  const leftAdjusted = adjustedRationalExponent({ rational: left });
  const rightAdjusted = adjustedRationalExponent({ rational: right });
  if (leftAdjusted !== rightAdjusted) return leftAdjusted < rightAdjusted ? -1 : 1;
  ensureCrossProductAllowed({ factors: [left.numerator, right.denominator] });
  ensureCrossProductAllowed({ factors: [right.numerator, left.denominator] });
  return compareScaledIntegerMagnitudes({
    leftCoefficient: absoluteBigInt({ value: left.numerator }) * right.denominator,
    leftExponent: left.decimalExponent,
    rightCoefficient: absoluteBigInt({ value: right.numerator }) * left.denominator,
    rightExponent: right.decimalExponent,
  });
}

export function compareRationals({ left, right }: { left: Rational, right: Rational }): number {
  if (left.numerator === 0n) return right.numerator === 0n ? 0 : right.numerator < 0n ? 1 : -1;
  if (right.numerator === 0n) return left.numerator < 0n ? -1 : 1;
  if (left.numerator < 0n && right.numerator >= 0n) return -1;
  if (left.numerator >= 0n && right.numerator < 0n) return 1;
  const comparison = compareAbsoluteRationals({
    left: absoluteRational({ rational: left }),
    right: absoluteRational({ rational: right }),
  });
  return left.numerator < 0n ? -comparison : comparison;
}

export function addRationals({ left, right }: { left: Rational, right: Rational }): Rational {
  const targetExponent = Math.min(left.decimalExponent, right.decimalExponent);
  const leftNumerator = left.numerator * powerOfTen({
    exponent: left.decimalExponent - targetExponent,
    reason: 'alignment',
  });
  const rightNumerator = right.numerator * powerOfTen({
    exponent: right.decimalExponent - targetExponent,
    reason: 'alignment',
  });
  const common = greatestCommonDivisor({ left: left.denominator, right: right.denominator });
  const leftFactor = right.denominator / common;
  const rightFactor = left.denominator / common;
  ensureCrossProductAllowed({ factors: [leftNumerator, leftFactor] });
  ensureCrossProductAllowed({ factors: [rightNumerator, rightFactor] });
  return createRational({
    numerator: leftNumerator * leftFactor + rightNumerator * rightFactor,
    denominator: left.denominator * leftFactor,
    decimalExponent: targetExponent,
  });
}

export function subtractRationals({ left, right }: { left: Rational, right: Rational }): Rational {
  return addRationals({ left, right: negateRational({ rational: right }) });
}

export function multiplyRationals({ left, right }: { left: Rational, right: Rational }): Rational {
  const first = greatestCommonDivisor({ left: left.numerator, right: right.denominator });
  const second = greatestCommonDivisor({ left: right.numerator, right: left.denominator });
  const leftNumerator = left.numerator / first;
  const rightNumerator = right.numerator / second;
  const leftDenominator = left.denominator / second;
  const rightDenominator = right.denominator / first;
  ensureCrossProductAllowed({ factors: [leftNumerator, rightNumerator] });
  ensureCrossProductAllowed({ factors: [leftDenominator, rightDenominator] });
  return createRational({
    numerator: leftNumerator * rightNumerator,
    denominator: leftDenominator * rightDenominator,
    decimalExponent: left.decimalExponent + right.decimalExponent,
  });
}

export function divideRationals({ numerator, denominator }: {
  numerator: Rational,
  denominator: Rational,
}): Rational {
  if (denominator.numerator === 0n) throw new Error('Cannot divide Rational by zero.');
  const numeratorGcd = greatestCommonDivisor({ left: numerator.numerator, right: denominator.numerator });
  const denominatorGcd = greatestCommonDivisor({ left: numerator.denominator, right: denominator.denominator });
  const leftNumerator = numerator.numerator / numeratorGcd;
  const rightNumerator = denominator.numerator / numeratorGcd;
  const leftDenominator = numerator.denominator / denominatorGcd;
  const rightDenominator = denominator.denominator / denominatorGcd;
  ensureCrossProductAllowed({ factors: [leftNumerator, rightDenominator] });
  ensureCrossProductAllowed({ factors: [leftDenominator, rightNumerator] });
  return createRational({
    numerator: leftNumerator * rightDenominator,
    denominator: leftDenominator * rightNumerator,
    decimalExponent: numerator.decimalExponent - denominator.decimalExponent,
  });
}

function countAndRemoveFactor({ value, factor }: { value: bigint, factor: bigint }): {
  remaining: bigint,
  count: number,
} {
  let remaining = value;
  let count = 0;
  while (remaining % factor === 0n) {
    count += 1;
    if (count > CALCULATOR_LIMITS.maximumInternalNumericIterations) {
      throw new NumericLimitError({
        reason: 'iterations',
        message: `Finite-decimal detection exceeds ${CALCULATOR_LIMITS.maximumInternalNumericIterations} internal iterations.`,
      });
    }
    remaining /= factor;
  }
  return { remaining, count };
}

function smallPower({ base, exponent }: { base: bigint, exponent: number }): bigint {
  if (!Number.isSafeInteger(exponent) || exponent < 0
    || exponent > CALCULATOR_LIMITS.maximumMaterializedIntegerDigits * 4) {
    throw new NumericLimitError({
      reason: 'materialized_integer',
      message: 'Exact finite-decimal conversion exceeds the materialization limit.',
    });
  }
  return base ** BigInt(exponent);
}

export function rationalToFiniteDecimal({ rational }: { rational: Rational }): Decimal | undefined {
  let denominator = rational.denominator;
  const twos = countAndRemoveFactor({ value: denominator, factor: 2n });
  denominator = twos.remaining;
  const fives = countAndRemoveFactor({ value: denominator, factor: 5n });
  denominator = fives.remaining;
  if (denominator !== 1n) return undefined;
  const scale = Math.max(twos.count, fives.count);
  const coefficient = rational.numerator
    * smallPower({ base: 2n, exponent: scale - twos.count })
    * smallPower({ base: 5n, exponent: scale - fives.count });
  return createDecimal({ coefficient, exponent: rational.decimalExponent - scale });
}

export function rationalToDecimal({ rational, significantDigits }: {
  rational: Rational,
  significantDigits: number,
}): Decimal {
  try {
    const finite = rationalToFiniteDecimal({ rational });
    if (finite !== undefined) {
      return roundDecimalToSignificantDigits({
        decimal: finite,
        significantDigits,
        mode: 'half_even',
      });
    }
  } catch (error) {
    if (!(error instanceof NumericLimitError)) throw error;
  }
  return divideIntegerRatioToDecimal({
    numerator: rational.numerator,
    denominator: rational.denominator,
    decimalExponent: rational.decimalExponent,
    significantDigits,
  });
}

function materializeRatio({ rational }: { rational: Rational }): {
  numerator: bigint,
  denominator: bigint,
} {
  if (rational.decimalExponent >= 0) {
    if (decimalDigitCount({ value: rational.numerator }) + rational.decimalExponent
      > CALCULATOR_LIMITS.maximumMaterializedIntegerDigits) {
      throw new NumericLimitError({
        reason: 'materialized_integer',
        message: `Materialized integer exceeds ${CALCULATOR_LIMITS.maximumMaterializedIntegerDigits} digits.`,
      });
    }
    return {
      numerator: rational.numerator * powerOfTen({
        exponent: rational.decimalExponent,
        reason: 'materialized_integer',
      }),
      denominator: rational.denominator,
    };
  }
  if (decimalDigitCount({ value: rational.denominator }) - rational.decimalExponent
    > CALCULATOR_LIMITS.maximumMaterializedIntegerDigits) {
    throw new NumericLimitError({
      reason: 'materialized_integer',
      message: `Materialized integer exceeds ${CALCULATOR_LIMITS.maximumMaterializedIntegerDigits} digits.`,
    });
  }
  return {
    numerator: rational.numerator,
    denominator: rational.denominator * powerOfTen({
      exponent: -rational.decimalExponent,
      reason: 'materialized_integer',
    }),
  };
}

export function rationalToInteger({ rational }: { rational: Rational }): bigint | undefined {
  const materialized = materializeRatio({ rational });
  if (materialized.numerator % materialized.denominator !== 0n) return undefined;
  return materialized.numerator / materialized.denominator;
}

function truncateRatioToInteger({ numerator, denominator, mode }: {
  numerator: bigint,
  denominator: bigint,
  mode: 'floor' | 'ceil' | 'trunc' | 'round_half_away',
}): bigint {
  const negative = numerator < 0n;
  const absolute = absoluteBigInt({ value: numerator });
  let quotient = absolute / denominator;
  const remainder = absolute % denominator;
  if (mode === 'floor' && negative && remainder !== 0n) quotient += 1n;
  if (mode === 'ceil' && !negative && remainder !== 0n) quotient += 1n;
  if (mode === 'round_half_away' && remainder * 2n >= denominator) quotient += 1n;
  return negative ? -quotient : quotient;
}

export function truncateRationalToInteger({ rational, mode }: {
  rational: Rational,
  mode: 'floor' | 'ceil' | 'trunc' | 'round_half_away',
}): Rational {
  try {
    const finite = rationalToFiniteDecimal({ rational });
    if (finite !== undefined) {
      return rationalFromDecimal({ decimal: truncateDecimalToInteger({ decimal: finite, mode }) });
    }
  } catch (error) {
    if (!(error instanceof NumericLimitError)) throw error;
  }

  const zero = createRational({ numerator: 0n, denominator: 1n, decimalExponent: 0 });
  const absolute = absoluteRational({ rational });
  const one = createRational({ numerator: 1n, denominator: 1n, decimalExponent: 0 });
  if (compareRationals({ left: absolute, right: one }) < 0) {
    switch (mode) {
    case 'floor':
      return createRational({
        numerator: rational.numerator < 0n ? -1n : 0n,
        denominator: 1n,
        decimalExponent: 0,
      });
    case 'ceil':
      return createRational({
        numerator: rational.numerator > 0n ? 1n : 0n,
        denominator: 1n,
        decimalExponent: 0,
      });
    case 'trunc':
      return zero;
    case 'round_half_away': {
      const half = createRational({ numerator: 1n, denominator: 2n, decimalExponent: 0 });
      if (compareRationals({ left: absolute, right: half }) < 0) return zero;
      return createRational({
        numerator: rational.numerator < 0n ? -1n : 1n,
        denominator: 1n,
        decimalExponent: 0,
      });
    }
    default: {
      const _exhaustive: never = mode;
      throw new Error(`Unhandled Rational integer rounding mode: ${String(_exhaustive)}`);
    }
    }
  }

  const materialized = materializeRatio({ rational });
  return createRational({
    numerator: truncateRatioToInteger({ ...materialized, mode }),
    denominator: 1n,
    decimalExponent: 0,
  });
}

export function roundRationalToDecimalPlaces({ rational, decimalPlaces }: {
  rational: Rational,
  decimalPlaces: number,
}): Rational {
  try {
    const finite = rationalToFiniteDecimal({ rational });
    if (finite !== undefined) {
      return rationalFromDecimal({
        decimal: roundDecimalToDecimalPlaces({
          decimal: finite,
          decimalPlaces,
          mode: 'half_away_from_zero',
        }),
      });
    }
  } catch (error) {
    if (!(error instanceof NumericLimitError)) throw error;
  }
  const shifted = createRational({
    numerator: rational.numerator,
    denominator: rational.denominator,
    decimalExponent: rational.decimalExponent + decimalPlaces,
  });
  const rounded = truncateRationalToInteger({ rational: shifted, mode: 'round_half_away' });
  return createRational({
    numerator: rounded.numerator,
    denominator: rounded.denominator,
    decimalExponent: rounded.decimalExponent - decimalPlaces,
  });
}

export function moduloRationals({ left, right }: { left: Rational, right: Rational }): Rational {
  const quotient = divideRationals({ numerator: left, denominator: right });
  const floor = truncateRationalToInteger({ rational: quotient, mode: 'floor' });
  return subtractRationals({ left, right: multiplyRationals({ left: floor, right }) });
}

export function powerRationalInteger({ base, exponent, consumeOperation }: {
  base: Rational,
  exponent: number,
  consumeOperation: () => void,
}): Rational {
  if (!Number.isSafeInteger(exponent)) throw new Error(`Invalid rational exponent: ${exponent}`);
  if (exponent === 0) return createRational({ numerator: 1n, denominator: 1n, decimalExponent: 0 });
  let remaining = Math.abs(exponent);
  let factor = base;
  let result = createRational({ numerator: 1n, denominator: 1n, decimalExponent: 0 });
  while (remaining > 0) {
    consumeOperation();
    if (remaining % 2 === 1) result = multiplyRationals({ left: result, right: factor });
    remaining = Math.floor(remaining / 2);
    if (remaining > 0) factor = multiplyRationals({ left: factor, right: factor });
  }
  return exponent > 0
    ? result
    : divideRationals({
      numerator: createRational({ numerator: 1n, denominator: 1n, decimalExponent: 0 }),
      denominator: result,
    });
}

function positiveModulo({ value, divisor }: { value: number, divisor: number }): number {
  return ((value % divisor) + divisor) % divisor;
}

export function perfectRationalRoot({ rational, degree, consumeOperation }: {
  rational: Rational,
  degree: 2 | 3,
  consumeOperation: () => void,
}): Rational | undefined {
  if (rational.numerator < 0n && degree === 2) return undefined;
  const exponentRemainder = positiveModulo({ value: rational.decimalExponent, divisor: degree });
  const adjustedNumerator = absoluteBigInt({ value: rational.numerator }) * powerOfTen({
    exponent: exponentRemainder,
    reason: 'alignment',
  });
  const numeratorRoot = integerRootFloor({ value: adjustedNumerator, degree, consumeOperation });
  const denominatorRoot = integerRootFloor({ value: rational.denominator, degree, consumeOperation });
  const numeratorPower = degree === 2
    ? numeratorRoot * numeratorRoot
    : numeratorRoot * numeratorRoot * numeratorRoot;
  const denominatorPower = degree === 2
    ? denominatorRoot * denominatorRoot
    : denominatorRoot * denominatorRoot * denominatorRoot;
  if (numeratorPower !== adjustedNumerator || denominatorPower !== rational.denominator) return undefined;
  return createRational({
    numerator: rational.numerator < 0n ? -numeratorRoot : numeratorRoot,
    denominator: denominatorRoot,
    decimalExponent: (rational.decimalExponent - exponentRemainder) / degree,
  });
}

export function serializeRational({ rational }: { rational: Rational }): string {
  try {
    const finite = rationalToFiniteDecimal({ rational });
    if (finite !== undefined) return serializeDecimalExact({ decimal: finite });
  } catch (error) {
    if (!(error instanceof NumericLimitError)) throw error;
  }
  const result = rational.decimalExponent === 0
    ? `${rational.numerator}/${rational.denominator}`
    : `(${rational.numerator}/${rational.denominator}) * 1e${rational.decimalExponent}`;
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
export const TEST_ONLY = { greatestCommonDivisor, adjustedRationalExponent };
