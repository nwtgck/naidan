import { describe, expect, it } from 'vitest';
import { validateJqProgram } from './compile';
import { extractPathExpression, parseJqProgram } from './parser';
import { evaluateJqFilter, TEST_ONLY as jqRuntime } from './runtime';
import {
  collectJqRegularExpressionMatches,
  compileJqRegularExpression,
  TEST_ONLY as jqRegexp,
} from './regexp';
import { TEST_ONLY as jqLimits } from './limits';
import type { JsonValue, JqFilter, JqPath, JqPathExpression, JqProgram } from './ast';
import { applyPathDeletion, applyPathDeletions, applyPathUpdate, extractJqPath, materializeJqPathExpression, readJqPathValue } from './path';
import {
  compareJsonValues,
  createJsonObject,
  defineJsonProperty,
  formatJqArithmeticError,
  isJsonObject,
  normalizeJsonValue,
  stringifyJson,
} from './value';

function jsonObject({
  entries,
}: {
  entries: readonly (readonly [string, JsonValue])[],
}): { [key: string]: JsonValue } {
  const object = createJsonObject();
  for (const [key, value] of entries) {
    defineJsonProperty({ object, key, value });
  }
  return object;
}

const nestedValuePath: JqPath = {
  segments: [
    { kind: 'field', key: 'changed', optional: false },
    { kind: 'field', key: 'value', optional: false },
  ],
};


describe('jq iterative branch cardinality proof', () => {
  const parsedFilter = ({ source }: { source: string }): JqFilter => {
    const parsed = parseJqProgram({ source });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) throw new Error(parsed.message);
    return parsed.program.filter;
  };

  it('admits only structurally proven single-output branches', () => {
    const admitted = [
      '(. + 1 | .)',
      'if true then . + 1 else . + 2 end',
      '(. + 1)?',
      '. as $x | $x + 1',
      'try (. + 1)',
      '[. + 1] | .[0]',
      'first((. + 1), error("unreached"))',
      'select(true) | . + 1',
      '{x:(. + 1)} | .x',
      String.raw`"\(. + 1)"`,
      'label $done | . + 1',
      'floor + 1',
      'numbers | . + 1',
      'scalars | . + 1',
      'values | . + 1',
      'error("stop")',
    ];
    const rejected = [
      '(1,2) | .',
      '{x:(1,2)}',
      String.raw`"\((1,2))"`,
      'select((true,true))',
      'try . catch .',
      'repeat(1)',
      'range(0;2)',
    ];

    for (const source of admitted) {
      expect(jqRuntime.iterativeBranchYieldsAtMostOneOutput({
        filter: parsedFilter({ source }),
      }), source).toBe(true);
    }
    for (const source of rejected) {
      expect(jqRuntime.iterativeBranchYieldsAtMostOneOutput({
        filter: parsedFilter({ source }),
      }), source).toBe(false);
    }
  });
});

