import { stringifyStorageDto } from './serialize';
import { beforeEach, expect, it, vi } from 'vitest';
import { LocalStorageProvider } from './local-storage';
import { SettingsSchemaDto } from '@/00-storage/00-dto/dto';
import { settingsToDomain, settingsToDto } from '@/00-storage/mapper/mappers';
import { cloneEndpoint, areEndpointsEqual, areEndpointModelNamespacesEqual } from '@/01-models/endpoint';
import { DEFAULT_SETTINGS, type Settings } from '@/01-models/types';
import { STORAGE_KEY_PREFIX } from '@/constants';

const key = `${STORAGE_KEY_PREFIX}lsp:settings`;

beforeEach(() => {
  localStorage.clear(); vi.restoreAllMocks();
});

function settings(): Settings {
  return { ...DEFAULT_SETTINGS, storageType: 'local', endpoint: { type: 'openai', url: 'https://local.example' } };
}
function unreadable({ value }: { value: unknown }): Settings {
  return settingsToDomain({
    dto: SettingsSchemaDto.parse({
      ...settingsToDto({ domain: settings() }),
      endpoint: { type: 'experimental_type', experimental: { endpoint: value } },
      experimental: { locale: 'ja', browserImageGeneration: { width: 768, height: 1024, historyPersistence: 'enabled' } },
    }),
  });
}

it('preserves distinct unavailable RPC leaves through clone, equality and actual provider JSON reparsing', async () => {
  const rawA = { type: 'naidan_rpc', registrationId: 'registration-A', future: { values: ['A'] } };
  const rawB = { type: 'naidan_rpc', registrationId: 'registration-A', future: { values: ['B'] } };
  const a = unreadable({ value: rawA }), b = unreadable({ value: rawB });
  expect(a.endpoint.type).toBe('unsupported_experimental_endpoint'); expect(b.endpoint.type).toBe('unsupported_experimental_endpoint');
  const copyA = cloneEndpoint({ endpoint: a.endpoint }), copyB = cloneEndpoint({ endpoint: b.endpoint });
  expect(areEndpointsEqual({ left: copyA, right: a.endpoint })).toBe(true);
  expect(areEndpointsEqual({ left: copyA, right: copyB })).toBe(false);
  expect(areEndpointModelNamespacesEqual({ left: copyA, right: copyB })).toBe(false);
  rawA.future.values.push('mutated input');
  if (copyA.type !== 'unsupported_experimental_endpoint' || !copyA.unavailableRpc) throw new Error('Missing retained value');
  const exposed = copyA.unavailableRpc.read();
  if (typeof exposed !== 'object' || exposed === null || !('future' in exposed)) throw new Error('Missing raw future');
  Reflect.set(exposed, 'future', 'mutated copy');
  rawA.future.values.pop();
  expect(areEndpointsEqual({ left: copyA, right: a.endpoint })).toBe(true);
  const provider = new LocalStorageProvider();
  for (const [domain, raw] of [[a, rawA], [b, rawB]] as const) {
    await provider.saveSettings({ settings: { ...domain, endpoint: cloneEndpoint({ endpoint: domain.endpoint }), defaultModelId: 'unrelated-model' } });
    expect(JSON.parse(localStorage.getItem(key)!).endpoint.experimental.endpoint).toEqual(raw);
    const reloaded = await provider.loadSettings(); if (!reloaded) throw new Error('Missing saved settings');
    expect(reloaded.endpoint.type).toBe('unsupported_experimental_endpoint');
    expect(reloaded.defaultModelId).toBe('unrelated-model');
    expect(reloaded.experimental).toMatchObject({ locale: 'ja', browserImageGeneration: { width: 768, height: 1024, historyPersistence: 'enabled' } });
    await provider.saveSettings({ settings: { ...reloaded, systemPrompt: 'Another unrelated edit' } });
    expect(JSON.parse(localStorage.getItem(key)!).endpoint.experimental.endpoint).toEqual(raw);
  }
});

it('rejects unrepresentable unknown own keys before changing prior JSON storage', async () => {
  const provider = new LocalStorageProvider(); await provider.saveSettings({ settings: settings() });
  const prior = localStorage.getItem(key), set = vi.spyOn(localStorage, 'setItem');
  const next = unreadable({ value: { type: 'naidan_rpc', legacyConnectionId: undefined } });
  expect(next.endpoint.type).toBe('unsupported_experimental_endpoint');
  await expect(provider.saveSettings({ settings: next })).rejects.toThrow();
  expect(set).not.toHaveBeenCalled(); expect(localStorage.getItem(key)).toBe(prior);
});

