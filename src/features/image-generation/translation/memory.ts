import { shallowRef } from 'vue';
import type { UiLocale } from '@/01-models/ui-locale';

export type ImageTranslationKey = { storeId: string | undefined, sessionId: string | undefined, field: 'prompt' | 'negativePrompt', language: UiLocale };
export type ImageTranslationMemoryEntry = { sourceText: string, text: string, createdAt: number };

/** Completed text only. No provider credentials, native resources or persistent writes. */
export function createImageTranslationMemory({ maxEntries, maxCharacters }: { maxEntries: number, maxCharacters: number }) {
  const revision = shallowRef(0);
  const entries = new Map<string, ImageTranslationMemoryEntry>();
  function keyOf({ key }: { key: ImageTranslationKey }): string {
    return JSON.stringify([key.storeId, key.sessionId, key.field, key.language]);
  }
  function read({ key }: { key: ImageTranslationKey }): ImageTranslationMemoryEntry | undefined {
    void revision.value;
    const value = entries.get(keyOf({ key }));
    return value && { ...value };
  }
  function save({ key, entry }: { key: ImageTranslationKey, entry: ImageTranslationMemoryEntry }): boolean {
    const identity = keyOf({ key });
    if (!entry.text.trim() || entry.sourceText.length + entry.text.length > maxCharacters || maxEntries < 1) return false;
    entries.delete(identity); entries.set(identity, { ...entry });
    let characters = [...entries.values()].reduce((total, value) => total + value.sourceText.length + value.text.length, 0);
    for (const [oldKey, value] of entries) {
      if (entries.size <= maxEntries && characters <= maxCharacters) break;
      entries.delete(oldKey); characters -= value.sourceText.length + value.text.length;
    }
    revision.value++;
    return true;
  }
  function clear(): void {
    entries.clear(); revision.value++;
  }
  function removeSession({ storeId, sessionId }: { storeId: string | undefined, sessionId: string }): void {
    const prefix = JSON.stringify([storeId, sessionId]).slice(0, -1) + ',';
    for (const key of entries.keys()) if (key.startsWith(prefix)) entries.delete(key);
    revision.value++;
  }
  return { read, save, clear, removeSession };
}

export const TEST_ONLY = {
};