describe('jq internal value safety and path updates', () => {
  it('uses copy-on-write and preserves unrelated branches', () => {
    const changed = jsonObject({ entries: [['value', 1]] });
    const unchanged = jsonObject({ entries: [['stable', true]] });
    const root = jsonObject({
      entries: [
        ['changed', changed],
        ['unchanged', unchanged],
      ],
    });

    const updated = applyPathUpdate({
      root,
      path: nestedValuePath,
      update: () => ({ ok: true, value: 2 }),
    });

    expect(updated.ok).toBe(true);
    if (!updated.ok || !isJsonObject(updated.value)) return;
    expect(updated.value).not.toBe(root);
    const updatedChanged = updated.value.changed;
    expect(updatedChanged).not.toBe(changed);
    expect(updated.value.unchanged).toBe(unchanged);
    expect(changed.value).toBe(1);
    if (updatedChanged === undefined) return;
    expect(isJsonObject(updatedChanged)).toBe(true);
    if (!isJsonObject(updatedChanged)) return;
    expect(updatedChanged.value).toBe(2);
  });

  it('reuses unchanged containers for identity path updates', () => {
    const changed = jsonObject({ entries: [['value', 1]] });
    const root = jsonObject({ entries: [['changed', changed]] });

    const updated = applyPathUpdate({
      root,
      path: nestedValuePath,
      update: ({ currentValue }) => ({ ok: true, value: currentValue ?? null }),
    });

    expect(updated.ok).toBe(true);
    if (!updated.ok) return;
    expect(updated.value).toBe(root);
  });

  it('uses copy-on-write for deletion and retains the source value', () => {
    const changed = jsonObject({
      entries: [
        ['value', 1],
        ['retained', 2],
      ],
    });
    const unchanged = jsonObject({ entries: [['stable', true]] });
    const root = jsonObject({
      entries: [
        ['changed', changed],
        ['unchanged', unchanged],
      ],
    });

    const deleted = applyPathDeletion({ root, path: nestedValuePath });

    expect(deleted.ok).toBe(true);
    if (!deleted.ok || !isJsonObject(deleted.value)) return;
    expect(deleted.value.unchanged).toBe(unchanged);
    expect(Object.hasOwn(changed, 'value')).toBe(true);
    const deletedChanged = deleted.value.changed;
    if (deletedChanged === undefined) return;
    expect(isJsonObject(deletedChanged)).toBe(true);
    if (!isJsonObject(deletedChanged)) return;
    expect(Object.hasOwn(deletedChanged, 'value')).toBe(false);
    expect(deletedChanged.retained).toBe(2);
  });




  it('rejects unsafe full case-fold expansion instead of silently narrowing matches', () => {
    const compiled = compileJqRegularExpression({
      pattern: `(?i:${'s'.repeat(13)})`,
      flags: '',
    });

    expect(compiled).toEqual({
      ok: false,
      message: expect.stringContaining(
        'full Unicode case-fold expansion exceeds the safe limit',
      ),
    });
  });

  it('limits bounded nullable capture-history replay to proven shapes', () => {
    const hasBoundedFallback = ({ pattern }: { pattern: string }): boolean => {
      const compiled = compileJqRegularExpression({ pattern, flags: '' });
      return compiled.ok &&
        compiled.compileBoundedSimpleCaptureHistoryFallback !== undefined;
    };

    for (const pattern of [
      String.raw`(?:(a)?\1|b)*`,
      String.raw`(?:([ab])?\1|c)*`,
      String.raw`(?:(😀)?\1|b)*`,
      String.raw`(?:(?<value>a)?\1|b)*`,
      String.raw`(?:(?<value>a)?\k<value>|b)*`,
      String.raw`(?:(a|b)?\1|c)*`,
      String.raw`(?:(?<value>a|b|c)?\k<value>|d)*`,
      String.raw`(?:(?:x(a|b|c)?)?\1|d)*`,
      String.raw`(?:(?:x(?<value>a|b|c)?)?\k<value>|d)*`,
      String.raw`(?:(a|b|c|d)?\1|e)*`,
      String.raw`(?:(?<value>a|b|c|d)?\k<value>|e)*`,
      String.raw`(?:(?:xy(a|b|c|d)?)?\1|e)*`,
      String.raw`(?:(?:xy(?<value>a|b|c|d)?)?\k<value>|e)*`,
      String.raw`(?:(ab|c|d|e)?\1|x)*`,
      String.raw`(?:(?<value>ab|c|d|e)?\k<value>|x)*`,
      String.raw`(?:(a|b|c|d|e)?\1|x)*`,
      String.raw`(?:(?<value>a|b|c|d|e)?\k<value>|x)*`,
      String.raw`(?:(?:xy(a|b|c|d|e)?)?\1|x)*`,
      String.raw`(?:(?:xy(?<value>a|b|c|d|e)?)?\k<value>|x)*`,
      String.raw`(?:(ab|c|d|e|f)?\1|x)*`,
      String.raw`(?:(?<value>ab|c|d|e|f)?\k<value>|x)*`,
      String.raw`(?:(a|b|c|d|e|f)?\1|x)*`,
      String.raw`(?:(?<value>a|b|c|d|e|f)?\k<value>|x)*`,
      String.raw`(?:(?:xy(a|b|c|d|e|f)?)?\1|x)*`,
      String.raw`(?:(?:xy(?<value>a|b|c|d|e|f)?)?\k<value>|x)*`,
      String.raw`(?:(ab|c|d|e|f|g)?\1|x)*`,
      String.raw`(?:(?<value>ab|c|d|e|f|g)?\k<value>|x)*`,
      String.raw`(?:(ab|c)?\1|x)*`,
      String.raw`(?:(?<value>ab|c)?\k<value>|x)*`,
      String.raw`(?:(?:x(ab|c)?)?\1|y)*`,
      String.raw`(?:(?:x(?<value>ab|c)?)?\k<value>|y)*`,
      String.raw`(?:(?:xy(a)?)?\1|c)*`,
      String.raw`(?:(?:xy(?<value>a)?)?\k<value>|c)*`,
      String.raw`(?:(?:xy(a|b)?)?\1|c)*`,
      String.raw`(?:(?:xy(?<value>a|b)?)?\k<value>|c)*`,
      String.raw`(?:(abc|d)?\1|x)*`,
      String.raw`(?:(?<value>abc|d)?\k<value>|x)*`,
      String.raw`(?:(?:y(abc|d)?)?\1|x)*`,
      String.raw`(?:(?:y(?<value>abc|d)?)?\k<value>|x)*`,
      String.raw`(?:(?:xyz(a|b)?)?\1|c)*`,
      String.raw`(?:(?:xyz(?<value>a|b)?)?\k<value>|c)*`,
      String.raw`(?:(?:xyz(abc|d)?)?\1|x)*`,
      String.raw`(?:(?:xyz(?<value>abc|d)?)?\k<value>|x)*`,
      String.raw`(?:(abcd|e)?\1|x)*`,
      String.raw`(?:(?<value>abcd|e)?\k<value>|x)*`,
      String.raw`(?:(?:wxyz(a)?)?\1|b)*`,
      String.raw`(?:(?:wxyz(?<value>a)?)?\k<value>|b)*`,
      String.raw`(?:(?:wxyz(abcd|e)?)?\1|x)*`,
      String.raw`(?:(?:wxyz(?<value>abcd|e)?)?\k<value>|x)*`,
      String.raw`(?:(abcde|f)?\1|x)*`,
      String.raw`(?:(?<value>abcde|f)?\k<value>|x)*`,
      String.raw`(?:(?:vwxyz(a)?)?\1|b)*`,
      String.raw`(?:(?:vwxyz(?<value>a)?)?\k<value>|b)*`,
      String.raw`(?:(?:vwxyz(abcde|f)?)?\1|x)*`,
      String.raw`(?:(?:vwxyz(?<value>abcde|f)?)?\k<value>|x)*`,
      String.raw`(?:(abcdef|g)?\1|x)*`,
      String.raw`(?:(?<value>abcdef|g)?\k<value>|x)*`,
      String.raw`(?:(?:uvwxyz(a)?)?\1|b)*`,
      String.raw`(?:(?:uvwxyz(?<value>a)?)?\k<value>|b)*`,
      String.raw`(?:(?:uvwxyz(abcdef|g)?)?\1|x)*`,
      String.raw`(?:(?:uvwxyz(?<value>abcdef|g)?)?\k<value>|x)*`,
      String.raw`(?:(\||a)?\1|b)*`,
      String.raw`(?:([a|b]|c)?\1|d)*`,
      String.raw`(?:(?<value>a|b)?\k<value>|c)*`,
      String.raw`(?:(?:x(a)?)?\1|b)*`,
      String.raw`(?:(?:x(a|b)?)?\1|c)*`,
      String.raw`(?:(?:x(?<value>a|b)?)?\k<value>|c)*`,
      String.raw`(?:(?:[xy](?<value>a)?)?\k<value>|b)*`,
      String.raw`(?:(?:\d(a)?)?\1|b)*`,
      String.raw`(?:(?:\p{L}(a)?)?\1|b)*`,
      String.raw`(?:(?:\|(a)?)?\1|b)*`,
      String.raw`(?:(a|b|c)?\1|d)*`,
      String.raw`(?:(a|b|c|d|e|f|g)?\1|x)*`,
      String.raw`(?:(?<value>a|b|c|d|e|f|g)?\k<value>|x)*`,
      String.raw`(?:(?:xy(a|b|c|d|e|f|g)?)?\1|x)*`,
      String.raw`(?:(?:xy(?<value>a|b|c|d|e|f|g)?)?\k<value>|x)*`,
      String.raw`(?:(ab|c|d|e|f|g|h)?\1|x)*`,
      String.raw`(?:(?<value>ab|c|d|e|f|g|h)?\k<value>|x)*`,
      String.raw`(?:(aa|bb|cc|dd|ee|ff|gg|hh|ii|jj|kk|ll|mm|nn)?\1|x)*`,
      String.raw`(?:(?<value>aa|bb|cc|dd|ee|ff|gg|hh|ii|jj|kk|ll|mm|nn)?\k<value>|x)*`,
      String.raw`(?:(?:x(a|b|c|d|e|f|g|h|i|j|k|l|m|n|o|p|q|r|s|t|u)?)?\1|x)*`,
      String.raw`(?:(aaa|bbb|ccc|ddd|eee|fff|ggg|hhh|iii|jjj)?\1|x)*`,
      String.raw`(?:(aaaaaa|bbbbbb|cccccc|dddddd|eeeeee|ffffff)?\1|x)*`,
      String.raw`(x)?(?:(a)?\1?|b)*`,
      String.raw`(?<v>x)?(?:(a)?\1?|(?<v>b))*`,
    ]) {
      expect(hasBoundedFallback({ pattern })).toBe(true);
    }
    for (const pattern of [
      String.raw`(?:(a|A)?\1|b)*`,
      String.raw`(?:(?<value>a|A)?\k<value>|b)*`,
      String.raw`(?:(?:x(a|A)?)?\1|b)*`,
      String.raw`(?:(?:x(?<value>a|A)?)?\k<value>|b)*`,
      String.raw`(?:(ß)?\1|b)*`,
      String.raw`(?:(?:ß(a)?)?\1|b)*`,
      String.raw`(?:(aa|ff)?\1|x)*`,
      String.raw`(?:(?<value>aa|ff)?\k<value>|x)*`,
      String.raw`(?:(aa|ss)?\1|x)*`,
      String.raw`(?:(aa|fi)?\1|x)*`,
      String.raw`(?:(aaa|ffi)?\1|x)*`,
      String.raw`(?:(?:xy(aa|ff)?)?\1|x)*`,
      String.raw`(?:(?:ff(aa|bb)?)?\1|x)*`,
      String.raw`(?:(aa|bb|cc|dd|ee|ff|gg|hh|ii|jj|kk|ll|mm|nn)?\1|x)*`,
      String.raw`(?:(aaa|bbb|ccc|ddd|eee|fff|ggg|hhh|iii|jjj)?\1|x)*`,
      String.raw`(?:(a|b|c|d|e|f|g|h|i|j|k|l|m|n|o|p|q|r|s|t|u)?\1|x)*`,
      String.raw`(?:(?<value>a|b|c|d|e|f|g|h|i|j|k|l|m|n|o|p|q|r|s|t|u)?\k<value>|x)*`,
    ]) {
      const compiled = compileJqRegularExpression({ pattern, flags: 'i' });
      expect(
        compiled.ok &&
          compiled.compileBoundedSimpleCaptureHistoryFallback !== undefined,
      ).toBe(true);
    }
    for (const pattern of [
    ]) {
      const compiled = compileJqRegularExpression({ pattern, flags: 'i' });
      expect(
        compiled.ok &&
          compiled.compileBoundedSimpleCaptureHistoryFallback !== undefined,
      ).toBe(false);
    }
    for (const pattern of [
      String.raw`(?:(aa|bb|cc|dd|ee|ff|gg|hh|ii|jj|kk|ll|mm|nn|oo)?\1|x)*`,
      String.raw`(?:(a|b|c|d|e|f|g|h|i|j|k|l|m|n|o|p|q|r|s|t|u|v)?\1|x)*`,
      String.raw`(?:(aaaaaa|bbbbbb|cccccc|dddddd|eeeeee|ffffff|gggggg)?\1|x)*`,
      String.raw`(?:(a|)?\1|b)*`,
      String.raw`(?:(a|b?)?\1|c)*`,
      String.raw`(?:((?:a|b))?\1|c)*`,
      String.raw`(?:(?:\X(a)?)?\1|b)*`,
      String.raw`(?:(?:\R(a)?)?\1|b)*`,
      String.raw`(?:(?:\K(a)?)?\1|b)*`,
      String.raw`(?:(?:\b(a)?)?\1|b)*`,
      String.raw`(?:(abcdefg|h)?\1|x)*`,
      String.raw`(?:(?<value>abcdefg|h)?\k<value>|x)*`,
      String.raw`(?:(?:tuvwxyz(a)?)?\1|b)*`,
      String.raw`(?:(?:tuvwxyz(?<value>a)?)?\k<value>|b)*`,
      String.raw`(?:(?:tuvwxyz(abcdefg|h)?)?\1|x)*`,
      String.raw`(?:(?:tuvwxyz(?<value>abcdefg|h)?)?\k<value>|x)*`,
      String.raw`(?:(?:x(a)?)??\1|b)*`,
      String.raw`(?:(?:x(a)?(b)?)?\1|c)*`,
      String.raw`(?:(?:x(a)?)?y\1|b)*`,
      String.raw`(?:(a)?\1?|b)*`,
      String.raw`(?:(a)??\1|b)*`,
      String.raw`(?:(a)?x\1|b)*`,
      String.raw`(?:\1(a)?|b)*`,
      String.raw`(?:(a)\1|)*`,
      String.raw`(?:(?<value>a)?\k<value>|(?<value>b)?\k<value>|c)*`,
      String.raw`(?:(?<value>a)?\k<-1>|b)*`,
    ]) {
      expect(hasBoundedFallback({ pattern })).toBe(false);
    }
  });

  it('admits only measured variable quantified capture history', () => {
    const hasBoundedFallback = ({
      pattern,
      flags,
    }: {
      pattern: string;
      flags: string;
    }): boolean => {
      const compiled = compileJqRegularExpression({ pattern, flags });
      return compiled.ok &&
        compiled.compileBoundedSimpleCaptureHistoryFallback !== undefined;
    };

    for (const pattern of [
      String.raw`(?:(a)?\1+|b)*`,
      String.raw`(?:(a)?\1+?|b)*`,
      String.raw`(?:(a)?\1++|b)*`,
      String.raw`(?:(a)?\1{1,2}|b)*`,
      String.raw`(?:(a)?\1{1,3}?|b)*`,
      String.raw`(?:(a)?\1{2,3}|b)*`,
      String.raw`(?:(a)?\1{2,3}?|b)*`,
      String.raw`(?:(a)?\1{2,3}+|b)*`,
      String.raw`(?:(a)?\1{2,}|b)*`,
      String.raw`(?:(a)?\1{2,}?|b)*`,
      String.raw`(?:(a)?\1{2,}+|b)*`,
      String.raw`(?:(?<value>a)?\k<value>{3,4}+|b)*`,
      String.raw`(?:(?<value>a)?\k<value>+|b)*`,
      String.raw`(?:([aA])?\1+|b)*`,
      String.raw`(?:([aAaAaA])?\1{2,3}|b)*`,
      String.raw`(?:([abcdef])?\1{2,3}+|b)*`,
      String.raw`(?:(\|)?\1+|b)*`,
      String.raw`(?:(😀)?\1+|b)*`,
      String.raw`(?:(ß)?\1+|b)*`,
      String.raw`(?:(ﬀ)?\1+|b)*`,
      String.raw`(?:(İ)?\1+|b)*`,
      String.raw`(?:(Σ)?\1+|b)*`,
      String.raw`(?:([abcdef])?\1+|b)*`,
      String.raw`(?:(?:z(a)?)?\1+|b)*`,
      String.raw`(?:(?:zy(?<value>a)?)?\k<value>{1,3}|b)*`,
    ]) {
      for (const flags of ['i', 'ig', 'il', 'igl']) {
        expect(hasBoundedFallback({ pattern, flags })).toBe(true);
      }
    }

    for (const pattern of [
      String.raw`(?:(a)?\1?|b)*`,
      String.raw`(?:(a)?\1*?|b)*`,
      String.raw`(?:(a)?\1*+|b)*`,
      String.raw`(?:(a)?\1{0,2}|b)*`,
      String.raw`(?:(?<value>a)?\k<value>{0,}?|b)*`,
      String.raw`(?:([aA])?\1?|b)*`,
      String.raw`(?:(\|)?\1*|b)*`,
      String.raw`(?:(😀)?\1{0,2}?|b)*`,
      String.raw`(?:(ß)?\1{0,2}+|b)*`,
    ]) {
      for (const flags of ['il', 'igl']) {
        expect(hasBoundedFallback({ pattern, flags })).toBe(true);
      }
    }

    for (const pattern of [
      String.raw`(?:(a)?\1?|b)*`,
      String.raw`(?:(a)?\1*?|b)*`,
      String.raw`(?:(a)?\1{0,2}|b)*`,
      String.raw`(?:(?<value>a)?\k<value>?|b)*`,
      String.raw`(?:([aA])?\1*|b)*`,
      String.raw`(?:(\|)?\1{0,2}|b)*`,
      String.raw`(?:(😀)?\1?|b)*`,
    ]) {
      for (const flags of ['l', 'gl']) {
        expect(hasBoundedFallback({ pattern, flags })).toBe(true);
      }
    }

    for (const pattern of [
      String.raw`(?:(aa)?\1?|b)*`,
      String.raw`(?:(a|b)?\1?|c)*`,
    ]) {
      for (const flags of ['l', 'gl']) {
        expect(hasBoundedFallback({ pattern, flags })).toBe(true);
      }
    }

    for (const pattern of [
      String.raw`(?:(a)?\1?+|b)*`,
      String.raw`(?:(?:z(a)?)?\1?|b)*`,
      String.raw`(?:(a|A|b)?\1?|c)*`,
    ]) {
      for (const flags of ['l', 'gl']) {
        expect(hasBoundedFallback({ pattern, flags })).toBe(false);
      }
    }

    for (const { pattern, flags } of [
      { pattern: String.raw`(?:(a)?\1+|b)*`, flags: '' },
      { pattern: String.raw`(?:(a)?\1+|b)*`, flags: 'g' },
      { pattern: String.raw`(?:(a)?\1+|b)*`, flags: 'l' },
      { pattern: String.raw`(?:(a)?\1+|b)*`, flags: 'im' },
      { pattern: String.raw`(?:(a)?\1+|b)*`, flags: 'in' },
      { pattern: String.raw`(?:(a)?\1+|b)*`, flags: 'ip' },
      { pattern: String.raw`(?:(a)?\1+|b)*`, flags: 'is' },
      { pattern: String.raw`(?:(a)?\1+|b)*`, flags: 'ix' },
      { pattern: String.raw`(?:(aa)?\1+|b)*`, flags: 'i' },
      { pattern: String.raw`(?:(a|A)?\1+|b)*`, flags: 'i' },
      { pattern: String.raw`(?:(a)?\1{1}|b)*`, flags: 'i' },
      { pattern: String.raw`(?:(a)?\1{2}|b)*`, flags: 'i' },
      { pattern: String.raw`(?:(a)?\1{2}+|b)*`, flags: 'i' },
      { pattern: String.raw`(?:(a)?\1{3}|b)*`, flags: 'i' },
      { pattern: String.raw`(?:(a)?\1{2,3}a|b)*`, flags: 'i' },
      { pattern: String.raw`(?:(a)?\1{2,3}(?=a)|b)*`, flags: 'i' },
      { pattern: String.raw`(?:(.)?\1+|b)*`, flags: 'i' },
      { pattern: String.raw`(?:(\w)?\1+|b)*`, flags: 'i' },
      { pattern: String.raw`(?:([A-Z])?\1+|b)*`, flags: 'i' },
      { pattern: String.raw`(?:([^a])?\1+|b)*`, flags: 'i' },
      { pattern: String.raw`(?:([abcdefg])?\1+|b)*`, flags: 'i' },
      { pattern: String.raw`(?:(K)?\1+|b)*`, flags: 'i' },
      { pattern: String.raw`(?:(ſ)?\1+|b)*`, flags: 'i' },
      { pattern: String.raw`(?:(aa)?\1{2,3}|b)*`, flags: 'i' },
      { pattern: String.raw`(?:(a|A)?\1{2,3}|b)*`, flags: 'i' },
      { pattern: String.raw`(?:(ß)?\1{2,3}|b)*`, flags: 'i' },
      { pattern: String.raw`(?:(ﬀ)?\1{2,3}+|b)*`, flags: 'il' },
      { pattern: String.raw`(?:(K)?\1{2,3}+|b)*`, flags: 'il' },
      { pattern: String.raw`(?:(.)?\1{2,3}+|b)*`, flags: 'il' },
      { pattern: String.raw`(?:(\w)?\1{2,3}+|b)*`, flags: 'il' },
      { pattern: String.raw`(?:(\p{L})?\1{2,3}+|b)*`, flags: 'il' },
      { pattern: String.raw`(?:(\d)?\1{2,3}+|b)*`, flags: 'il' },
      { pattern: String.raw`(?:(\s)?\1{2,3}+|b)*`, flags: 'il' },
      { pattern: String.raw`(?:([a\d])?\1{2,3}+|b)*`, flags: 'il' },
      { pattern: String.raw`(?:([\p{L}])?\1{2,3}+|b)*`, flags: 'il' },
      { pattern: String.raw`(?:([A-Z])?\1{2,3}+|b)*`, flags: 'il' },
      { pattern: String.raw`(?:([^a])?\1{2,3}+|b)*`, flags: 'il' },
      { pattern: String.raw`(?:([aAßK])?\1{2,3}+|b)*`, flags: 'il' },
      { pattern: String.raw`(?:([abcdef])?\1{2,3}|b)*`, flags: 'il' },
      { pattern: String.raw`(?:([abcdef])?\1{2,3}?|b)*`, flags: 'il' },
      { pattern: String.raw`(?:([abcdefg])?\1{2,3}+|b)*`, flags: 'il' },
      { pattern: String.raw`(?:(a)?\1?|b)*`, flags: 'i' },
      { pattern: String.raw`(?:(a)?\1?|b)*`, flags: 'ig' },
      { pattern: String.raw`(?:(aa)?\1?|b)*`, flags: 'il' },
      { pattern: String.raw`(?:(a|A)?\1?|b)*`, flags: 'il' },
      { pattern: String.raw`(?:(?:z(a)?)?\1?|b)*`, flags: 'il' },
      { pattern: String.raw`(?:(?:(a)?)?\1+|b)*`, flags: 'i' },
      { pattern: String.raw`(?:(?i:(a)?)\1+|b)*`, flags: '' },
      { pattern: String.raw`(?i:(?:(a)?\1+|b)*)`, flags: '' },
      { pattern: String.raw`(?i)(?:(a)?\1+|b)*`, flags: '' },
    ]) {
      expect(hasBoundedFallback({ pattern, flags })).toBe(false);
    }
  });

  it('classifies bounded capture-history empty continuation conservatively', () => {
    for (const pattern of [
      String.raw`(?:(a|A)?\1|b)*`,
      String.raw`(?:(?:x(a|A)?)?\1|b)*`,
    ]) {
      const compiled = compileJqRegularExpression({ pattern, flags: 'i' });
      expect(compiled.ok).toBe(true);
      if (!compiled.ok) continue;
      const fallback = compiled.compileBoundedSimpleCaptureHistoryFallback?.({
        maximumRepetitions: 4,
      });
      expect(fallback?.ok).toBe(true);
      if (fallback?.ok) expect(fallback.emptyByteContinuation).toBe('any');
    }

    for (const pattern of [
      String.raw`^(?:(a)?\1|b)*`,
      String.raw`(?=a)(?:(a)?\1|b)*`,
      String.raw`x(?:(a)?\1|b)*`,
    ]) {
      const compiled = compileJqRegularExpression({ pattern, flags: '' });
      expect(compiled.ok).toBe(true);
      if (!compiled.ok) continue;
      const fallback = compiled.compileBoundedSimpleCaptureHistoryFallback?.({
        maximumRepetitions: 4,
      });
      expect(fallback?.ok).toBe(true);
      if (fallback?.ok) expect(fallback.emptyByteContinuation).toBe('none');
    }
  });

  it('caches bounded simple capture-history fallbacks only within the production width', () => {
    const compiled = compileJqRegularExpression({
      pattern: String.raw`(?:(a|b)?\1|c)*`,
      flags: '',
    });

    expect(compiled.ok).toBe(true);
    if (!compiled.ok) return;
    const compileFallback =
      compiled.compileBoundedSimpleCaptureHistoryFallback;
    expect(compileFallback).toBeDefined();
    if (compileFallback === undefined) return;

    expect(compileFallback({ maximumRepetitions: 4 })).toBe(
      compileFallback({ maximumRepetitions: 4 }),
    );
    expect(compileFallback({ maximumRepetitions: 8 })).toBe(
      compileFallback({ maximumRepetitions: 8 }),
    );
    expect(compileFallback({ maximumRepetitions: 9 })).not.toBe(
      compileFallback({ maximumRepetitions: 9 }),
    );
  });

  it('bounds dynamic plain capture-history replay by shape, input, and source size', () => {
    const hasPlainFallback = ({
      pattern,
      flags = '',
    }: {
      pattern: string;
      flags?: string;
    }): boolean => {
      const compiled = compileJqRegularExpression({ pattern, flags });
      return compiled.ok &&
        compiled.compileBoundedPlainCaptureHistoryFallback !== undefined;
    };

    expect(hasPlainFallback({ pattern: String.raw`(?:(a)|b)*` })).toBe(true);
    expect(hasPlainFallback({ pattern: String.raw`(?:a|b)*` })).toBe(false);
    expect(hasPlainFallback({
      pattern: String.raw`(?:(a)|b)*(?:(c)|d)*`,
    })).toBe(false);
    expect(hasPlainFallback({ pattern: String.raw`(?:(a)\1|b)*` })).toBe(false);

    expect(jqRegexp.boundedPlainCaptureHistoryInputCodePointLength({
      input: 'a'.repeat(32),
      longest: false,
    })).toBeUndefined();
    expect(jqRegexp.boundedPlainCaptureHistoryInputCodePointLength({
      input: 'a'.repeat(33),
      longest: false,
    })).toBe(33);
    expect(jqRegexp.boundedPlainCaptureHistoryInputCodePointLength({
      input: '😀'.repeat(33),
      longest: false,
    })).toBe(33);
    expect(jqRegexp.boundedPlainCaptureHistoryInputCodePointLength({
      input: 'a'.repeat(16),
      longest: true,
    })).toBeUndefined();
    expect(jqRegexp.boundedPlainCaptureHistoryInputCodePointLength({
      input: 'a'.repeat(17),
      longest: true,
    })).toBe(17);
    expect(jqRegexp.boundedPlainCaptureHistoryInputCodePointLength({
      input: 'a'.repeat(512),
      longest: false,
    })).toBe(512);
    expect(jqRegexp.boundedPlainCaptureHistoryInputCodePointLength({
      input: 'a'.repeat(513),
      longest: false,
    })).toBeUndefined();

    const largePattern = compileJqRegularExpression({
      pattern: `(${'a'.repeat(512)})*`,
      flags: '',
    });
    expect(largePattern.ok).toBe(true);
    if (!largePattern.ok) return;
    const compileFallback = largePattern.compileBoundedPlainCaptureHistoryFallback;
    expect(compileFallback).toBeDefined();
    if (compileFallback === undefined) return;
    expect(compileFallback({ maximumRepetitions: 33 }).ok).toBe(true);
    const overBudget = compileFallback({ maximumRepetitions: 64 });
    expect(overBudget).toEqual({
      ok: false,
      message: 'dynamic capture-history fallback exceeds the source budget',
    });
    expect(compileFallback({ maximumRepetitions: 64 })).toBe(overBudget);
  });

  describe('dynamic linear runtime-marker capture-history replay', () => {
    const hasLinearRuntimeFallback = ({
      pattern,
      flags = '',
    }: {
      pattern: string;
      flags?: string;
    }): boolean => {
      const compiled = compileJqRegularExpression({ pattern, flags });
      return compiled.ok &&
        compiled.compileBoundedLinearRuntimeCaptureHistoryFallback !== undefined;
    };

    const oneMarkerPattern = String.raw`(?<unit>(a)\2)(?:\g<unit>|b)*`;
    const twoMarkerPattern = String.raw`(?<unit>(a)\2(c)\3)(?:\g<unit>|b)*`;

    const collectFirst = ({
      pattern,
      flags,
      input,
    }: {
      pattern: string;
      flags: string;
      input: string;
    }) => {
      const compiled = compileJqRegularExpression({ pattern, flags });
      expect(compiled.ok).toBe(true);
      if (!compiled.ok) return undefined;
      return collectJqRegularExpressionMatches({
        input,
        compiled,
        global: false,
      })[0];
    };

    it('selects only supported linear runtime fallbacks', () => {
      expect(hasLinearRuntimeFallback({ pattern: oneMarkerPattern })).toBe(true);
      expect(hasLinearRuntimeFallback({ pattern: twoMarkerPattern })).toBe(true);
      expect(hasLinearRuntimeFallback({
        pattern: String.raw`(?<unit>(a)\2)(?:\g<unit>|b)*(?:(c)|d)*`,
      })).toBe(false);
      expect(hasLinearRuntimeFallback({
        pattern: String.raw`(?<unit>(a)\2)(?:\g<unit>|\y)*`,
      })).toBe(false);
    });

    it('bounds one-marker fallback source generation', () => {
      const compiled = compileJqRegularExpression({
        pattern: oneMarkerPattern,
        flags: '',
      });
      expect(compiled.ok).toBe(true);
      if (!compiled.ok) return;
      const fallback = compiled.compileBoundedLinearRuntimeCaptureHistoryFallback;
      expect(fallback).toBeDefined();
      if (fallback === undefined) return;
      expect(fallback({ maximumRepetitions: 771 }).ok).toBe(true);
      expect(fallback({ maximumRepetitions: 1203 }).ok).toBe(true);
      const boundary = fallback({ maximumRepetitions: 2048 });
      expect(boundary.ok).toBe(true);
      if (boundary.ok) {
        expect(boundary.create({ global: false }).source.length).toBeLessThanOrEqual(
          40 * 1024,
        );
      }
    });

    it('bounds two-marker fallback source generation', () => {
      const compiled = compileJqRegularExpression({
        pattern: twoMarkerPattern,
        flags: '',
      });
      expect(compiled.ok).toBe(true);
      if (!compiled.ok) return;
      const fallback = compiled.compileBoundedLinearRuntimeCaptureHistoryFallback;
      expect(fallback).toBeDefined();
      if (fallback === undefined) return;
      expect(fallback({ maximumRepetitions: 512 }).ok).toBe(true);
      const boundary = fallback({ maximumRepetitions: 1200 });
      expect(boundary.ok).toBe(true);
      if (boundary.ok) {
        expect(boundary.create({ global: false }).source.length).toBeLessThanOrEqual(
          32 * 1024,
        );
      }
      expect(fallback({ maximumRepetitions: 1400 })).toEqual({
        ok: false,
        message: 'dynamic capture-history fallback exceeds the source budget',
      });
    });

    it('bounds runtime-selected maximum repetitions', () => {
      expect(jqRegexp.boundedLinearRuntimeCaptureHistoryMaximumRepetitions({
        input: 'a'.repeat(64),
        longest: false,
      })).toBeUndefined();
      expect(jqRegexp.boundedLinearRuntimeCaptureHistoryMaximumRepetitions({
        input: 'a'.repeat(65),
        longest: false,
      })).toBe(65);
      expect(jqRegexp.boundedLinearRuntimeCaptureHistoryMaximumRepetitions({
        input: 'a'.repeat(24),
        longest: true,
      })).toBeUndefined();
      expect(jqRegexp.boundedLinearRuntimeCaptureHistoryMaximumRepetitions({
        input: 'a'.repeat(25),
        longest: true,
      })).toBe(25);
      expect(jqRegexp.boundedLinearRuntimeCaptureHistoryMaximumRepetitions({
        input: 'a'.repeat(513),
        longest: false,
      })).toBe(513);
      expect(jqRegexp.boundedLinearRuntimeCaptureHistoryMaximumRepetitions({
        input: 'a'.repeat(2048),
        longest: false,
      })).toBe(2048);
      expect(jqRegexp.boundedLinearRuntimeCaptureHistoryMaximumRepetitions({
        input: 'a'.repeat(2049),
        longest: false,
      })).toBeUndefined();
    });

    it('replays one- and two-marker capture history', () => {
      const oneMarkerMatch = collectFirst({
        pattern: oneMarkerPattern,
        flags: '',
        input: `${'aa'.repeat(256)}b`,
      });
      expect(oneMarkerMatch?.captures.map(({ start, end, text }) => ({
        start,
        end,
        text,
      }))).toEqual([
        { start: 510, end: 512, text: 'aa' },
        { start: 510, end: 511, text: 'a' },
      ]);

      const twoMarkerMatch = collectFirst({
        pattern: twoMarkerPattern,
        flags: 'l',
        input: `${'aacc'.repeat(256)}b`,
      });
      expect(twoMarkerMatch?.captures.map(({ start, end, text }) => ({
        start,
        end,
        text,
      }))).toEqual([
        { start: 1020, end: 1024, text: 'aacc' },
        { start: 1020, end: 1021, text: 'a' },
        { start: 1022, end: 1023, text: 'c' },
      ]);
    });

    it('replays capture history beyond the bounded compilation windows', () => {
      const overRepetitionMatch = collectFirst({
        pattern: oneMarkerPattern,
        flags: '',
        input: `aa${'b'.repeat(700)}`,
      });
      expect(overRepetitionMatch).toMatchObject({
        start: 0,
        end: 702,
      });
      expect(overRepetitionMatch?.captures[0]).toMatchObject({
        start: 0,
        end: 2,
        text: 'aa',
      });

      const overPartialWindowInput = `aa${`baa`.repeat(256)}b`;
      for (const flags of ['', 'l']) {
        const match = collectFirst({
          pattern: oneMarkerPattern,
          flags,
          input: overPartialWindowInput,
        });
        expect(match).toMatchObject({
          start: 0,
          end: 771,
        });
        expect(match?.captures[0]).toMatchObject({
          start: 768,
          end: 770,
          text: 'aa',
        });
      }
    });
  });

  it('admits only uniform seven-code-point inputs through the wider bounded window', () => {
    expect(jqRegexp.boundedSimpleCaptureHistoryInputCodePointLength({
      input: 'aaaaaa',
      allowUniformSevenCodePoints: false,
      allowSingletonRequiredSevenCodePoints: false,
    })).toBe(6);
    expect(jqRegexp.boundedSimpleCaptureHistoryInputCodePointLength({
      input: 'aaaaaaa',
      allowUniformSevenCodePoints: true,
      allowSingletonRequiredSevenCodePoints: false,
    })).toBe(7);
    expect(jqRegexp.boundedSimpleCaptureHistoryInputCodePointLength({
      input: '😀😀😀😀😀😀😀',
      allowUniformSevenCodePoints: true,
      allowSingletonRequiredSevenCodePoints: false,
    })).toBe(7);
    expect(jqRegexp.boundedSimpleCaptureHistoryInputCodePointLength({
      input: 'aaaaaaa',
      allowUniformSevenCodePoints: false,
      allowSingletonRequiredSevenCodePoints: false,
    })).toBeUndefined();
    expect(jqRegexp.boundedSimpleCaptureHistoryInputCodePointLength({
      input: 'abababa',
      allowUniformSevenCodePoints: true,
      allowSingletonRequiredSevenCodePoints: false,
    })).toBeUndefined();
    expect(jqRegexp.boundedSimpleCaptureHistoryInputCodePointLength({
      input: 'aaaaaaaa',
      allowUniformSevenCodePoints: true,
      allowSingletonRequiredSevenCodePoints: false,
    })).toBeUndefined();
    expect(jqRegexp.boundedSimpleCaptureHistoryInputCodePointLength({
      input: 'abababa',
      allowUniformSevenCodePoints: false,
      allowSingletonRequiredSevenCodePoints: true,
    })).toBe(7);
    expect(jqRegexp.boundedSimpleCaptureHistoryInputCodePointLength({
      input: 'abababab',
      allowUniformSevenCodePoints: false,
      allowSingletonRequiredSevenCodePoints: true,
    })).toBeUndefined();
  });

  it('limits uniform seven-code-point replay to the measured runtime contexts', () => {
    const allows = jqRegexp.allowsUniformSevenCodePointCaptureHistoryReplay;

    expect(allows({
      compatiblePatternMode: true,
      global: false,
      ignoreCase: true,
      longest: false,
      hasCaseFoldedBackreference: true,
    })).toBe(true);
    expect(allows({
      compatiblePatternMode: true,
      global: true,
      ignoreCase: false,
      longest: false,
      hasCaseFoldedBackreference: false,
    })).toBe(true);
    expect(allows({
      compatiblePatternMode: true,
      global: true,
      ignoreCase: true,
      longest: false,
      hasCaseFoldedBackreference: false,
    })).toBe(false);
    expect(allows({
      compatiblePatternMode: true,
      global: true,
      ignoreCase: false,
      longest: false,
      hasCaseFoldedBackreference: true,
    })).toBe(false);
    expect(allows({
      compatiblePatternMode: true,
      global: false,
      ignoreCase: false,
      longest: true,
      hasCaseFoldedBackreference: false,
    })).toBe(false);
    expect(allows({
      compatiblePatternMode: false,
      global: false,
      ignoreCase: false,
      longest: false,
      hasCaseFoldedBackreference: false,
    })).toBe(false);
  });

  it('keeps unmeasured regular-expression modes on the six-code-point path', () => {
    for (const flags of ['', 'g', 'i', 'l']) {
      const compiled = compileJqRegularExpression({
        pattern: String.raw`(?:(a|b)?\1|~)*`,
        flags,
      });
      expect(compiled.ok).toBe(true);
      if (compiled.ok) {
        expect(
          compiled.uniformSevenCodePointCaptureHistoryReplayCompatible,
        ).toBe(true);
      }
    }

    for (const flags of ['m', 'n', 'p', 's', 'x']) {
      const compiled = compileJqRegularExpression({
        pattern: String.raw`(?:(a|b)?\1|~)*`,
        flags,
      });
      expect(compiled.ok).toBe(true);
      if (compiled.ok) {
        expect(
          compiled.uniformSevenCodePointCaptureHistoryReplayCompatible,
        ).toBe(false);
      }
    }

    for (const pattern of [
      String.raw`(?i)(?:(a|b)?\1|~)*`,
      String.raw`(?i:(?:(a|b)?\1|~)*)`,
    ]) {
      const wholePatternIgnoreCase = compileJqRegularExpression({
        pattern,
        flags: '',
      });
      expect(wholePatternIgnoreCase.ok).toBe(true);
      if (wholePatternIgnoreCase.ok) {
        expect(
          wholePatternIgnoreCase
            .uniformSevenCodePointCaptureHistoryReplayCompatible,
        ).toBe(true);
      }
    }

    for (const pattern of [
      String.raw`(?m)(?:(a|b)?\1|~)*`,
      String.raw`(?s:(?:(a|b)?\1|~)*)`,
      String.raw`(?x:(?:(a|b)?\1|~)*)`,
    ]) {
      const wholePatternUnmeasuredMode = compileJqRegularExpression({
        pattern,
        flags: '',
      });
      expect(wholePatternUnmeasuredMode.ok).toBe(true);
      if (wholePatternUnmeasuredMode.ok) {
        expect(
          wholePatternUnmeasuredMode
            .uniformSevenCodePointCaptureHistoryReplayCompatible,
        ).toBe(false);
      }
    }

    const localModifier = compileJqRegularExpression({
      pattern: String.raw`(?:(?i:a|b)?\1|~)*`,
      flags: '',
    });
    expect(localModifier.ok).toBe(true);
    if (localModifier.ok) {
      expect(
        localModifier.uniformSevenCodePointCaptureHistoryReplayCompatible,
      ).toBe(false);
    }
  });

  it('compiles the eighth replay only for admitted uniform runtime contexts', () => {
    const observeReplayWidths = ({
      flags,
      global,
      input,
    }: {
      flags: string;
      global: boolean;
      input: string;
    }): readonly number[] => {
      const compiled = compileJqRegularExpression({
        pattern: String.raw`(?:(a|b)?\1|~)*`,
        flags,
      });
      expect(compiled.ok).toBe(true);
      if (!compiled.ok) return [];
      const compileFallback =
        compiled.compileBoundedSimpleCaptureHistoryFallback;
      expect(compileFallback).toBeDefined();
      if (compileFallback === undefined) return [];

      const replayWidths: number[] = [];
      collectJqRegularExpressionMatches({
        input,
        global,
        compiled: {
          ...compiled,
          compileBoundedSimpleCaptureHistoryFallback: ({
            maximumRepetitions,
          }) => {
            replayWidths.push(maximumRepetitions);
            return compileFallback({ maximumRepetitions });
          },
        },
      });
      return replayWidths;
    };

    expect(observeReplayWidths({
      flags: 'g',
      global: true,
      input: 'aaaaaaa',
    })).toEqual([8]);
    expect(observeReplayWidths({
      flags: 'ig',
      global: true,
      input: 'aaaaaaa',
    })).toEqual([]);
    expect(observeReplayWidths({
      flags: 'l',
      global: false,
      input: 'aaaaaaa',
    })).toEqual([]);
    expect(observeReplayWidths({
      flags: '',
      global: false,
      input: 'abababa',
    })).toEqual([]);
    expect(observeReplayWidths({
      flags: '',
      global: false,
      input: 'aaaaaaaa',
    })).toEqual([]);
  });

  it('replays a uniform seven-code-point capture when global folding is absent', () => {
    const compiled = compileJqRegularExpression({
      pattern: String.raw`(?:(a|b)?\1|~)*`,
      flags: 'i',
    });

    expect(compiled.ok).toBe(true);
    if (!compiled.ok) return;
    const matches = collectJqRegularExpressionMatches({
      input: 'aaaaaaa',
      compiled,
      global: false,
    });

    expect(matches.map(({ start, end, text, captures }) => ({
      start,
      end,
      text,
      capture: captures[0]?.text,
    }))).toEqual([
      { start: 0, end: 7, text: 'aaaaaaa', capture: 'a' },
    ]);
  });

  it('reconsiders newer nullable captures when an older history branch is referenced', () => {
    const patterns = [
      String.raw`(?:(\||a|b)?\1|c)*`,
      String.raw`(?:(?<v>[a|b]|c|x)?\k<v>|y)*`,
    ];

    for (const pattern of patterns) {
      const compiled = compileJqRegularExpression({ pattern, flags: 'i' });
      expect(compiled.ok).toBe(true);
      if (!compiled.ok) continue;

      const nonEmptyMatches = collectJqRegularExpressionMatches({
        input: 'KaAa1K',
        compiled,
        global: true,
      }).filter(({ text }) => text.length > 0);

      expect(nonEmptyMatches.map(({ start, end, text, captures }) => ({
        start,
        end,
        text,
        capture: captures[0]?.text,
      }))).toEqual([
        { start: 1, end: 4, text: 'aAa', capture: 'a' },
      ]);
    }
  });

  it('limits nonuniform seven-code-point replay to singleton required history', () => {
    const supportsSeven = ({ pattern, flags }: { pattern: string; flags: string }): boolean => {
      const compiled = compileJqRegularExpression({ pattern, flags });
      return compiled.ok &&
        compiled.singletonRequiredSevenCodePointCaptureHistoryReplayCompatible;
    };

    for (const [pattern, flags] of [
      [String.raw`(?:(a)?\1|b)*`, ''],
      [String.raw`(?:(?<v>a)?\k<v>|b)*`, 'l'],
      [String.raw`(?:([a])?\1|[b])*`, 'g'],
      [String.raw`(?:(😀)?\1|a)*`, 'gl'],
      [String.raw`(?:(\|)?\1|x)*`, ''],
    ] as const) {
      expect(supportsSeven({ pattern, flags })).toBe(true);
    }

    for (const [pattern, flags] of [
      [String.raw`(?:([ab])?\1|x)*`, ''],
      [String.raw`(?:([|])?\1|[x])*`, ''],
      [String.raw`(?:([^c])?\1|x)*`, ''],
      [String.raw`(?:(.)?\1|x)*`, ''],
      [String.raw`(?:(aa)?\1|x)*`, ''],
      [String.raw`(?:(?:x(a)?)?\1|b)*`, ''],
      [String.raw`(?:(a)?\1?|b)*`, ''],
      [String.raw`(?:(a)*\1|b)*`, ''],
      [String.raw`(?:(a)??\1|b)*`, ''],
      [String.raw`(?:(a){0,1}\1|b)*`, ''],
      [String.raw`(?:(a)?\1+|b)*`, ''],
      [String.raw`(?:(a)?\1|b)*`, 'i'],
      [String.raw`(?:(a)?\1|b)*(?:(c|d)?\2|e)*`, ''],
    ] as const) {
      expect(supportsSeven({ pattern, flags })).toBe(false);
    }
  });

  it('keeps bounded capture-history replay inside the proven input limit', () => {
    const compiled = compileJqRegularExpression({
      pattern: String.raw`(?:(\||a)?\1|b)*`,
      flags: 'il',
    });

    expect(compiled.ok).toBe(true);
    if (!compiled.ok) return;
    const matches = collectJqRegularExpressionMatches({
      input: '1xAaya😀',
      compiled,
      global: true,
    });

    expect(matches.map(({ start, end, text, captures }) => ({
      start,
      end,
      text,
      capture: captures[0]?.text,
    }))).toEqual([
      { start: 0, end: 0, text: '', capture: '' },
      { start: 1, end: 1, text: '', capture: '' },
      { start: 2, end: 2, text: '', capture: '' },
      { start: 3, end: 3, text: '', capture: '' },
      { start: 4, end: 4, text: '', capture: '' },
      { start: 5, end: 5, text: '', capture: '' },
      { start: 6, end: 6, text: '', capture: '' },
      { start: 8, end: 8, text: '', capture: '' },
    ]);
  });

  it('rejects zero-consumption recursive regular-expression call cycles', () => {
    const invalidPatterns = [
      String.raw`(?<a>\g<a>?a)`,
      String.raw`(?<a>(?:\g<a>)?a)`,
      String.raw`(?<a>a|\g<a>)`,
      String.raw`(?<a>\g<b>|a)(?<b>\g<a>|b)`,
      String.raw`(?<a>(?:(?:\g<a>))|a)`,
      String.raw`(?<prefix>x?)(?<a>\k<prefix>\g<a>|b)`,
      String.raw`(x?)(?<a>\1\g<a>|b)`,
      String.raw`(x)(?<a>\k<-1>\g<a>|b)`,
    ];

    for (const pattern of invalidPatterns) {
      expect(compileJqRegularExpression({ pattern, flags: '' })).toEqual({
        ok: false,
        message: 'Regex failure: never ending recursion',
      });
    }

    const validPatterns = [
      String.raw`(?<a>a\g<a>|b)`,
      String.raw`(?<a>a\g<a>?|b)`,
      String.raw`(?<a>a\g<a>*|b)`,
      String.raw`(?<a>a\g<a>{1}|b)`,
      String.raw`(?<a>\g<a>{0}a)`,
      String.raw`(?<a>\g<b>|a)(?<b>a\g<a>|b)`,
      String.raw`(?<a>(?=a\g<a>)a|a)`,
      String.raw`(?<prefix>x)(?<a>\k<prefix>\g<a>|b)`,
      String.raw`(x)(?<a>\1\g<a>|b)`,
    ];
    for (const pattern of validPatterns) {
      expect(compileJqRegularExpression({ pattern, flags: '' }).ok).toBe(true);
    }
  });

  it('rejects forward named backreferences with jq diagnostics', () => {
    for (const pattern of [
      String.raw`\k<x>(?<x>x)`,
      String.raw`(?<a>\k<prefix>\g<a>|b)(?<prefix>x)`,
    ]) {
      expect(compileJqRegularExpression({ pattern, flags: '' })).toEqual({
        ok: false,
        message: 'Regex failure: undefined name <' +
          (pattern.includes('prefix') ? 'prefix' : 'x') + '> reference',
      });
    }
  });

  it('bounds unsafe recursive regular-expression input', () => {
    const compiled = compileJqRegularExpression({
      pattern: String.raw`(?<node>\((?:x|\g<node>)*\))`,
      flags: '',
    });

    expect(compiled.ok).toBe(true);
    if (!compiled.ok) return;
    const input = `${'('.repeat(130)}x${')'.repeat(130)}`;
    expect(() =>
      collectJqRegularExpressionMatches({ input, compiled, global: false }),
    ).toThrow('regular expression input exceeds the safe backtracking limit');
  });

  it('compiles deeply nested local regular-expression modifiers without recursive stack growth', () => {
    const depth = 20_000;
    const pattern = `${'(?i:'.repeat(depth)}a${')'.repeat(depth)}`;

    const compiled = compileJqRegularExpression({ pattern, flags: '' });

    expect(compiled.ok).toBe(true);
    if (!compiled.ok) return;
    expect(compiled.create({ global: false }).test('A')).toBe(true);
    expect(compiled.create({ global: false }).test('b')).toBe(false);
  });

  it('validates very deep linear filters and append paths without recursive stack growth', () => {
    const depth = 20_000;
    let linearFilter: JqFilter = { kind: 'identity' };
    let pathExpression: JqPathExpression = {
      kind: 'path',
      path: { segments: [] },
    };
    for (let index = 0; index < depth; index += 1) {
      linearFilter = {
        kind: 'field',
        input: linearFilter,
        key: `level-${index}`,
        optional: false,
      };
      pathExpression = {
        kind: 'append',
        parent: pathExpression,
        segment: {
          kind: 'field',
          key: `level-${index}`,
          optional: false,
        },
      };
    }
    const linearProgram: JqProgram = { filter: linearFilter, userDefinitions: [] };
    const assignmentProgram: JqProgram = {
      userDefinitions: [],
      filter: {
        kind: 'assign',
        pathExpression,
        value: { kind: 'identity' },
      },
    };

    expect(validateJqProgram({ program: linearProgram, variables: [] })).toEqual({ ok: true });
    expect(validateJqProgram({ program: assignmentProgram, variables: [] })).toEqual({ ok: true });
  });

  it('recognizes deeply nested identity pipes for compile-time object-key validation', () => {
    const depth = 1_000;
    let identityPipe: JqFilter = { kind: 'identity' };
    for (let index = 0; index < depth; index += 1) {
      identityPipe = {
        kind: 'pipe',
        left: identityPipe,
        right: { kind: 'identity' },
      };
    }
    const program: JqProgram = {
      userDefinitions: [],
      filter: {
        kind: 'object',
        entries: [{
          key: {
            kind: 'dynamic',
            filter: {
              kind: 'pipe',
              left: { kind: 'literal', value: 1 },
              right: identityPipe,
            },
          },
          value: { kind: 'literal', value: null },
        }],
      },
    };

    expect(validateJqProgram({ program, variables: [] })).toEqual({
      ok: false,
      message: 'Cannot use number (1) as object key',
    });
  });

  it('materializes very deep append expressions without recursive stack growth', () => {
    const depth = 20_000;
    let expression: JqPathExpression = {
      kind: 'path',
      path: { segments: [] },
    };
    for (let index = 0; index < depth; index += 1) {
      expression = {
        kind: 'append',
        parent: expression,
        segment: {
          kind: 'field',
          key: `level-${index}`,
          optional: false,
        },
      };
    }

    const materialized = materializeJqPathExpression({
      root: null,
      expression,
      evaluateDynamicIndex: () => ({ ok: true, outputs: [] }),
    });

    expect(materialized.ok).toBe(true);
    if (!materialized.ok) return;
    expect(materialized.paths).toHaveLength(1);
    expect(materialized.paths[0]?.segments).toHaveLength(depth);
    expect(materialized.paths[0]?.segments[0]).toEqual({
      kind: 'field',
      key: 'level-0',
      optional: false,
    });
    expect(materialized.paths[0]?.segments.at(-1)).toEqual({
      kind: 'field',
      key: `level-${depth - 1}`,
      optional: false,
    });
  });

  it('extracts very deep dynamic index paths without recursive stack growth', () => {
    const depth = 20_000;
    let filter: JqFilter = { kind: 'identity' };
    for (let index = 0; index < depth; index += 1) {
      filter = {
        kind: 'dynamic_index',
        input: filter,
        index: { kind: 'literal', value: 0 },
        optional: false,
      };
    }

    const expression = extractPathExpression({ filter });

    expect(expression?.kind).toBe('dynamic_index');
    let current = expression;
    let extractedDepth = 0;
    while (current?.kind === 'dynamic_index') {
      extractedDepth += 1;
      current = current.parent;
    }
    expect(extractedDepth).toBe(depth);
    expect(current).toEqual({ kind: 'path', path: { segments: [] } });
  });

  it('parses and evaluates very deep dynamic assignment source without recursive stack growth', () => {
    const depth = 20_000;
    const parsed = parseJqProgram({ source: `.${'[0+0]'.repeat(depth)} = 2` });

    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(validateJqProgram({ program: parsed.program, variables: [] })).toEqual({ ok: true });
    const evaluated = evaluateJqFilter({ filter: parsed.program.filter, input: null });
    expect(evaluated.ok).toBe(true);
    if (!evaluated.ok) return;
    expect(evaluated.outputs).toHaveLength(1);
    const path: JqPath = {
      segments: Array.from({ length: depth }, () => ({
        kind: 'index' as const,
        index: 0,
        optional: false,
      })),
    };
    expect(readJqPathValue({ root: evaluated.outputs[0]!, path })).toMatchObject({
      ok: true,
      value: 2,
      skipped: false,
    });
  });

  it('evaluates assignment and binding chains through the explicit runtime depth limit', () => {
    const depth = 512;
    const assignment = parseJqProgram({ source: `${'.a = '.repeat(depth)}0` });
    const binding = parseJqProgram({ source: `${'. as $x | '.repeat(depth)}.` });

    expect(assignment.ok).toBe(true);
    expect(binding.ok).toBe(true);
    if (!assignment.ok || !binding.ok) return;

    const assigned = evaluateJqFilter({ filter: assignment.program.filter, input: {} });
    const bound = evaluateJqFilter({ filter: binding.program.filter, input: { value: 1 } });
    expect(assigned.ok).toBe(true);
    expect(bound).toEqual({ ok: true, outputs: [{ value: 1 }] });
    if (!assigned.ok) return;

    const path: JqPath = {
      segments: Array.from({ length: depth }, () => ({
        kind: 'field' as const,
        key: 'a',
        optional: false,
      })),
    };
    expect(readJqPathValue({ root: assigned.outputs[0]!, path })).toMatchObject({
      ok: true,
      value: 0,
      skipped: false,
    });
  });

  it('keeps bindings and reducer variables within their lexical scopes', () => {
    const cases = [
      { source: '. as $x | $x', variables: [], expected: { ok: true } },
      { source: 'reduce .[] as $x (0; . + $x)', variables: [], expected: { ok: true } },
      { source: 'foreach .[] as $x (0; . + $x; [$x, .])', variables: [], expected: { ok: true } },
      { source: '$outer as $x | [$outer, $x]', variables: ['outer'], expected: { ok: true } },
      {
        source: '(. as $x | $x), $x',
        variables: [],
        expected: { ok: false, message: '$x is not defined' },
      },
      {
        source: 'reduce .[] as $x ($x; .)',
        variables: [],
        expected: { ok: false, message: '$x is not defined' },
      },
      {
        source: 'foreach .[] as $x ($x; .; .)',
        variables: [],
        expected: { ok: false, message: '$x is not defined' },
      },
    ] as const;

    for (const { source, variables, expected } of cases) {
      const parsed = parseJqProgram({ source });
      expect(parsed.ok).toBe(true);
      if (!parsed.ok) continue;
      expect(validateJqProgram({ program: parsed.program, variables })).toEqual(expected);
    }
  });

  it('reports the jq runtime depth limit for very deep assignment and binding chains', () => {
    const depth = 20_000;
    for (const source of [
      `${'.a = '.repeat(depth)}0`,
      `${'. as $x | '.repeat(depth)}.`,
      Array.from({ length: depth + 1 }, () => '0').join(' + '),
      Array.from({ length: depth + 1 }, () => 'null').join(' // '),
      Array.from({ length: depth + 1 }, () => '.').join(' | '),
      Array.from({ length: depth + 1 }, () => 'empty').join(', '),
      Array.from({ length: depth + 1 }, () => 'true').join(' and '),
      Array.from({ length: depth + 1 }, () => 'false').join(' or '),
    ]) {
      const parsed = parseJqProgram({ source });
      expect(parsed.ok).toBe(true);
      if (!parsed.ok) continue;
      expect(validateJqProgram({ program: parsed.program, variables: [] })).toEqual({ ok: true });
      const evaluated = evaluateJqFilter({ filter: parsed.program.filter, input: {} });
      expect(evaluated.ok).toBe(false);
      if (evaluated.ok) continue;
      expect(evaluated.error.message).toBe('maximum jq evaluation depth exceeded');
    }
  });

  it('reports the jq runtime depth limit for recursive user definitions', () => {
    const accepted = parseJqProgram({
      source: `def f: if . > 0 then . - 1 | f else . end; ${jqLimits.JQ_MAX_USER_DEFINITION_CALL_DEPTH} | f`,
    });
    const rejected = parseJqProgram({
      source: `def f: if . > 0 then . - 1 | f else . end; ${jqLimits.JQ_MAX_USER_DEFINITION_CALL_DEPTH + 1} | f`,
    });
    const unbounded = parseJqProgram({ source: 'def f: f; f' });

    expect(accepted.ok).toBe(true);
    expect(rejected.ok).toBe(true);
    expect(unbounded.ok).toBe(true);
    if (!accepted.ok || !rejected.ok || !unbounded.ok) return;

    const acceptedResult = evaluateJqFilter({
      filter: accepted.program.filter,
      input: null,
      userDefinitions: accepted.program.userDefinitions,
    });
    expect(acceptedResult).toEqual({ ok: true, outputs: [0] });

    for (const program of [rejected.program, unbounded.program]) {
      expect(validateJqProgram({ program, variables: [] })).toEqual({ ok: true });
      const evaluated = evaluateJqFilter({
        filter: program.filter,
        input: null,
        userDefinitions: program.userDefinitions,
      });
      expect(evaluated.ok).toBe(false);
      if (evaluated.ok) continue;
      expect(evaluated.error.message).toBe('maximum jq evaluation depth exceeded');
    }
  });

  it('fails closed at the explicit string interpolation nesting limit', () => {
    const nestedInterpolation = ({ depth }: { depth: number }): string => {
      let source = '0';
      for (let index = 0; index < depth; index += 1) {
        source = `"\\(${source})"`;
      }
      return source;
    };

    const accepted = parseJqProgram({ source: nestedInterpolation({ depth: 128 }) });
    expect(accepted.ok).toBe(true);

    const rejected = parseJqProgram({ source: nestedInterpolation({ depth: 129 }) });
    expect(rejected.ok).toBe(false);
    if (rejected.ok) return;
    expect(rejected.message).toContain('string interpolation nesting exceeds limit 128');
  });

  it('fails closed at the explicit structural parser nesting limit', () => {
    const nestedSources = ({ depth }: { depth: number }): readonly string[] => [
      `${'('.repeat(depth)}.${')'.repeat(depth)}`,
      `${'['.repeat(depth)}0${']'.repeat(depth)}`,
      `${'{a:'.repeat(depth)}0${'}'.repeat(depth)}`,
      `${'if true then '.repeat(depth)}0${' else 0 end'.repeat(depth)}`,
    ];

    for (const source of nestedSources({ depth: 256 })) {
      expect(parseJqProgram({ source }).ok).toBe(true);
    }
    for (const source of nestedSources({ depth: 257 })) {
      const rejected = parseJqProgram({ source });
      expect(rejected.ok).toBe(false);
      if (rejected.ok) continue;
      expect(rejected.message).toBe('parser structural nesting exceeds limit 256');
    }
  });

  it('fails closed at the explicit parser prefix nesting limit', () => {
    const localDefinitions = ({ depth }: { depth: number }): string =>
      `(${Array.from({ length: depth }, (_, index) => `def f${index}: ${index}; `).join("")}.)`;

    for (const source of [
      `${'try '.repeat(128)}.`,
      `${'-'.repeat(128)}1`,
      localDefinitions({ depth: 128 }),
    ]) {
      expect(parseJqProgram({ source }).ok).toBe(true);
    }
    for (const source of [
      `${'try '.repeat(129)}.`,
      `${'-'.repeat(129)}1`,
      localDefinitions({ depth: 129 }),
    ]) {
      const rejected = parseJqProgram({ source });
      expect(rejected.ok).toBe(false);
      if (rejected.ok) continue;
      expect(rejected.message).toBe('parser prefix nesting exceeds limit 128');
    }
  });

  it('parses very deep elif chains without recursive stack growth', () => {
    const depth = 20_000;
    const parsed = parseJqProgram({
      source: `if . then 0 ${'elif . then 0 '.repeat(depth)}else 1 end`,
    });

    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(validateJqProgram({ program: parsed.program, variables: [] })).toEqual({ ok: true });
    let current = parsed.program.filter;
    let branchCount = 0;
    while (current.kind === 'conditional') {
      branchCount += 1;
      current = current.elseBranch;
    }
    expect(branchCount).toBe(depth + 1);
    expect(current).toMatchObject({ kind: 'literal', value: 1 });

    const evaluated = evaluateJqFilter({ filter: parsed.program.filter, input: false });
    expect(evaluated.ok).toBe(false);
    if (evaluated.ok) return;
    expect(evaluated.error.message).toBe('maximum jq evaluation depth exceeded');
  });

  it('evaluates very deep try comma chains without recursive stack growth', () => {
    const depth = 5_000;
    const parsed = parseJqProgram({
      source: `try (${'0,'.repeat(depth)}error("x")) catch .`,
    });

    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const evaluated = evaluateJqFilter({ filter: parsed.program.filter, input: null });
    expect(evaluated.ok).toBe(true);
    if (!evaluated.ok) return;
    expect(evaluated.outputs).toHaveLength(depth + 1);
    expect(evaluated.outputs[0]).toBe(0);
    expect(evaluated.outputs.at(-1)).toBe('x');
  });

  it('expands very deep user-defined dynamic assignment paths without recursive stack growth', () => {
    const depth = 20_000;
    const parsed = parseJqProgram({
      source: `def deep(f): .${'[f]'.repeat(depth)} = 1; deep(0)`,
    });

    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(validateJqProgram({ program: parsed.program, variables: [] })).toEqual({ ok: true });
    expect(parsed.program.filter.kind).toBe('assign');
    if (parsed.program.filter.kind !== 'assign') return;

    const materialized = materializeJqPathExpression({
      root: null,
      expression: parsed.program.filter.pathExpression,
      evaluateDynamicIndex: ({ filter, input }) => {
        const evaluated = evaluateJqFilter({ filter, input });
        return evaluated.ok
          ? evaluated
          : { ok: false, message: evaluated.error.message };
      },
    });

    expect(materialized.ok).toBe(true);
    if (!materialized.ok) return;
    expect(materialized.paths).toHaveLength(1);
    expect(materialized.paths[0]?.segments).toHaveLength(depth);
    expect(materialized.paths[0]?.segments[0]).toEqual({
      kind: 'index',
      index: 0,
      optional: false,
    });
    expect(materialized.paths[0]?.segments.at(-1)).toEqual({
      kind: 'index',
      index: 0,
      optional: false,
    });
  });

  it('materializes very deep path sequences without quadratic sequence copying', () => {
    const depth = 20_000;
    let expression: JqPathExpression = {
      kind: 'path',
      path: { segments: [{ kind: 'field', key: '0', optional: false }] },
    };
    for (let index = 1; index < depth; index += 1) {
      expression = {
        kind: 'sequence',
        items: [
          expression,
          {
            kind: 'path',
            path: { segments: [{ kind: 'field', key: String(index), optional: false }] },
          },
        ],
      };
    }

    const materialized = materializeJqPathExpression({
      root: null,
      expression,
      evaluateDynamicIndex: () => ({ ok: true, outputs: [] }),
    });

    expect(materialized.ok).toBe(true);
    if (!materialized.ok) return;
    expect(materialized.paths).toHaveLength(depth);
    expect(materialized.paths[0]?.segments[0]).toEqual({
      kind: 'field',
      key: '0',
      optional: false,
    });
    expect(materialized.paths.at(-1)?.segments[0]).toEqual({
      kind: 'field',
      key: String(depth - 1),
      optional: false,
    });
  });

  it('validates and materializes very deep dynamic index paths without recursive stack growth', () => {
    const depth = 20_000;
    let expression: JqPathExpression = {
      kind: 'path',
      path: { segments: [] },
    };
    let root: JsonValue = 1;
    for (let index = 0; index < depth; index += 1) {
      expression = {
        kind: 'dynamic_index',
        parent: expression,
        index: { kind: 'literal', value: 0 },
        optional: false,
      };
      root = [root];
    }
    const program: JqProgram = {
      userDefinitions: [],
      filter: {
        kind: 'assign',
        pathExpression: expression,
        value: { kind: 'literal', value: 2 },
      },
    };

    expect(validateJqProgram({ program, variables: [] })).toEqual({ ok: true });
    let evaluationCount = 0;
    const materialized = materializeJqPathExpression({
      root,
      expression,
      evaluateDynamicIndex: ({ filter, input }) => {
        expect(input).toBe(root);
        expect(filter).toEqual({ kind: 'literal', value: 0 });
        evaluationCount += 1;
        return { ok: true, outputs: [0] };
      },
    });

    expect(materialized.ok).toBe(true);
    if (!materialized.ok) return;
    expect(evaluationCount).toBe(depth);
    expect(materialized.paths).toHaveLength(1);
    expect(materialized.paths[0]?.segments).toHaveLength(depth);
    expect(materialized.paths[0]?.segments[0]).toEqual({
      kind: 'index',
      index: 0,
      optional: false,
    });
    expect(materialized.paths[0]?.segments.at(-1)).toEqual({
      kind: 'index',
      index: 0,
      optional: false,
    });
  });

  it('extracts very deep paths without recursive stack growth', () => {
    const depth = 20_000;
    let filter: JqFilter = { kind: 'identity' };
    for (let index = 0; index < depth; index += 1) {
      filter = { kind: 'field', input: filter, key: `level-${index}`, optional: false };
    }

    const extractedPath = extractJqPath({ filter });

    expect(extractedPath?.segments).toHaveLength(depth);
    expect(extractedPath?.segments[0]).toEqual({
      kind: 'field',
      key: 'level-0',
      optional: false,
    });
    expect(extractedPath?.segments.at(-1)).toEqual({
      kind: 'field',
      key: `level-${depth - 1}`,
      optional: false,
    });
  });


  it('updates very deep paths without recursive stack growth', () => {
    const depth = 20_000;
    const path: JqPath = {
      segments: Array.from({ length: depth }, (_, index) => ({
        kind: 'field' as const,
        key: `level-${index}`,
        optional: false,
      })),
    };

    const updated = applyPathUpdate({
      root: null,
      path,
      update: () => ({ ok: true, value: 2 }),
    });

    expect(updated.ok).toBe(true);
    if (!updated.ok) return;
    const readBack = readJqPathValue({ root: updated.value, path });
    expect(readBack).toEqual({ ok: true, value: 2, skipped: false });
  });


  it('deletes very deep paths without recursive stack growth', () => {
    const depth = 20_000;
    const path: JqPath = {
      segments: Array.from({ length: depth }, (_, index) => ({
        kind: 'field' as const,
        key: `level-${index}`,
        optional: false,
      })),
    };
    let root: JsonValue = 1;
    for (let index = depth - 1; index >= 0; index -= 1) {
      root = jsonObject({ entries: [[`level-${index}`, root]] });
    }

    const deleted = applyPathDeletion({ root, path });

    expect(deleted.ok).toBe(true);
    if (!deleted.ok) return;
    expect(readJqPathValue({ root: deleted.value, path })).toEqual({
      ok: true,
      value: undefined,
      skipped: false,
    });
    expect(readJqPathValue({ root, path })).toEqual({
      ok: true,
      value: 1,
      skipped: false,
    });
  });


  it('deletes multiple very deep object paths without recursive stack growth', () => {
    const depth = 10_000;
    const createBranch = ({ prefix }: { prefix: string }): JsonValue => {
      let value: JsonValue = 1;
      for (let index = depth - 1; index >= 0; index -= 1) {
        value = jsonObject({ entries: [[`${prefix}-${index}`, value]] });
      }
      return value;
    };
    const root = jsonObject({
      entries: [
        ['left', createBranch({ prefix: 'left' })],
        ['right', createBranch({ prefix: 'right' })],
        ['retained', 3],
      ],
    });
    const paths: readonly JqPath[] = ['left', 'right'].map((prefix) => ({
      segments: [
        { kind: 'field' as const, key: prefix, optional: false },
        ...Array.from({ length: depth }, (_, index) => ({
          kind: 'field' as const,
          key: `${prefix}-${index}`,
          optional: false,
        })),
      ],
    }));

    const deleted = applyPathDeletions({ root, paths });

    expect(deleted.ok).toBe(true);
    if (!deleted.ok || !isJsonObject(deleted.value)) return;
    expect(deleted.value.retained).toBe(3);
    for (const path of paths) {
      expect(readJqPathValue({ root: deleted.value, path })).toEqual({
        ok: true,
        value: undefined,
        skipped: false,
      });
    }
  });

  it('extracts, updates, and deletes deep paths while preserving the source tree', () => {
    const depth = 128;
    let filter: JqFilter = { kind: 'identity' };
    for (let index = 0; index < depth; index += 1) {
      filter = { kind: 'field', input: filter, key: `level-${index}`, optional: false };
    }
    const extractedPath = extractJqPath({ filter });
    expect(extractedPath?.segments).toHaveLength(depth);
    const segments: JqPath['segments'] = Array.from({ length: depth }, (_, index) => ({
      kind: 'field' as const,
      key: `level-${index}`,
      optional: false,
    }));
    const path: JqPath = { segments };

    let root: JsonValue = 1;
    for (let index = depth - 1; index >= 0; index -= 1) {
      root = jsonObject({ entries: [[`level-${index}`, root]] });
    }

    const updated = applyPathUpdate({
      root,
      path,
      update: () => ({ ok: true, value: 2 }),
    });
    expect(updated.ok).toBe(true);
    if (!updated.ok) return;

    let nested: JsonValue = updated.value;
    for (let index = 0; index < depth; index += 1) {
      expect(isJsonObject(nested)).toBe(true);
      if (!isJsonObject(nested)) return;
      nested = nested[`level-${index}`]!;
    }
    expect(nested).toBe(2);

    const deleted = applyPathDeletion({ root: updated.value, path });
    expect(deleted.ok).toBe(true);
    expect(root).not.toBe(updated.value);
  });




  it('deletes multiple fields through very deep arrays without recursive stack growth', () => {
    const depth = 20_000;
    let root: JsonValue = jsonObject({
      entries: [
        ['left', 1],
        ['right', 2],
        ['retained', 3],
      ],
    });
    const prefix = Array.from({ length: depth }, () => ({
      kind: 'index' as const,
      index: 0,
      optional: false,
    }));
    for (let index = 0; index < depth; index += 1) root = [root];
    const leftPath: JqPath = {
      segments: [...prefix, { kind: 'field', key: 'left', optional: false }],
    };
    const rightPath: JqPath = {
      segments: [...prefix, { kind: 'field', key: 'right', optional: false }],
    };

    const deleted = applyPathDeletions({ root, paths: [leftPath, rightPath] });

    expect(deleted.ok).toBe(true);
    if (!deleted.ok) return;
    expect(readJqPathValue({ root: deleted.value, path: leftPath })).toEqual({
      ok: true,
      value: undefined,
      skipped: false,
    });
    expect(readJqPathValue({ root: deleted.value, path: rightPath })).toEqual({
      ok: true,
      value: undefined,
      skipped: false,
    });
    expect(readJqPathValue({ root, path: leftPath })).toEqual({
      ok: true,
      value: 1,
      skipped: false,
    });
  });

  it('lets a parent deletion subsume invalid descendant deletions', () => {
    const root = jsonObject({ entries: [['target', false], ['retained', 1]] });
    const descendantPath: JqPath = {
      segments: [
        { kind: 'field', key: 'target', optional: false },
        { kind: 'field', key: 'invalid', optional: false },
      ],
    };
    const parentPath: JqPath = {
      segments: [{ kind: 'field', key: 'target', optional: false }],
    };

    const deleted = applyPathDeletions({ root, paths: [descendantPath, parentPath] });

    expect(deleted).toEqual({
      ok: true,
      value: jsonObject({ entries: [['retained', 1]] }),
    });
  });

  it('deletes multiple indices through very deep arrays without recursive stack growth', () => {
    const depth = 20_000;
    let root: JsonValue = ['left', 'retained', 'right'];
    const prefix = Array.from({ length: depth }, () => ({
      kind: 'index' as const,
      index: 0,
      optional: false,
    }));
    for (let index = 0; index < depth; index += 1) root = [root];
    const leftPath: JqPath = {
      segments: [...prefix, { kind: 'index', index: 0, optional: false }],
    };
    const rightPath: JqPath = {
      segments: [...prefix, { kind: 'index', index: 2, optional: false }],
    };

    const deleted = applyPathDeletions({ root, paths: [leftPath, rightPath] });

    expect(deleted.ok).toBe(true);
    if (!deleted.ok) return;
    let deletedLeaf: JsonValue = deleted.value;
    let sourceLeaf: JsonValue = root;
    for (let index = 0; index < depth; index += 1) {
      expect(Array.isArray(deletedLeaf)).toBe(true);
      expect(Array.isArray(sourceLeaf)).toBe(true);
      if (!Array.isArray(deletedLeaf) || !Array.isArray(sourceLeaf)) return;
      deletedLeaf = deletedLeaf[0]!;
      sourceLeaf = sourceLeaf[0]!;
    }
    expect(deletedLeaf).toEqual(['retained']);
    expect(sourceLeaf).toEqual(['left', 'retained', 'right']);
  });

  it('reconstructs very deep pick paths without recursive stack growth', () => {
    const depth = 20_000;
    let input: JsonValue = 2;
    let pathFilter: JqFilter = { kind: 'identity' };
    const segments: JqPath['segments'] = [];
    for (let index = depth - 1; index >= 0; index -= 1) {
      input = jsonObject({ entries: [[`level-${index}`, input]] });
    }
    for (let index = 0; index < depth; index += 1) {
      const key = `level-${index}`;
      pathFilter = { kind: 'field', input: pathFilter, key, optional: false };
      segments.push({ kind: 'field', key, optional: false });
    }

    const evaluated = evaluateJqFilter({
      filter: { kind: 'call', name: 'pick', args: [pathFilter] },
      input,
    });

    expect(evaluated.ok).toBe(true);
    if (!evaluated.ok) return;
    expect(readJqPathValue({ root: evaluated.outputs[0]!, path: { segments } })).toEqual({
      ok: true,
      value: 2,
      skipped: false,
    });
  });

  it('flattens very deep comma paths without recursive stack growth', () => {
    const depth = 20_000;
    const pathFilter = ({ key }: { key: string }): JqFilter => ({
      kind: 'field',
      input: { kind: 'identity' },
      key,
      optional: false,
    });
    let filter = pathFilter({ key: '0' });
    for (let index = 1; index < depth; index += 1) {
      filter = { kind: 'comma', left: filter, right: pathFilter({ key: String(index) }) };
    }

    const evaluated = evaluateJqFilter({
      filter: { kind: 'call', name: 'path', args: [filter] },
      input: null,
    });

    expect(evaluated.ok).toBe(true);
    if (!evaluated.ok) return;
    expect(evaluated.outputs).toHaveLength(depth);
    expect(evaluated.outputs[0]).toEqual(['0']);
    expect(evaluated.outputs.at(-1)).toEqual([String(depth - 1)]);
  });

  it('checks very deep object and array containment without recursive stack growth', () => {
    const depth = 20_000;
    let objectInput: JsonValue = 2;
    let objectExpected: JsonValue = 2;
    let arrayInput: JsonValue = 2;
    let arrayExpected: JsonValue = 2;
    for (let index = depth - 1; index >= 0; index -= 1) {
      objectInput = jsonObject({
        entries: [
          [`level-${index}`, objectInput],
          [`retained-${index}`, index],
        ],
      });
      objectExpected = jsonObject({ entries: [[`level-${index}`, objectExpected]] });
      arrayInput = [0, arrayInput, 3];
      arrayExpected = [arrayExpected];
    }

    for (const [input, expected] of [
      [objectInput, objectExpected],
      [arrayInput, arrayExpected],
    ] as const) {
      const evaluated = evaluateJqFilter({
        filter: {
          kind: 'call',
          name: 'contains',
          args: [{ kind: 'literal', value: expected }],
        },
        input,
      });
      expect(evaluated).toEqual({ ok: true, outputs: [true] });
    }
  });

  it('recursively merges very deep objects without recursive stack growth', () => {
    const depth = 20_000;
    const createDeepValue = ({ leaf }: { leaf: JsonValue }): JsonValue => {
      let value = leaf;
      for (let index = depth - 1; index >= 0; index -= 1) {
        value = jsonObject({ entries: [[`level-${index}`, value]] });
      }
      return value;
    };
    const left = createDeepValue({ leaf: 1 });
    const right = createDeepValue({ leaf: 2 });

    const evaluated = evaluateJqFilter({
      filter: {
        kind: 'binary',
        operator: 'mul',
        left: { kind: 'literal', value: left },
        right: { kind: 'literal', value: right },
      },
      input: null,
    });

    expect(evaluated.ok).toBe(true);
    if (!evaluated.ok) return;
    expect(evaluated.outputs).toHaveLength(1);
    const path: JqPath = {
      segments: Array.from({ length: depth }, (_, index) => ({
        kind: 'field' as const,
        key: `level-${index}`,
        optional: false,
      })),
    };
    expect(readJqPathValue({ root: evaluated.outputs[0]!, path })).toMatchObject({
      ok: true,
      value: 2,
      skipped: false,
    });
    expect(readJqPathValue({ root: left, path })).toEqual({
      ok: true,
      value: 1,
      skipped: false,
    });
  });

  it('normalizes deeply nested JSON without recursive stack growth', () => {
    const depth = 5_000;
    let source: JsonValue = 1;
    for (let index = depth - 1; index >= 0; index -= 1) {
      source = index % 2 === 0
        ? [source]
        : jsonObject({ entries: [['value', source]] });
    }

    let normalized = normalizeJsonValue({ value: source });
    if (normalized === source) throw new Error('normalization must clone the root container');
    for (let index = 0; index < depth; index += 1) {
      if (index % 2 === 0) {
        if (!Array.isArray(normalized)) throw new Error(`expected array at depth ${index}`);
        normalized = normalized[0]!;
      } else {
        if (!isJsonObject(normalized)) throw new Error(`expected object at depth ${index}`);
        normalized = normalized.value!;
      }
    }
    expect(normalized).toBe(1);
  });


  it('serializes deeply nested values without recursive stack growth', () => {
    const depth = 5_000;
    let value: JsonValue = 1;
    for (let index = 0; index < depth; index += 1) value = [value];

    const serialized = stringifyJson({
      value,
      indentation: undefined,
      sortKeys: false,
      asciiOnly: false,
    });

    expect(serialized.length).toBe(depth * 2 + 1);
    expect(serialized.startsWith('[[[[')).toBe(true);
    expect(serialized.endsWith(']]]]')).toBe(true);
  });

  it('serializes deeply nested sorted objects with ASCII escaping without recursive stack growth', () => {
    const depth = 5_000;
    let value: JsonValue = 'β';
    for (let index = 0; index < depth; index += 1) {
      value = jsonObject({ entries: [['z', index], ['a', value]] });
    }

    const serialized = stringifyJson({
      value,
      indentation: undefined,
      sortKeys: true,
      asciiOnly: true,
    });

    expect(serialized.startsWith('{"a":{"a":')).toBe(true);
    expect(serialized.includes('\\u03b2')).toBe(true);
    expect(serialized.endsWith(`,"z":${depth - 1}}`)).toBe(true);
    expect(serialized.match(/"a":/gu)).toHaveLength(depth);
    expect(serialized.match(/,"z":/gu)).toHaveLength(depth);
  });

  it('stops object diagnostic preview before enumerating unrelated keys', () => {
    const object = createJsonObject();
    defineJsonProperty({ object, key: 'abcdefghijklmno', value: 1 });
    defineJsonProperty({ object, key: 'unused', value: 2 });
    const guarded = new Proxy(object, {
      ownKeys: () => {
        throw new Error('diagnostic preview must not enumerate all object keys');
      },
    });

    const message = formatJqArithmeticError({
      operator: 'sub',
      left: false,
      right: guarded,
    });

    expect(message).toBe(
      'boolean (false) and object ({"abcdefghi...) cannot be subtracted',
    );
  });

  it('keeps prototype-related JSON keys as inert own properties', () => {
    const normalized = normalizeJsonValue({
      value: JSON.parse('{"__proto__":{"polluted":true},"constructor":1}') as JsonValue,
    });

    expect(isJsonObject(normalized)).toBe(true);
    if (!isJsonObject(normalized)) return;
    expect(Object.getPrototypeOf(normalized)).toBeNull();
    expect(Object.hasOwn(normalized, '__proto__')).toBe(true);
    expect(Object.hasOwn(normalized, 'constructor')).toBe(true);
    expect(({} as { polluted?: boolean }).polluted).toBeUndefined();
  });

  it('moves a deleted and re-added object key to the end of jq insertion order', () => {
    const object = createJsonObject();
    defineJsonProperty({ object, key: 'first', value: 1 });
    defineJsonProperty({ object, key: 'second', value: 2 });
    delete object.first;
    defineJsonProperty({ object, key: 'first', value: 3 });

    expect(stringifyJson({
      value: object,
      indentation: undefined,
      sortKeys: false,
      asciiOnly: false,
    })).toBe('{"second":2,"first":3}');
  });


  it('compares deeply nested values without recursive stack growth', () => {
    const depth = 5_000;
    let left: JsonValue = 1;
    let equal: JsonValue = 1;
    let greater: JsonValue = 2;
    for (let index = 0; index < depth; index += 1) {
      left = [left];
      equal = [equal];
      greater = [greater];
    }

    expect(compareJsonValues({ left, right: equal })).toBe(0);
    expect(compareJsonValues({ left, right: greater })).toBe(-1);
    expect(compareJsonValues({ left: greater, right: left })).toBe(1);
  });

  it('implements jq type ordering recursively', () => {
    const values: JsonValue[] = [
      jsonObject({ entries: [] }),
      [],
      'a',
      1,
      true,
      false,
      null,
    ];

    values.sort((left, right) => compareJsonValues({ left, right }));

    expect(values).toEqual([
      null,
      false,
      true,
      1,
      'a',
      [],
      {},
    ]);
  });

  it('guards ordinary optional capture history only for the measured singleton shape', () => {
    const direct = compileJqRegularExpression({
      pattern: String.raw`(?:(a)?\1?|b)*x`,
      flags: '',
    });
    expect(direct.ok).toBe(true);
    if (!direct.ok) return;
    expect(direct.wholeMatchGuardedOptionalCaptureHistoryProjectionReplay).toBe(true);

    const global = compileJqRegularExpression({
      pattern: String.raw`(?:(?<v>a)?\k<v>?|b)*x`,
      flags: 'g',
    });
    expect(global.ok).toBe(true);
    if (!global.ok) return;
    expect(global.wholeMatchGuardedOptionalCaptureHistoryProjectionReplay).toBe(true);

    const broaderOrdinary = compileJqRegularExpression({
      pattern: String.raw`(?:(aa)?\1?|b)*x`,
      flags: '',
    });
    expect(broaderOrdinary.ok).toBe(true);
    if (!broaderOrdinary.ok) return;
    expect(
      broaderOrdinary.wholeMatchGuardedOptionalCaptureHistoryProjectionReplay,
    ).toBe(false);

    const broaderLongest = compileJqRegularExpression({
      pattern: String.raw`(?:(aa)?\1?|b)*x`,
      flags: 'l',
    });
    expect(broaderLongest.ok).toBe(true);
    if (!broaderLongest.ok) return;
    expect(
      broaderLongest.wholeMatchGuardedOptionalCaptureHistoryProjectionReplay,
    ).toBe(true);
  });

  it('rewrites only terminal optional capture-history siblings as dead branches', () => {
    const rewrite = jqRegexp.rewriteJqTerminalOptionalCaptureHistoryBranches;

    expect(rewrite({ source: String.raw`(?:(a)?\1?|(b))*` })).toBe(
      String.raw`(?:(a)?\1?|(?:(b)(?!)))*`,
    );
    expect(rewrite({ source: String.raw`x(?:(?<v>a)?\k<v>?|b)*` })).toBe(
      String.raw`x(?:(?<v>a)?\k<v>?|(?:b(?!)))*`,
    );
    expect(rewrite({ source: String.raw`(?:y|x(?:(a)?\1?|b)*)` })).toBe(
      String.raw`(?:y|x(?:(a)?\1?|(?:b(?!)))*)`,
    );
    expect(rewrite({ source: String.raw`(?:(a)?\1?|b)*x` })).toBe(
      String.raw`(?:(a)?\1?|b)*x`,
    );
    expect(rewrite({ source: String.raw`(?:(a)?\1?|b)*$` })).toBe(
      String.raw`(?:(a)?\1?|b)*$`,
    );
    expect(rewrite({ source: String.raw`(?:(a)?\1?|b)*(?=x)` })).toBe(
      String.raw`(?:(a)?\1?|b)*(?=x)`,
    );
    expect(rewrite({ source: String.raw`(?:(ab)?\1?|b)*` })).toBe(
      String.raw`(?:(ab)?\1?|b)*`,
    );
    expect(rewrite({ source: String.raw`(?:([ab])?\1?|b)*` })).toBe(
      String.raw`(?:([ab])?\1?|b)*`,
    );
    expect(rewrite({ source: String.raw`(?:(a)?\1?|bc)*` })).toBe(
      String.raw`(?:(a)?\1?|bc)*`,
    );
    expect(rewrite({ source: String.raw`(?:(a)?\1?|(b)(c))*` })).toBe(
      String.raw`(?:(a)?\1?|(b)(c))*`,
    );

    const deep = String.raw`${"(?:".repeat(256)}(?:(a)?\1?|b)*${")".repeat(256)}`;
    expect(rewrite({ source: deep })).toBe(deep);
  });


  it('replays bounded terminal capture history when the branch reference is external', () => {
    const compiled = compileJqRegularExpression({
      pattern: String.raw`(?<v>x)?(?:(a)?\1?|(?<v>b))*`,
      flags: 'g',
    });
    expect(compiled.ok).toBe(true);
    if (!compiled.ok) return;
    expect(compiled.compileBoundedSimpleCaptureHistoryFallback).toBeDefined();
    expect(compiled.uniformSevenCodePointCaptureHistoryReplayCompatible).toBe(false);

    const namedLocal = compileJqRegularExpression({
      pattern: String.raw`(x)?(?:(?<a>a)?\k<a>?|b)*`,
      flags: 'g',
    });
    expect(namedLocal.ok).toBe(true);
    if (!namedLocal.ok) return;
    expect(namedLocal.compileBoundedSimpleCaptureHistoryFallback).toBeUndefined();

    const matches = collectJqRegularExpressionMatches({
      input: 'xcxaxx',
      compiled,
      global: true,
    });
    expect(matches[2]?.captures[1]).toEqual({
      start: 3,
      end: 4,
      name: null,
      text: 'a',
    });
  });

});
