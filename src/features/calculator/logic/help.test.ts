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
  it('documents exact rational and approximate decimal behavior', () => {
    const text = getHelpText({ input: 'help precision' });
    expect(text).toContain('1 / 3');
    expect(text).toContain('significant digits');
    expect(text).toContain('pi * 2');
  });

  it('describes variadic arity without inventing another required argument', () => {
    expect(getHelpText({ input: 'help mean' })).toContain('Usage: mean(value, ...)');
    expect(getHelpText({ input: 'help gcd' })).toContain('Usage: gcd(value, ...)');
  });

  it('renders categories from the active catalog only', () => {
    const angles = getHelpText({ input: 'help angles' });
    expect(angles).toContain('deg_to_rad');
    expect(angles).toContain('rad_to_deg');
    expect(getHelpText({ input: 'help' })).not.toContain('log10');
  });

  it('suggests related topics and rejects multiple topics', () => {
    const unknown = runCalculator({ input: 'help percent_chang' });
    expect(unknown.status).toBe('error');
    if (unknown.status === 'error') {
      expect(unknown.diagnostic.code).toBe('unknown_help_topic');
      expect(unknown.text).toContain('percent_change');
    }

    const multiple = runCalculator({ input: 'help mean extra' });
    expect(multiple.status).toBe('error');
    if (multiple.status === 'error') expect(multiple.diagnostic.code).toBe('invalid_help_usage');
  });
});
