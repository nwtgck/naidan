import { computed } from 'vue';
import { describe, expect, it } from 'vitest';
import { createImageTranslationMemory, type ImageTranslationKey } from './memory';
const key: ImageTranslationKey = { storeId: 'store', sessionId: 'a', field: 'prompt', language: 'ja' };
const entry = { text: '猫', sourceText: 'cat', createdAt: 1 };
describe('workspace translation memory', () => {
  it('separates stores, sessions, fields and languages reactively', () => {
    const memory = createImageTranslationMemory({ maxEntries: 8, maxCharacters: 100 });
    const current = computed(() => memory.read({ key })); expect(current.value).toBeUndefined();
    memory.save({ key, entry }); expect(current.value).toEqual(entry);
    for (const changed of [{ ...key, storeId: 'other' }, { ...key, sessionId: 'b' }, { ...key, field: 'negativePrompt' as const }, { ...key, language: 'en' as const }]) expect(memory.read({ key: changed })).toBeUndefined();
    const read = memory.read({ key })!; read.text = 'mutated'; expect(current.value?.text).toBe('猫');
  });
  it('retains successful text when new text is empty or exceeds the global bound', () => {
    const memory = createImageTranslationMemory({ maxEntries: 2, maxCharacters: 12 }); memory.save({ key, entry });
    memory.save({ key, entry: { ...entry, text: '' } }); memory.save({ key, entry: { ...entry, text: 'x'.repeat(13) } });
    expect(memory.read({ key })).toEqual(entry);
    memory.save({ key: { ...key, sessionId: 'b' }, entry }); memory.save({ key: { ...key, sessionId: 'c' }, entry });
    expect(memory.read({ key })).toBeUndefined();
  });
  it('deletes only the selected session and clears all entries at workspace disposal', () => {
    const memory = createImageTranslationMemory({ maxEntries: 8, maxCharacters: 100 }); memory.save({ key, entry });
    memory.save({ key: { ...key, sessionId: 'b' }, entry }); memory.removeSession({ storeId: 'store', sessionId: 'a' });
    expect(memory.read({ key })).toBeUndefined(); expect(memory.read({ key: { ...key, sessionId: 'b' } })).toEqual(entry);
    memory.clear(); expect(memory.read({ key: { ...key, sessionId: 'b' } })).toBeUndefined();
  });
});

it('reports cache admission independently of successful translation', () => {
  const memory = createImageTranslationMemory({ maxEntries: 1, maxCharacters: 8 });
  expect(memory.save({ key, entry })).toBe(true);
  expect(memory.save({ key, entry: { ...entry, text: 'too large' } })).toBe(false);
  expect(memory.read({ key })).toEqual(entry);
  expect(createImageTranslationMemory({ maxEntries: 0, maxCharacters: 100 }).save({ key, entry })).toBe(false);
});
