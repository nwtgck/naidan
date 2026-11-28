import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS, type Settings } from '@/01-models/types';
import { SettingsDtoSchema } from '@/00-format/00-dto/dto';
import { settingsToDomain, settingsToDto } from './mappers';

const base: Settings = { ...DEFAULT_SETTINGS, storageType: 'local', endpoint: { type: 'openai', url: 'https://example.invalid' } };

describe('Audio transcription preference persistence', () => {
  it('round-trips the model ID, audio language, and model preload preference', () => {
    const audioTranscription = { modelId: 'hf.co/test/recognition:Q4_K_M', recognitionLanguage: 'ja', modelAutoLoad: 'disabled', microphoneSegmentMaxSeconds: 20 } as const;
    const saved = settingsToDto({ domain: { ...base, experimental: { audioTranscription } } });
    const persisted = JSON.parse(JSON.stringify(saved));
    const restored = settingsToDomain({ dto: SettingsDtoSchema.parse(persisted) });
    expect(persisted.experimental.audioTranscription).toEqual(audioTranscription);
    expect(restored.experimental?.audioTranscription).toEqual(audioTranscription);
  });

  it.each(['enabled', 'disabled'] as const)('round-trips explicit %s while keeping unrelated preferences', autoCopy => {
    const saved = settingsToDto({ domain: { ...base, experimental: { locale: 'ja', fakeLm: 'enabled', unimplementedLauncherEntries: 'show', audioTranscription: { microphoneAutoCopy: autoCopy } } } });
    const restored = settingsToDomain({ dto: SettingsDtoSchema.parse(JSON.parse(JSON.stringify(saved))) });
    expect(saved.experimental?.audioTranscription?.microphoneAutoCopy).toBe(autoCopy);
    expect(restored.experimental?.audioTranscription?.microphoneAutoCopy).toBe(autoCopy);
    expect(restored.experimental?.locale).toBe('ja');
    expect(restored.experimental?.fakeLm).toBe('enabled');
    expect(restored.experimental?.unimplementedLauncherEntries).toBe('show');
  });

  it.each([undefined, {}, { locale: 'ja' }] satisfies Settings['experimental'][])('keeps absent preferences absent from persisted JSON: %j', experimental => {
    const stored = JSON.parse(JSON.stringify(settingsToDto({ domain: { ...base, experimental } })));
    const restored = settingsToDomain({ dto: SettingsDtoSchema.parse(stored) });
    expect(stored.experimental ?? {}).not.toHaveProperty('audioTranscription');
    expect(restored.experimental?.audioTranscription).toBeUndefined();
    expect(settingsToDto({ domain: restored }).experimental?.audioTranscription).toBeUndefined();
  });

  it.each(['future', true, 1, null, {}])('isolates unreadable automatic copy value %j without losing other settings', autoCopy => {
    const dto = SettingsDtoSchema.parse({ ...settingsToDto({ domain: base }), experimental: { locale: 'ja', unimplementedLauncherEntries: 'show', audioTranscription: { microphoneAutoCopy: autoCopy } } });
    const domain = settingsToDomain({ dto });
    expect(domain.experimental?.audioTranscription?.microphoneAutoCopy).toBeUndefined();
    expect(domain.experimental?.locale).toBe('ja');
    expect(domain.experimental?.unimplementedLauncherEntries).toBe('show');
    expect(domain.experimental?.unreadable).toEqual({ audioTranscription: { microphoneAutoCopy: autoCopy } });
  });

  it('keeps an empty transcription object unset without materializing the default', () => {
    const dto = SettingsDtoSchema.parse({ ...settingsToDto({ domain: base }), experimental: { audioTranscription: {} } });
    const domain = settingsToDomain({ dto });
    const stored = JSON.parse(JSON.stringify(settingsToDto({ domain })));
    expect(domain.experimental?.audioTranscription?.microphoneAutoCopy).toBeUndefined();
    expect(stored.experimental.audioTranscription).toEqual({});
  });

  it.each(['future', true, 1, null])('isolates an unreadable transcription object %j', audioTranscription => {
    const dto = SettingsDtoSchema.parse({ ...settingsToDto({ domain: base }), experimental: { locale: 'ja', audioTranscription } });
    const domain = settingsToDomain({ dto });
    expect(domain.experimental?.audioTranscription).toBeUndefined();
    expect(domain.experimental?.locale).toBe('ja');
    expect(domain.experimental?.unreadable).toEqual({ audioTranscription });
  });
});
