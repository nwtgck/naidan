import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mount } from '@vue/test-utils';
import HistoryManipulationModal from './HistoryManipulationModal.vue';
import { useChat } from '../composables/useChat';
import { nextTick, ref } from 'vue';

// Mock useChat
vi.mock('../composables/useChat', () => ({
  useChat: vi.fn()
}));

// Mock useLayout
vi.mock('../composables/useLayout', () => ({
  useLayout: () => ({
    setActiveFocusArea: vi.fn()
  })
}));

describe('HistoryManipulationModal', () => {
  const mockCommit = vi.fn();
  const mockCurrentChat = ref({ id: 'chat-1' });
  const mockActiveMessages = ref([
    { id: '1', role: 'user', content: 'Msg 1', replies: { items: [] } },
    { id: '2', role: 'assistant', content: 'Msg 2', replies: { items: [] } }
  ] as any);

  beforeEach(() => {
    vi.clearAllMocks();
    (useChat as any).mockReturnValue({
      currentChat: mockCurrentChat,
      activeMessages: mockActiveMessages,
      commitFullHistoryManipulation: mockCommit
    });
  });

  const mountModal = async () => {
    const wrapper = mount(HistoryManipulationModal, {
      props: { isOpen: false },
      global: {
        stubs: {
          Transition: {
            template: '<div><slot /></div>'
          }
        }
      }
    });
    await wrapper.setProps({ isOpen: true });
    await nextTick();
    await nextTick();
    return wrapper;
  };

  it('renders messages when open', async () => {
    const wrapper = await mountModal();
    
    const textareas = wrapper.findAll('textarea');
    expect(textareas.length).toBe(2);
    expect((textareas[0]!.element as HTMLTextAreaElement).value).toBe('Msg 1');
    expect((textareas[1]!.element as HTMLTextAreaElement).value).toBe('Msg 2');
  });

  it('can add and remove messages', async () => {
    const wrapper = await mountModal();

    // Add message after first one
    const addButtons = wrapper.findAll('button[title="Add Message After"]');
    await addButtons[0]!.trigger('click');
    
    expect(wrapper.findAll('textarea').length).toBe(3);

    // Remove first message
    const removeButtons = wrapper.findAll('button[title="Remove Message"]');
    await removeButtons[0]!.trigger('click');

    expect(wrapper.findAll('textarea').length).toBe(2);
    expect((wrapper.findAll('textarea')[0]!.element as HTMLTextAreaElement).value).toBe(''); 
  });

  it('switches roles when clicking role button', async () => {
    const wrapper = await mountModal();

    const roleButtons = wrapper.findAll('button[title^="Switch Role"]');
    
    // First message is 'user', click to change to 'assistant'
    await roleButtons[0]!.trigger('click');
    expect(wrapper.find('.text-purple-600').exists()).toBe(true); 
    
    // Click again to change back to 'user'
    await roleButtons[0]!.trigger('click');
    expect(wrapper.find('.text-blue-600').exists()).toBe(true); 
  });

  it('calls commitFullHistoryManipulation on save', async () => {
    const wrapper = await mountModal();

    // Edit content
    const textarea = wrapper.find('textarea');
    await textarea.setValue('Updated Msg 1');

    // Click Apply - find by text content instead of icon class
    const buttons = wrapper.findAll('button');
    const saveButton = buttons.find(b => b.text().includes('Apply Changes'));
    await saveButton?.trigger('click');

    expect(mockCommit).toHaveBeenCalledWith('chat-1', [
      { role: 'user', content: 'Updated Msg 1', modelId: undefined, thinking: undefined, attachments: undefined },
      { role: 'assistant', content: 'Msg 2', modelId: undefined, thinking: undefined, attachments: undefined }
    ]);
    expect(wrapper.emitted().close).toBeTruthy();
  });

  it('emits close on cancel', async () => {
    const wrapper = await mountModal();

    const buttons = wrapper.findAll('button');
    const cancelButton = buttons.find(b => b.text().includes('Cancel'));
    await cancelButton?.trigger('click');
    expect(wrapper.emitted().close).toBeTruthy();
  });

  it('renders empty state when no messages and can add first message', async () => {
    mockActiveMessages.value = [];
    const wrapper = await mountModal();

    expect(wrapper.text()).toContain('No messages in history');
    
    const addButton = wrapper.find('button:has(.lucide-plus)');
    await addButton.trigger('click');

    const textareas = wrapper.findAll('textarea');
    expect(textareas.length).toBe(1);
    expect(textareas[0]!.element.value).toBe('');
  });
});
