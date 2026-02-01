import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mount } from '@vue/test-utils';
import HistoryManipulationModal from './HistoryManipulationModal.vue';
import { useChat } from '../composables/useChat';
import { nextTick, ref } from 'vue';

// Mock vuedraggable
vi.mock('vuedraggable', () => ({
  default: {
    name: 'draggable',
    template: '<div class="draggable-root"><slot name="item" v-for="(element, index) in modelValue" :element="element" :index="index"></slot></div>',
    props: ['modelValue', 'itemKey', 'handle']
  }
}));

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

  it('can duplicate messages', async () => {
    mockActiveMessages.value = [{ id: '1', role: 'user', content: 'Msg 1', replies: { items: [] } }] as any;
    const wrapper = await mountModal();

    const duplicateButton = wrapper.find('button[title="Duplicate Message"]');
    await duplicateButton.trigger('click');
    await nextTick();

    const textareas = wrapper.findAll('textarea');
    expect(textareas.length).toBe(2);
    expect((textareas[0]!.element as HTMLTextAreaElement).value).toBe('Msg 1');
    expect((textareas[1]!.element as HTMLTextAreaElement).value).toBe('Msg 1');
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

  it('configures draggable correctly and updates order', async () => {
    mockActiveMessages.value = [
      { id: '1', role: 'user', content: 'Msg 1', replies: { items: [] } },
      { id: '2', role: 'assistant', content: 'Msg 2', replies: { items: [] } }
    ] as any;
    const wrapper = await mountModal();

    const draggable = wrapper.findComponent({ name: 'draggable' });
    expect(draggable.exists()).toBe(true);
    expect(draggable.props('handle')).toBe('.handle');
    expect(draggable.props('itemKey')).toBe('localId');

    // Simulate drag start
    await draggable.vm.$emit('start');
    await nextTick();
    expect(wrapper.find('.pb-32').exists()).toBe(true);

    // Simulate reordering: swap Msg 1 and Msg 2
    const currentList = draggable.props('modelValue');
    const newList = [currentList[1], currentList[0]];
    await draggable.vm.$emit('update:modelValue', newList);
    await nextTick();

    // Verify DOM reflects new order
    const textareas = wrapper.findAll('textarea');
    expect(textareas[0]!.element.value).toBe('Msg 2');
    expect(textareas[1]!.element.value).toBe('Msg 1');

    // Simulate drag end
    await draggable.vm.$emit('end');
    await nextTick();
    expect(wrapper.find('.pb-32').exists()).toBe(false);
  });

  it('preserves new order when committing changes after drag-and-drop reordering', async () => {
    mockActiveMessages.value = [
      { id: '1', role: 'user', content: 'First', replies: { items: [] } },
      { id: '2', role: 'assistant', content: 'Second', replies: { items: [] } }
    ] as any;
    const wrapper = await mountModal();

    const draggable = wrapper.findComponent({ name: 'draggable' });
    
    // Simulate reordering: Second, then First
    const currentList = draggable.props('modelValue');
    const newList = [currentList[1], currentList[0]];
    await draggable.vm.$emit('update:modelValue', newList);
    await nextTick();

    // Click Apply Changes
    const buttons = wrapper.findAll('button');
    const saveButton = buttons.find(b => b.text().includes('Apply Changes'));
    await saveButton?.trigger('click');

    // Verify commit call has the NEW order
    expect(mockCommit).toHaveBeenCalledWith('chat-1', [
      expect.objectContaining({ content: 'Second' }),
      expect.objectContaining({ content: 'First' })
    ], undefined);
  });

  it('calls commitFullHistoryManipulation on save', async () => {
    mockActiveMessages.value = [
      { id: '1', role: 'user', content: 'Msg 1', replies: { items: [] } },
      { id: '2', role: 'assistant', content: 'Msg 2', replies: { items: [] } }
    ] as any;
    const wrapper = await mountModal();

    // Edit content
    const textareas = wrapper.findAll('textarea');
    expect(textareas.length).toBe(2);
    await textareas[0]!.setValue('Updated Msg 1');

    // Click Apply
    const buttons = wrapper.findAll('button');
    const saveButton = buttons.find(b => b.text().includes('Apply Changes'));
    await saveButton?.trigger('click');

    expect(mockCommit).toHaveBeenCalledWith('chat-1', [
      { role: 'user', content: 'Updated Msg 1', modelId: undefined, thinking: undefined, attachments: undefined },
      { role: 'assistant', content: 'Msg 2', modelId: undefined, thinking: undefined, attachments: undefined }
    ], undefined);
    expect(wrapper.emitted().close).toBeTruthy();
  });

  it('commits system prompt changes', async () => {
    mockActiveMessages.value = [{ id: '1', role: 'user', content: 'Msg 1', replies: { items: [] } }] as any;
    const wrapper = await mountModal();

    // 1. Select 'override' (Section is already open)
    const overrideButton = wrapper.findAll('button').find(b => b.text().toLowerCase() === 'override');
    await overrideButton!.trigger('click');
    await nextTick();

    // 2. Set content
    const sysTextarea = wrapper.find('textarea[placeholder="Enter system prompt content..."]');
    await sysTextarea.setValue('New System Prompt');

    // 3. Save
    const saveButton = wrapper.findAll('button').find(b => b.text().toLowerCase().includes('apply changes'));
    await saveButton?.trigger('click');

    expect(mockCommit).toHaveBeenCalledWith('chat-1', [
      expect.objectContaining({ content: 'Msg 1' })
    ], { behavior: 'override', content: 'New System Prompt' });
  });

  it('commits system prompt CLEAR behavior', async () => {
    mockActiveMessages.value = [{ id: '1', role: 'user', content: 'Msg 1', replies: { items: [] } }] as any;
    const wrapper = await mountModal();

    // Select 'clear' (Section is already open)
    const clearButton = wrapper.findAll('button').find(b => b.text().toLowerCase() === 'clear');
    await clearButton!.trigger('click');
    await nextTick();

    const saveButton = wrapper.findAll('button').find(b => b.text().toLowerCase().includes('apply changes'));
    await saveButton?.trigger('click');

    expect(mockCommit).toHaveBeenCalledWith('chat-1', [
      expect.objectContaining({ content: 'Msg 1' })
    ], { behavior: 'override', content: null });
  });

  it('commits system prompt INHERIT behavior', async () => {
    mockActiveMessages.value = [{ id: '1', role: 'user', content: 'Msg 1', replies: { items: [] } }] as any;
    mockCurrentChat.value = { id: 'chat-1', systemPrompt: { behavior: 'override', content: 'Old' } } as any;
    const wrapper = await mountModal();

    // Select 'inherit' (Section is already open)
    const inheritButton = wrapper.findAll('button').find(b => b.text().toLowerCase() === 'inherit');
    await inheritButton!.trigger('click');
    await nextTick();

    const saveButton = wrapper.findAll('button').find(b => b.text().toLowerCase().includes('apply changes'));
    await saveButton?.trigger('click');

    expect(mockCommit).toHaveBeenCalledWith('chat-1', [
      expect.objectContaining({ content: 'Msg 1' })
    ], undefined);
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
    // 2 textareas: 1 for system prompt (always present) + 1 newly added message
    expect(textareas.length).toBe(2);
    // The message textarea is the second one
    expect((textareas[1]!.element as HTMLTextAreaElement).value).toBe('');
    // First message in empty history should be 'user'
    expect(wrapper.find('.text-blue-600').exists()).toBe(true);
  });

  it('predicts roles correctly when inserting messages (alternating role heuristic)', async () => {
    mockActiveMessages.value = [
      { id: '1', role: 'user', content: 'U1', replies: { items: [] } },
      { id: '2', role: 'assistant', content: 'A1', replies: { items: [] } }
    ] as any;
    const wrapper = await mountModal();

    // 1. Add after 'user' (index 0) -> should be 'assistant'
    const addButtons = wrapper.findAll('button[title="Add Message After"]');
    await addButtons[0]!.trigger('click');
    await nextTick();
    
    let labels = wrapper.findAll('[data-testid="role-label"]');
    expect(labels[1]!.text()).toBe('assistant');

    // 2. Add after 'assistant' (A1 is now at index 2) -> should be 'user'
    // Refresh buttons list as DOM has changed
    const newAddButtons = wrapper.findAll('button[title="Add Message After"]');
    await newAddButtons[2]!.trigger('click'); // Click on A1's add button (now at index 2)
    await nextTick();
    
    labels = wrapper.findAll('[data-testid="role-label"]');
    // Sequence should be: [U1 (user), new1 (assistant), A1 (assistant), new2 (user)]
    expect(labels[3]!.text()).toBe('user');
  });

  it('predicts role correctly when inserting at the beginning', async () => {
    mockActiveMessages.value = [
      { id: '1', role: 'user', content: 'U1', replies: { items: [] } }
    ] as any;
    const wrapper = await mountModal();

    const buttons = wrapper.findAll('button');
    const appendButton = buttons.find(b => b.text().includes('Append Message'));
    await appendButton!.trigger('click');
    await nextTick();

    const labels = wrapper.findAll('[data-testid="role-label"]');
    expect(labels[1]!.text()).toBe('assistant'); 
  });

  it('loads existing attachments and shows previews', async () => {
    const mockAtt = { id: 'att-1', status: 'persisted', originalName: 'test.png', mimeType: 'image/png', size: 100, uploadedAt: Date.now() };
    mockActiveMessages.value = [
      { id: '1', role: 'user', content: 'Msg 1', attachments: [mockAtt], replies: { items: [] } }
    ] as any;

    const mockCreateObjectURL = vi.fn().mockReturnValue('blob:test-persisted');
    global.URL.createObjectURL = mockCreateObjectURL;
    // Mock storageService.getFile
    vi.mock('../services/storage', () => ({
      storageService: {
        getFile: vi.fn().mockResolvedValue(new Blob([''], { type: 'image/png' })),
        saveFile: vi.fn().mockResolvedValue(undefined),
        canPersistBinary: true
      }
    }));

    const wrapper = await mountModal();
    
    expect(wrapper.find('img').exists()).toBe(true);
    expect(wrapper.find('img').attributes('src')).toBe('blob:test-persisted');
  });

  it('can add attachments via file input', async () => {
    mockActiveMessages.value = [{ id: '1', role: 'user', content: 'Msg 1', replies: { items: [] } }] as any;
    const mockCreateObjectURL = vi.fn().mockReturnValue('blob:test-upload');
    global.URL.createObjectURL = mockCreateObjectURL;

    const wrapper = await mountModal();
    
    // Find the hidden file input
    const fileInput = wrapper.find('input[type="file"]');
    const file = new File([''], 'test.png', { type: 'image/png' });
    
    // Mock the change event
    Object.defineProperty(fileInput.element, 'files', {
      value: [file]
    });
    await fileInput.trigger('change');
    await nextTick();

    expect(wrapper.find('img').exists()).toBe(true);
    expect(wrapper.find('img').attributes('src')).toBe('blob:test-upload');
  });

  it('can remove attachments', async () => {
    const mockAtt = { id: 'att-1', status: 'memory', blob: new Blob(['']), originalName: 'test.png', mimeType: 'image/png', size: 100, uploadedAt: Date.now() };
    mockActiveMessages.value = [
      { id: '1', role: 'user', content: 'Msg 1', attachments: [mockAtt], replies: { items: [] } }
    ] as any;

    const mockRevokeObjectURL = vi.fn();
    global.URL.revokeObjectURL = mockRevokeObjectURL;

    const wrapper = await mountModal();
    expect(wrapper.find('img').exists()).toBe(true);

    // Find the remove button (the one with the X icon)
    const removeAttButton = wrapper.find('.group\\/att button'); 
    await removeAttButton.trigger('click');
    await nextTick();

    expect(wrapper.find('img').exists()).toBe(false);
  });

  it('can paste images into a message', async () => {
    // Ensure there is at least one message to paste into
    mockActiveMessages.value = [{ id: '1', role: 'user', content: 'Msg 1', replies: { items: [] } }] as any;
    
    // Mock URL.createObjectURL
    const mockCreateObjectURL = vi.fn().mockReturnValue('blob:test');
    global.URL.createObjectURL = mockCreateObjectURL;

    const wrapper = await mountModal();
    // Use second textarea (the message one) as the first one is for System Prompt
    const textareas = wrapper.findAll('textarea');
    const messageTextarea = textareas[1];
    expect(messageTextarea?.exists()).toBe(true);

    const file = new File([''], 'test.png', { type: 'image/png' });
    
    // Trigger paste with mocked event
    await messageTextarea!.trigger('paste', {
      clipboardData: {
        items: [
          {
            type: 'image/png',
            getAsFile: () => file
          }
        ]
      }
    });
    
    await nextTick();

    // Check if attachment preview is rendered
    expect(wrapper.find('img').exists()).toBe(true);
    expect(wrapper.find('img').attributes('src')).toBe('blob:test');
  });
});
