import type { CalculatorRuntime } from '@/features/calculator/logic/catalog/types';
import { failCalculatorInput } from '@/features/calculator/logic/diagnostics';
import { CALCULATOR_LIMITS } from '@/features/calculator/logic/limits';
import type { SourceSpan } from '@/features/calculator/logic/syntax';
import {
  absoluteDecimal,
  addApproximateDecimals,
  compareDecimals,
  createDecimal,
  divideApproximateDecimals,
  multiplyApproximateDecimals,
  negateDecimal,
  parseDecimalLiteral,
  powerApproximateDecimalInteger,
  rootApproximateDecimal,
  roundDecimalToDecimalPlaces,
  roundDecimalToSignificantDigits,
  truncateDecimalToInteger,
  type Decimal,
} from './decimal';
import {
  absoluteRational,
  addRationals,
  compareRationals,
  createRational,
  divideRationals,
  moduloRationals,
  multiplyRationals,
  negateRational,
  perfectRationalRoot,
  powerRationalInteger,
  rationalFromDecimal,
  rationalToDecimal,
  rationalToInteger,
  roundRationalToDecimalPlaces,
  subtractRationals,
  truncateRationalToInteger,
  type Rational,
} from './rational';

export type CalculatorNumericValue =
  | { readonly kind: 'rational', readonly rational: Rational }
  | { readonly kind: 'approximate', readonly decimal: Decimal };

export function createRationalValue({ rational }: { rational: Rational }): CalculatorNumericValue {
  return { kind: 'rational', rational };
}

export function createApproximateValue({ decimal }: { decimal: Decimal }): CalculatorNumericValue {
  return {
    kind: 'approximate',
    decimal: roundDecimalToSignificantDigits({
      decimal,
      significantDigits: CALCULATOR_LIMITS.workingSignificantDigits,
      mode: 'half_even',
    }),
  };
}

export function parseCalculatorNumericLiteral({ literal }: { literal: string }): CalculatorNumericValue {
  return createRationalValue({ rational: rationalFromDecimal({ decimal: parseDecimalLiteral({ literal }) }) });
}

export function parseApproximateConstant({ literal }: { literal: string }): CalculatorNumericValue {
  return createApproximateValue({ decimal: parseDecimalLiteral({ literal }) });
}

export function numericValueFromBigInt({ value }: { value: bigint }): CalculatorNumericValue {
  return createRationalValue({
    rational: createRational({ numerator: value, denominator: 1n, decimalExponent: 0 }),
  });
}

export function numericValueToApproximateDecimal({ value, significantDigits }: {
  value: CalculatorNumericValue,
  significantDigits: number,
}): Decimal {
  switch (value.kind) {
  case 'rational':
    return rationalToDecimal({ rational: value.rational, significantDigits });
  case 'approximate':
    return roundDecimalToSignificantDigits({
      decimal: value.decimal,
      significantDigits,
      mode: 'half_even',
    });
  default: {
    const _exhaustive: never = value;
    throw new Error(`Unhandled calculator numeric value: ${String(_exhaustive)}`);
  }
  }
}

export function isNumericValueZero({ value }: { value: CalculatorNumericValue }): boolean {
  switch (value.kind) {
  case 'rational': return value.rational.numerator === 0n;
  case 'approximate': return value.decimal.coefficient === 0n;
  default: {
    const _exhaustive: never = value;
    throw new Error(`Unhandled calculator numeric value: ${String(_exhaustive)}`);
  }
  }
}

function numericValueToStoredRational({ value }: { value: CalculatorNumericValue }): Rational {
  switch (value.kind) {
  case 'rational': return value.rational;
  case 'approximate': return rationalFromDecimal({ decimal: value.decimal });
  default: {
    const _exhaustive: never = value;
    throw new Error(`Unhandled calculator numeric value: ${String(_exhaustive)}`);
  }
  }
}

export function compareNumericValues({ left, right }: {
  left: CalculatorNumericValue,
  right: CalculatorNumericValue,
}): number {
  if (left.kind === 'rational' && right.kind === 'rational') {
    return compareRationals({ left: left.rational, right: right.rational });
  }
  if (left.kind === 'approximate' && right.kind === 'approximate') {
    return compareDecimals({ left: left.decimal, right: right.decimal });
  }
  return compareRationals({
    left: numericValueToStoredRational({ value: left }),
    right: numericValueToStoredRational({ value: right }),
  });
}


