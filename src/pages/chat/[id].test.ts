import { toChatId, toMessageId } from '@/01-models/ids';
import { describe, it, expect, vi, beforeEach, afterEach, type Mock } from 'vitest';
import { enableAutoUnmount, flushPromises, mount } from '@vue/test-utils';
import { nextTick, ref } from 'vue';
import ChatPage from './[id].vue';
import { useChatNavigation } from '@/composables/chat/ui/useChatNavigation';
import { useRouter } from 'vue-router';
import { ensureAllStringsForTest } from '@/strings/utils.test-support';

enableAutoUnmount(afterEach);
vi.mock('@/00-storage/service', () => ({ storageService: { captureSettingsStorage: () => () => true, subscribeToChanges: () => () => {} } }));

vi.mock('../../composables/chat/ui/useChatNavigation', () => ({
  useChatNavigation: vi.fn(),
}));

vi.mock('vue-router', () => ({
  useRouter: vi.fn(),
}));
vi.mock('@/composables/useAppEntry', () => ({
  useAppEntry: () => ({
    recoverNotFound: async ({ isCurrent }: { isCurrent(): boolean }) => {
      if (isCurrent()) {
        await useRouter().replace({ path: '/', query: {}, hash: '' });
      }
    },
  }),
}));

vi.mock('../../components/CurrentChatPane.vue', () => ({
  default: {
    name: 'CurrentChatPane',
    props: ['targetMessageId'],
    template: '<div data-testid="current-chat-pane"></div>',
  },
}));

