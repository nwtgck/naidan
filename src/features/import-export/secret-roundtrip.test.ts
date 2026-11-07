import { installSecretEqualityTester } from '@/utils/secret.test-support';
import { describe, expect, it } from 'vitest';
import JSZip from 'jszip';
import { MemoryStorageProvider } from '@/00-storage/service/memory-storage';
import { DEFAULT_SETTINGS, EMPTY_LM_PARAMETERS, type Chat, type ChatGroup, type HttpEndpoint, type Settings } from '@/01-models/types';
import { idToRaw, toChatId, toChatGroupId, toProviderProfileId } from '@/01-models/ids';
import { Secret } from '@/utils/secret';
import { clonePlainData } from '@/utils/clone-plain-data';
import { revealHttpHeaders } from '@/01-models/endpoint';
import { ImportExportService, type IImportExportStorage } from './service';

installSecretEqualityTester();

function createService({ provider }: { provider: MemoryStorageProvider }): ImportExportService {
  const storage: IImportExportStorage = {
    loadSettings: () => provider.loadSettings(),
    updateSettings: async ({ updater }) => provider.saveSettings({ settings: await updater({ current: await provider.loadSettings() }) }),
    listChats: () => provider.listChats(),
    listChatGroups: () => provider.listChatGroups(),
    loadChat: ({ id }) => provider.loadChat({ id }),
    loadHierarchy: async () => ({ items: [] }),
    clearAll: () => provider.clearAll(),
    dumpWithoutLock: () => provider.dump(),
    restore: ({ snapshot }) => provider.restore({ snapshot }),
  };
  return new ImportExportService({ storage });
}

function endpoint({ value }: { value: string }): HttpEndpoint {
  return { type: 'openai', url: 'https://example.invalid/v1', httpHeaders: [['X-Custom', Secret.from({ value })]] };
}

describe('intentional ZIP credential transfer', () => {
  it('exports and imports original settings, chat and group credentials through real storage', async () => {
    const provider = new MemoryStorageProvider();
    await provider.init();
    const settings: Settings = {
      ...clonePlainData({ value: DEFAULT_SETTINGS }),
      storageType: 'memory',
      endpoint: endpoint({ value: 'global-original' }),
      providerProfiles: [{ id: toProviderProfileId({ raw: 'profile-test' }), name: 'Profile', endpoint: endpoint({ value: '[masked]' }) }],
      titleGeneration: { endpoint: endpoint({ value: 'global-title-original' }), model: { id: 'title' }, lmParameters: EMPTY_LM_PARAMETERS },
    };
    const chat: Chat = { id: toChatId({ raw: 'chat-secret' }), title: 'Chat', createdAt: 1, updatedAt: 2, debugEnabled: false, root: { items: [] }, endpoint: endpoint({ value: 'chat-original' }), titleGeneration: { endpoint: endpoint({ value: 'chat-title-original' }), model: { id: 'title' }, lmParameters: EMPTY_LM_PARAMETERS } };
    const group: ChatGroup = { id: toChatGroupId({ raw: 'group-secret' }), name: 'Group', updatedAt: 2, isCollapsed: false, items: [], endpoint: endpoint({ value: 'group-original' }), titleGeneration: { endpoint: endpoint({ value: 'group-title-original' }), model: { id: 'title' }, lmParameters: EMPTY_LM_PARAMETERS } };
    await provider.saveSettings({ settings });
    await provider.saveChatMeta({ meta: chat });
    await provider.saveChatContent({ id: chat.id, content: chat });
    await provider.saveChatGroup({ chatGroup: group });
    await provider.saveHierarchy({ hierarchy: { items: [{ type: 'chat_group', id: idToRaw({ id: group.id }), chat_ids: [idToRaw({ id: chat.id })] }] } });
    const { stream } = await createService({ provider }).exportData({});
    const bytes = await new Response(stream).arrayBuffer();
    const zip = await JSZip.loadAsync(bytes);
    const jsonFiles = await Promise.all(Object.values(zip.files).filter(entry => entry.name.endsWith('.json')).map(entry => entry.async('string')));
    const raw = jsonFiles.join('');
    for (const value of ['global-original', 'global-title-original', 'chat-original', 'chat-title-original', 'group-original', 'group-title-original']) {
      expect(raw).toContain(value);
      expect(JSON.stringify({ settings, chat, group })).not.toContain(value);
    }
    const restored = new MemoryStorageProvider();
    await restored.init();
    await createService({ provider: restored }).executeImport({ zipFile: new Blob([bytes]), config: { data: { mode: 'replace' }, settings: { endpoint: 'replace', model: 'replace', titleModel: 'replace', systemPrompt: 'replace', lmParameters: 'replace', providerProfiles: 'replace' } } });
    const loadedSettings = await restored.loadSettings();
    const loadedChat = await restored.loadChat({ id: chat.id });
    const loadedGroup = await restored.loadChatGroup({ id: group.id });
    for (const [value, original] of [[loadedSettings, 'global-original'], [loadedChat, 'chat-original'], [loadedGroup, 'group-original']] as const) {
      if (value?.endpoint?.type !== 'openai') {
        throw new Error('Expected restored HTTP endpoint');
      }
      expect(value.endpoint.httpHeaders?.[0]?.[1]).toBeInstanceOf(Secret);
      expect(revealHttpHeaders({ headers: value.endpoint.httpHeaders })).toEqual([['X-Custom', original]]);
      const title = value.titleGeneration;
      if (typeof title !== 'object' || title.endpoint === 'same_scope' || title.endpoint.type !== 'openai') {
        throw new Error('Expected restored title endpoint');
      }
      expect(title.endpoint.httpHeaders?.[0]?.[1].reveal()).toBe(original.replace('-original', '-title-original'));
    }
    const profile = loadedSettings?.providerProfiles[0];
    if (profile?.endpoint.type !== 'openai') {
      throw new Error('Expected restored HTTP profile');
    }
    expect(profile.endpoint.httpHeaders?.[0]?.[1].reveal()).toBe('[masked]');
  });
});
