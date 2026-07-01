import { describe, expect, it } from 'vitest';
import { runCalculator } from './run-calculator';

function getHelpText({ input }: { input: string }): string {
  const result = runCalculator({ input });
  expect(result.status).toBe('success');
  if (result.status !== 'success') throw new Error(`Expected help success for ${input}`);
  expect(result.output.kind).toBe('help');
  return result.output.text;
}

describe('calculator help', () => {
  it('describes variadic arity without inventing another required argument', () => {
    expect(getHelpText({ input: 'help mean' })).toContain('Usage: mean(value, ...)');
    expect(getHelpText({ input: 'help gcd' })).toContain('Usage: gcd(value, value, ...)');
  });

  it('renders category help from the function catalog', () => {
    const text = getHelpText({ input: 'help logarithms' });
    expect(text).toContain('log(value, base)');
    expect(text).toContain('ln(value)');
  });

  it('documents percentage-change behavior for negative starting values', () => {
    expect(getHelpText({ input: 'help percent_change' })).toContain(
      'absolute starting value',
    );
  });

  it('suggests related topics for an unknown topic', () => {
    const result = runCalculator({ input: 'help logarithm' });
    expect(result.status).toBe('error');
    if (result.status !== 'error') throw new Error('Expected unknown help topic error');
    expect(result.diagnostic.code).toBe('unknown_help_topic');
    expect(result.text).toContain('logarithms');
  });

  it('rejects multiple help topics', () => {
    const result = runCalculator({ input: 'help log extra' });
    expect(result.status).toBe('error');
    if (result.status !== 'error') throw new Error('Expected invalid help usage error');
    expect(result.diagnostic.code).toBe('invalid_help_usage');
  });
});
