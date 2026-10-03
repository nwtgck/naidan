import { describe, expect, it } from 'vitest';
import { canTransitionImageGenerationRun, imageGenerationTagNameKey, imageGenerationTagNameSchema, imageGenerationTagReferenceKey, normalizeImageGenerationTagName, planImageGenerationSeeds, type ImageGenerationRunExecution } from './image-generation';
import { toImageGenerationTagId } from './ids';

it.each(['日本語', '雨夜景', '顔OK', '要修正', 'hero image', '🟦', '家族👨‍👩‍👧‍👦', 'العربية', '한국어', 'Русский', '__proto__', 'constructor', 'a/b', 'mail@example'])('allows ordinary Unicode tag label %s without making it an identity/path', name => {
  expect(imageGenerationTagNameSchema.parse(name)).toBe(name);
});
it('normalizes outer whitespace and canonical composition, but not compatibility distinctions', () => {
  expect(imageGenerationTagNameSchema.parse('  雨夜景  ')).toBe('雨夜景');
  expect(imageGenerationTagNameSchema.parse('か\u3099')).toBe('が');
  expect(imageGenerationTagNameKey({ name: '  HERO  ' })).toBe('hero');
  expect(imageGenerationTagNameKey({ name: 'ÉCLAIR' })).toBe(imageGenerationTagNameKey({ name: 'e\u0301clair' }));
  expect(normalizeImageGenerationTagName({ name: 'Ａ' })).toBe('Ａ');
});
it.each(['', '   ', '@favorite', ' @custom', '＠favorite', '\u200b@favorite', '\u2060＠favorite', '\u200b @favorite', '\u200b', '\u200d ', `\
a
b`, '\n猫', 'a\tb', 'a\u0000b', 'a\u0085b', 'a\u2028b', 'a\u2029b', 'a\u202eb', '\u2066tag', '\ud800', '\udfff', 'a'.repeat(65)])('rejects invalid or reserved tag label %j', name => {
  expect(imageGenerationTagNameSchema.safeParse(name).success).toBe(false);
});
it('counts code points rather than UTF-16 code units', () => {
  expect(imageGenerationTagNameSchema.parse('🟦'.repeat(64))).toHaveLength(128);
  expect(imageGenerationTagNameSchema.safeParse('🟦'.repeat(65)).success).toBe(false);
});
it('keeps system and user tag identities separate', () => {
  expect(imageGenerationTagReferenceKey({ tag: { type: 'system', key: 'favorite' } })).toBe('system:favorite');
  expect(imageGenerationTagReferenceKey({ tag: { type: 'user', tagId: toImageGenerationTagId({ raw: 'favorite' }) } })).toBe('user:favorite');
});

it('plans exact seeds above the JavaScript safe-integer range', () => {
  expect(planImageGenerationSeeds({ baseSeed: '9007199254740993', count: 4 })).toEqual(['9007199254740993', '9007199254740994', '9007199254740995', '9007199254740996']);
  expect(planImageGenerationSeeds({ baseSeed: '0', count: 2 })).toEqual(['0', '1']);
  expect(planImageGenerationSeeds({ baseSeed: '9223372036854775807', count: 1 })).toEqual(['9223372036854775807']);
});
it.each(['-1', '00', '+42', '1.5', '1e4', '9223372036854775808', ' ', 'NaN'])('rejects unresolved or invalid seed %j', baseSeed => {
  expect(() => planImageGenerationSeeds({ baseSeed, count: 1 })).toThrow();
});
it.each([0, -1, 65, 1.5, Number.NaN, Infinity])('rejects invalid plan size %s', count => {
  expect(() => planImageGenerationSeeds({ baseSeed: '42', count })).toThrow();
});
it('rejects overflow instead of wrapping or clamping seeds', () => {
  expect(() => planImageGenerationSeeds({ baseSeed: '9223372036854775807', count: 2 })).toThrow('range');
  expect(planImageGenerationSeeds({ baseSeed: '42', count: 64 }).at(-1)).toBe('105');
});

describe('explicit run execution transitions', () => {
  const states: ImageGenerationRunExecution['type'][] = ['queued', 'running', 'completed', 'cancelled', 'failed', 'interrupted'];
  for (const from of states) {
    it.each(states)(`validates ${from} -> %s`, to => {
      const allowed = from === 'queued' ? ['running', 'cancelled', 'failed', 'interrupted'] : from === 'running' ? ['completed', 'cancelled', 'failed', 'interrupted'] : [];
      expect(canTransitionImageGenerationRun({ from, to })).toBe(allowed.includes(to));
    });
  }
});
