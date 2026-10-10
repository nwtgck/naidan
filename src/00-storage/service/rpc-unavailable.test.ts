import { beforeEach, expect, it } from 'vitest';
import { LocalStorageProvider } from './local-storage';
import { SettingsSchemaDto } from '@/00-storage/00-dto/dto';
import { settingsToDomain, settingsToDto } from '@/00-storage/mapper/mappers';
import { cloneEndpoint } from '@/01-models/endpoint';
import { DEFAULT_SETTINGS, type Settings } from '@/01-models/types';
import { STORAGE_KEY_PREFIX } from '@/constants';

const defaults: Settings = { ...DEFAULT_SETTINGS, storageType: 'local', endpoint: { type: 'transformers_js' } };
const key = `${STORAGE_KEY_PREFIX}lsp:settings`;

beforeEach(() => localStorage.clear());

it('keeps an unreadable image destination unavailable through normal provider saves', async () => {
  const raw = {
    ...settingsToDto({ domain: defaults }),
    experimental: { browserImageGeneration: { inferenceLocation: { kind: 'future-runtime', secret: 'not retained' } } },
  };
  localStorage.setItem(key, JSON.stringify(raw));
  const provider = new LocalStorageProvider();
  const first = await provider.loadSettings();
  expect(first?.experimental?.browserImageGeneration?.inferenceLocation).toEqual({ kind: 'unavailable' });
  if (!first) throw new Error('Missing settings');
  await provider.saveSettings({ settings: { ...first, systemPrompt: 'unrelated edit' } });
  expect(localStorage.getItem(key)).not.toContain('not retained');
  const second = await provider.loadSettings();
  expect(second?.experimental?.browserImageGeneration?.inferenceLocation).toEqual({ kind: 'unavailable' });
  expect(second?.systemPrompt).toBe('unrelated edit');
});

it('does not turn an unknown chat endpoint into local execution after saving', async () => {
  const dto = SettingsSchemaDto.parse({
    ...settingsToDto({ domain: defaults }),
    endpoint: { type: 'experimental_type', experimental: { endpoint: { type: 'future-rpc', secret: 'discarded' } } },
  });
  const domain = settingsToDomain({ dto });
  expect(domain.endpoint.type).toBe('unsupported_experimental_endpoint');
  const provider = new LocalStorageProvider();
  await provider.saveSettings({ settings: { ...domain, endpoint: cloneEndpoint({ endpoint: domain.endpoint }) } });
  expect((await provider.loadSettings())?.endpoint.type).toBe('unsupported_experimental_endpoint');
  expect(localStorage.getItem(key)).not.toContain('discarded');
});

it('permits explicit reselection without resurrecting unknown values', async () => {
  const provider = new LocalStorageProvider();
  await provider.saveSettings({
    settings: {
      ...defaults,
      experimental: {
        ...DEFAULT_SETTINGS.experimental,
        browserImageGeneration: { inferenceLocation: { kind: 'unavailable' } },
      },
    },
  });
  const loaded = await provider.loadSettings();
  if (!loaded) throw new Error('Missing settings');
  await provider.saveSettings({
    settings: {
      ...loaded,
      experimental: {
        ...loaded.experimental,
        browserImageGeneration: { inferenceLocation: { kind: 'local' } },
      },
    },
  });
  expect((await provider.loadSettings())?.experimental?.browserImageGeneration?.inferenceLocation).toEqual({ kind: 'local' });
});

it('keeps absent image settings absent rather than manufacturing a block', () => {
  const value = settingsToDomain({ dto: SettingsSchemaDto.parse(settingsToDto({ domain: defaults })) });
  expect(value.experimental?.browserImageGeneration).toBeUndefined();
});

it('does not treat invalid reference strings as a usable image destination', () => {
  const value = settingsToDomain({
    dto: SettingsSchemaDto.parse({
      ...settingsToDto({ domain: defaults }),
      experimental: { browserImageGeneration: { inferenceLocation: { kind: 'naidan_rpc', registration: { registrationId: '', peerPublicKey: '' } } } },
    }),
  });
  expect(value.experimental?.browserImageGeneration?.inferenceLocation).toEqual({ kind: 'unavailable' });
});
