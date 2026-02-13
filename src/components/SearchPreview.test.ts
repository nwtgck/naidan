import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mount } from '@vue/test-utils';
import SearchPreview from './SearchPreview.vue';
import { ref } from 'vue';
import { storageService } from '../services/storage';

vi.mock('../services/storage', () => ({
  storageService: {
    loadChat: vi.fn(),
  },
}));

const mockSearchContextSize = ref(2);

vi.mock('../composables/useSettings', () => ({
  useSettings: () => ({
    searchContextSize: mockSearchContextSize,
  }),
}));

// Mock Lucide icons
vi.mock('lucide-vue-next', () => ({
  Clock: { render: () => null },
  GitBranch: { render: () => null },
  Loader2: { render: () => null },
  MessageSquare: { render: () => null },
}));

// Mock MessageItem
vi.mock('./MessageItem.vue', () => ({
  default: {
    name: 'MessageItem',
    props: ['message'],
    template: '<div class="message-item">{{ message.content }}</div>'
  }
}));

describe('SearchPreview Component', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should show empty state when no match or chat is provided', () => {
    const wrapper = mount(SearchPreview);
    expect(wrapper.text()).toContain('Select an item to preview');
  });

  it('should load and display context when match is provided', async () => {
    const mockChat = {
      id: 'chat1',
      root: {
        items: [
          { id: 'm1', content: 'Msg 1', role: 'user', timestamp: 1, replies: { items: [
            { id: 'm2', content: 'Msg 2', role: 'assistant', timestamp: 2, replies: { items: [] } }
          ] } }
        ]
      },
      currentLeafId: 'm2'
    };
    vi.mocked(storageService.loadChat).mockResolvedValue(mockChat as any);

    const wrapper = mount(SearchPreview, {
      props: {
        match: {
          chatId: 'chat1',
          messageId: 'm1',
          targetLeafId: 'm2',
          excerpt: 'Msg 1',
          fullContent: 'Msg 1',
          role: 'user',
          timestamp: 1,
          isCurrentThread: true
        }
      }
    });

    // Wait for async loadContext
    await new Promise(resolve => setTimeout(resolve, 0));
    await wrapper.vm.$nextTick();

    expect(storageService.loadChat).toHaveBeenCalledWith('chat1');
    expect(wrapper.findAll('.message-item')).toHaveLength(2);
    expect(wrapper.text()).toContain('Msg 1');
    expect(wrapper.text()).toContain('Msg 2');
  });

  it('should show all messages when context size is Infinity', async () => {
    mockSearchContextSize.value = Infinity;

    const mockChat = {
      id: 'chat1',
      root: {
        items: [
          { id: 'm1', content: 'M1', role: 'u', timestamp: 1, replies: { items: [
            { id: 'm2', content: 'M2', role: 'a', timestamp: 2, replies: { items: [
              { id: 'm3', content: 'M3', role: 'u', timestamp: 3, replies: { items: [] } }
            ] } }
          ] } }
        ]
      },
      currentLeafId: 'm3'
    };
    vi.mocked(storageService.loadChat).mockResolvedValue(mockChat as any);

    const wrapper = mount(SearchPreview, {
      props: {
        match: { chatId: 'chat1', messageId: 'm2', targetLeafId: 'm3' } as any
      }
    });

    await new Promise(resolve => setTimeout(resolve, 0));
    await wrapper.vm.$nextTick();

    // With Infinity, it should show M1, M2, and M3 regardless of where M2 is
    expect(wrapper.findAll('.message-item')).toHaveLength(3);
  });
});
