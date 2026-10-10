import { LocalStorageProvider } from '@/00-storage/service/local-storage';
import { DEFAULT_SETTINGS } from '@/01-models/types';
import type { Settings } from '@/01-models/types';
import { toNaidanRpcRegistrationId } from '@/01-models/ids';
import { STORAGE_KEY_PREFIX } from '@/constants';
import { loadLmProvider } from './providerFactory';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeLmFetch } from '@/features/fake-lm/api/fakeLmFetch';
import { createLmFetch } from '@/features/lm/fetchFactory';
import { createOllamaProvider } from '@/features/lm/ollamaProviderFactory';

const rpcManager = vi.hoisted(() => ({ get: vi.fn(), client: vi.fn() }));

// Keep persistence, the factory and the RPC provider real; only isolate the
// manager so these tests cannot start connections or native model runtimes.
vi.mock('@/features/naidan-rpc-integration/runtime/feature', () => ({
  getRpcManager: rpcManager.get,
}));

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

describe('loadLmProvider for persisted experimental endpoints', () => {
  const storageKey = `${STORAGE_KEY_PREFIX}lsp:settings`;

  beforeEach(() => {
    rpcManager.get.mockReset();
    rpcManager.client.mockReset();
    rpcManager.get.mockResolvedValue({ client: rpcManager.client });
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Unexpected provider request'));
  });

  afterEach(() => {
    vi.restoreAllMocks();
    localStorage.removeItem(storageKey);
  });

  async function loadPersistedSettings({ endpoint }: { endpoint: unknown }): Promise<[Settings, Settings]> {
    const storage = new LocalStorageProvider();
    await storage.saveSettings({
      settings: {
        ...DEFAULT_SETTINGS,
        storageType: 'local',
        endpoint: { type: 'openai', url: 'https://other-peer.example' },
      },
    });
    const raw: unknown = JSON.parse(localStorage.getItem(storageKey)!);
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new Error('Missing saved settings');
    localStorage.setItem(storageKey, JSON.stringify({
      ...raw,
      endpoint: { type: 'experimental_type', experimental: { endpoint } },
    }));
    const loaded = await storage.loadSettings();
    if (!loaded) throw new Error('Missing settings');
    // An unrelated settings save must not change which provider is selected.
    await storage.saveSettings({ settings: { ...loaded, systemPrompt: 'Unrelated edit' } });
    const reloaded = await storage.loadSettings();
    if (!reloaded) throw new Error('Missing reloaded settings');
    return [loaded, reloaded];
  }

  it.each([
    { type: 'naidan_rpc' },
    { type: 'naidan_rpc', connectionId: 'old-peer-A' },
  ])('keeps a missing current registration unconfigured without falling back: %j', async endpoint => {
    for (const settings of await loadPersistedSettings({ endpoint })) {
      expect(settings.endpoint).toEqual({ type: 'naidan_rpc', registrationId: undefined });
      const provider = await loadLmProvider({ endpoint: settings.endpoint, fakeLmDebugModeStatus: 'disabled' });
      await expect(provider.listModels({ signal: undefined })).rejects.toThrow('Select a connection in Naidan RPC settings');
      if (!provider.runChatOperation) throw new Error('Missing RPC operation scope');
      const operation = vi.fn();
      await expect(provider.runChatOperation({ signal: undefined, operation })).rejects.toThrow('Select a connection in Naidan RPC settings');
      expect(operation).not.toHaveBeenCalled();
    }
    expect(rpcManager.get).not.toHaveBeenCalled();
    expect(rpcManager.client).not.toHaveBeenCalled();
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it.each([
    { type: 'naidan_rpc', registrationId: 'registration-B' },
    { type: 'naidan_rpc', connectionId: 'old-peer-A', registrationId: 'registration-B' },
    { type: 'naidan_rpc', registrationId: 'registration-B', future: { value: 'unavailable' } },
  ])('uses only the current registration and propagates RPC unavailability without fallback: %j', async endpoint => {
    // Unknown properties do not invalidate a structurally supported endpoint.
    // The declared registration must remain authoritative, including on failure.
    const registrationId = toNaidanRpcRegistrationId({ raw: 'registration-B' });
    const unavailable = new Error('Selected RPC connection is unavailable');
    rpcManager.client.mockImplementation(() => {
      throw unavailable;
    });
    for (const settings of await loadPersistedSettings({ endpoint })) {
      expect(settings.endpoint).toEqual({ type: 'naidan_rpc', registrationId });
      const provider = await loadLmProvider({ endpoint: settings.endpoint, fakeLmDebugModeStatus: 'disabled' });
      await expect(provider.listModels({ signal: undefined })).rejects.toBe(unavailable);
    }
    expect(rpcManager.get).toHaveBeenCalledTimes(2);
    expect(rpcManager.client).toHaveBeenCalledTimes(2);
    for (const call of rpcManager.client.mock.calls) expect(call).toEqual([{ id: registrationId }]);
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it.each([
    { type: 'naidan_rpc', registrationId: '' },
    { type: 'naidan_rpc', registrationId: 'bad' },
    { type: 'naidan_rpc', registrationId: 'registration/B' },
    { type: 'naidan_rpc', registrationId: null },
    { type: 'naidan_rpc', registrationId: 42 },
    { type: 'naidan_rpc', registrationId: { value: 'registration-B' } },
    { type: 'future_rpc', registrationId: 'registration-B' },
  ])('rejects an invalid or unsupported persisted endpoint without loading another provider: %j', async endpoint => {
    for (const settings of await loadPersistedSettings({ endpoint })) {
      expect(settings.endpoint.type).toBe('unsupported_experimental_endpoint');
      await expect(loadLmProvider({ endpoint: settings.endpoint, fakeLmDebugModeStatus: 'disabled' })).rejects.toThrow('Unsupported experimental endpoint');
    }
    expect(rpcManager.get).not.toHaveBeenCalled();
    expect(rpcManager.client).not.toHaveBeenCalled();
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });
});
