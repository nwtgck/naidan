import { LocalStorageProvider } from '@/00-storage/service/local-storage';
import { DEFAULT_SETTINGS } from '@/01-models/types';
import { STORAGE_KEY_PREFIX } from '@/constants';
import { loadLmProvider } from './providerFactory';
import { describe, expect, it, vi } from 'vitest';
import { fakeLmFetch } from '@/features/fake-lm/api/fakeLmFetch';
import { createLmFetch } from '@/features/lm/fetchFactory';
import { createOllamaProvider } from '@/features/lm/ollamaProviderFactory';

describe('createLmFetch', () => {
  it('uses fake LM only when debug mode is enabled for the fake endpoint', async () => {
    expect(createLmFetch({
      endpointUrl: 'https://fake-lm.invalid',
      fakeLmDebugModeStatus: 'disabled',
    })).not.toBe(fakeLmFetch);

    const fakeFetch = createLmFetch({
      endpointUrl: 'https://fake-lm.invalid',
      fakeLmDebugModeStatus: 'enabled',
    });
    expect(fakeFetch).not.toBe(fakeLmFetch);
    const response = await fakeFetch('https://fake-lm.invalid/v1/models');
    expect(response.ok).toBe(true);

    const normalFetch = createLmFetch({
      endpointUrl: 'https://example.com',
      fakeLmDebugModeStatus: 'enabled',
    });
    expect(normalFetch).not.toBe(fakeFetch);
  });
});

describe('createOllamaProvider', () => {
  it('creates an Ollama management client using the fake LM fetch path', async () => {
    const provider = createOllamaProvider({
      endpointUrl: 'https://fake-lm.invalid',
      endpointHttpHeaders: [['X-Test', 'value']],
      fakeLmDebugModeStatus: 'enabled',
    });

    await expect(provider.listRunningModels({ signal: undefined })).resolves.toEqual([]);
  });
});

it.each([
  { type: 'naidan_rpc', connectionId: 'old-peer-A' },
  { type: 'naidan_rpc', connectionId: 'old-peer-A', registrationId: 'registration-B' },
  { type: 'naidan_rpc', registrationId: 'registration-B', future: { value: 'unavailable' } },
])('never loads another provider for a persisted unavailable RPC endpoint: %j', async endpoint => {
  const provider = new LocalStorageProvider();
  await provider.saveSettings({ settings: { ...DEFAULT_SETTINGS, storageType: 'local', endpoint: { type: 'openai', url: 'https://other-peer.example' } } });
  const key = `${STORAGE_KEY_PREFIX}lsp:settings`, raw = JSON.parse(localStorage.getItem(key)!);
  raw.endpoint = { type: 'experimental_type', experimental: { endpoint } };
  localStorage.setItem(key, JSON.stringify(raw));
  const loaded = await provider.loadSettings(); if (!loaded) throw new Error('Missing settings');
  expect(loaded.endpoint.type).toBe('unsupported_experimental_endpoint');
  const fetch = vi.spyOn(globalThis, 'fetch');
  try {
    await expect(loadLmProvider({ endpoint: loaded.endpoint, fakeLmDebugModeStatus: 'disabled' })).rejects.toThrow('Unsupported experimental endpoint');
    expect(fetch).not.toHaveBeenCalled();
  } finally {
    fetch.mockRestore();
  }
});
