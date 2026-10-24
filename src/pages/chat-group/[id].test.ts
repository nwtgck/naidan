import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { enableAutoUnmount, flushPromises, mount } from '@vue/test-utils';
import { ref } from 'vue';
import type { ChatGroup } from '@/01-models/types';
import { toChatGroupId } from '@/01-models/ids';
import { ensureAllStringsForTest } from '@/strings/utils.test-support';
import ChatGroupPage from './[id].vue';

enableAutoUnmount(afterEach);
const mocks = vi.hoisted(() => ({ open: vi.fn(), recover: vi.fn() }));
let generation = 0;
let migration: (() => void) | undefined;
const route = ref<{ params: { id: string }, query: Record<string, string> }>({ params: { id: 'first' }, query: {} });
vi.mock('vue-router', () => ({ useRouter: () => ({ currentRoute: route }) }));
vi.mock('@/composables/chat/ui/useChatNavigation', () => ({ useChatNavigation: () => ({ loadAndOpenChatGroup: mocks.open }) }));
vi.mock('@/composables/useAppEntry', () => ({ useAppEntry: () => ({ recoverNotFound: mocks.recover }) }));
vi.mock('@/00-storage/service', () => ({
  storageService: {
    captureSettingsStorage: () => {
      const captured = generation;
      return () => captured === generation;
    },
    subscribeToChanges: ({ listener }: { listener({ event }: { event: { type: 'migration' } }): void }) => {
      migration = () => listener({ event: { type: 'migration' } });
      return () => {
        migration = undefined;
      };
    },
  },
}));
vi.mock('@/components/ChatGroupSettingsPanel.vue', () => ({ default: { template: '<input data-testid="group-settings-draft" />' } }));
const chatGroup: ChatGroup = { id: toChatGroupId({ raw: 'first' }), name: 'First', items: [], updatedAt: 1, isCollapsed: false };

beforeEach(async () => {
  vi.resetAllMocks();
  generation = 0;
  migration = undefined;
  route.value = { params: { id: 'first' }, query: {} };
  mocks.open.mockResolvedValue(chatGroup);
  mocks.recover.mockResolvedValue(undefined);
  vi.spyOn(console, 'error').mockImplementation(() => {});
  await ensureAllStringsForTest({ locale: 'en' });
});

afterEach(() => vi.restoreAllMocks());

it('keeps group settings hidden and inert until the requested group has loaded', async () => {
  const pending = Promise.withResolvers<ChatGroup | null>();
  mocks.open.mockReturnValueOnce(pending.promise);
  const wrapper = mount(ChatGroupPage, { attachTo: document.body });
  expect(mocks.open).toHaveBeenCalledWith({ groupId: chatGroup.id, isCurrent: expect.any(Function) });
  expect(wrapper.get('[data-testid="chat-group-page-content"]').isVisible()).toBe(false);
  expect(wrapper.get('[data-testid="chat-group-page-content"]').attributes('inert')).toBeDefined();
  expect(wrapper.get('[role="status"]').text()).toBe('Loading chat group…');
  pending.resolve(chatGroup);
  await flushPromises();
  expect(wrapper.get('[data-testid="chat-group-page-content"]').attributes('inert')).toBeUndefined();
  expect(wrapper.get('[data-testid="chat-group-page-content"]').isVisible()).toBe(true);
  expect(mocks.recover).not.toHaveBeenCalled();
});

it('reports only a confirmed absent group to the shared Not Found recovery', async () => {
  mocks.open.mockResolvedValueOnce(null);
  const wrapper = mount(ChatGroupPage, { attachTo: document.body });
  await flushPromises();
  expect(mocks.recover).toHaveBeenCalledExactlyOnceWith({ isCurrent: expect.any(Function) });
  expect(wrapper.get('[data-testid="chat-group-page-content"]').isVisible()).toBe(false);
});

it('keeps the ready settings in place when an unrelated query changes', async () => {
  const wrapper = mount(ChatGroupPage, { attachTo: document.body });
  await flushPromises();
  const input = wrapper.get<HTMLInputElement>('[data-testid="group-settings-draft"]');
  await input.setValue('Unsaved edit');
  route.value = { params: { id: 'first' }, query: { settings: 'storage' } };
  await flushPromises();
  expect(mocks.open).toHaveBeenCalledOnce();
  expect(wrapper.get('[data-testid="chat-group-page-content"]').isVisible()).toBe(true);
  expect(input.element.value).toBe('Unsaved edit');
});