it('known optional undefined remains a legitimate unselected RPC value', async () => {
  const provider = new LocalStorageProvider(), next = unreadable({ value: { type: 'naidan_rpc', registrationId: undefined } });
  expect(next.endpoint).toEqual({ type: 'naidan_rpc', registrationId: undefined });
  await provider.saveSettings({ settings: next });
  expect(JSON.parse(localStorage.getItem(key)!).endpoint.experimental.endpoint).toEqual({ type: 'naidan_rpc' });
});

it('retains the original slot through repeated schema parses and serialization', () => {
  const raw = { type: 'naidan_rpc', registrationId: 'registration-A', future: { a: [1, null, true] } };
  const dto = settingsToDto({ domain: unreadable({ value: raw }) });
  const first = stringifyStorageDto({ value: SettingsSchemaDto.parse(SettingsSchemaDto.parse(dto)), space: undefined });
  const second = stringifyStorageDto({ value: SettingsSchemaDto.parse(JSON.parse(first)), space: undefined });
  expect(second).toBe(first);
  expect(JSON.parse(second).endpoint.experimental.endpoint).toEqual(raw);
});

it('preflights OPFS serialization before opening a directory or writable', async () => {
  const getDirectory = vi.fn();
  vi.stubGlobal('navigator', { storage: { getDirectory } });
  try {
    const { OPFSStorageProvider } = await import('./opfs-storage');
    const provider = new OPFSStorageProvider();
    await expect(provider.saveSettings({ settings: unreadable({ value: { type: 'naidan_rpc', unknown: undefined } }) })).rejects.toThrow();
    expect(getDirectory).not.toHaveBeenCalled();
  } finally {
    vi.unstubAllGlobals();
  }
});

it('an explicit supported replacement cannot inherit retained unavailable data', async () => {
  const provider = new LocalStorageProvider();
  const previous = unreadable({ value: { type: 'naidan_rpc', future: 'unavailable' } });
  await provider.saveSettings({ settings: { ...previous, endpoint: { type: 'naidan_rpc', registrationId: undefined } } });
  expect(JSON.parse(localStorage.getItem(key)!).endpoint.experimental.endpoint).toEqual({ type: 'naidan_rpc' });
});

it.each(['__proto__', 'constructor', 'prototype', 'toString'])('preserves own %s without laundering it into an active endpoint', async property => {
  const raw: unknown = JSON.parse(`{"type":"naidan_rpc","registrationId":"registration-A","${property}":{"future":7}}`);
  const provider = new LocalStorageProvider(), domain = unreadable({ value: raw });
  expect(domain.endpoint.type).toBe('unsupported_experimental_endpoint');
  await provider.saveSettings({ settings: domain });
  const persisted = JSON.parse(localStorage.getItem(key)!).endpoint.experimental.endpoint;
  expect(persisted).toEqual(raw); expect(Object.hasOwn(persisted, property)).toBe(true);
  expect((await provider.loadSettings())?.endpoint.type).toBe('unsupported_experimental_endpoint');
});

it('rejects nested undefined under a prototype-named key before any write', async () => {
  const raw = { type: 'naidan_rpc', registrationId: 'registration-A' };
  Object.defineProperty(raw, '__proto__', { value: { hidden: undefined }, enumerable: true });
  const provider = new LocalStorageProvider(); await provider.saveSettings({ settings: settings() });
  const previous = localStorage.getItem(key), write = vi.spyOn(localStorage, 'setItem');
  await expect(provider.saveSettings({ settings: unreadable({ value: raw }) })).rejects.toThrow();
  expect(write).not.toHaveBeenCalled(); expect(localStorage.getItem(key)).toBe(previous);
  expect(Object.prototype).not.toHaveProperty('future');
});

it('rejects an accessor without invoking it or touching storage', () => {
  const getter = vi.fn(() => 'secret'), raw = { type: 'naidan_rpc' };
  Object.defineProperty(raw, 'future', { enumerable: true, get: getter });
  expect(() => unreadable({ value: raw })).toThrow(); expect(getter).not.toHaveBeenCalled();
});

