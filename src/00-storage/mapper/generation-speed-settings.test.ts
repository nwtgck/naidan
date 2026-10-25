import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS, type Settings } from '@/01-models/types';
import { SettingsSchemaDto } from '@/00-storage/00-dto/dto';
import { settingsToDomain, settingsToDto } from './mappers';

type DisplaySettings = NonNullable<NonNullable<Settings['experimental']>['generationSpeed']>;

function roundTrip({ value }: { value: DisplaySettings | undefined }) {
  const domain: Settings = {
    ...DEFAULT_SETTINGS,
    storageType: 'local',
    endpoint: { type: 'openai', url: 'https://example.invalid' },
    experimental: { locale: 'ja', generationSpeed: value },
  };
  const dto = SettingsSchemaDto.parse(JSON.parse(JSON.stringify(settingsToDto({ domain }))));
  return { dto, domain: settingsToDomain({ dto }) };
}

describe('experimental generation speed preferences', () => {
  it.each(['enabled', 'disabled'] as const)('round-trips %s with either inline mode', status => {
    for (const inlineStats of ['on_demand', 'always'] as const) {
      const value = { status, inlineStats };
      const result = roundTrip({ value });
      expect(result.dto.experimental?.generationSpeed).toEqual(value);
      expect(result.domain.experimental?.generationSpeed).toEqual(value);
      expect(result.domain.experimental?.locale).toBe('ja');
      expect(Object.keys(result.dto.experimental?.generationSpeed ?? {}).sort()).toEqual(['inlineStats', 'status']);
    }
  });

  it.each([undefined, {}, { status: 'disabled' }, { inlineStats: 'always' }] satisfies (DisplaySettings | undefined)[])('accepts absent and partial preferences (%j)', value => {
    const result = roundTrip({ value });
    if (value === undefined) {
      expect(result.domain.experimental?.generationSpeed).toBeUndefined();
    } else {
      expect(result.domain.experimental?.generationSpeed).toStrictEqual({ status: value.status, inlineStats: value.inlineStats });
    }
  });

  it('isolates an unreadable display option without losing other experimental settings', () => {
    const initial = roundTrip({ value: undefined }).dto;
    const dto = SettingsSchemaDto.parse({ ...initial, experimental: { locale: 'ja', generationSpeed: { status: 'future_status', inlineStats: 'always' } } });
    const domain = settingsToDomain({ dto });
    expect(domain.experimental?.locale).toBe('ja');
    expect(domain.experimental?.generationSpeed).toBeUndefined();
    expect(domain.experimental?.unreadable?.generationSpeed).toEqual({ status: 'future_status', inlineStats: 'always' });
  });
});
