import { describe, expect, it } from 'vitest';
import { SettingsSchemaDto } from '@/00-storage/00-dto/dto';
import { DEFAULT_SETTINGS, type Settings } from '@/01-models/types';
import { settingsToDomain, settingsToDto } from './mappers';

const base: Settings = {
  ...DEFAULT_SETTINGS,
  endpoint: { type: 'openai', url: 'https://api.example.invalid/v1' },
  storageType: 'local',
};
const policy = "default-src 'self'; connect-src 'self' http://localhost:*; x-future-rule v2";

function roundTrip({ value }: { value: string | undefined }) {
  const initial: Settings = {
    ...base,
    experimental: { locale: 'ja', naidanRpc: 'enabled', metaCspForDevelopmentNotForSecurity: value },
  };
  const saved = settingsToDto({ domain: initial });
  const dto = SettingsSchemaDto.parse(JSON.parse(JSON.stringify(saved)));
  return { saved, dto, domain: settingsToDomain({ dto }) };
}

describe('development-only CSP settings mapping', () => {
  it('uses the compact DTO key and the explicit domain name without interpreting policy syntax', () => {
    const result = roundTrip({ value: policy });
    expect(result.saved.experimental?.metaCsp).toBe(policy);
    expect(result.dto.experimental?.metaCsp).toBe(policy);
    expect(result.domain.experimental?.metaCspForDevelopmentNotForSecurity).toBe(policy);
    expect(result.domain.experimental?.locale).toBe('ja');
    expect(result.domain.experimental?.naidanRpc).toBe('enabled');
    expect(result.domain.endpoint).toEqual(base.endpoint);
    expect(settingsToDto({ domain: result.domain })).toStrictEqual(result.saved);
    expect(JSON.stringify(result.saved)).not.toContain('metaCspForDevelopmentNotForSecurity');
  });

  it('keeps legacy settings without experimental readable without creating a saved policy', () => {
    const { experimental: _experimental, ...legacy } = settingsToDto({ domain: base });
    const dto = SettingsSchemaDto.parse(legacy);
    const domain = settingsToDomain({ dto });
    expect(dto.experimental).toBeUndefined();
    expect(domain.experimental?.metaCspForDevelopmentNotForSecurity).toBeUndefined();
    expect(domain.endpoint).toEqual(base.endpoint);
    expect(JSON.stringify(settingsToDto({ domain }))).not.toContain('metaCsp');
  });

  it('keeps a legacy partial experimental block readable when metaCsp is absent', () => {
    const dto = SettingsSchemaDto.parse({ ...settingsToDto({ domain: base }), experimental: { locale: 'ja', naidanRpc: 'enabled' } });
    const domain = settingsToDomain({ dto });
    expect(dto.experimental?.metaCsp).toBeUndefined();
    expect(domain.experimental?.metaCspForDevelopmentNotForSecurity).toBeUndefined();
    expect(domain.experimental?.locale).toBe('ja');
    expect(domain.experimental?.naidanRpc).toBe('enabled');
    expect(JSON.stringify(settingsToDto({ domain }))).not.toContain('metaCsp');
  });

  it('clears only the saved policy with undefined and removes the compact key from JSON', () => {
    const initial = roundTrip({ value: policy }).domain;
    const cleared: Settings = {
      ...initial,
      experimental: { ...initial.experimental, metaCspForDevelopmentNotForSecurity: undefined },
    };
    const saved = settingsToDto({ domain: cleared });
    const serialized = JSON.stringify(saved);
    const dto = SettingsSchemaDto.parse(JSON.parse(serialized));
    const restored = settingsToDomain({ dto });
    expect(saved.experimental?.metaCsp).toBeUndefined();
    expect(serialized).not.toContain('metaCsp');
    expect(JSON.parse(serialized).experimental).not.toHaveProperty('metaCsp');
    expect(restored.experimental?.metaCspForDevelopmentNotForSecurity).toBeUndefined();
    expect(restored.experimental?.locale).toBe('ja');
    expect(restored.experimental?.naidanRpc).toBe('enabled');
    expect(restored.endpoint).toEqual(initial.endpoint);
  });

  it('omits the entire experimental block after saving, loading, and clearing its only saved value', () => {
    const initial: Settings = { ...base, experimental: { metaCspForDevelopmentNotForSecurity: policy } };
    const stored = settingsToDto({ domain: initial });
    const loaded = settingsToDomain({ dto: SettingsSchemaDto.parse(JSON.parse(JSON.stringify(stored))) });
    expect(loaded.experimental?.sidebarSendMessageReorder).toBe('disabled');
    const cleared: Settings = { ...loaded, experimental: { ...loaded.experimental, metaCspForDevelopmentNotForSecurity: undefined } };
    const saved = settingsToDto({ domain: cleared });
    expect(saved.experimental).toBeUndefined();
    expect(JSON.parse(JSON.stringify(saved))).not.toHaveProperty('experimental');

    const restored = settingsToDomain({ dto: SettingsSchemaDto.parse(JSON.parse(JSON.stringify(saved))) });
    expect(restored.experimental?.metaCspForDevelopmentNotForSecurity).toBeUndefined();
    expect(restored.experimental).toMatchObject({
      sidebarSendMessageReorder: 'disabled',
      fakeLm: 'disabled',
      naidanRpc: 'disabled',
      toolConfigPersistence: 'disabled',
    });
    expect(restored.endpoint).toEqual(initial.endpoint);
  });

  it.each([
    { locale: 'ja' },
    { naidanRpc: 'enabled' },
    { fakeLm: 'enabled' },
    { toolConfigPersistence: 'enabled' },
    { sidebarSendMessageReorder: 'move_sent_chat' },
    { toolConfigs: [] },
    { generationSpeed: {} },
    { globalSearch: { scope: 'current_thread' } },
    { hostModelDirectories: [] },
    { llamaCppBrowser: {} },
    { browserImageGeneration: { width: 512 } },
  ] satisfies NonNullable<Settings['experimental']>[])('retains other explicitly saved experimental preferences after clearing the policy: %j', remaining => {
    const initial: Settings = { ...base, experimental: { ...remaining, metaCspForDevelopmentNotForSecurity: policy } };
    const loaded = settingsToDomain({ dto: SettingsSchemaDto.parse(JSON.parse(JSON.stringify(settingsToDto({ domain: initial })))) });
    const cleared: Settings = { ...loaded, experimental: { ...loaded.experimental, metaCspForDevelopmentNotForSecurity: undefined } };
    const saved = settingsToDto({ domain: cleared });
    const expected = settingsToDto({ domain: { ...base, experimental: remaining } });
    expect(saved.experimental).toBeDefined();
    expect(JSON.parse(JSON.stringify(saved)).experimental).toEqual(JSON.parse(JSON.stringify(expected)).experimental);
    expect(JSON.stringify(saved)).not.toContain('metaCsp');
  });

  it.each([undefined, 'disabled'] as const)('keeps the sidebar default %s absent on disk and disabled after reload', sidebarSendMessageReorder => {
    const saved = settingsToDto({ domain: { ...base, experimental: { sidebarSendMessageReorder } } });
    expect(saved.experimental).toBeUndefined();
    const restored = settingsToDomain({ dto: SettingsSchemaDto.parse(JSON.parse(JSON.stringify(saved))) });
    expect(restored.experimental?.sidebarSendMessageReorder).toBe('disabled');
  });

  it('keeps legacy persisted sidebar disabled readable and compacts it on the next save', () => {
    const legacy = SettingsSchemaDto.parse({ ...settingsToDto({ domain: base }), experimental: { sidebarSendMessageReorder: 'disabled' } });
    const loaded = settingsToDomain({ dto: legacy });
    expect(loaded.experimental?.sidebarSendMessageReorder).toBe('disabled');
    expect(settingsToDto({ domain: loaded }).experimental).toBeUndefined();
  });

  it.each(['', ' ', 'not CSP syntax'])('does not treat the string %j as an unset value', value => {
    const result = roundTrip({ value });
    expect(result.domain.experimental?.metaCspForDevelopmentNotForSecurity).toBe(value);
    expect(JSON.parse(JSON.stringify(result.saved)).experimental).toHaveProperty('metaCsp', value);
  });

  it.each([null, false, 42, [], { policy }])('isolates an unreadable saved policy %j and preserves other settings', metaCsp => {
    const dto = SettingsSchemaDto.parse({
      ...settingsToDto({ domain: base }),
      experimental: { locale: 'ja', naidanRpc: 'enabled', globalSearch: { scope: 'current_thread' }, metaCsp },
    });
    const domain = settingsToDomain({ dto });
    expect(domain.experimental?.metaCspForDevelopmentNotForSecurity).toBeUndefined();
    expect(domain.experimental?.unreadable).toEqual({ metaCsp });
    expect(domain.experimental?.locale).toBe('ja');
    expect(domain.experimental?.naidanRpc).toBe('enabled');
    expect(domain.experimental?.globalSearch?.scope).toBe('current_thread');
    expect(domain.endpoint).toEqual(base.endpoint);
    const saved = settingsToDto({ domain });
    expect(JSON.stringify(saved)).not.toContain('metaCsp');
    expect(JSON.stringify(saved)).not.toContain('unreadable');
  });

  it('preserves readable metaCsp when an unrelated future experimental field is unreadable', () => {
    const futureOption = { mode: 'future' };
    const dto = SettingsSchemaDto.parse({
      ...settingsToDto({ domain: base }),
      experimental: { locale: 'ja', metaCsp: policy, futureOption },
    });
    const domain = settingsToDomain({ dto });
    expect(domain.experimental?.metaCspForDevelopmentNotForSecurity).toBe(policy);
    expect(domain.experimental?.unreadable).toEqual({ futureOption });
    expect(domain.experimental?.locale).toBe('ja');
    expect(settingsToDto({ domain }).experimental?.metaCsp).toBe(policy);
  });
});
