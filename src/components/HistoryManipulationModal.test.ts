import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mount } from '@vue/test-utils';
import HistoryManipulationModal from './HistoryManipulationModal.vue';
import { useChat } from '../composables/useChat';
import { storageService } from '../services/storage';
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
  const mockCurrentChat = ref({ id: 'chat-1', systemPrompt: undefined });
  const mockActiveMessages = ref([
    { id: '1', role: 'user', content: 'Msg 1', replies: { items: [] } },
    { id: '2', role: 'assistant', content: 'Msg 2', replies: { items: [] } }
  ] as any);
  const mockInheritedSettings = ref({
    systemPromptMessages: ['Inherited Prompt']
  });

  beforeEach(() => {
    vi.clearAllMocks();
    (useChat as any).mockReturnValue({
      currentChat: mockCurrentChat,
      activeMessages: mockActiveMessages,
      inheritedSettings: mockInheritedSettings,
      commitFullHistoryManipulation: mockCommit
    });
    mockActiveMessages.value = [
      { id: '1', role: 'user', content: 'Msg 1', replies: { items: [] } },
      { id: '2', role: 'assistant', content: 'Msg 2', replies: { items: [] } }
    ];
    mockCurrentChat.value = { id: 'chat-1', systemPrompt: undefined };
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
    
    // System prompt textarea might not be present if behavior is 'inherit' (it shows info div)
    // In our component, if behavior is 'inherit', it shows a div. 
    // So there should be as many textareas as messages.
    const messageTextareas = wrapper.findAll('textarea[placeholder="Type message content..."]');
    expect(messageTextareas.length).toBe(2);
    expect((messageTextareas[0]!.element as HTMLTextAreaElement).value).toBe('Msg 1');
    expect((messageTextareas[1]!.element as HTMLTextAreaElement).value).toBe('Msg 2');
  });

  it('can add and remove messages', async () => {
    const wrapper = await mountModal();

    // Add message after first one
    const addButtons = wrapper.findAll('button[title="Add Message After"]');
    await addButtons[0]!.trigger('click');
    await nextTick();
    
    let messageTextareas = wrapper.findAll('textarea[placeholder="Type message content..."]');
    expect(messageTextareas.length).toBe(3);

    // Remove first message
    const removeButtons = wrapper.findAll('button[title="Remove Message"]');
    await removeButtons[0]!.trigger('click');
    await nextTick();

    messageTextareas = wrapper.findAll('textarea[placeholder="Type message content..."]');
    expect(messageTextareas.length).toBe(2);
    expect((messageTextareas[0]!.element as HTMLTextAreaElement).value).toBe(''); 
  });

  it('can duplicate messages', async () => {
    const wrapper = await mountModal();

    const duplicateButton = wrapper.find('button[title="Copy Message"]');
    await duplicateButton.trigger('click');
    await nextTick();

    const messageTextareas = wrapper.findAll('textarea[placeholder="Type message content..."]');
    expect(messageTextareas.length).toBe(3);
    expect((messageTextareas[0]!.element as HTMLTextAreaElement).value).toBe('Msg 1');
    expect((messageTextareas[1]!.element as HTMLTextAreaElement).value).toBe('Msg 1');
  });

  it('switches roles when clicking role button', async () => {
    const wrapper = await mountModal();

    const roleButtons = wrapper.findAll('button[title^="Switch Role"]');
    
    // First message is 'user', click to change to 'assistant'
    await roleButtons[0]!.trigger('click');
    await nextTick();
    expect(wrapper.find('.bg-purple-50').exists()).toBe(true); 
    
    // Click again to change back to 'user'
    await roleButtons[0]!.trigger('click');
    await nextTick();
    expect(wrapper.find('.bg-blue-50').exists()).toBe(true); 
  });

  it('configures draggable correctly and updates order', async () => {
    const wrapper = await mountModal();

    const draggable = wrapper.findComponent({ name: 'draggable' });
    expect(draggable.exists()).toBe(true);
    expect(draggable.props('handle')).toBe('.handle');
    expect(draggable.props('itemKey')).toBe('localId');

    // Simulate drag start
    await draggable.vm.$emit('start');
    await nextTick();
    // In new UI, we use :class="['space-y-6', isDragging ? 'pb-40' : 'pb-8']"
    expect(wrapper.find('.pb-40').exists()).toBe(true);

    // Simulate reordering: swap Msg 1 and Msg 2
    const currentList = draggable.props('modelValue');
    const newList = [currentList[1], currentList[0]];
    await draggable.vm.$emit('update:modelValue', newList);
    await nextTick();

    // Verify DOM reflects new order
    const messageTextareas = wrapper.findAll('textarea[placeholder="Type message content..."]');
    expect((messageTextareas[0]!.element as HTMLTextAreaElement).value).toBe('Msg 2');
    expect((messageTextareas[1]!.element as HTMLTextAreaElement).value).toBe('Msg 1');

    // Simulate drag end
    await draggable.vm.$emit('end');
    await nextTick();
    expect(wrapper.find('.pb-40').exists()).toBe(false);
  });

  it('preserves new order when committing changes after drag-and-drop reordering', async () => {
    const wrapper = await mountModal();

    const draggable = wrapper.findComponent({ name: 'draggable' });
    const currentList = draggable.props('modelValue');
    const newList = [currentList[1], currentList[0]];
    await draggable.vm.$emit('update:modelValue', newList);
    await nextTick();

    // Click Apply Changes
    const buttons = wrapper.findAll('button');
    const saveButton = buttons.find(b => b.text().includes('Apply Changes'));
    await saveButton?.trigger('click');

    expect(mockCommit).toHaveBeenCalledWith('chat-1', [
      expect.objectContaining({ content: 'Msg 2' }),
      expect.objectContaining({ content: 'Msg 1' })
    ], undefined);
  });

  it('calls commitFullHistoryManipulation on save', async () => {
    const wrapper = await mountModal();

    const messageTextareas = wrapper.findAll('textarea[placeholder="Type message content..."]');
    await messageTextareas[0]!.setValue('Updated Msg 1');

    const buttons = wrapper.findAll('button');
    const saveButton = buttons.find(b => b.text().includes('Apply Changes'));
    await saveButton?.trigger('click');

    expect(mockCommit).toHaveBeenCalledWith('chat-1', [
      expect.objectContaining({ content: 'Updated Msg 1' }),
      expect.objectContaining({ content: 'Msg 2' })
    ], undefined);
    expect(wrapper.emitted().close).toBeTruthy();
  });

  it('commits system prompt changes', async () => {
    const wrapper = await mountModal();

    // 1. Select 'override'
    const overrideButton = wrapper.findAll('button').find(b => b.text().toLowerCase() === 'override');
    await overrideButton!.trigger('click');
    await nextTick();

    // 2. Set content
    const sysTextarea = wrapper.find('textarea[placeholder="Enter system prompt content..."]');
    await sysTextarea.setValue('New System Prompt');

    // 3. Save
    const saveButton = wrapper.findAll('button').find(b => b.text().includes('Apply Changes'));
    await saveButton?.trigger('click');

    expect(mockCommit).toHaveBeenCalledWith('chat-1', [
      expect.objectContaining({ content: 'Msg 1' }),
      expect.objectContaining({ content: 'Msg 2' })
    ], { behavior: 'override', content: 'New System Prompt' });
  });

  it('commits system prompt CLEAR behavior', async () => {
    const wrapper = await mountModal();

    const clearButton = wrapper.findAll('button').find(b => b.text().toLowerCase() === 'clear');
    await clearButton!.trigger('click');
    await nextTick();

    const saveButton = wrapper.findAll('button').find(b => b.text().includes('Apply Changes'));
    await saveButton?.trigger('click');

    expect(mockCommit).toHaveBeenCalledWith('chat-1', [
      expect.objectContaining({ content: 'Msg 1' }),
      expect.objectContaining({ content: 'Msg 2' })
    ], { behavior: 'override', content: null });
  });

  it('commits system prompt INHERIT behavior', async () => {
    mockCurrentChat.value = { id: 'chat-1', systemPrompt: { behavior: 'override', content: 'Old' } } as any;
    const wrapper = await mountModal();

    const inheritButton = wrapper.findAll('button').find(b => b.text().toLowerCase() === 'inherit');
    await inheritButton!.trigger('click');
    await nextTick();

    const saveButton = wrapper.findAll('button').find(b => b.text().includes('Apply Changes'));
    await saveButton?.trigger('click');

    expect(mockCommit).toHaveBeenCalledWith('chat-1', [
      expect.objectContaining({ content: 'Msg 1' }),
      expect.objectContaining({ content: 'Msg 2' })
    ], undefined);
  });

  it('emits close on discard', async () => {
    const wrapper = await mountModal();

    const buttons = wrapper.findAll('button');
    const discardButton = buttons.find(b => b.text().includes('Discard'));
    await discardButton?.trigger('click');
    expect(wrapper.emitted().close).toBeTruthy();
  });

  it('renders empty state when no messages and can add first message', async () => {
    mockActiveMessages.value = [];
    const wrapper = await mountModal();

    expect(wrapper.text()).toContain('Forge empty history');
    
    const addButton = wrapper.find('button:has(.lucide-plus)');
    await addButton.trigger('click');
    await nextTick();

    const messageTextareas = wrapper.findAll('textarea[placeholder="Type message content..."]');
    expect(messageTextareas.length).toBe(1);
    expect((messageTextareas[0]!.element as HTMLTextAreaElement).value).toBe('');
    expect(wrapper.find('[data-testid="role-label"]').text()).toBe('User');
  });

  it('predicts roles correctly when inserting messages (alternating role heuristic)', async () => {
    mockActiveMessages.value = [
      { id: '1', role: 'user', content: 'U1', replies: { items: [] } },
      { id: '2', role: 'assistant', content: 'A1', replies: { items: [] } }
    ];
    const wrapper = await mountModal();

    const addButtons = wrapper.findAll('button[title="Add Message After"]');
    await addButtons[0]!.trigger('click');
    await nextTick();
    
    let labels = wrapper.findAll('[data-testid="role-label"]');
    expect(labels[1]!.text()).toBe('Assistant');

    const newAddButtons = wrapper.findAll('button[title="Add Message After"]');
    await newAddButtons[2]!.trigger('click'); 
    await nextTick();
    
    labels = wrapper.findAll('[data-testid="role-label"]');
    expect(labels[3]!.text()).toBe('User');
  });

  it('predicts role correctly when inserting at the beginning', async () => {
    mockActiveMessages.value = [
      { id: '1', role: 'user', content: 'U1', replies: { items: [] } }
    ];
    const wrapper = await mountModal();

    const buttons = wrapper.findAll('button');
    const appendButton = buttons.find(b => b.text().includes('Append Message'));
    await appendButton!.trigger('click');
    await nextTick();

    const labels = wrapper.findAll('[data-testid="role-label"]');
    expect(labels[1]!.text()).toBe('Assistant'); 
  });

  it('loads existing attachments and shows previews', async () => {
    const mockAtt = { id: 'att-1', status: 'persisted', originalName: 'test.png', mimeType: 'image/png', size: 100, uploadedAt: Date.now() };
    mockActiveMessages.value = [
      { id: '1', role: 'user', content: 'Msg 1', attachments: [mockAtt], replies: { items: [] } }
    ];

    const mockCreateObjectURL = vi.fn().mockReturnValue('blob:test-persisted');
    global.URL.createObjectURL = mockCreateObjectURL;
    
    // Manual mock for this test
    const mockGetFile = vi.fn().mockResolvedValue(new Blob([''], { type: 'image/png' }));
    (storageService.getFile as any) = mockGetFile;

    const wrapper = await mountModal();
    
    expect(wrapper.find('img').exists()).toBe(true);
    expect(wrapper.find('img').attributes('src')).toBe('blob:test-persisted');
  });

  it('can add attachments via file input', async () => {
    const mockCreateObjectURL = vi.fn().mockReturnValue('blob:test-upload');
    global.URL.createObjectURL = mockCreateObjectURL;

    const wrapper = await mountModal();
    
    const fileInput = wrapper.find('input[type="file"]');
    const file = new File([''], 'test.png', { type: 'image/png' });
    
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
    ];

    const mockRevokeObjectURL = vi.fn();
    global.URL.revokeObjectURL = mockRevokeObjectURL;

    const wrapper = await mountModal();
    expect(wrapper.find('img').exists()).toBe(true);

    const removeAttButton = wrapper.find('.group\\/att button'); 
    await removeAttButton.trigger('click');
    await nextTick();

    expect(wrapper.find('img').exists()).toBe(false);
  });

  it('can paste images into a message', async () => {
    const mockCreateObjectURL = vi.fn().mockReturnValue('blob:test');
    global.URL.createObjectURL = mockCreateObjectURL;

    const wrapper = await mountModal();
    const messageTextareas = wrapper.findAll('textarea[placeholder="Type message content..."]');
    const messageTextarea = messageTextareas[0];

    const file = new File([''], 'test.png', { type: 'image/png' });
    
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
    expect(wrapper.find('img').exists()).toBe(true);
  });
});