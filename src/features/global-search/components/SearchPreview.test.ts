import { idToRaw, toChatId, toMessageId } from '@/01-models/ids';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mount } from '@vue/test-utils';
import SearchPreview from './SearchPreview.vue';
import { ref } from 'vue';
import { storageService } from '@/00-storage/service';
import { ensureAllStringsForTest } from '@/strings/test-utils';

vi.mock('../../../00-storage/service', () => ({
  storageService: {
    loadChatContent: vi.fn(),
  },
}));

const mockSearchContextSize = ref<number | 'full'>(2);

vi.mock('../../../composables/useSettings', () => ({
  useSettings: () => ({
    searchContextSize: mockSearchContextSize,
  }),
}));

// Mock Lucide icons
vi.mock('lucide-vue-next', () => ({
  ClockIcon: { render: () => null },
  GitBranchIcon: { render: () => null },
  Loader2Icon: { render: () => null },
  MessageSquareIcon: { render: () => null },
}));

// Mock MessageItem
vi.mock('../../../components/MessageItem.vue', () => ({
  default: {
    name: 'MessageItem',
    props: ['message'],
    template: '<div class="message-item">{{ message.content }}</div>',
  },
}));

describe('SearchPreview Component', () => {
  beforeEach(async () => {
    await ensureAllStringsForTest({ locale: 'en' });
    vi.clearAllMocks();
    mockSearchContextSize.value = 2;
  });

  it('should show empty state when no match or chat is provided', async () => {
    const wrapper = mount(SearchPreview);
    await vi.waitFor(() => {
      expect(wrapper.text()).toContain('Select an item to preview');
    });
  });

  it('should load and display context when match is provided', async () => {
    const mockChat = {
      id: 'chat1',
      root: {
        items: [
          { id: 'm1', content: 'Msg 1', role: 'user', timestamp: 1, replies: { items: [
            { id: 'm2', content: 'Msg 2', role: 'assistant', timestamp: 2, replies: { items: [] } },
          ] } },
        ],
      },
      currentLeafId: 'm2',
    };
    vi.mocked(storageService.loadChatContent).mockResolvedValue(mockChat as any);

    const wrapper = mount(SearchPreview, {
      props: {
        match: {
          chatId: idToRaw({ id: toChatId({ raw: 'chat1' }) }),
          messageId: idToRaw({ id: toMessageId({ raw: 'm1' }) }),
          targetLeafId: 'm2',
          excerpt: 'Msg 1',
          role: 'user',
          timestamp: 1,
          isCurrentThread: true,
        },
      },
    });

    // Wait for async loadContext
    await new Promise(resolve => setTimeout(resolve, 0));
    await wrapper.vm.$nextTick();

    expect(storageService.loadChatContent).toHaveBeenCalledWith({ id: 'chat1' });
    expect(wrapper.findAll('.message-item')).toHaveLength(2);
    expect(wrapper.text()).toContain('Msg 1');
    expect(wrapper.text()).toContain('Msg 2');
  });

  it('should show exactly the latest configured messages for a chat title result', async () => {
    mockSearchContextSize.value = 2;
    vi.mocked(storageService.loadChatContent).mockResolvedValue({
      root: {
        items: [{
          id: 'm1',
          content: 'M1',
          role: 'user',
          timestamp: 1,
          replies: {
            items: [{
              id: 'm2',
              content: 'M2',
              role: 'assistant',
              timestamp: 2,
              replies: {
                items: [{
                  id: 'm3',
                  content: 'M3',
                  role: 'user',
                  timestamp: 3,
                  replies: { items: [] },
                }],
              },
            }],
          },
        }],
      },
      currentLeafId: 'm3',
    } as any);

    const wrapper = mount(SearchPreview, {
      props: {
        chat: {
          type: 'chat',
          chatId: 'chat1',
          title: 'Chat 1',
          updatedAt: 3,
          matchType: 'title',
          contentMatches: [],
        },
      },
    });

    await new Promise(resolve => setTimeout(resolve, 0));
    await wrapper.vm.$nextTick();

    expect(wrapper.findAll('.message-item').map(item => item.text())).toEqual([
      'M2',
      'M3',
    ]);
    expect(wrapper.text()).toContain('... previous messages ...');
    expect(wrapper.text()).not.toContain('... following messages ...');
  });

  it('should show all messages when context size is full', async () => {
    mockSearchContextSize.value = 'full';

    const mockChat = {
      id: 'chat1',
      root: {
        items: [
          { id: 'm1', content: 'M1', role: 'u', timestamp: 1, replies: { items: [
            { id: 'm2', content: 'M2', role: 'a', timestamp: 2, replies: { items: [
              { id: 'm3', content: 'M3', role: 'u', timestamp: 3, replies: { items: [] } },
            ] } },
          ] } },
        ],
      },
      currentLeafId: 'm3',
    };
    vi.mocked(storageService.loadChatContent).mockResolvedValue(mockChat as any);

    const wrapper = mount(SearchPreview, {
      props: {
        match: { chatId: idToRaw({ id: toChatId({ raw: 'chat1' }) }), messageId: idToRaw({ id: toMessageId({ raw: 'm2' }) }), targetLeafId: 'm3' } as any,
      },
    });

    await new Promise(resolve => setTimeout(resolve, 0));
    await wrapper.vm.$nextTick();

    expect(wrapper.findAll('.message-item')).toHaveLength(3);
  });

  it('should use arbitrary numeric context sizes', async () => {
    mockSearchContextSize.value = 4;
    const items = Array.from({ length: 11 }, (_, index) => ({
      id: `m${index + 1}`,
      content: `M${index + 1}`,
      role: index % 2 === 0 ? 'user' : 'assistant',
      timestamp: index + 1,
      replies: { items: [] as any[] },
    }));
    for (let index = 0; index < items.length - 1; index++) {
      items[index]!.replies.items = [items[index + 1]!];
    }
    vi.mocked(storageService.loadChatContent).mockResolvedValue({
      root: { items: [items[0]!] },
      currentLeafId: 'm11',
    } as any);

    const wrapper = mount(SearchPreview, {
      props: {
        match: {
          chatId: 'chat1',
          messageId: 'm6',
          targetLeafId: 'm11',
          excerpt: 'M6',
          role: 'assistant',
          timestamp: 6,
          isCurrentThread: true,
        },
      },
    });

    await new Promise(resolve => setTimeout(resolve, 0));
    await wrapper.vm.$nextTick();

    const visibleText = wrapper.findAll('.message-item').map(item => item.text());
    expect(visibleText).toEqual([
      'M2',
      'M3',
      'M4',
      'M5',
      'M6',
      'M7',
      'M8',
      'M9',
      'M10',
    ]);
  });

  it('should ignore an older preview load that resolves after a newer selection', async () => {
    let resolveFirst: ((value: any) => void) | undefined;
    vi.mocked(storageService.loadChatContent)
      .mockImplementationOnce(() => new Promise(resolve => {
        resolveFirst = resolve;
      }))
      .mockResolvedValueOnce({
        root: { items: [{ id: 'new-message', content: 'New preview', role: 'user', timestamp: 2, replies: { items: [] } }] },
        currentLeafId: 'new-message',
      } as any);

    const wrapper = mount(SearchPreview, {
      props: {
        chat: { type: 'chat', chatId: 'old-chat', title: 'Old', updatedAt: 1, matchType: 'title', contentMatches: [] },
      },
    });
    await wrapper.setProps({
      chat: { type: 'chat', chatId: 'new-chat', title: 'New', updatedAt: 2, matchType: 'title', contentMatches: [] },
    });
    await new Promise(resolve => setTimeout(resolve, 0));

    resolveFirst?.({
      root: { items: [{ id: 'old-message', content: 'Old preview', role: 'user', timestamp: 1, replies: { items: [] } }] },
      currentLeafId: 'old-message',
    });
    await new Promise(resolve => setTimeout(resolve, 0));
    await wrapper.vm.$nextTick();

    expect(wrapper.text()).toContain('New preview');
    expect(wrapper.text()).not.toContain('Old preview');
  });

});
