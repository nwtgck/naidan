import { describe, expect, it } from 'vitest';
import { parseDecimalLiteral, serializeDecimalExact } from './decimal';
import {
  addRationals,
  compareRationals,
  createRational,
  divideRationals,
  moduloRationals,
  multiplyRationals,
  perfectRationalRoot,
  powerRationalInteger,
  rationalFromDecimal,
  rationalToDecimal,
  rationalToFiniteDecimal,
  roundRationalToDecimalPlaces,
  serializeRational,
  truncateRationalToInteger,
  subtractRationals,
} from './rational';

const consumeOperation = (): void => {};
const rational = (numerator: bigint, denominator = 1n, decimalExponent = 0) => createRational({
  numerator,
  denominator,
  decimalExponent,
});

describe('Rational', () => {
  it('normalizes signs, common factors, and decimal powers', () => {
    expect(createRational({ numerator: 10n, denominator: -30n, decimalExponent: 2 })).toEqual({
      numerator: -1n,
      denominator: 3n,
      decimalExponent: 2,
    });
    expect(createRational({ numerator: 1200n, denominator: 30n, decimalExponent: -2 })).toEqual({
      numerator: 4n,
      denominator: 1n,
      decimalExponent: -1,
    });
    expect(rational(0n, -999n, 100)).toEqual({ numerator: 0n, denominator: 1n, decimalExponent: 0 });
  });

  it('keeps non-terminating division as an exact reduced fraction', () => {
    expect(serializeRational({ rational: rational(10n, 30n) })).toBe('1/3');
    expect(serializeRational({ rational: divideRationals({ numerator: rational(2n), denominator: rational(6n) }) })).toBe('1/3');
  });

  it('keeps decimal arithmetic exact across all four rational operations', () => {
    const oneTenth = rationalFromDecimal({ decimal: parseDecimalLiteral({ literal: '0.1' }) });
    const oneFifth = rationalFromDecimal({ decimal: parseDecimalLiteral({ literal: '0.2' }) });
    expect(serializeRational({ rational: addRationals({ left: oneTenth, right: oneFifth }) })).toBe('0.3');
    expect(serializeRational({ rational: subtractRationals({ left: oneTenth, right: oneFifth }) })).toBe('-0.1');
    expect(serializeRational({ rational: multiplyRationals({ left: oneTenth, right: oneFifth }) })).toBe('0.02');
    expect(serializeRational({ rational: divideRationals({ numerator: oneTenth, denominator: oneFifth }) })).toBe('0.5');
  });

  it('compares zero, sub-unit decimals, negatives, and fractions correctly', () => {
    const zero = rational(0n);
    const quarter = rationalFromDecimal({ decimal: parseDecimalLiteral({ literal: '0.25' }) });
    const negative = rational(-25n, 1n, -2);
    expect(compareRationals({ left: quarter, right: zero })).toBe(1);
    expect(compareRationals({ left: zero, right: quarter })).toBe(-1);
    expect(compareRationals({ left: negative, right: zero })).toBe(-1);
    expect(compareRationals({ left: rational(1n, 3n), right: rational(2n, 5n) })).toBe(-1);
    expect(compareRationals({ left: rational(10n, 30n), right: rational(1n, 3n) })).toBe(0);
  });

  it('detects finite decimals and rounds non-terminating fractions deterministically', () => {
    const finite = rationalToFiniteDecimal({ rational: rational(1n, 8n) });
    expect(finite).toBeDefined();
    expect(serializeDecimalExact({ decimal: finite! })).toBe('0.125');
    expect(rationalToFiniteDecimal({ rational: rational(1n, 3n) })).toBeUndefined();
    expect(serializeDecimalExact({
      decimal: rationalToDecimal({ rational: rational(1n, 3n), significantDigits: 5 }),
    })).toBe('0.33333');
    expect(serializeDecimalExact({
      decimal: rationalToDecimal({ rational: rational(2n, 3n), significantDigits: 5 }),
    })).toBe('0.66667');
  });


  it('preserves decimal powers introduced by rational rounding', () => {
    for (const [value, decimalPlaces, expected] of [
      [rational(28192n, 115443n, 8), 0, '24420710'],
      [rational(-223697n, 731523n, 5), 0, '-30580'],
      [rational(145022n, 414899n, 1), 2, '3.5'],
      [rational(-1385035n, 1391373n, 1), 1, '-10'],
      [rational(-1689247n, 1717633n, -5), 6, '-0.00001'],
    ] as const) {
      expect(serializeRational({
        rational: roundRationalToDecimalPlaces({ rational: value, decimalPlaces }),
      })).toBe(expected);
    }
  });

  it('rounds tiny finite rationals without materializing their full decimal expansion', () => {
    const tiny = rational(1n, 2n ** 3400n);
    const negativeTiny = rational(-1n, 2n ** 3400n);
    expect(serializeRational({ rational: truncateRationalToInteger({ rational: tiny, mode: 'floor' }) })).toBe('0');
    expect(serializeRational({ rational: truncateRationalToInteger({ rational: tiny, mode: 'ceil' }) })).toBe('1');
    expect(serializeRational({ rational: truncateRationalToInteger({ rational: tiny, mode: 'trunc' }) })).toBe('0');
    expect(serializeRational({ rational: truncateRationalToInteger({ rational: tiny, mode: 'round_half_away' }) })).toBe('0');
    expect(serializeRational({ rational: truncateRationalToInteger({ rational: negativeTiny, mode: 'floor' }) })).toBe('-1');
    expect(serializeRational({ rational: truncateRationalToInteger({ rational: negativeTiny, mode: 'ceil' }) })).toBe('0');
    expect(serializeRational({ rational: truncateRationalToInteger({ rational: negativeTiny, mode: 'trunc' }) })).toBe('0');
    expect(serializeRational({ rational: truncateRationalToInteger({ rational: negativeTiny, mode: 'round_half_away' }) })).toBe('0');
  });

  it('compares huge scaled rationals without materializing their decimal exponent gap', () => {
    const largeCoefficient = BigInt('9'.repeat(1024));
    const left = rational(largeCoefficient);
    const right = rational(1n, largeCoefficient, 2047);
    expect(compareRationals({ left, right })).toBe(1);
    expect(compareRationals({ left: right, right: left })).toBe(-1);
    expect(compareRationals({
      left: rational(-largeCoefficient),
      right: rational(-1n, largeCoefficient, 2047),
    })).toBe(-1);
  });

  it('implements Euclidean modulo for rational decimals', () => {
    expect(serializeRational({ rational: moduloRationals({ left: rational(-17n), right: rational(5n) }) })).toBe('3');
    expect(serializeRational({
      rational: moduloRationals({
        left: rationalFromDecimal({ decimal: parseDecimalLiteral({ literal: '5.5' }) }),
        right: rationalFromDecimal({ decimal: parseDecimalLiteral({ literal: '0.2' }) }),
      }),
    })).toBe('0.1');
  });

  it('calculates exact integer powers and perfect roots', () => {
    expect(serializeRational({
      rational: powerRationalInteger({ base: rational(-2n), exponent: 3, consumeOperation }),
    })).toBe('-8');
    expect(serializeRational({
      rational: powerRationalInteger({ base: rational(3n), exponent: -1, consumeOperation }),
    })).toBe('1/3');
    expect(serializeRational({
      rational: perfectRationalRoot({ rational: rational(4n, 9n), degree: 2, consumeOperation })!,
    })).toBe('2/3');
    expect(serializeRational({
      rational: perfectRationalRoot({ rational: rational(-1n, 8n), degree: 3, consumeOperation })!,
    })).toBe('-0.5');
    expect(perfectRationalRoot({ rational: rational(2n), degree: 2, consumeOperation })).toBeUndefined();
  });
});
