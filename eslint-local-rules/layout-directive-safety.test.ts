import { Linter } from 'eslint';
import * as parser from '@typescript-eslint/parser';
import { describe, expect, it } from 'vitest';
import { getProtectedLines, intersectsProtectedLines } from './layout-directive-safety.js';

type Interval = { start: number; end: number };

function collect({ code }: { code: string }): Interval[] {
  let intervals: Interval[] = [];
  const linter = new Linter();
  const messages = linter.verify(code, {
    files: ['**/*.ts'],
    languageOptions: { parser },
    linterOptions: { noInlineConfig: true },
    plugins: {
      fixture: {
        rules: {
          collect: {
            create(context) {
              return {
                Program() {
                  intervals = getProtectedLines({ sourceCode: context.sourceCode });
                },
              };
            },
          },
        },
      },
    },
    rules: { 'fixture/collect': 'error' },
  }, { filename: 'fixture.ts' });
  expect(messages.some(message => message.fatal)).toBe(false);
  return intervals;
}

const compilerPrefixCases = ['expect-error', 'ignore'].flatMap(directive => (
  ['TS2304', '_reason', '123'].flatMap(suffix => (
    [
      `// @ts-${directive}${suffix}`,
      `/// @ts-${directive}${suffix}`,
      `/* @ts-${directive}${suffix} */`,
      `/* explanation\n * @ts-${directive}${suffix} */`,
    ].map(comment => ({ comment }))
  ))
));

describe('layout-directive-safety TypeScript prefixes', () => {
  it.each(compilerPrefixCases)('protects the compiler-recognized prefix in $comment', ({ comment }) => {
    const count = comment.split('\n').length;
    expect(collect({ code: `${comment}\nconst x = {value: missing};` })).toEqual([
      { start: 1, end: count + 1 },
    ]);
  });

  it('does not treat directive-like strings or ordinary prose as directives', () => {
    expect(collect({ code: `\
// This explanation mentions @ts-ignore but is not an instruction.
/* Not a directive: @ts-expect-error */
const x = {a: "@ts-ignore", b: "node:coverage ignore next 3"};
` })).toEqual([]);
  });

  it.each(['\n', '\r\n', '\r', '\u2028', '\u2029'])('skips comment-only and blank lines with %j', ending => {
    const code = '// @ts-expect-errorTS2304\n\n/* context */\nconst x = {};'.replaceAll('\n', ending);
    expect(collect({ code })).toEqual([{ start: 1, end: 4 }]);
  });
});

describe('layout-directive-safety counted coverage ranges', () => {
  it.each(['c8', 'v8', 'node:coverage'])('protects the full counted %s range', tool => {
    const code = `/* ${tool} ignore next 3 */\nconst a = 1;\nconst b = {};\nconst c = {};\nconst safe = {};`;
    expect(collect({ code })).toEqual([{ start: 1, end: 4 }]);
  });

  it.each(['c8', 'v8', 'node:coverage'])('treats an omitted %s count as the next line', tool => {
    expect(collect({ code: `/* ${tool} ignore next */\nconst a = {};\nconst safe = {};` })).toEqual([
      { start: 1, end: 2 },
    ]);
  });

  it.each(['c8', 'v8', 'node:coverage'])('bounds a very large %s count without allocating per covered line', tool => {
    const code = `/* ${tool} ignore next ${'9'.repeat(400)} */\nconst a = {};\nconst b = {};`;
    const intervals = collect({ code });
    expect(intervals).toHaveLength(1);
    expect(intervals[0]?.start).toBe(1);
    expect(intervals[0]?.end).toBeLessThanOrEqual(4);
    expect(intervals[0]?.end).toBeGreaterThanOrEqual(3);
  });

  it('protects the positions of Node.js coverage region markers', () => {
    expect(collect({ code: `\
/* node:coverage disable */
const a = {};
/* node:coverage enable */
const b = {};` })).toEqual([{ start: 1, end: 1 }, { start: 3, end: 3 }]);
  });
});

describe('layout-directive-safety interval merging and lookup', () => {
  it('merges overlapping and adjacent spans without protecting distant code', () => {
    const code = `\
/* c8 ignore next 4 */
const a = {};
/* v8 ignore next 3 */
const b = {};
const c = {};
const d = {};
// @ts-ignoreTS2304
const e = {};
const safe = {};
const alsoSafe = {};
// @ts-expect-error_code
const f = {};`;
    expect(collect({ code })).toEqual([{ start: 1, end: 8 }, { start: 11, end: 12 }]);
  });

  it.each([
    [],
    [{ start: 3, end: 3 }],
    [{ start: 2, end: 4 }, { start: 7, end: 9 }, { start: 14, end: 17 }],
    [{ start: 1, end: 25 }],
  ].map(intervals => ({ intervals })))('matches a linear intersection check for intervals $intervals', ({ intervals }) => {
    for (let start = 1; start <= 25; start += 1) {
      for (let end = start; end <= 25; end += 1) {
        const node = { loc: { start: { line: start }, end: { line: end } } };
        expect(intersectsProtectedLines({ node, intervals })).toBe(
          intervals.some(interval => interval.start <= end && start <= interval.end),
        );
      }
    }
  });
});
