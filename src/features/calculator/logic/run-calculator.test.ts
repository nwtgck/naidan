import { describe, expect, it } from 'vitest';
import { runCalculator } from './run-calculator';
import type { CalculatorOutputPolicy } from './result-presentation';

const DECIMAL_15: CalculatorOutputPolicy = { format: 'decimal', significantDigits: 15 };

function expectValue({
  input,
  text,
  exactness,
  output = DECIMAL_15,
}: {
  input: string,
  text: string,
  exactness: 'rational' | 'approximate',
  output?: CalculatorOutputPolicy,
}): void {
  expect(runCalculator({ input, output })).toEqual({
    status: 'success',
    output: { kind: 'value', exactness, text },
  });
}

describe('runCalculator', () => {
  it('preserves rational arithmetic through AST evaluation', () => {
    expectValue({ input: '0.1 + 0.2', text: '0.3', exactness: 'rational' });
    expectValue({ input: '1 / 3', text: '0.333333333333333', exactness: 'rational' });
    expectValue({
      input: '1 / 3',
      output: { format: 'rational' },
      text: '1/3',
      exactness: 'rational',
    });
    expectValue({
      input: '1 / 3 + 1 / 6',
      output: { format: 'rational' },
      text: '0.5',
      exactness: 'rational',
    });
  });

  it('uses the calculator maximum precision when output is omitted', () => {
    expect(runCalculator({ input: '1 / 3' })).toEqual({
      status: 'success',
      output: {
        kind: 'value',
        exactness: 'rational',
        text: '0.33333333333333333333333333333333333333333333333333',
      },
    });
  });

  it('evaluates approximate constants in decimal output', () => {
    expectValue({ input: 'pi * 2', text: '6.28318530717959', exactness: 'approximate' });
    expectValue({
      input: 'pi * 2',
      output: { format: 'decimal', significantDigits: 30 },
      text: '6.28318530717958647692528676656',
      exactness: 'approximate',
    });
    const rational = runCalculator({ input: 'pi * 2', output: { format: 'rational' } });
    expect(rational.status).toBe('error');
    if (rational.status !== 'error') throw new Error('Expected rational-output error');
    expect(rational.diagnostic.code).toBe('result_not_rational');
  });

  it('evaluates precedence, integer powers, and unary signs', () => {
    expectValue({ input: '2 + 3 * 4', text: '14', exactness: 'rational' });
    expectValue({ input: '2 ^ 3 ^ 2', text: '512', exactness: 'rational' });
    expectValue({ input: '-2 ^ 2', text: '-4', exactness: 'rational' });
    expectValue({ input: '(-2) ^ 2', text: '4', exactness: 'rational' });
    expectValue({ input: '2 ^ -3', text: '0.125', exactness: 'rational' });
    expectValue({ input: '3 ^ -1', text: '0.333333333333333', exactness: 'rational' });
    expectValue({ input: '0 ^ 0', text: '1', exactness: 'rational' });
  });

  it('calculates exact and approximate roots without Math fallback', () => {
    expectValue({ input: 'sqrt(81)', text: '9', exactness: 'rational' });
    expectValue({ input: 'cbrt(-27)', text: '-3', exactness: 'rational' });
    expectValue({ input: 'hypot(3, 4)', text: '5', exactness: 'rational' });
    expectValue({ input: 'sqrt(2)', text: '1.4142135623731', exactness: 'approximate' });
  });

  it('evaluates rounding, aggregation, percentage, and integer functions', () => {
    expectValue({ input: 'round_to(1.005, 2)', text: '1.01', exactness: 'rational' });
    expectValue({ input: 'mean(10, 20, 30)', text: '20', exactness: 'rational' });
    expectValue({ input: 'percent_of(15, 240)', text: '36', exactness: 'rational' });
    expectValue({ input: 'gcd(48, 18)', text: '6', exactness: 'rational' });
    expectValue({ input: 'combinations(10, 3)', text: '120', exactness: 'rational' });
  });

  it('uses exact Euclidean modulo with a positive divisor', () => {
    expectValue({ input: '-5.5 % 2', text: '0.5', exactness: 'rational' });
    for (const input of ['5 % -2', '5 % 0', 'pi % 2']) {
      const result = runCalculator({ input, output: DECIMAL_15 });
      expect(result.status, input).toBe('error');
    }
  });

  it('does not shorten exact integers in rational output', () => {
    const expected = '93326215443944152681699238856266700490715968264381621468592963895217599993229915608941463976156518286253697920827223758251185210916864000000000000000000000000';
    expectValue({
      input: 'factorial(100)',
      output: { format: 'rational' },
      text: expected,
      exactness: 'rational',
    });
    expectValue({
      input: 'factorial(100)',
      text: '9.33262154439442e157',
      exactness: 'rational',
    });
  });

  it('enforces numeric limits before unbounded work', () => {
    for (const input of ['1e100001', '0e100001', 'factorial(459)']) {
      const result = runCalculator({ input, output: DECIMAL_15 });
      expect(result.status, input).toBe('error');
      if (result.status === 'error') expect(result.diagnostic.code).toBe('limit_exceeded');
    }
    expectValue({ input: 'min(1e100000, 1)', text: '1', exactness: 'rational' });
    expectValue({
      input: 'max(1e100000, 1)',
      output: { format: 'rational' },
      text: '1e100000',
      exactness: 'rational',
    });
  });

  it('returns actionable syntax and domain diagnostics', () => {
    const syntax = runCalculator({ input: '2 + * 3' });
    expect(syntax.status).toBe('error');
    if (syntax.status !== 'error') throw new Error('Expected syntax error');
    expect(syntax.diagnostic.code).toBe('unexpected_token');
    expect(syntax.text).toContain('line 1, column 5');

    const domain = runCalculator({ input: 'sqrt(-1)' });
    expect(domain.status).toBe('error');
    if (domain.status !== 'error') throw new Error('Expected domain error');
    expect(domain.diagnostic.code).toBe('domain_error');

    const nonIntegerPower = runCalculator({ input: '2 ^ 0.5' });
    expect(nonIntegerPower.status).toBe('error');
    if (nonIntegerPower.status === 'error') expect(nonIntegerPower.diagnostic.code).toBe('invalid_argument');
  });

  it('locates numeric resource-limit errors at the expression that caused them', () => {
    const result = runCalculator({ input: '1 + factorial(459)' });
    expect(result.status).toBe('error');
    if (result.status === 'error') {
      expect(result.diagnostic.code).toBe('limit_exceeded');
      expect(result.diagnostic.span).toEqual({ start: 4, end: 18 });
    }
  });

  it('rejects removed functions and unsupported program syntax', () => {
    for (const input of [
      'sin(1)',
      'log(8, 2)',
      'constructor.constructor("return globalThis")()',
      'globalThis',
      'Math.sin(1)',
      'sqrt.constructor',
      '1..toString()',
      '[1, 2, 3]',
      '{ value: 1 }',
      'x = 1',
      '1; 2',
      '`hello`',
      'import(1)',
      '__proto__',
    ]) {
      expect(runCalculator({ input }).status, input).toBe('error');
    }
  });

  it('is deterministic for a fixed corpus of arbitrary short inputs', () => {
    let state = 0x5eed1234;
    const alphabet = '0123456789abcdefghijklmnopqrstuvwxyz_+-*/%^(),. []{};=`"\n';
    for (let sample = 0; sample < 250; sample += 1) {
      state = (state * 1_664_525 + 1_013_904_223) >>> 0;
      const length = state % 40;
      let input = '';
      for (let index = 0; index < length; index += 1) {
        state = (state * 1_664_525 + 1_013_904_223) >>> 0;
        input += alphabet[state % alphabet.length];
      }
      expect(runCalculator({ input })).toEqual(runCalculator({ input }));
    }
  });
});