export function propagateApproximateInputs({ value, inputs }: {
  value: CalculatorNumericValue,
  inputs: readonly CalculatorNumericValue[],
}): CalculatorNumericValue {
  if (!inputs.some(input => input.kind === 'approximate')) return value;
  switch (value.kind) {
  case 'approximate':
    return value;
  case 'rational':
    return createApproximateValue({
      decimal: rationalToDecimal({
        rational: value.rational,
        significantDigits: CALCULATOR_LIMITS.workingSignificantDigits,
      }),
    });
  default: {
    const _exhaustive: never = value;
    throw new Error(`Unhandled calculator numeric value: ${String(_exhaustive)}`);
  }
  }
}

export function negateNumericValue({ value }: { value: CalculatorNumericValue }): CalculatorNumericValue {
  switch (value.kind) {
  case 'rational': return createRationalValue({ rational: negateRational({ rational: value.rational }) });
  case 'approximate': return createApproximateValue({ decimal: negateDecimal({ decimal: value.decimal }) });
  default: {
    const _exhaustive: never = value;
    throw new Error(`Unhandled calculator numeric value: ${String(_exhaustive)}`);
  }
  }
}

export function absoluteNumericValue({ value }: { value: CalculatorNumericValue }): CalculatorNumericValue {
  switch (value.kind) {
  case 'rational': return createRationalValue({ rational: absoluteRational({ rational: value.rational }) });
  case 'approximate': return createApproximateValue({ decimal: absoluteDecimal({ decimal: value.decimal }) });
  default: {
    const _exhaustive: never = value;
    throw new Error(`Unhandled calculator numeric value: ${String(_exhaustive)}`);
  }
  }
}

export function addNumericValues({ left, right }: {
  left: CalculatorNumericValue,
  right: CalculatorNumericValue,
}): CalculatorNumericValue {
  if (left.kind === 'rational' && right.kind === 'rational') {
    return createRationalValue({ rational: addRationals({ left: left.rational, right: right.rational }) });
  }
  return createApproximateValue({
    decimal: addApproximateDecimals({
      left: numericValueToApproximateDecimal({ value: left, significantDigits: CALCULATOR_LIMITS.workingSignificantDigits }),
      right: numericValueToApproximateDecimal({ value: right, significantDigits: CALCULATOR_LIMITS.workingSignificantDigits }),
      significantDigits: CALCULATOR_LIMITS.workingSignificantDigits,
    }),
  });
}

export function subtractNumericValues({ left, right }: {
  left: CalculatorNumericValue,
  right: CalculatorNumericValue,
}): CalculatorNumericValue {
  if (left.kind === 'rational' && right.kind === 'rational') {
    return createRationalValue({ rational: subtractRationals({ left: left.rational, right: right.rational }) });
  }
  return addNumericValues({ left, right: negateNumericValue({ value: right }) });
}

export function multiplyNumericValues({ left, right }: {
  left: CalculatorNumericValue,
  right: CalculatorNumericValue,
}): CalculatorNumericValue {
  if (left.kind === 'rational' && right.kind === 'rational') {
    return createRationalValue({ rational: multiplyRationals({ left: left.rational, right: right.rational }) });
  }
  return createApproximateValue({
    decimal: multiplyApproximateDecimals({
      left: numericValueToApproximateDecimal({ value: left, significantDigits: CALCULATOR_LIMITS.workingSignificantDigits }),
      right: numericValueToApproximateDecimal({ value: right, significantDigits: CALCULATOR_LIMITS.workingSignificantDigits }),
      significantDigits: CALCULATOR_LIMITS.workingSignificantDigits,
    }),
  });
}

