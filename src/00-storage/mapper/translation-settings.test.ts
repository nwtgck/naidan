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

  it('round trips exactly the three approved settings without changing chat configuration', () => {
    const translation = { modelId: 'renamed-model.gguf', sourceLang: 'en', targetLang: 'ja(easy)' };
    const initial: Settings = { ...base, defaultModelId: 'chat-model', experimental: { locale: 'ja', translation } };
    const dto = SettingsSchemaDto.parse(JSON.parse(JSON.stringify(settingsToDto({ domain: initial }))));
    const domain = settingsToDomain({ dto });
    expect(domain.experimental?.translation).toEqual(translation);
    expect(domain.defaultModelId).toBe('chat-model');
    expect(domain.endpoint).toEqual(base.endpoint);
    expect(domain.experimental?.locale).toBe('ja');
    expect(Object.keys(dto.experimental?.translation ?? {})).toEqual(['modelId', 'sourceLang', 'targetLang']);
  });

  it('normalizes missing preference fields to undefined without imposing model-specific validation', () => {
    expect(ExperimentalTranslationSettingsSchemaDto.parse({})).toStrictEqual({ modelId: undefined, sourceLang: undefined, targetLang: undefined });
    expect(ExperimentalTranslationSettingsSchemaDto.parse({ targetLang: 'future-code' }).targetLang).toBe('future-code');
  });

  it('removes the automatic source language from serialized JSON', () => {
    const dto = settingsToDto({ domain: { ...base, experimental: { translation: { modelId: 'model', sourceLang: undefined, targetLang: 'en' } } } });
    expect(JSON.parse(JSON.stringify(dto)).experimental.translation).toEqual({ modelId: 'model', targetLang: 'en' });
  });

  it('does not store transient translation data through the DTO', () => {
    const parsed = ExperimentalTranslationSettingsSchemaDto.parse({ modelId: 'model', sourceLang: 'en', targetLang: 'ja', text: 'private', context: 'private', glossary: [{ source: 'a', target: 'b' }], output: 'private' });
    expect(Object.keys(parsed)).toEqual(['modelId', 'sourceLang', 'targetLang']);
    expect(JSON.stringify(parsed)).not.toContain('private');
  });

  it('isolates unreadable experimental translation settings without discarding unrelated preferences', () => {
    const schema = optionalExperimentalFieldSchemaDto({ schema: ExperimentalSettingsSchemaDto });
    const parsed = schema.parse({ locale: 'ja', translation: { modelId: 123 } });
    expect(parsed?.translation).toBeUndefined();
    expect(parsed?.locale).toBe('ja');
    expect(parsed?.unreadable).toHaveProperty('translation');
  });
});
