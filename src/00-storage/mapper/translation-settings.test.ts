import { describe, expect, it } from 'vitest';
import { SettingsSchemaDto } from '@/00-storage/00-dto/dto';
import { ExperimentalTranslationSettingsSchemaDto, ExperimentalSettingsSchemaDto, optionalExperimentalFieldSchemaDto } from '@/00-storage/00-dto/experimental.dto';
import { DEFAULT_SETTINGS, type Settings } from '@/01-models/types';
import { settingsToDomain, settingsToDto } from './mappers';
const base: Settings = { ...DEFAULT_SETTINGS, endpoint: { type: 'openai', url: 'https://example.invalid/v1' }, storageType: 'local' };

describe('experimental translation settings persistence', () => {
  it('keeps legacy settings and partial settings readable without materializing translation preferences', () => {
    for (const experimental of [undefined, {}, { locale: 'ja' }]) {
      const dto = SettingsSchemaDto.parse({ ...settingsToDto({ domain: base }), experimental });
      const domain = settingsToDomain({ dto });
      expect(domain.experimental?.translation).toBeUndefined();
      expect(JSON.stringify(settingsToDto({ domain }))).not.toContain('translation');
    }
  });

  it('round trips exactly the two approved settings without changing chat configuration', () => {
    const translation = { modelId: 'renamed-model.gguf', autoTranslate: { enabled: false } };
    const initial: Settings = { ...base, defaultModelId: 'chat-model', experimental: { locale: 'ja', translation } };
    const dto = SettingsSchemaDto.parse(JSON.parse(JSON.stringify(settingsToDto({ domain: initial }))));
    const domain = settingsToDomain({ dto });
    expect(domain.experimental?.translation).toEqual(translation);
    expect(domain.defaultModelId).toBe('chat-model');
    expect(domain.endpoint).toEqual(base.endpoint);
    expect(domain.experimental?.locale).toBe('ja');
    expect(Object.keys(dto.experimental?.translation ?? {})).toEqual(['modelId', 'autoTranslate']);
  });

  it('normalizes missing preference fields to undefined without imposing model-specific validation', () => {
    expect(ExperimentalTranslationSettingsSchemaDto.parse({})).toStrictEqual({ modelId: undefined, autoTranslate: undefined });
    expect(ExperimentalTranslationSettingsSchemaDto.parse({ targetLang: 'future-code', sourceLang: 'en' })).toEqual({ modelId: undefined, autoTranslate: undefined });
  });

  it('omits an unset automatic-translation preference from serialized JSON', () => {
    const dto = settingsToDto({ domain: { ...base, experimental: { translation: { modelId: 'model', autoTranslate: undefined } } } });
    expect(JSON.parse(JSON.stringify(dto)).experimental.translation).toEqual({ modelId: 'model' });
  });

  it('does not store transient translation data through the DTO', () => {
    const parsed = ExperimentalTranslationSettingsSchemaDto.parse({ modelId: 'model', sourceLang: 'en', targetLang: 'ja', text: 'private', context: 'private', glossary: [{ source: 'a', target: 'b' }], output: 'private' });
    expect(Object.keys(parsed)).toEqual(['modelId', 'autoTranslate']);
    expect(JSON.stringify(parsed)).not.toContain('private');
  });

  it('isolates unreadable experimental translation settings without discarding unrelated preferences', () => {
    const schema = optionalExperimentalFieldSchemaDto({ schema: ExperimentalSettingsSchemaDto });
    const parsed = schema.parse({ locale: 'ja', translation: { modelId: 123 } });
    expect(parsed?.translation?.modelId).toBeUndefined();
    expect(parsed?.locale).toBe('ja');
    expect(parsed?.translation?.unreadable).toHaveProperty('modelId');
  });
});

it('discards legacy language fields on a settings round trip, including malformed old values', () => {
  const dto = SettingsSchemaDto.parse({ ...settingsToDto({ domain: base }), experimental: { locale: 'ja', translation: { modelId: 'model', sourceLang: { old: true }, targetLang: 123 } } });
  const domain = settingsToDomain({ dto });
  expect(domain.experimental?.translation).toEqual({ modelId: 'model', autoTranslate: undefined });
  const serialized = JSON.stringify(settingsToDto({ domain }));
  expect(serialized).not.toContain('sourceLang');
  expect(serialized).not.toContain('targetLang');
  expect(domain.experimental?.locale).toBe('ja');
});

it.each([true, false])('destructively discards old boolean %s without losing the selected model or other settings', old => {
  const dto = SettingsSchemaDto.parse({ ...settingsToDto({ domain: base }), experimental: { locale: 'ja', translation: { modelId: 'model', autoTranslate: old } } });
  const domain = settingsToDomain({ dto });
  expect(domain.experimental?.translation).toEqual({ modelId: 'model', autoTranslate: undefined });
  expect(domain.experimental?.locale).toBe('ja');
  expect(JSON.parse(JSON.stringify(settingsToDto({ domain }))).experimental.translation).toEqual({ modelId: 'model' });
});

it('round trips an explicit delay without persisting source text or language parameters', () => {
  const initial: Settings = { ...base, experimental: { translation: { modelId: 'model', autoTranslate: { enabled: false, debounceMs: 1200 } } } };
  const domain = settingsToDomain({ dto: SettingsSchemaDto.parse(JSON.parse(JSON.stringify(settingsToDto({ domain: initial })))) });
  expect(domain.experimental?.translation).toEqual(initial.experimental?.translation);
});
