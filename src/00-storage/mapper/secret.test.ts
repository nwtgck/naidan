import { describe, expect, it } from 'vitest';
import { Secret } from '@/utils/secret';
import { clonePlainData } from '@/utils/clone-plain-data';
import { installSecretEqualityTester } from '@/utils/secret.test-support';
import { DEFAULT_SETTINGS, type Settings } from '@/01-models/types';
import { toProviderProfileId } from '@/01-models/ids';
import { endpointToDomain, endpointToDto, settingsToDomain, settingsToDto } from './mappers';
import { SettingsSchemaDto } from '@/00-storage/00-dto/dto';

installSecretEqualityTester();

describe('credential persistence boundary', () => {
  it.each(['', '[masked]', 'Bearer original-value', '値🗝'])('round-trips the literal value %s without sentinel decoding', value => {
    const dto = { type: 'openai' as const, url: 'https://example.invalid/v1', httpHeaders: [['X-Custom', value]] as [string, string][] };
    const domain = endpointToDomain({ dto });
    expect(JSON.stringify(domain)).toContain('[masked]');
    expect(endpointToDto({ endpoint: domain })).toEqual(dto);
    if (domain.type !== 'openai') {
      throw new Error('Expected HTTP endpoint');
    }
    expect(domain.httpHeaders?.[0]?.[1]).toBeInstanceOf(Secret);
    expect(domain.httpHeaders?.[0]?.[1].reveal()).toBe(value);
  });

  it('retains global, title and profile values through a real persisted JSON round-trip and editable copy', () => {
    const settings: Settings = { ...clonePlainData({ value: DEFAULT_SETTINGS }), storageType: 'local', endpoint: { type: 'openai', url: '' } };
    settings.endpoint = { type: 'openai', url: 'https://example.invalid', httpHeaders: [['X-Custom', Secret.from({ value: 'global-original' })]] };
    settings.titleGeneration = { endpoint: { type: 'ollama', url: 'https://title.invalid', httpHeaders: [['X-Title', Secret.from({ value: 'title-original' })]] }, model: { id: 'title' }, lmParameters: { reasoning: { effort: undefined }, temperature: undefined, topP: undefined, maxCompletionTokens: undefined, presencePenalty: undefined, frequencyPenalty: undefined, stop: undefined } };
    settings.providerProfiles = [{ id: toProviderProfileId({ raw: 'profile-test' }), name: 'Profile', endpoint: { type: 'openai', url: 'https://profile.invalid', httpHeaders: [['X-Profile', Secret.from({ value: 'profile-original' })]] } }];
    const copy = clonePlainData({ value: settings });
    const raw = JSON.stringify(settingsToDto({ domain: copy }));
    const restored = settingsToDomain({ dto: SettingsSchemaDto.parse(JSON.parse(raw)) });
    for (const value of ['global-original', 'title-original', 'profile-original']) {
      expect(raw).toContain(value);
      expect(JSON.stringify(copy)).not.toContain(value);
      expect(JSON.stringify(restored)).not.toContain(value);
    }
    expect(settingsToDto({ domain: restored })).toEqual(settingsToDto({ domain: settings }));
    expect(copy.endpoint).not.toBe(settings.endpoint);
  });
});
