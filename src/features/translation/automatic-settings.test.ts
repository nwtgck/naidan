import { describe, expect, it } from 'vitest';
import { automaticTranslationSettings } from './automatic-settings';

describe('automatic translation preferences', () => {
  it('uses enabled and 600 milliseconds only when preferences are missing', () => {
    expect(automaticTranslationSettings({ value: undefined })).toEqual({ enabled: true, debounceMs: 600 });
    expect(automaticTranslationSettings({ value: { enabled: false, debounceMs: 1200 } })).toEqual({ enabled: false, debounceMs: 1200 });
  });

  it.each([[0, 200], [-5, 200], [5000, 3000], [655, 700], [NaN, 600], [Infinity, 600]])('normalizes %s milliseconds to %s without changing the persisted object', (value, expected) => {
    const settings = { debounceMs: value };
    expect(automaticTranslationSettings({ value: settings }).debounceMs).toBe(expected);
    expect(Object.is(settings.debounceMs, value)).toBe(true);
  });
});