describe('ChatPage', () => {
  const mockOpenChat = vi.fn();
  const mockOpenChatAtMessage = vi.fn();
  const mockRouter = {
    currentRoute: ref({
      params: { id: 'chat-123' },
      query: {},
    }),
    replace: vi.fn(),
  };

  beforeEach(async () => {
    await ensureAllStringsForTest({ locale: 'en' });
    vi.clearAllMocks();
    mockOpenChat.mockReset().mockResolvedValue(undefined);
    mockOpenChatAtMessage.mockReset().mockResolvedValue(undefined);
    mockRouter.replace.mockReset().mockResolvedValue(undefined);
    (useChatNavigation as unknown as Mock).mockReturnValue({
      openChat: mockOpenChat,
      openChatAtMessage: mockOpenChatAtMessage,
    });
    (useRouter as unknown as Mock).mockReturnValue(mockRouter);
  });

  it('calls openChat on mount with id from route', () => {
    mockRouter.currentRoute.value = {
      params: { id: 'chat-123' },
      query: {},
    };

    mount(ChatPage);
    expect(mockOpenChat).toHaveBeenCalledWith({ chatId: toChatId({ raw: 'chat-123' }), leafId: undefined, isCurrent: expect.any(Function) });
  });

  it('watches route.params.id and calls openChat', async () => {
    mockRouter.currentRoute.value = {
      params: { id: 'chat-123' },
      query: {},
    };

    mount(ChatPage);
    expect(mockOpenChat).toHaveBeenCalledWith({ chatId: toChatId({ raw: 'chat-123' }), leafId: undefined, isCurrent: expect.any(Function) });

    mockRouter.currentRoute.value = {
      params: { id: 'chat-456' },
      query: {},
    };
    await nextTick();
    expect(mockOpenChat).toHaveBeenCalledWith({ chatId: toChatId({ raw: 'chat-456' }), leafId: undefined, isCurrent: expect.any(Function) });
  });

  it('watches leaf query parameter and calls openChat', async () => {
    mockRouter.currentRoute.value = {
      params: { id: 'chat-123' },
      query: { leaf: 'leaf-1' },
    };

    mount(ChatPage);
    expect(mockOpenChat).toHaveBeenCalledWith({ chatId: toChatId({ raw: 'chat-123' }), leafId: 'leaf-1', isCurrent: expect.any(Function) });

    mockRouter.currentRoute.value = {
      params: { id: 'chat-123' },
      query: { leaf: 'leaf-2' },
    };
    await nextTick();
    expect(mockOpenChat).toHaveBeenCalledWith({ chatId: toChatId({ raw: 'chat-123' }), leafId: 'leaf-2', isCurrent: expect.any(Function) });
  });

  it('watches message-id query parameter and opens at that message', async () => {
    mockRouter.currentRoute.value = {
      params: { id: 'chat-123' },
      query: { 'message-id': 'message-1' },
    };

    mount(ChatPage);
    expect(mockOpenChatAtMessage).toHaveBeenCalledWith({ chatId: toChatId({ raw: 'chat-123' }), messageId: toMessageId({ raw: 'message-1' }), isCurrent: expect.any(Function) });
    expect(mockOpenChat).not.toHaveBeenCalled();

    mockRouter.currentRoute.value = {
      params: { id: 'chat-123' },
      query: { 'message-id': 'message-2' },
    };
    await nextTick();
    expect(mockOpenChatAtMessage).toHaveBeenCalledWith({ chatId: toChatId({ raw: 'chat-123' }), messageId: toMessageId({ raw: 'message-2' }), isCurrent: expect.any(Function) });
  });

  it('passes message-id query parameter to CurrentChatPane as the target message', async () => {
    mockRouter.currentRoute.value = {
      params: { id: 'chat-123' },
      query: { 'message-id': 'message-1' },
    };

    const wrapper = mount(ChatPage);
    await flushPromises();

    expect(wrapper.findComponent({ name: 'CurrentChatPane' }).props('targetMessageId')).toBe('message-1');
  });

  it('prefers message-id over leaf when both query parameters are present', () => {
    mockRouter.currentRoute.value = {
      params: { id: 'chat-123' },
      query: { leaf: 'leaf-1', 'message-id': 'message-1' },
    };

    mount(ChatPage);
    expect(mockOpenChatAtMessage).toHaveBeenCalledWith({ chatId: toChatId({ raw: 'chat-123' }), messageId: toMessageId({ raw: 'message-1' }), isCurrent: expect.any(Function) });
    expect(mockOpenChat).not.toHaveBeenCalled();
  });

  it.each(['chat', 'message'])('replaces a confirmed missing %s target with the clean root', async kind => {
    mockRouter.currentRoute.value = { params: { id: 'missing' }, query: { q: 'do not resend', 'chat-group': 'do not create', ...(kind === 'message' ? { 'message-id': 'missing-message' } : {}) } };
    mockOpenChat.mockResolvedValue(null);
    mockOpenChatAtMessage.mockResolvedValue(null);
    const wrapper = mount(ChatPage);
    await flushPromises();
    expect(mockRouter.replace).toHaveBeenCalledExactlyOnceWith({ path: '/', query: {}, hash: '' });
    expect(wrapper.find('[data-testid="chat-page-content"]').isVisible()).toBe(false);
  });

  it('keeps a valid empty chat and a failed read on their original routes', async () => {
    mockRouter.currentRoute.value = { params: { id: 'empty' }, query: {} };
    mockOpenChat.mockResolvedValue({ id: 'empty', root: { items: [] } });
    const wrapper = mount(ChatPage);
    await flushPromises();
    expect(wrapper.get('[data-testid="chat-page-content"]').isVisible()).toBe(true);
    expect(mockRouter.replace).not.toHaveBeenCalled();
    mockOpenChat.mockRejectedValue(new Error('Storage unavailable'));
    mockRouter.currentRoute.value = { params: { id: 'failed' }, query: {} };
    await flushPromises();
    expect(wrapper.get('[data-testid="chat-load-error"]').text()).toContain('Could not load');
    expect(mockRouter.replace).not.toHaveBeenCalled();
  });

  it('does not redirect a late missing read after a newer route or unmount', async () => {
    let finish: ((value: null) => void) | undefined;
    mockOpenChat.mockImplementationOnce(() => new Promise<null>(resolve => {
      finish = resolve;
    }));
    mockRouter.currentRoute.value = { params: { id: 'slow' }, query: {} };
    const wrapper = mount(ChatPage);
    const owner = mockOpenChat.mock.calls[0]?.[0].isCurrent;
    mockRouter.currentRoute.value = { params: { id: 'other' }, query: { 'llama-cpp-browser-model': 'owner/model' } };
    await nextTick();
    expect(owner()).toBe(false);
    finish?.(null);
    await flushPromises();
    expect(mockRouter.replace).not.toHaveBeenCalled();
    wrapper.unmount();
  });
});
