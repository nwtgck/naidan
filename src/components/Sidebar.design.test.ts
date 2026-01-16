import { ref, defineComponent, h, nextTick, reactive } from 'vue';
import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest';
import { mount } from '@vue/test-utils';
import Sidebar from './Sidebar.vue';
import { useChat } from '../composables/useChat';
import { useTheme } from '../composables/useTheme';
import { useConfirm } from '../composables/useConfirm';

vi.mock('../composables/useChat', () => ({
  useChat: vi.fn(),
}));
vi.mock('../composables/useTheme', () => ({
  useTheme: vi.fn(),
}));
vi.mock('../composables/useConfirm', () => ({
  useConfirm: vi.fn(),
}));
vi.mock('vue-router', () => ({
  useRouter: vi.fn(),
}));

const DraggableStub = defineComponent({
  name: 'DraggableStub',
  props: ['modelValue', 'list'],
  setup(props, { slots }) {
    return () => {
      const items = (props.modelValue || props.list || []) as unknown[];
      return h('div', { class: 'draggable-stub' }, 
        items.map((item: unknown, index: number) => 
          slots.item ? slots.item({ element: item, index }) : null,
        ),
      );
    };
  },
});

describe('Sidebar Design Specifications', () => {
  beforeEach(() => {
    (useChat as unknown as Mock).mockReturnValue({
      currentChat: ref(null),
      streaming: ref(false),
      activeGenerations: reactive(new Map()),
      chatGroups: ref([]),
      chats: ref([]),
      sidebarItems: ref([]),
      loadChats: vi.fn().mockResolvedValue(undefined),
    });
    (useTheme as unknown as Mock).mockReturnValue({
      themeMode: ref('light'),
      setTheme: vi.fn(),
    });
    (useConfirm as unknown as Mock).mockReturnValue({
      showConfirm: vi.fn(),
    });
  });

  it('is explicitly white in light mode to match the modern aesthetic', async () => {
    const wrapper = mount(Sidebar, {
      global: { 
        stubs: { 
          'router-link': { template: '<a><slot /></a>' }, 
          'Logo': true, 
          'draggable': DraggableStub,
        }, 
      },
    });
    await nextTick();
    expect(wrapper.classes()).toContain('bg-white');
  });

  it('uses rounded-xl and soft shadows for the primary New Chat button', async () => {
    const wrapper = mount(Sidebar, {
      global: { 
        stubs: { 
          'router-link': { template: '<a><slot /></a>' }, 
          'Logo': true, 
          'draggable': true, 
        }, 
      },
    });
    await nextTick();
    const newChatBtn = wrapper.find('[data-testid="new-chat-button"]');
    expect(newChatBtn.classes()).toContain('rounded-xl');
    expect(newChatBtn.classes()).toContain('shadow-lg');
    expect(newChatBtn.classes()).toContain('shadow-blue-500/20');
  });

  it('uses gray-800 for the header title to avoid harsh black', async () => {
    const wrapper = mount(Sidebar, {
      global: { 
        stubs: { 
          'router-link': { template: '<a><slot /></a>' }, 
          'Logo': true, 
          'draggable': true, 
        }, 
      },
    });
    await nextTick();
    const title = wrapper.find('h1');
    expect(title.exists()).toBe(true);
    expect(title.classes()).toContain('from-gray-800');
  });

  it('uses blue-600 for active chat highlighting instead of indigo', async () => {
    const currentChat = ref({ id: 'active-chat-id' });
    const sidebarItems = ref([{ id: 'item-1', type: 'chat', chat: { id: 'active-chat-id', title: 'Test Active' } }]);
    
    (useChat as unknown as Mock).mockReturnValue({
      currentChat,
      sidebarItems,
      activeGenerations: reactive(new Map()),
      loadChats: vi.fn().mockResolvedValue(undefined),
      chatGroups: ref([]),
      chats: ref([]),
    });
    
    const wrapper = mount(Sidebar, {
      global: { 
        stubs: { 
          'router-link': { template: '<a><slot /></a>' }, 
          'Logo': true, 
          'draggable': DraggableStub,
        }, 
      },
    });
    
    // Wait for onMounted and internal syncLocalItems
    await nextTick();
    await nextTick(); // Second tick for the nested draggable update

    const activeItem = wrapper.find('.bg-blue-50');
    expect(activeItem.exists()).toBe(true);
    expect(activeItem.classes()).toContain('text-blue-600');
    expect(activeItem.classes()).not.toContain('text-indigo-600');
  });
});
