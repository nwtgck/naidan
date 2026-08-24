import { describe, expect, it } from 'vitest';
import { compareGitUtf8Strings, sortGitUtf8Strings } from './utf8-order';

const bmpPrivateUse = '\uE000';
const supplementary = '\u{10000}';

describe('wesh git UTF-8 ordering', () => {
  it('orders strings by their UTF-8 bytes rather than JavaScript UTF-16 code units', () => {
    expect([bmpPrivateUse, supplementary].sort()).toEqual([supplementary, bmpPrivateUse]);
    expect(compareGitUtf8Strings({ left: bmpPrivateUse, right: supplementary })).toBeLessThan(0);
    expect(sortGitUtf8Strings({ values: [supplementary, bmpPrivateUse] })).toEqual([
      bmpPrivateUse,
      supplementary,
    ]);
  });
});
