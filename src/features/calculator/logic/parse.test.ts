import { describe, expect, it } from 'vitest';
import { parseCalculatorTokens } from './parse';
import { tokenizeCalculatorInput } from './tokenize';

function parse({ input }: { input: string }) {
  return parseCalculatorTokens({ tokens: tokenizeCalculatorInput({ input }) });
}

describe('calculator parser', () => {
  it('flattens long left-associative sequences', () => {
    const expression = parse({ input: '1 + 2 - 3 + 4' });
    expect(expression.type).toBe('sequence');
    if (expression.type !== 'sequence') throw new Error('Expected sequence expression');
    expect(expression.group).toBe('additive');
    expect(expression.tail.map(item => item.operator)).toEqual(['+', '-', '+']);
  });

  it('constructs right-associative power expressions', () => {
    const expression = parse({ input: '2 ^ 3 ^ 2' });
    expect(expression.type).toBe('power');
    if (expression.type !== 'power') throw new Error('Expected power expression');
    expect(expression.exponent.type).toBe('power');
  });

  it('places unary minus outside a power but permits negative exponents', () => {
    const negativeBase = parse({ input: '-2 ^ 2' });
    expect(negativeBase.type).toBe('unary');
    if (negativeBase.type !== 'unary') throw new Error('Expected unary expression');
    expect(negativeBase.operand.type).toBe('power');

    const negativeExponent = parse({ input: '2 ^ -3' });
    expect(negativeExponent.type).toBe('power');
    if (negativeExponent.type !== 'power') throw new Error('Expected power expression');
    expect(negativeExponent.exponent.type).toBe('unary');
  });
});