it('isolates an unsupported image RPC location without losing neighboring preferences or choosing local', async () => {
  const raw = { kind: 'naidan_rpc', connection: { connectionId: 'old-registration', peerId: 'B'.repeat(43) } };
  const dto = settingsToDto({ domain: settings() });
  const domain = settingsToDomain({
    dto: SettingsSchemaDto.parse({
      ...dto,
      experimental: {
        locale: 'ja',
        browserImageGeneration: {
          width: 768,
          height: 1024,
          historyPersistence: 'enabled',
          inferenceLocation: raw,
        },
      },
    }),
  });
  const preference = domain.experimental?.browserImageGeneration;
  expect(preference).toMatchObject({ width: 768, height: 1024, inferenceLocation: { kind: 'naidan_rpc', registration: undefined } });
  expect(preference?.inferenceLocation?.kind === 'naidan_rpc' && preference.inferenceLocation.unavailableRpc?.read()).toEqual(raw);
  const provider = new LocalStorageProvider(); await provider.saveSettings({ settings: domain });
  const saved = JSON.parse(localStorage.getItem(key)!);
  expect(saved.experimental.browserImageGeneration.inferenceLocation).toEqual(raw);
  const reloaded = await provider.loadSettings();
  expect(reloaded?.experimental?.browserImageGeneration?.inferenceLocation?.kind).toBe('naidan_rpc');
});

it('retains malformed remote editor references separately from usable entries', async () => {
  const editor = { components: [], loras: [] };
  const raw = { connectionId: 'old-registration', peerId: 'B'.repeat(43), editor };
  const usable = { registrationId: 'registration-B', peerPublicKey: 'C'.repeat(43), editor };
  const rawC = { ...raw, connectionId: 'other-legacy-registration' };
  const domain = settingsToDomain({
    dto: SettingsSchemaDto.parse({
      ...settingsToDto({ domain: settings() }),
      experimental: {
        locale: 'ja',
        browserImageGeneration: { width: 768, remoteModelEditors: [raw, usable, rawC] },
      },
    }),
  });
  const values = domain.experimental?.browserImageGeneration?.remoteModelEditors;
  expect(values?.[0]).toHaveProperty('unavailableRpc'); expect(values?.[1]).toHaveProperty('registrationId');
  const provider = new LocalStorageProvider(); await provider.saveSettings({ settings: domain });
  expect(JSON.parse(localStorage.getItem(key)!).experimental.browserImageGeneration.remoteModelEditors).toEqual([raw, usable, rawC]);
});

it('round-trips opaque RPC JSON through OPFS writable bytes and leaves prior bytes on rejection', async () => {
  const files = new Map<string, string>();
  const open = vi.fn(async (name: string) => ({
    getFile: async () => ({ text: async () => files.get(name) }),
    createWritable: async () => ({
      write: async (text: string) => {
        files.set(name, text);
      },
      close: async () => {},
    }),
  }));
  vi.stubGlobal('navigator', { storage: { getDirectory: async () => ({ getDirectoryHandle: async () => ({ getFileHandle: open }) }) } });
  try {
    const { OPFSStorageProvider } = await import('./opfs-storage');
    const provider = new OPFSStorageProvider();
    const raw = JSON.parse('{"type":"naidan_rpc","registrationId":"registration-A","__proto__":{"nested":[1,2]}}');
    await provider.saveSettings({ settings: unreadable({ value: raw }) });
    expect(JSON.parse(files.get('settings.json')!).endpoint.experimental.endpoint).toEqual(raw);
    expect((await provider.loadSettings())?.endpoint.type).toBe('unsupported_experimental_endpoint');
    const previous = files.get('settings.json'); open.mockClear();
    await expect(provider.saveSettings({ settings: unreadable({ value: { type: 'naidan_rpc', future: undefined } }) })).rejects.toThrow();
    expect(open).not.toHaveBeenCalled(); expect(files.get('settings.json')).toBe(previous);
  } finally {
    vi.unstubAllGlobals();
  }
});

