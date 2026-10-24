import { enableAutoUnmount, flushPromises, mount } from '@vue/test-utils';
import { computed, defineComponent, h, ref, shallowRef } from 'vue';
import { createMemoryHistory, createRouter, RouterView } from 'vue-router';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { storageService } from '@/00-storage/service';
import { idToRaw } from '@/01-models/ids';
import { DEFAULT_SETTINGS, type Settings } from '@/01-models/types';
import { provideAppEntry } from '@/composables/useAppEntry';
import { provideAppPresentation } from '@/composables/useAppPresentation';
import { chatDataStore, creatingChat, currentChatGroupRef, currentChatRef, loadData, rootItems } from '@/composables/chat/global/chat-core-singletons';
import { useChatLifecycle } from '@/composables/chat/ui/useChatLifecycle';
import { useChatOrganization } from '@/composables/chat/ui/useChatOrganization';
import { resolveChatSettings } from '@/logic/chat-settings-resolver';
import type { StartupState } from '@/logic/startup/types';
import { ensureAllStringsForTest } from '@/strings/utils.test-support';
import ChatPage from '@/pages/chat/[id].vue';
import HomeWelcome from './HomeWelcome.vue';

enableAutoUnmount(afterEach);
const settings = ref<Settings>({ ...DEFAULT_SETTINGS, storageType: 'memory', endpoint: { type: 'openai', url: '' } });
vi.mock('@/composables/useSettings', () => ({
  useSettings: () => ({
    settings,
    initialized: ref(true),
    captureExperimentalStorage: () => storageService.captureSettingsStorage(),
    captureModelLaunchDefaults: async () => undefined,
    deferModelRefresh: vi.fn(),
    resumeModelRefresh: vi.fn(),
  }),
}));
vi.mock('@/features/tools/composables/useChatTools', () => ({ useChatTools: () => ({ setCurrentChatId: vi.fn() }), getEffectiveToolConfigsForChat: () => [] }));
vi.mock('@/features/tools/wesh/chat-workspace', () => ({ ensureChatWorkspaceMounted: vi.fn() }));
vi.mock('@/composables/useToast', () => ({ useToast: () => ({ addToast: vi.fn(() => 'toast') }) }));
vi.mock('@/composables/useGlobalEvents', () => ({ useGlobalEvents: () => ({ addErrorEvent: vi.fn(), addInfoEvent: vi.fn() }) }));
vi.mock('@/composables/useLayout', () => ({ useLayout: () => ({ setActiveFocusArea: vi.fn() }) }));
vi.mock('@/components/CurrentChatPane.vue', () => ({ default: { template: '<div data-testid="opened-chat" />' } }));

beforeEach(async () => {
  await ensureAllStringsForTest({ locale: 'en' });
  await storageService.init({ type: 'memory' });
  chatDataStore.TEST_ONLY.resetLiveState();
  rootItems.value = [];
  creatingChat.value = false;
  settings.value = { ...DEFAULT_SETTINGS, storageType: 'memory', endpoint: { type: 'openai', url: '' }, defaultModelId: 'global-model' };
});

async function openHome() {
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: '/', component: HomeWelcome },
      { path: '/chat/:id', component: ChatPage },
      { path: '/chat-group/:id', component: { template: '<div />' } },
    ],
  });
  await router.push('/');
  await loadData();
  const host = defineComponent({
    setup() {
      const startupState = shallowRef<StartupState>({ kind: 'ready', mainApp: HomeWelcome });
      const entry = provideAppEntry({ startupState });
      provideAppPresentation({ startupState, modelSelectionVisible: computed(() => entry.modelSelection.value !== undefined) });
      return () => h(RouterView);
    },
  });
  const view = mount(host, { attachTo: document.body, global: { plugins: [router], stubs: { LanguageSelector: true } } });
  await flushPromises();
  return { router, view };
}

it('persists a real root chat and lets its route select it without copying a previously selected chat group', async () => {
  const chatGroupId = await useChatOrganization().createChatGroup({ name: 'Private group', options: { modelId: 'group-only', endpoint: { type: 'ollama', url: 'http://localhost:11434' } } });
  const selected = rootItems.value.find(item => item.type === 'chat_group' && item.chatGroup.id === chatGroupId);
  if (selected?.type !== 'chat_group') {
    throw new Error('Expected the saved chat group');
  }
  currentChatGroupRef.value = selected.chatGroup;
  const { router, view } = await openHome();
  expect(await storageService.listChats()).toHaveLength(0);
  await view.get('[data-testid="home-new-chat"]').trigger('click');
  await flushPromises();
  const chats = await storageService.listChats();
  expect(chats).toHaveLength(1);
  const saved = await storageService.loadChat({ id: chats[0]!.id });
  expect(saved?.groupId).toBeUndefined();
  expect(saved?.modelId).toBeUndefined();
  expect(saved?.endpoint).toBeUndefined();
  expect(saved?.systemPrompt).toBeUndefined();
  expect(router.currentRoute.value.path).toBe(`/chat/${idToRaw({ id: chats[0]!.id })}`);
  expect(currentChatRef.value?.id).toBe(chats[0]!.id);
  expect(view.find('[data-testid="opened-chat"]').exists()).toBe(true);
  if (saved === null) {
    throw new Error('Expected the new chat to be saved');
  }
  expect(resolveChatSettings({ chat: saved, groups: [selected.chatGroup], globalSettings: settings.value }).modelId).toBe('global-model');
});

it('resumes a chat-group member with its existing overrides even when the global model is unset', async () => {
  settings.value.defaultModelId = undefined;
  const chatGroupId = await useChatOrganization().createChatGroup({ name: 'Research', options: { modelId: 'group-only' } });
  const chat = await useChatLifecycle().createChatWithoutSelecting({ groupId: chatGroupId, modelId: undefined, systemPrompt: undefined });
  if (chat === null) {
    throw new Error('Expected the existing chat');
  }
  const { router, view } = await openHome();
  const row = view.get('[data-testid="home-recent-chat"]');
  expect(row.text()).toContain('Research');
  await row.trigger('click');
  await flushPromises();
  expect(router.currentRoute.value.path).toBe(`/chat/${idToRaw({ id: chat.id })}`);
  expect(currentChatRef.value?.id).toBe(chat.id);
  expect(await storageService.listChats()).toHaveLength(1);
  const chatGroup = rootItems.value.find(item => item.type === 'chat_group' && item.chatGroup.id === chatGroupId);
  if (chatGroup?.type !== 'chat_group') {
    throw new Error('Expected the existing chat group');
  }
  expect(resolveChatSettings({ chat, groups: [chatGroup.chatGroup], globalSettings: settings.value }).modelId).toBe('group-only');
});
