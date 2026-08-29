import { describe, expect, it } from 'vitest';
import { parseGitMaxCount } from '@/features/wesh/commands/git/max-count';
describe('git max-count parsing', () => {
  it('treats negative values as unlimited', () => {
    expect(parseGitMaxCount({ value: '-1', option: '--max-count' })).toBe(Number.POSITIVE_INFINITY);
    expect(parseGitMaxCount({ value: '-20', option: '-n' })).toBe(Number.POSITIVE_INFINITY);
  });
  it('preserves zero and positive limits', () => {
    expect(parseGitMaxCount({ value: '0', option: '-n' })).toBe(0);
    expect(parseGitMaxCount({ value: '12', option: '--max-count' })).toBe(12);
  });
  it("rejects values outside Git's signed 32-bit range", () => {
    expect(parseGitMaxCount({ value: '-2147483648', option: '-n' })).toBe(Number.POSITIVE_INFINITY);
    expect(parseGitMaxCount({ value: '2147483647', option: '--max-count' })).toBe(2147483647);
    expect(() => parseGitMaxCount({ value: '-2147483649', option: '-n' })).toThrow("option '-n' requires a numeric value");
    expect(() => parseGitMaxCount({ value: '+2147483648', option: '--max-count' })).toThrow("option '--max-count' requires a numeric value");
  });

  it('rejects non-decimal values', () => {
    expect(() => parseGitMaxCount({ value: '1x', option: '-n' })).toThrow("option '-n' requires a numeric value");
    expect(() => parseGitMaxCount({ value: '1 ', option: '-n' })).toThrow("option '-n' requires a numeric value");
    expect(() => parseGitMaxCount({ value: '+', option: '-n' })).toThrow("option '-n' requires a numeric value");
  });
});
