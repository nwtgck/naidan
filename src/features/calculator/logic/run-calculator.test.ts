import { describe, expect, it } from 'vitest';
import { runCalculator } from './run-calculator';

function expectValue({ input, text }: { input: string, text: string }): void {
  const result = runCalculator({ input });
  expect(result).toEqual({
    status: 'success',
    output: {
      kind: 'value',
      value: expect.any(Number),
      text,
    },
  });
}

describe('runCalculator', () => {
  it('evaluates precedence, right-associative powers, and unary signs', () => {
    expectValue({ input: '2 + 3 * 4', text: '14' });
    expectValue({ input: '2 ^ 3 ^ 2', text: '512' });
    expectValue({ input: '-2 ^ 2', text: '-4' });
    expectValue({ input: '(-2) ^ 2', text: '4' });
    expectValue({ input: '2 ^ -3', text: '0.125' });
  });

  it('evaluates practical calculator functions', () => {
    expectValue({ input: 'mean(10, 20, 30)', text: '20' });
    expectValue({ input: 'percent_of(15, 240)', text: '36' });
    expectValue({ input: 'log(8, 2)', text: '3' });
    expectValue({ input: 'gcd(48, 18)', text: '6' });
    expectValue({ input: 'combinations(10, 3)', text: '120' });
    expectValue({ input: 'sin(deg_to_rad(30))', text: '0.5' });
  });

  it('uses Euclidean modulo with a positive divisor', () => {
    expectValue({ input: '-17 % 5', text: '3' });
  });

  it('formats floating-point noise for readable Tool output', () => {
    expectValue({ input: '0.1 + 0.2', text: '0.3' });
    expectValue({ input: '1 / 3', text: '0.3333333333333333' });
  });

  it('avoids avoidable overflow in aggregation and conversion helpers', () => {
    expectValue({ input: 'sum(1e308, 1e308, -1e308)', text: '1e308' });
    expectValue({ input: 'mean(1e308, 1e308)', text: '1e308' });
    expectValue({ input: 'median(1e308, 1e308)', text: '1e308' });
    expectValue({ input: 'percent_of(100, 1e308)', text: '1e308' });
    expectValue({ input: 'percent_change(-1e308, 1e308)', text: '200' });

    const conversion = runCalculator({ input: 'deg_to_rad(1e308)' });
    expect(conversion.status).toBe('success');
    if (conversion.status !== 'success' || conversion.output.kind !== 'value') {
      throw new Error('Expected finite degree conversion');
    }
    expect(Number.isFinite(conversion.output.value)).toBe(true);
  });

  it('rounds decimal positions with halves away from zero', () => {
    expectValue({ input: 'round_to(1.005, 2)', text: '1.01' });
    expectValue({ input: 'round_to(-1.005, 2)', text: '-1.01' });
    expectValue({ input: 'round_to(1e308, 100)', text: '1e308' });
  });

  it('enforces the evaluation operation budget', () => {
    const arguments_ = Array.from({ length: 254 }, () => '0').join(', ');
    const result = runCalculator({
      input: `median(${arguments_}) + median(${arguments_})`,
    });
    expect(result.status).toBe('error');
    if (result.status !== 'error') throw new Error('Expected operation budget error');
    expect(result.diagnostic.code).toBe('limit_exceeded');
    expect(result.text).toContain('operation budget');
  });

  it('returns overview and focused help without parsing it as an expression', () => {
    const overview = runCalculator({ input: 'help' });
    expect(overview.status).toBe('success');
    if (overview.status !== 'success') throw new Error('Expected calculator help success');
    expect(overview.output.kind).toBe('help');
    expect(overview.output.text).toContain('Functions:');
    expect(overview.output.text).toContain('percent_change');

    const logHelp = runCalculator({ input: 'help log' });
    expect(logHelp.status).toBe('success');
    if (logHelp.status !== 'success') throw new Error('Expected calculator help success');
    expect(logHelp.output.text).toContain('Usage: log(value, base)');
    expect(logHelp.output.text).toContain('log(8, 2) => 3');
  });

  it('returns actionable syntax and domain diagnostics', () => {
    const syntax = runCalculator({ input: '2 + * 3' });
    expect(syntax.status).toBe('error');
    if (syntax.status !== 'error') throw new Error('Expected calculator syntax error');
    expect(syntax.diagnostic.code).toBe('unexpected_token');
    expect(syntax.text).toContain('line 1, column 5');

    const domain = runCalculator({ input: 'sqrt(-1)' });
    expect(domain.status).toBe('error');
    if (domain.status !== 'error') throw new Error('Expected calculator domain error');
    expect(domain.diagnostic.code).toBe('domain_error');
  });

  it('requires explicit multiplication and rejects unsupported program syntax', () => {
    const implicit = runCalculator({ input: '2pi' });
    expect(implicit.status).toBe('error');
    if (implicit.status !== 'error') throw new Error('Expected calculator syntax error');
    expect(implicit.text).toContain('explicit `*`');

    const attackInputs = [
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
    ];
    for (const input of attackInputs) {
      expect(runCalculator({ input }).status, input).toBe('error');
    }
  });

  it('is deterministic for a fixed corpus of arbitrary short inputs', () => {
    let state = 0x5eed1234;
    const alphabet = '0123456789abcdefghijklmnopqrstuvwxyz_+-*/%^(),. []{};=`"\n';
    for (let sample = 0; sample < 500; sample += 1) {
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
