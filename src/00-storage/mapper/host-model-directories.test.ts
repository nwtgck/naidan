import { describe, expect, it } from 'vitest';
import { SettingsSchemaDto } from '@/00-storage/00-dto/dto';
import { settingsToDomain, settingsToDto } from './mappers';
import { DEFAULT_SETTINGS, type Settings } from '@/01-models/types';
import { toHostModelDirectoryId } from '@/01-models/ids';

const base: Settings = { ...DEFAULT_SETTINGS, endpoint: { type: 'openai', url: '' }, storageType: 'local' };

describe('native model directory settings', () => {
  it('keeps old settings without directory registrations readable', () => {
    const saved = settingsToDto({ domain: base });
    const read = settingsToDomain({ dto: SettingsSchemaDto.parse(saved) });
    expect(read.experimental?.hostModelDirectories).toBeUndefined();
    expect(JSON.stringify(saved)).not.toContain('hostModelDirectories');
  });

  it('roundtrips stable IDs and names without serializing handles or model files', () => {
    const registrations = [
      { id: toHostModelDirectoryId({ raw: 'first' }), name: 'models' },
      { id: toHostModelDirectoryId({ raw: 'second' }), name: 'models' },
    ];
    const saved = settingsToDto({ domain: { ...base, experimental: { hostModelDirectories: registrations } } });
    expect(saved.experimental?.hostModelDirectories).toEqual([
      { id: 'first', name: 'models' }, { id: 'second', name: 'models' },
    ]);
    const restored = settingsToDomain({ dto: SettingsSchemaDto.parse(JSON.parse(JSON.stringify(saved))) });
    expect(restored.experimental?.hostModelDirectories).toEqual(registrations);
  });

  it('isolates malformed registrations while retaining unrelated settings and unreadable evidence', () => {
    const hostModelDirectories = [{ id: 'first', name: 42 }];
    const dto = SettingsSchemaDto.parse({ ...settingsToDto({ domain: base }), experimental: {
      hostModelDirectories, locale: 'ja', futureFeature: { active: true },
    } });
    const restored = settingsToDomain({ dto });
    expect(restored.experimental?.locale).toBe('ja');
    expect(restored.experimental?.hostModelDirectories).toBeUndefined();
    expect(restored.experimental?.unreadable).toEqual({ hostModelDirectories, futureFeature: { active: true } });
  });
});
