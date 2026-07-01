import { describe, expect, it } from 'vitest';
import { createRationalValue, parseApproximateConstant } from './numeric/numeric-value';
import { createRational } from './numeric/rational';
import { presentCalculatorValue } from './result-presentation';

describe('presentCalculatorValue', () => {
  it('renders a rational as decimal significant digits or an exact fraction', () => {
    const rational = createRationalValue({
      rational: createRational({ numerator: 1n, denominator: 3n, decimalExponent: 0 }),
    });
    expect(presentCalculatorValue({
      value: rational,
      output: { format: 'decimal', significantDigits: 15 },
    })).toBe('0.333333333333333');
    expect(presentCalculatorValue({ value: rational, output: { format: 'rational' } })).toBe('1/3');
  });

  it('keeps finite rationals readable in rational output', () => {
    const value = createRationalValue({
      rational: createRational({ numerator: 1n, denominator: 8n, decimalExponent: 0 }),
    });
    expect(presentCalculatorValue({ value, output: { format: 'rational' } })).toBe('0.125');
  });

  it('rejects rational presentation for approximate values', () => {
    expect(() => presentCalculatorValue({
      value: parseApproximateConstant({ literal: '3.1415926535897932384626433832795028841971693993751' }),
      output: { format: 'rational' },
    })).toThrow('cannot be represented as an exact rational');
  });
});
