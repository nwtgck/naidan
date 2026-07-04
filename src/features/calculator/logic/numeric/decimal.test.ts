import { describe, expect, it } from 'vitest';
import {
  addApproximateDecimals,
  compareDecimals,
  compareScaledIntegerMagnitudes,
  createDecimal,
  divideApproximateDecimals,
  integerRootFloor,
  multiplyApproximateDecimals,
  negateDecimal,
  parseDecimalLiteral,
  rootApproximateDecimal,
  roundDecimalToDecimalPlaces,
  roundDecimalToSignificantDigits,
  serializeDecimal,
  serializeDecimalExact,
  truncateDecimalToInteger,
} from './decimal';

const consumeOperation = (): void => {};

function signedDecimal({ literal, negative = false }: {
  literal: string,
  negative?: boolean,
}) {
  const decimal = parseDecimalLiteral({ literal });
  return negative ? negateDecimal({ decimal }) : decimal;
}

describe('Decimal', () => {
  it('parses and normalizes decimal literals without binary floating point', () => {
    expect(parseDecimalLiteral({ literal: '00123.4500e2' })).toEqual({ coefficient: 12345n, exponent: 0 });
    expect(parseDecimalLiteral({ literal: '0e100000' })).toEqual({ coefficient: 0n, exponent: 0 });
    expect(createDecimal({ coefficient: 123400n, exponent: -4 })).toEqual({ coefficient: 1234n, exponent: -2 });
    expect(() => parseDecimalLiteral({ literal: '' })).toThrow('without digits');
    expect(() => parseDecimalLiteral({ literal: '.' })).toThrow('without digits');
  });

  it('serializes exact and compact decimal forms canonically', () => {
    const small = createDecimal({ coefficient: 1n, exponent: -7 });
    expect(serializeDecimalExact({ decimal: small })).toBe('0.0000001');
    expect(serializeDecimal({ decimal: small })).toBe('1e-7');
    expect(serializeDecimal({ decimal: createDecimal({ coefficient: 1n, exponent: 21 }) })).toBe('1e21');
    expect(serializeDecimalExact({ decimal: createDecimal({ coefficient: -125n, exponent: -2 }) })).toBe('-1.25');
  });

  it('compares zero, sub-unit values, negatives, and aligned values correctly', () => {
    const zero = createDecimal({ coefficient: 0n, exponent: 0 });
    const quarter = signedDecimal({ literal: '0.25' });
    const negativeQuarter = signedDecimal({ literal: '0.25', negative: true });
    expect(compareDecimals({ left: quarter, right: zero })).toBe(1);
    expect(compareDecimals({ left: zero, right: quarter })).toBe(-1);
    expect(compareDecimals({ left: negativeQuarter, right: zero })).toBe(-1);
    expect(compareDecimals({ left: signedDecimal({ literal: '1.20' }), right: signedDecimal({ literal: '1.2' }) })).toBe(0);
    expect(compareDecimals({ left: signedDecimal({ literal: '999e10' }), right: signedDecimal({ literal: '1e13' }) })).toBe(-1);
  });


  it('compares huge scaled integer magnitudes without creating powers of ten', () => {
    const largeCoefficient = BigInt('9'.repeat(1024));
    expect(compareScaledIntegerMagnitudes({
      leftCoefficient: largeCoefficient,
      leftExponent: 0,
      rightCoefficient: 1n,
      rightExponent: 1023,
    })).toBe(1);
    expect(compareScaledIntegerMagnitudes({
      leftCoefficient: 1n,
      leftExponent: 100000,
      rightCoefficient: largeCoefficient,
      rightExponent: 98977,
    })).toBe(-1);
    expect(compareScaledIntegerMagnitudes({
      leftCoefficient: 123n,
      leftExponent: 100000,
      rightCoefficient: 1230n,
      rightExponent: 99999,
    })).toBe(0);
  });

  it('uses half-even for internal significant-digit rounding', () => {
    const rounded = (literal: string, negative = false): string => serializeDecimalExact({
      decimal: roundDecimalToSignificantDigits({
        decimal: signedDecimal({ literal, negative }),
        significantDigits: 1,
        mode: 'half_even',
      }),
    });
    expect(rounded('2.5')).toBe('2');
    expect(rounded('3.5')).toBe('4');
    expect(rounded('2.5', true)).toBe('-2');
    expect(rounded('3.5', true)).toBe('-4');
    expect(rounded('9.99')).toBe('10');
  });

  it('uses halves away from zero for explicit decimal-place rounding', () => {
    const rounded = (literal: string, negative = false): string => serializeDecimalExact({
      decimal: roundDecimalToDecimalPlaces({
        decimal: signedDecimal({ literal, negative }),
        decimalPlaces: 2,
        mode: 'half_away_from_zero',
      }),
    });
    expect(rounded('1.005')).toBe('1.01');
    expect(rounded('1.005', true)).toBe('-1.01');
    expect(rounded('1.004')).toBe('1');
  });

  it('performs bounded approximate arithmetic at the requested precision', () => {
    const oneThird = divideApproximateDecimals({
      numerator: signedDecimal({ literal: '1' }),
      denominator: signedDecimal({ literal: '3' }),
      significantDigits: 5,
    });
    expect(serializeDecimalExact({ decimal: oneThird })).toBe('0.33333');
    expect(serializeDecimalExact({
      decimal: addApproximateDecimals({
        left: oneThird,
        right: signedDecimal({ literal: '0.00001' }),
        significantDigits: 5,
      }),
    })).toBe('0.33334');
    expect(serializeDecimalExact({
      decimal: multiplyApproximateDecimals({
        left: oneThird,
        right: signedDecimal({ literal: '3' }),
        significantDigits: 5,
      }),
    })).toBe('0.99999');
  });

  it('calculates integer root floors with exact bounding inequalities', () => {
    for (const [value, degree, expected] of [
      [0n, 2, 0n],
      [1n, 2, 1n],
      [15n, 2, 3n],
      [16n, 2, 4n],
      [26n, 3, 2n],
      [27n, 3, 3n],
    ] as const) {
      const root = integerRootFloor({ value, degree, consumeOperation });
      expect(root).toBe(expected);
      const lower = degree === 2 ? root * root : root * root * root;
      const upperRoot = root + 1n;
      const upper = degree === 2 ? upperRoot * upperRoot : upperRoot * upperRoot * upperRoot;
      expect(lower <= value).toBe(true);
      expect(value < upper).toBe(true);
    }
  });

  it('rounds roots at root-space midpoints and supports negative cube roots', () => {
    const root = ({ literal, degree, negative = false }: {
      literal: string,
      degree: 2 | 3,
      negative?: boolean,
    }): string => serializeDecimalExact({
      decimal: rootApproximateDecimal({
        decimal: signedDecimal({ literal, negative }),
        degree,
        significantDigits: 1,
        consumeOperation,
      }),
    });
    expect(root({ literal: '2.25', degree: 2 })).toBe('2');
    expect(root({ literal: '6.25', degree: 2 })).toBe('2');
    expect(root({ literal: '12.25', degree: 2 })).toBe('4');
    expect(root({ literal: '2', degree: 3, negative: true })).toBe('-1');
  });

  it('implements floor, ceil, truncation, and half-away integer rounding', () => {
    const negative = signedDecimal({ literal: '1.8', negative: true });
    expect(serializeDecimalExact({ decimal: truncateDecimalToInteger({ decimal: negative, mode: 'floor' }) })).toBe('-2');
    expect(serializeDecimalExact({ decimal: truncateDecimalToInteger({ decimal: negative, mode: 'ceil' }) })).toBe('-1');
    expect(serializeDecimalExact({ decimal: truncateDecimalToInteger({ decimal: negative, mode: 'trunc' }) })).toBe('-1');
    expect(serializeDecimalExact({
      decimal: truncateDecimalToInteger({ decimal: signedDecimal({ literal: '1.5', negative: true }), mode: 'round_half_away' }),
    })).toBe('-2');
  });
});