export function divideNumericValues({ numerator, denominator, span }: {
  numerator: CalculatorNumericValue,
  denominator: CalculatorNumericValue,
  span: SourceSpan,
}): CalculatorNumericValue {
  if (isNumericValueZero({ value: denominator })) {
    failCalculatorInput({
      code: 'division_by_zero',
      message: 'Division by zero is not defined.',
      span,
      hint: undefined,
    });
  }
  if (numerator.kind === 'rational' && denominator.kind === 'rational') {
    return createRationalValue({
      rational: divideRationals({ numerator: numerator.rational, denominator: denominator.rational }),
    });
  }
  return createApproximateValue({
    decimal: divideApproximateDecimals({
      numerator: numericValueToApproximateDecimal({ value: numerator, significantDigits: CALCULATOR_LIMITS.workingSignificantDigits }),
      denominator: numericValueToApproximateDecimal({ value: denominator, significantDigits: CALCULATOR_LIMITS.workingSignificantDigits }),
      significantDigits: CALCULATOR_LIMITS.workingSignificantDigits,
    }),
  });
}

function requireRational({ value, message, span, hint }: {
  value: CalculatorNumericValue,
  message: string,
  span: SourceSpan,
  hint: string | undefined,
}): Rational {
  switch (value.kind) {
  case 'rational': return value.rational;
  case 'approximate': return failCalculatorInput({ code: 'invalid_argument', message, span, hint });
  default: {
    const _exhaustive: never = value;
    throw new Error(`Unhandled calculator numeric value: ${String(_exhaustive)}`);
  }
  }
}

export function moduloNumericValues({ left, right, span }: {
  left: CalculatorNumericValue,
  right: CalculatorNumericValue,
  span: SourceSpan,
}): CalculatorNumericValue {
  const leftRational = requireRational({
    value: left,
    message: 'Modulo requires exact rational operands.',
    span,
    hint: 'Do not use pi, e, tau, or irrational roots with `%`.',
  });
  const rightRational = requireRational({
    value: right,
    message: 'Modulo requires exact rational operands.',
    span,
    hint: 'Do not use pi, e, tau, or irrational roots with `%`.',
  });
  if (compareRationals({
    left: rightRational,
    right: createRational({ numerator: 0n, denominator: 1n, decimalExponent: 0 }),
  }) <= 0) {
    failCalculatorInput({
      code: 'invalid_argument',
      message: 'Modulo requires a divisor greater than zero.',
      span,
      hint: '`%` uses Euclidean modulo, not JavaScript remainder.',
    });
  }
  return createRationalValue({ rational: moduloRationals({ left: leftRational, right: rightRational }) });
}

export function integerFromNumericValue({ value, name, span }: {
  value: CalculatorNumericValue,
  name: string,
  span: SourceSpan,
}): bigint {
  const rational = requireRational({
    value,
    message: `${name} must be an exact integer.`,
    span,
    hint: undefined,
  });
  const integer = rationalToInteger({ rational });
  if (integer === undefined) {
    failCalculatorInput({
      code: 'invalid_argument',
      message: `${name} must be an integer.`,
      span,
      hint: undefined,
    });
  }
  return integer;
}

export function powerNumericValue({ base, exponentValue, exponentSpan, operatorSpan, runtime }: {
  base: CalculatorNumericValue,
  exponentValue: CalculatorNumericValue,
  exponentSpan: SourceSpan,
  operatorSpan: SourceSpan,
  runtime: CalculatorRuntime,
}): CalculatorNumericValue {
  const exponentBigInt = integerFromNumericValue({ value: exponentValue, name: 'exponent', span: exponentSpan });
  const maximum = BigInt(CALCULATOR_LIMITS.maximumIntegerPowerExponent);
  if (exponentBigInt < -maximum || exponentBigInt > maximum) {
    failCalculatorInput({
      code: 'limit_exceeded',
      message: `Integer exponent exceeds ${CALCULATOR_LIMITS.maximumIntegerPowerExponent}.`,
      span: exponentSpan,
      hint: 'Use a smaller integer exponent.',
    });
  }
  const exponent = Number(exponentBigInt);
  if (isNumericValueZero({ value: base }) && exponent < 0) {
    failCalculatorInput({
      code: 'division_by_zero',
      message: 'Zero cannot be raised to a negative power.',
      span: operatorSpan,
      hint: undefined,
    });
  }
  const consumeOperation = (): void => runtime.consumeOperations({ count: 1, span: operatorSpan });
  switch (base.kind) {
  case 'rational':
    return createRationalValue({ rational: powerRationalInteger({ base: base.rational, exponent, consumeOperation }) });
  case 'approximate':
    return createApproximateValue({
      decimal: powerApproximateDecimalInteger({
        base: base.decimal,
        exponent,
        significantDigits: CALCULATOR_LIMITS.workingSignificantDigits,
        consumeOperation,
      }),
    });
  default: {
    const _exhaustive: never = base;
    throw new Error(`Unhandled calculator numeric value: ${String(_exhaustive)}`);
  }
  }
}