it('preserves the settings component while displaying a read error and allows retry', async () => {
  const wrapper = mount(ChatGroupPage, { attachTo: document.body });
  await flushPromises();
  const input = wrapper.get<HTMLInputElement>('[data-testid="group-settings-draft"]');
  await input.setValue('Unsaved group edit');
  mocks.open.mockRejectedValueOnce(new Error('Permission denied'));
  route.value = { params: { id: 'second' }, query: {} };
  await flushPromises();
  expect(wrapper.get('[data-testid="chat-group-load-error"]').text()).toContain('Could not load this chat group');
  expect(wrapper.get('[data-testid="chat-group-page-content"]').isVisible()).toBe(false);
  expect(input.element.value).toBe('Unsaved group edit');
  expect(mocks.recover).not.toHaveBeenCalled();
  await wrapper.get('[data-testid="chat-group-load-retry"]').trigger('click');
  await flushPromises();
  expect(wrapper.find('[data-testid="chat-group-load-error"]').exists()).toBe(false);
  expect(wrapper.get('[data-testid="chat-group-page-content"]').isVisible()).toBe(true);
});

it('makes a failed Not Found transition retryable rather than leaving permanent loading', async () => {
  mocks.open.mockResolvedValueOnce(null);
  mocks.recover.mockRejectedValueOnce(new Error('Navigation refused'));
  const wrapper = mount(ChatGroupPage, { attachTo: document.body });
  await flushPromises();
  expect(wrapper.find('[data-testid="chat-group-load-retry"]').exists()).toBe(true);
  await wrapper.get('[data-testid="chat-group-load-retry"]').trigger('click');
  await flushPromises();
  expect(wrapper.get('[data-testid="chat-group-page-content"]').isVisible()).toBe(true);
});

it.each(['absent', 'failed'] as const)('ignores a late %s read after another group is selected', async result => {
  const pending = Promise.withResolvers<ChatGroup | null>();
  mocks.open.mockReturnValueOnce(pending.promise);
  const wrapper = mount(ChatGroupPage, { attachTo: document.body });
  const firstCurrent = mocks.open.mock.calls[0]![0].isCurrent;
  route.value = { params: { id: 'second' }, query: {} };
  await flushPromises();
  expect(firstCurrent()).toBe(false);
  switch (result) {
  case 'absent': pending.resolve(null);
    break;
  case 'failed': pending.reject(new Error('Old failed read'));
    break;
  default: {
    const exhaustive: never = result;
    throw new Error(String(exhaustive));
  }
  }
  await flushPromises();
  expect(mocks.recover).not.toHaveBeenCalled();
  expect(wrapper.get('[data-testid="chat-group-page-content"]').isVisible()).toBe(true);
  expect(wrapper.find('[data-testid="chat-group-load-error"]').exists()).toBe(false);
});

it('does not recover a stale absent group after entering a formal model URL', async () => {
  const pending = Promise.withResolvers<ChatGroup | null>();
  mocks.open.mockReturnValueOnce(pending.promise);
  const wrapper = mount(ChatGroupPage, { attachTo: document.body });
  route.value = { params: { id: 'first' }, query: { 'llama-cpp-browser-model': 'owner/repo' } };
  await flushPromises();
  pending.resolve(null);
  await flushPromises();
  expect(mocks.open).toHaveBeenCalledOnce();
  expect(mocks.recover).not.toHaveBeenCalled();
  expect(wrapper.get('[data-testid="chat-group-page-content"]').isVisible()).toBe(false);
});

it('rechecks the new storage generation and ignores the previous absent result', async () => {
  const pending = Promise.withResolvers<ChatGroup | null>();
  mocks.open.mockReturnValueOnce(pending.promise);
  const wrapper = mount(ChatGroupPage, { attachTo: document.body });
  generation++;
  migration!();
  await flushPromises();
  pending.resolve(null);
  await flushPromises();
  expect(mocks.open).toHaveBeenCalledTimes(2);
  expect(mocks.recover).not.toHaveBeenCalled();
  expect(wrapper.get('[data-testid="chat-group-page-content"]').isVisible()).toBe(true);
});

it('does not recover an absent group after the page unmounts', async () => {
  const pending = Promise.withResolvers<ChatGroup | null>();
  mocks.open.mockReturnValueOnce(pending.promise);
  const wrapper = mount(ChatGroupPage, { attachTo: document.body });
  wrapper.unmount();
  pending.resolve(null);
  await flushPromises();
  expect(mocks.recover).not.toHaveBeenCalled();
});
