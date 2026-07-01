import { describe, expect, it } from 'vitest';
import { CALCULATOR_LIMITS } from './limits';
import { tokenizeCalculatorInput } from './tokenize';

describe('tokenizeCalculatorInput', () => {
  it('preserves decimal and scientific literals with source spans', () => {
    expect(tokenizeCalculatorInput({ input: '.5 1. 2.5e-3' })).toEqual([
      { type: 'number', literal: '.5', span: { start: 0, end: 2 } },
      { type: 'number', literal: '1.', span: { start: 3, end: 5 } },
      { type: 'number', literal: '2.5e-3', span: { start: 6, end: 12 } },
      { type: 'end', span: { start: 12, end: 12 } },
    ]);
  });

  it('counts source tokens without charging the synthetic end token', () => {
    const maximumInput = Array.from({ length: CALCULATOR_LIMITS.maximumTokenCount }, () => '1').join(' ');
    expect(tokenizeCalculatorInput({ input: maximumInput })).toHaveLength(
      CALCULATOR_LIMITS.maximumTokenCount + 1,
    );
    expect(() => tokenizeCalculatorInput({ input: `${maximumInput} 1` })).toThrow(
      `maximum of ${CALCULATOR_LIMITS.maximumTokenCount} tokens`,
    );
  });

  it('rejects incomplete scientific notation', () => {
    expect(() => tokenizeCalculatorInput({ input: '1e-' })).toThrow(
      'exponent must contain at least one digit',
    );
  });

  it('reports a complete Unicode code point for unsupported input', () => {
    expect(() => tokenizeCalculatorInput({ input: '🙂' })).toThrow(
      'The character "🙂" is not part of the calculator language.',
    );
  });
});