export function rootNumericValue({ value, degree, span, runtime }: {
  value: CalculatorNumericValue,
  degree: 2 | 3,
  span: SourceSpan,
  runtime: CalculatorRuntime,
}): CalculatorNumericValue {
  if (degree === 2 && compareNumericValues({ left: value, right: numericValueFromBigInt({ value: 0n }) }) < 0) {
    failCalculatorInput({
      code: 'domain_error',
      message: 'sqrt requires a non-negative value.',
      span,
      hint: 'Complex numbers are not supported.',
    });
  }
  const consumeOperation = (): void => runtime.consumeOperations({ count: 1, span });
  switch (value.kind) {
  case 'rational': {
    const exact = perfectRationalRoot({ rational: value.rational, degree, consumeOperation });
    if (exact !== undefined) return createRationalValue({ rational: exact });
    break;
  }
  case 'approximate':
    break;
  default: {
    const _exhaustive: never = value;
    throw new Error(`Unhandled calculator numeric value: ${String(_exhaustive)}`);
  }
  }
  return createApproximateValue({
    decimal: rootApproximateDecimal({
      decimal: numericValueToApproximateDecimal({
        value,
        significantDigits: CALCULATOR_LIMITS.workingSignificantDigits,
      }),
      degree,
      significantDigits: CALCULATOR_LIMITS.workingSignificantDigits,
      consumeOperation,
    }),
  });
}

export function truncateNumericValueToInteger({ value, mode }: {
  value: CalculatorNumericValue,
  mode: 'floor' | 'ceil' | 'trunc' | 'round_half_away',
}): CalculatorNumericValue {
  switch (value.kind) {
  case 'rational':
    return createRationalValue({ rational: truncateRationalToInteger({ rational: value.rational, mode }) });
  case 'approximate':
    return createApproximateValue({ decimal: truncateDecimalToInteger({ decimal: value.decimal, mode }) });
  default: {
    const _exhaustive: never = value;
    throw new Error(`Unhandled calculator numeric value: ${String(_exhaustive)}`);
  }
  }
}

export function roundNumericValueToDecimalPlaces({ value, decimalPlaces }: {
  value: CalculatorNumericValue,
  decimalPlaces: number,
}): CalculatorNumericValue {
  switch (value.kind) {
  case 'rational':
    return createRationalValue({
      rational: roundRationalToDecimalPlaces({ rational: value.rational, decimalPlaces }),
    });
  case 'approximate':
    return createApproximateValue({
      decimal: roundDecimalToDecimalPlaces({
        decimal: value.decimal,
        decimalPlaces,
        mode: 'half_away_from_zero',
      }),
    });
  default: {
    const _exhaustive: never = value;
    throw new Error(`Unhandled calculator numeric value: ${String(_exhaustive)}`);
  }
  }
}

export function signNumericValue({ value }: { value: CalculatorNumericValue }): -1 | 0 | 1 {
  let raw: bigint;
  switch (value.kind) {
  case 'rational': raw = value.rational.numerator; break;
  case 'approximate': raw = value.decimal.coefficient; break;
  default: {
    const _exhaustive: never = value;
    throw new Error(`Unhandled calculator numeric value: ${String(_exhaustive)}`);
  }
  }
  return raw < 0n ? -1 : raw > 0n ? 1 : 0;
}

export function signResultNumericValue({ value }: { value: CalculatorNumericValue }): CalculatorNumericValue {
  const sign = BigInt(signNumericValue({ value }));
  switch (value.kind) {
  case 'rational': return numericValueFromBigInt({ value: sign });
  case 'approximate': return createApproximateValue({ decimal: createDecimal({ coefficient: sign, exponent: 0 }) });
  default: {
    const _exhaustive: never = value;
    throw new Error(`Unhandled calculator numeric value: ${String(_exhaustive)}`);
  }
  }
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {};
