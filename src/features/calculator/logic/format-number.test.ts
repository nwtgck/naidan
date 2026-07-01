import { describe, expect, it } from 'vitest';
import { formatCalculatorNumber } from './format-number';

describe('formatCalculatorNumber', () => {
  it('shortens ordinary floating-point noise', () => {
    expect(formatCalculatorNumber({ value: 0.1 + 0.2 })).toBe('0.3');
    expect(formatCalculatorNumber({ value: Math.sin(Math.PI / 6) })).toBe('0.5');
  });

  it('does not use a unit-scale tolerance for tiny values', () => {
    expect(formatCalculatorNumber({
      value: 1.234567890123456e-20,
    })).toBe('1.234567890123456e-20');
  });

  it('preserves safe integers and normalizes negative zero', () => {
    expect(formatCalculatorNumber({ value: Number.MAX_SAFE_INTEGER })).toBe('9007199254740991');
    expect(formatCalculatorNumber({ value: -0 })).toBe('0');
  });

  it('rejects non-finite internal values', () => {
    expect(() => formatCalculatorNumber({ value: Number.POSITIVE_INFINITY })).toThrow(
      'Cannot format non-finite calculator value',
    );
  });
});
