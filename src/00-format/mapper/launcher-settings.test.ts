import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS, type Settings } from '@/01-models/types';
import { SettingsDtoSchema } from '@/00-format/00-dto/dto';
import { settingsToDomain, settingsToDto } from './mappers';

const base: Settings = { ...DEFAULT_SETTINGS, storageType: 'local', endpoint: { type: 'openai', url: 'https://example.invalid' } };

describe('Home and launcher entry visibility persistence', () => {
  it.each(['show', 'hide'] as const)('round-trips %s without changing other experimental preferences', unimplementedLauncherEntries => {
    const saved = settingsToDto({ domain: { ...base, experimental: { locale: 'ja', fakeLm: 'enabled', unimplementedLauncherEntries } } });
    const restored = settingsToDomain({ dto: SettingsDtoSchema.parse(JSON.parse(JSON.stringify(saved))) });
    expect(saved.experimental?.unimplementedLauncherEntries).toBe(unimplementedLauncherEntries);
    expect(restored.experimental?.unimplementedLauncherEntries).toBe(unimplementedLauncherEntries);
    expect(restored.experimental?.locale).toBe('ja');
    expect(restored.experimental?.fakeLm).toBe('enabled');
  });

  it.each([undefined, {}, { locale: 'ja' }] satisfies Settings['experimental'][])('keeps an absent preference undefined and absent from persisted JSON: %j', experimental => {
    const stored = JSON.parse(JSON.stringify(settingsToDto({ domain: { ...base, experimental } })));
    const restored = settingsToDomain({ dto: SettingsDtoSchema.parse(stored) });
    expect(stored.experimental ?? {}).not.toHaveProperty('unimplementedLauncherEntries');
    expect(restored.experimental?.unimplementedLauncherEntries).toBeUndefined();
    expect(settingsToDto({ domain: restored }).experimental?.unimplementedLauncherEntries).toBeUndefined();
  });

  it.each(['future', true, 1, null, {}])('isolates unreadable visibility %j and keeps unrelated settings', unimplementedLauncherEntries => {
    const dto = SettingsDtoSchema.parse({ ...settingsToDto({ domain: base }), experimental: { locale: 'ja', unimplementedLauncherEntries } });
    const domain = settingsToDomain({ dto });
    expect(domain.experimental?.unimplementedLauncherEntries).toBeUndefined();
    expect(domain.experimental?.locale).toBe('ja');
    expect(domain.experimental?.unreadable).toEqual({ unimplementedLauncherEntries });
  });
});
