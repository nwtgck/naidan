import { describe, expect, it } from 'vitest';
import { compileShellPattern, containsShellPatternMeta, escapeShellPatternLiteral, matchesShellPattern } from './pattern';

describe('containsShellPatternMeta', () => {
  it('treats only complete bracket expressions as pathname-expansion metadata', () => {
    for (const pattern of ['[', '[a', '[!', '[a-', 'foo[', 'foo[a']) {
      expect(containsShellPatternMeta({
        pattern,
        extglob: 'disabled',
      })).toBe(false);
    }

    for (const pattern of ['[a]', '[!a]', '[a-z]', '[[:digit:]]', '[[:digit:]', 'foo[a]']) {
      expect(containsShellPatternMeta({
        pattern,
        extglob: 'disabled',
      })).toBe(true);
    }
  });
});


describe('compileShellPattern', () => {
  it('coalesces adjacent literal tokens around pattern operators', () => {
    expect(compileShellPattern({
      pattern: 'alpha\\*beta?gamma[0-9]delta',
    })).toEqual({
      kind: 'tokens',
      tokens: [
        { kind: 'literal', value: 'alpha*beta' },
        { kind: 'any-character' },
        { kind: 'literal', value: 'gamma' },
        {
          kind: 'character-class',
          negated: false,
          items: [{ kind: 'range', start: '0', end: '9' }],
        },
        { kind: 'literal', value: 'delta' },
      ],
    });
  });
});

describe('matchesShellPattern', () => {
  it('matches coalesced literal tokens inside generic patterns', () => {
    for (const [pattern, text] of [
      ['?ab', 'xab'],
      ['[x]ab', 'xab'],
      ['*ab?', 'zzabx'],
      ['a?bc', 'axbc'],
      ['?😀x', 'a😀x'],
    ] as const) {
      expect(matchesShellPattern({ pattern, text })).toBe(true);
    }

    for (const [pattern, text] of [
      ['?ab', 'xabx'],
      ['[x]ab', 'xac'],
      ['*ab?', 'zzab'],
      ['a?bc', 'axbd'],
      ['?😀x', 'a😀y'],
    ] as const) {
      expect(matchesShellPattern({ pattern, text })).toBe(false);
    }
  });

  it('matches POSIX character classes with ASCII shell semantics', () => {
    for (const [className, matching, nonMatching] of [
      ['alnum', 'A7', '-'],
      ['alpha', 'Az', '7'],
      ['ascii', '~', 'é'],
      ['blank', ' \t', '\n'],
      ['cntrl', '\n', 'A'],
      ['digit', '07', 'A'],
      ['graph', '!~', ' '],
      ['lower', 'az', 'A'],
      ['print', ' ~', '\n'],
      ['punct', '!_', 'A'],
      ['space', ' \t\n\v\f\r', 'A'],
      ['upper', 'AZ', 'a'],
      ['word', 'A7_', '-'],
      ['xdigit', '09Af', 'G'],
    ] as const) {
      for (const character of matching) {
        expect(matchesShellPattern({ pattern: `[[:${className}:]]`, text: character })).toBe(true);
      }
      expect(matchesShellPattern({ pattern: `[[:${className}:]]`, text: nonMatching })).toBe(false);
    }
  });

  it('matches single-character equivalence classes and collating symbols', () => {
    for (const [pattern, text] of [
      ['[[=a=]]', 'a'],
      ['[[=A=]]', 'A'],
      ['[[===]]', '='],
      ['[[.a.]]', 'a'],
      ['[[.-.]]', '-'],
      ['[[=é=]]', 'é'],
      ['[[.😀.]]', '😀'],
    ] as const) {
      expect(matchesShellPattern({ pattern, text })).toBe(true);
    }

    for (const pattern of ['[[=ab=]]', '[[.ab.]]'] as const) {
      expect(matchesShellPattern({ pattern, text: 'a' })).toBe(false);
      expect(matchesShellPattern({ pattern, text: 'b' })).toBe(false);
    }
  });
});

describe('escapeShellPatternLiteral', () => {
  it('leaves long literal text unchanged and escapes only shell-pattern metacharacters', () => {
    const literal = `prefix-${'x'.repeat(4096)}-😀`;
    expect(escapeShellPatternLiteral({ text: literal })).toBe(literal);
    expect(escapeShellPatternLiteral({
      text: `${literal}*a?b[c]\\tail`,
    })).toBe(`${literal}\\*a\\?b\\[c\\]\\\\tail`);
  });
});