it.each(['local', 'opfs'] as const)('keeps unrepresentable RPC bytes unavailable during actual %s reads and updates', async type => {
  const { StorageService } = await import('./index');
  const { OPFSStorageProvider } = await import('./opfs-storage');
  const { UnrepresentableRpcValueError } = await import('@/01-models/unavailable-rpc-value');
  const files = new Map<string, string>();
  const fileHandle = async ({ name }: { name: string }) => ({
    getFile: async () => ({ text: async () => files.get(name) }),
    createWritable: async () => ({
      write: async (text: string) => {
        files.set(name, text);
      },
      close: async () => {},
    }),
  });
  vi.stubGlobal('navigator', {
    storage: {
      getDirectory: async () => ({
        getDirectoryHandle: async () => ({ getFileHandle: (name: string) => fileHandle({ name }) }),
        getFileHandle: (name: string) => fileHandle({ name }),
        removeEntry: async (name: string) => {
          files.delete(name);
        },
      }),
    },
  });
  const init = vi.spyOn(OPFSStorageProvider.prototype, 'init').mockResolvedValue();
  try {
    const storage = new StorageService(); await storage.init({ type }); expect(storage.getCurrentType()).toBe(type);
    function writeRaw({ text }: { text: string }): void {
      switch (type) {
      case 'local': localStorage.setItem(key, text); break;
      case 'opfs': files.set('settings.json', text); break;
      default: { const exhaustive: never = type; throw new Error(String(exhaustive)); }
      }
    }
    function readRaw(): string | null | undefined {
      switch (type) {
      case 'local': return localStorage.getItem(key);
      case 'opfs': return files.get('settings.json');
      default: { const exhaustive: never = type; throw new Error(String(exhaustive)); }
      }
    }
    for (const invalidJson of ['1e999', '-1e999', '['.repeat(2048) + '0' + ']'.repeat(2048)]) {
      const text = JSON.stringify({
        ...settingsToDto({ domain: settings() }),
        endpoint: {
          type: 'experimental_type',
          experimental: {
            endpoint: { type: 'naidan_rpc', registrationId: 'registration-A', future: 'OVERFLOW' },
          },
        },
      }).replace('"OVERFLOW"', invalidJson);
      writeRaw({ text });
      await expect(storage.loadSettings()).rejects.toBeInstanceOf(UnrepresentableRpcValueError);
      const update = vi.fn(() => settings());
      await expect(storage.updateSettings({ updater: update })).rejects.toBeInstanceOf(UnrepresentableRpcValueError);
      expect(update).not.toHaveBeenCalled();
      expect(readRaw()).toBe(text);
    }
    const nested = '['.repeat(256) + '0' + ']'.repeat(256);
    const readable = JSON.stringify({
      ...settingsToDto({ domain: settings() }),
      endpoint: {
        type: 'experimental_type',
        experimental: {
          endpoint: { type: 'naidan_rpc', future: 'NESTED' },
        },
      },
    }).replace('"NESTED"', nested);
    writeRaw({ text: readable });
    expect((await storage.loadSettings())?.endpoint.type).toBe('unsupported_experimental_endpoint');
    await storage.updateSettings({
      updater: ({ current }) => {
        if (!current) throw new Error('Unavailable RPC settings became absent');
        return { ...current, systemPrompt: 'Unrelated edit' };
      },
    });
    expect(JSON.stringify(JSON.parse(readRaw()!).endpoint.experimental.endpoint.future)).toBe(nested);
    const valid = JSON.stringify(settingsToDto({ domain: settings() }));
    for (const invalid of [undefined, Infinity, NaN, () => undefined]) {
      writeRaw({ text: valid });
      await expect(storage.updateSettings({ updater: () => unreadable({ value: { type: 'naidan_rpc', future: invalid } }) })).rejects.toBeInstanceOf(UnrepresentableRpcValueError);
      expect(readRaw()).toBe(valid);
    }
  } finally {
    init.mockRestore(); vi.unstubAllGlobals();
  }
});

it('preserves native capture failure as the typed retention cause', async () => {
  const { UnavailableRpcValue, UnrepresentableRpcValueError } = await import('@/01-models/unavailable-rpc-value');
  const cause = new RangeError('Bounded native capture failure');
  vi.spyOn(globalThis, 'structuredClone').mockImplementationOnce(() => {
    throw cause;
  });
  try {
    new UnavailableRpcValue({ raw: { type: 'naidan_rpc', future: [] } });
    throw new Error('Expected capture failure');
  } catch (error) {
    if (!(error instanceof UnrepresentableRpcValueError)) throw error;
    expect(error.cause).toBe(cause);
  }
});

it.each([
  { type: 'naidan_rpc', connectionId: 'registration-A' },
  { type: 'naidan_rpc', connectionId: 'registration-A', registrationId: 'registration-B' },
])('keeps old or mixed endpoint references unavailable at the actual JSON boundary: %j', async raw => {
  const provider = new LocalStorageProvider();
  const domain = unreadable({ value: raw });
  expect(domain.endpoint.type).toBe('unsupported_experimental_endpoint');
  await provider.saveSettings({ settings: { ...domain, systemPrompt: 'unrelated edit' } });
  expect(JSON.parse(localStorage.getItem(key)!).endpoint.experimental.endpoint).toEqual(raw);
  expect((await provider.loadSettings())?.endpoint.type).toBe('unsupported_experimental_endpoint');
});
