import { describe, expect, it, vi } from 'vitest';
import { toChatGroupId, toChatId } from '@/01-models/ids';
import { STORAGE_KEY_PREFIX } from '@/constants';
import { LocalStorageProvider } from './local-storage';
import { OPFSStorageProvider } from './opfs-storage';
import { createImageGenerationStorageHarness } from './image-generation/index.test-support';

const legacyEndpoint = { type: 'experimental_type', experimental: { endpoint: { type: 'llama_cpp_browser' } } };
const stableEndpoint = { type: 'llama_cpp_browser' };
const titleGeneration = { endpoint: legacyEndpoint, model: { id: 'title.gguf' }, lmParameters: {} };
const recordPaths = {
  settings: { local: 'settings', opfs: 'settings.json' },
  chat: { local: 'chat_meta:migrating-chat', opfs: 'chat-metas/migrating-chat.json' },
  chatGroup: { local: 'chat_group:migrating-group', opfs: 'chat-groups/migrating-group.json' },
};
type RecordName = keyof typeof recordPaths;

async function storageFixture({ kind }: { kind: 'local' | 'opfs' }) {
  localStorage.clear();
  const files = kind === 'opfs' ? createImageGenerationStorageHarness() : undefined;
  const provider = kind === 'opfs' ? new OPFSStorageProvider() : new LocalStorageProvider();
  if (files) {
    // Isolate endpoint migration from the unrelated uploaded-file migration.
    const directory = await files.root.getDirectoryHandle('naidan-storage', { create: true });
    (await directory.getFileHandle('migration-state.json', { create: true })).text = JSON.stringify({
      completedMigrations: [{ name: 'v1_uploaded_files_to_binary_objects', completedAt: 1 }],
    });
  }
  await provider.init();
  return {
    provider,
    async seed({ record, value }: { record: RecordName, value: unknown }) {
      const text = JSON.stringify(value);
      const paths = recordPaths[record];
      if (!files) {
        localStorage.setItem(`${STORAGE_KEY_PREFIX}lsp:${paths.local}`, text);
        return text;
      }
      const parts = ['naidan-storage', ...paths.opfs.split('/')];
      const filename = parts.pop()!;
      let directory = files.root;
      for (const name of parts) {
        directory = await directory.getDirectoryHandle(name, { create: true });
      }
      (await directory.getFileHandle(filename, { create: true })).text = text;
      return text;
    },
    async read({ record }: { record: RecordName }): Promise<string> {
      const paths = recordPaths[record];
      if (files) {
        return (await files.file({ path: `naidan-storage/${paths.opfs}` })).text;
      }
      const text = localStorage.getItem(`${STORAGE_KEY_PREFIX}lsp:${paths.local}`);
      if (text === null) {
        throw new Error(`Missing fixture: ${record}`);
      }
      return text;
    },
    [Symbol.dispose]() {
      vi.unstubAllGlobals();
      localStorage.clear();
    },
  };
}

describe.each(['local', 'opfs'] as const)('lazy endpoint migration in %s storage', kind => {
  it('reads legacy settings, chat and chat-group endpoints without writes and migrates only each saved record', async () => {
    using fixture = await storageFixture({ kind });
    const experimental = {
      llamaCppBrowser: { contextTokens: 8192, modelDownloadDestination: { kind: 'host', directoryId: 'models' } },
      hostModelDirectories: [{ id: 'models', name: 'Models' }],
      locale: 'ja',
    };
    const otherEndpoints = [
      { type: 'experimental_type', experimental: { endpoint: { type: 'browser_provided_lm' } } },
      { type: 'experimental_type', experimental: { endpoint: { type: 'naidan_rpc', registrationId: 'peer-registration' } } },
    ];
    const originalSettings = await fixture.seed({
      record: 'settings',
      value: {
        endpoint: legacyEndpoint,
        storageType: kind,
        titleGeneration,
        providerProfiles: [legacyEndpoint, ...otherEndpoints].map((endpoint, index) => ({ id: `profile-${index}`, name: `Profile ${index}`, endpoint })),
        experimental,
      },
    });
    const originalChat = await fixture.seed({
      record: 'chat',
      value: {
        id: 'migrating-chat',
        title: 'Chat',
        createdAt: 1,
        updatedAt: 2,
        endpoint: legacyEndpoint,
        titleGeneration,
      },
    });
    const originalGroup = await fixture.seed({
      record: 'chatGroup',
      value: {
        id: 'migrating-group',
        name: 'Group',
        updatedAt: 3,
        endpoint: legacyEndpoint,
        titleGeneration,
      },
    });

    const settings = await fixture.provider.loadSettings();
    const chat = await fixture.provider.loadChatMeta({ id: toChatId({ raw: 'migrating-chat' }) });
    const chatGroup = await fixture.provider.loadChatGroupConfiguration({ id: toChatGroupId({ raw: 'migrating-group' }) });
    if (!settings || !chat || !chatGroup) {
      throw new Error('Legacy records must remain readable.');
    }
    for (const owner of [settings, chat, chatGroup]) {
      expect(owner.endpoint).toStrictEqual(stableEndpoint);
      expect(owner.titleGeneration).toMatchObject({ endpoint: stableEndpoint, model: { id: 'title.gguf' } });
    }
    expect(await fixture.read({ record: 'settings' })).toBe(originalSettings);
    expect(await fixture.read({ record: 'chat' })).toBe(originalChat);
    expect(await fixture.read({ record: 'chatGroup' })).toBe(originalGroup);

    await fixture.provider.saveSettings({ settings });
    const savedSettings = JSON.parse(await fixture.read({ record: 'settings' }));
    expect(savedSettings.endpoint).toStrictEqual(stableEndpoint);
    expect(savedSettings.titleGeneration.endpoint).toStrictEqual(stableEndpoint);
    expect(savedSettings.providerProfiles.map((profile: { endpoint: unknown }) => profile.endpoint)).toStrictEqual([stableEndpoint, ...otherEndpoints]);
    expect(savedSettings.experimental).toStrictEqual(experimental);
    expect(await fixture.read({ record: 'chat' })).toBe(originalChat);
    expect(await fixture.read({ record: 'chatGroup' })).toBe(originalGroup);

    await fixture.provider.saveChatMeta({ meta: chat });
    const savedChat = JSON.parse(await fixture.read({ record: 'chat' }));
    expect(savedChat.endpoint).toStrictEqual(stableEndpoint);
    expect(savedChat.titleGeneration.endpoint).toStrictEqual(stableEndpoint);
    expect(await fixture.read({ record: 'chatGroup' })).toBe(originalGroup);

    await fixture.provider.saveChatGroup({ chatGroup: { ...chatGroup, items: [] } });
    const savedGroup = JSON.parse(await fixture.read({ record: 'chatGroup' }));
    expect(savedGroup.endpoint).toStrictEqual(stableEndpoint);
    expect(savedGroup.titleGeneration.endpoint).toStrictEqual(stableEndpoint);

    const stableSettingsBytes = await fixture.read({ record: 'settings' });
    const reread = await fixture.provider.loadSettings();
    if (!reread) {
      throw new Error('Stable settings must remain readable.');
    }
    await fixture.provider.saveSettings({ settings: reread });
    expect(await fixture.read({ record: 'settings' })).toBe(stableSettingsBytes);
  });
});
