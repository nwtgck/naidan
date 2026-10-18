import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ref } from 'vue';
import { storageService } from '@/00-storage/service';
import { toChatId } from '@/01-models/ids';
import { EMPTY_LM_PARAMETERS, type Chat, type Settings } from '@/01-models/types';
import { resolveChatSettings } from '@/logic/chat-settings-resolver';
import { useChatOrganization } from './useChatOrganization';

const mocks = vi.hoisted(() => ({
  updateChatGroup: vi.fn(),
  updateHierarchy: vi.fn(),
  loadData: vi.fn(),
}));
vi.mock('@/00-storage/service', () => ({ storageService: { updateChatGroup: mocks.updateChatGroup, updateHierarchy: mocks.updateHierarchy } }));
vi.mock('@/composables/useSettings', () => ({ useSettings: () => ({ settings: ref({}) }) }));
vi.mock('./useCurrentChatState', () => ({ useCurrentChatState: () => ({ chatGroups: ref([]) }) }));
vi.mock('./useChatLifecycle', () => ({ useChatLifecycle: () => ({}) }));
vi.mock('@/composables/chat/global/chat-core-singletons', () => ({
  currentChatGroupRef: { value: null },
  currentChatRef: { value: null },
  loadData: mocks.loadData,
}));

beforeEach(() => {
  vi.clearAllMocks();
  mocks.updateChatGroup.mockResolvedValue(undefined);
  mocks.updateHierarchy.mockResolvedValue(undefined);
  mocks.loadData.mockResolvedValue(undefined);
});

describe('chat group creation', () => {
  it('creates different chat-group identities for repeated names without adding a name suffix', async () => {
    const organization = useChatOrganization();
    const firstChatGroupId = await organization.createChatGroup({ name: 'Model-Q4_K_M', options: { endpoint: { type: 'llama_cpp_browser' }, modelId: 'hf.co/owner/repo:Q4_K_M' } });
    const secondChatGroupId = await organization.createChatGroup({ name: 'Model-Q4_K_M', options: { endpoint: { type: 'llama_cpp_browser' }, modelId: 'hf.co/owner/repo:Q4_K_M' } });
    expect(secondChatGroupId).not.toBe(firstChatGroupId);
    const firstChatGroup = await vi.mocked(storageService.updateChatGroup).mock.calls[0]![0].updater({ current: null });
    const secondChatGroup = await vi.mocked(storageService.updateChatGroup).mock.calls[1]![0].updater({ current: null });
    expect([firstChatGroup.name, secondChatGroup.name]).toEqual(['Model-Q4_K_M', 'Model-Q4_K_M']);
    expect([firstChatGroup.id, secondChatGroup.id]).toEqual([firstChatGroupId, secondChatGroupId]);
  });

  it('persists the chosen endpoint and model together and lets a member chat inherit them', async () => {
    const chatGroupId = await useChatOrganization().createChatGroup({
      name: 'Local model',
      options: { endpoint: { type: 'llama_cpp_browser' }, modelId: 'local-model-name' },
    });
    const call = vi.mocked(storageService.updateChatGroup).mock.calls[0]![0];
    const chatGroup = await call.updater({ current: null });
    expect(chatGroup).toMatchObject({ id: chatGroupId, name: 'Local model', endpoint: { type: 'llama_cpp_browser' }, modelId: 'local-model-name', items: [] });
    const hierarchy = { items: [] };
    await vi.mocked(storageService.updateHierarchy).mock.calls[0]![0].updater({ current: hierarchy });
    expect(hierarchy.items).toEqual([{ type: 'chat_group', id: chatGroupId, chat_ids: [] }]);
    const settings: Settings = {
      endpoint: { type: 'openai', url: 'https://global.invalid/v1' },
      defaultModelId: 'global-model',
      titleGeneration: { endpoint: 'same_scope', model: 'same_scope', lmParameters: EMPTY_LM_PARAMETERS },
      storageType: 'local',
      mounts: [],
      providerProfiles: [],
    };
    const chat: Chat = { id: toChatId({ raw: 'new-chat' }), groupId: chatGroupId, title: null, root: { items: [] }, createdAt: 1, updatedAt: 1, debugEnabled: false };
    const resolved = resolveChatSettings({ chat, groups: [chatGroup], globalSettings: settings });
    expect(resolved).toMatchObject({ endpoint: { type: 'llama_cpp_browser' }, modelId: 'local-model-name', sources: { endpoint: 'chat_group', modelId: 'chat_group' } });
    expect(chat.endpoint).toBeUndefined();
    expect(chat.modelId).toBeUndefined();
    expect(settings.endpoint.type).toBe('openai');
    expect(mocks.loadData).toHaveBeenCalledOnce();
  });

  it('keeps endpoint inheritance when no endpoint override is supplied', async () => {
    await useChatOrganization().createChatGroup({ name: 'Inherited group', options: { modelId: 'custom-model' } });
    const chatGroup = await vi.mocked(storageService.updateChatGroup).mock.calls[0]![0].updater({ current: null });
    expect(chatGroup.endpoint).toBeUndefined();
    expect(chatGroup.modelId).toBe('custom-model');
  });
});
