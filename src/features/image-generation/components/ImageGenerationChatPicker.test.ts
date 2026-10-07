import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { ref } from 'vue';
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import type { Chat, SidebarItem } from '@/01-models/types';
import { idToRaw, toChatGroupId, toChatId } from '@/01-models/ids';
import { ensureAllStringsForTest } from '@/strings/test-utils';
import ImageGenerationChatPicker from './ImageGenerationChatPicker.vue';
const items = ref<SidebarItem[]>([]);
const mocks = vi.hoisted(() => ({ create: vi.fn() }));
vi.mock('@/composables/chat/ui/useCurrentChatState', () => ({ useCurrentChatState: () => ({ sidebarItems: items }) }));
vi.mock('@/composables/chat/ui/useChatLifecycle', () => ({ useChatLifecycle: () => ({ createChatWithoutSelecting: mocks.create }) }));
const groupId = toChatGroupId({ raw: 'group-aa' });
const chatId = toChatId({ raw: 'chat-aa' });
let wrapper: VueWrapper<InstanceType<typeof ImageGenerationChatPicker>> | undefined;
beforeEach(async () => {
  vi.resetAllMocks(); await ensureAllStringsForTest({ locale: 'en' });
  items.value = [
    { type: 'chat', id: 'chat-bb', chat: { id: toChatId({ raw: 'chat-bb' }), title: 'Photo assistant', updatedAt: 1 } },
    {
      type: 'chat_group',
      id: idToRaw({ id: groupId }),
      chatGroup: {
      id: groupId,
      name: '画像制作',
      isCollapsed: true,
      updatedAt: 1,
      items: [
      { type: 'chat', id: idToRaw({ id: chatId }), chat: { id: chatId, title: '夜景の英語プロンプト', groupId, updatedAt: 1 } },
    ],
    },
    },
    { type: 'chat_group', id: 'group-empty', chatGroup: { id: toChatGroupId({ raw: 'group-empty' }), name: 'Empty group', isCollapsed: false, updatedAt: 1, items: [] } },
  ];
});
afterEach(() => wrapper?.unmount());
function open({ selected }: { selected: typeof chatId | undefined }) {
  wrapper = mount(ImageGenerationChatPicker, { props: { selected, disabled: false } });
  return wrapper;
}
it('uses the existing grouped order and expands the attached chat without changing sidebar state', async () => {
  const view = open({ selected: chatId });
  expect(view.get('[data-testid="workspace-chat-choice-chat-aa"]').attributes('aria-pressed')).toBe('true');
  expect(view.get('[data-testid="workspace-chat-choice-chat-bb"]').text()).toBe('Photo assistant');
  await view.get('[data-testid="workspace-chat-choice-chat-aa"]').trigger('click');
  expect(view.emitted('select')).toEqual([[chatId]]);
  const group = items.value[1]; if (group?.type !== 'chat_group') throw new Error('Missing group.');
  expect(group.chatGroup.isCollapsed).toBe(true);
});
it('searches Japanese group or chat names and reveals matches in collapsed groups', async () => {
  const view = open({ selected: undefined });
  expect(view.find('[data-testid="workspace-chat-choice-chat-aa"]').exists()).toBe(false);
  await view.get('[data-testid="workspace-chat-search"]').setValue('夜景');
  expect(view.get('[data-testid="workspace-chat-choice-chat-aa"]').text()).toContain('夜景');
  expect(view.find('[data-testid="workspace-chat-choice-chat-bb"]').exists()).toBe(false);
  await view.get('[data-testid="workspace-chat-search"]').setValue('画像制作');
  expect(view.find('[data-testid="workspace-chat-choice-chat-aa"]').exists()).toBe(true);
  await view.get('[data-testid="workspace-chat-search"]').setValue('not found');
  expect(view.text()).toContain('No matching chats');
});
it.each([undefined, groupId])('creates in the selected destination without requesting main-chat navigation: %s', async groupId => {
  const created: Chat = { id: toChatId({ raw: 'new-chat' }), groupId, title: null, createdAt: 1, updatedAt: 1, root: { items: [] }, debugEnabled: false };
  mocks.create.mockResolvedValue(created);
  const view = open({ selected: undefined });
  await view.get(groupId ? '[data-testid="workspace-chat-create-group-aa"]' : '[data-testid="workspace-chat-create"]').trigger('click'); await flushPromises();
  expect(mocks.create).toHaveBeenCalledWith({ groupId, modelId: undefined, systemPrompt: undefined });
  expect(view.emitted('select')).toEqual([[created.id]]);
});
it('prevents duplicate creation and does not attach a chat after its picker has been disposed', async () => {
  const pending = Promise.withResolvers<Chat>(); mocks.create.mockReturnValue(pending.promise);
  const view = open({ selected: undefined });
  await view.get('[data-testid="workspace-chat-create"]').trigger('click');
  expect(view.get<HTMLButtonElement>('[data-testid="workspace-chat-create"]').element.disabled).toBe(true);
  view.unmount(); wrapper = undefined;
  pending.resolve({ id: chatId, title: null, createdAt: 1, updatedAt: 1, root: { items: [] }, debugEnabled: false }); await flushPromises();
  expect(view.emitted('select')).toBeUndefined(); expect(mocks.create).toHaveBeenCalledOnce();
});
it('displays creation failures and does not change selection', async () => {
  mocks.create.mockRejectedValue(new Error('storage failure')); const view = open({ selected: chatId });
  await view.get('[data-testid="workspace-chat-create"]').trigger('click'); await flushPromises();
  expect(view.get('[role="alert"]').text()).toBe('storage failure'); expect(view.emitted('select')).toBeUndefined();
});
