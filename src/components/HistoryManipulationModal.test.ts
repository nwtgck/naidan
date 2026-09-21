import { toChatId, toMessageId, toAttachmentId, toBinaryObjectId, toToolCallId } from '@/01-models/ids';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mount, type VueWrapper } from '@vue/test-utils';
import { copyMessageWithoutReplies } from '@/logic/copy-message-node';
import HistoryManipulationModal from './HistoryManipulationModal.vue';
import { useCurrentChatState } from '@/composables/chat/ui/useCurrentChatState';
import { storageService } from '@/00-storage/service';
import { computed, nextTick, ref } from 'vue';
import { commitFullHistoryManipulationForChat } from '@/composables/chat/chat-scoped/chat-history-flow';
import { ensureAllStringsForTest } from '@/strings/test-utils';
import type { Attachment, Chat, MessageNode } from '@/01-models/types';
import { EMPTY_LM_PARAMETERS } from '@/01-models/types';
import { cloneLmParameters } from '@/utils/lm-parameters';
// Mock vuedraggable
vi.mock('vuedraggable', () => ({
  default: {
    name: 'draggable',
    template: '<div class="draggable-root"><slot name="item" v-for="(element, index) in modelValue" :element="element" :index="index"></slot></div>',
    props: ['modelValue', 'itemKey', 'handle'],
  },
}));
vi.mock('../composables/chat/ui/useCurrentChatState', () => ({
  useCurrentChatState: vi.fn(),
}));
vi.mock('../composables/chat/chat-scoped/chat-history-flow', () => ({
  commitFullHistoryManipulationForChat: vi.fn(),
}));
// Mock useLayout
vi.mock('../composables/useLayout', () => ({
  useLayout: () => ({
    setActiveFocusArea: vi.fn(),
  }),
}));
describe('HistoryManipulationModal', () => {
  const mockCommit = vi.fn();
  const wrappers: VueWrapper[] = [];
  const originalCreateObjectURL = URL.createObjectURL;
  const originalRevokeObjectURL = URL.revokeObjectURL;
  const originalGetFile = storageService.getFile;
  afterEach(() => {
    for (const wrapper of wrappers.splice(0)) wrapper.unmount();
    URL.createObjectURL = originalCreateObjectURL;
    URL.revokeObjectURL = originalRevokeObjectURL;
    storageService.getFile = originalGetFile;
  });
  const mockCurrentChat = ref<Chat>(chatFixture());
  const mockActiveMessages = ref<MessageNode[]>([
    messageFixture({ id: '1', role: 'user', content: 'Msg 1', attachments: undefined }),
    messageFixture({ id: '2', role: 'assistant', content: 'Msg 2', attachments: undefined }),
  ]);
  const mockInheritedSettings = ref({
    systemPromptMessages: ['Inherited Prompt'],
  });
  beforeEach(async () => {
    await ensureAllStringsForTest({ locale: 'en' });
    vi.clearAllMocks();
    mockCommit.mockReset();
    URL.createObjectURL = vi.fn(() => 'blob:history-preview');
    URL.revokeObjectURL = vi.fn();
    vi.mocked(useCurrentChatState).mockReturnValue({
      currentChatId: computed(() => toChatId({ raw: 'chat-1' })),
      currentChat: computed(() => mockCurrentChat.value),
      currentChatGroup: computed(() => null),
      activeMessages: computed(() => mockActiveMessages.value),
      resolvedSettings: computed(() => null),
      inheritedSettings: computed(() => mockInheritedSettings.value as any),
      chatGroups: computed(() => []),
      sidebarItems: computed(() => []),
      TEST_ONLY: {
        allMessages: computed(() => mockActiveMessages.value),
      },
    });
    vi.mocked(commitFullHistoryManipulationForChat).mockImplementation(mockCommit);
    mockActiveMessages.value = [
      messageFixture({ id: '1', role: 'user', content: 'Msg 1', attachments: undefined }),
      messageFixture({ id: '2', role: 'assistant', content: 'Msg 2', attachments: undefined }),
    ];
    mockCurrentChat.value = chatFixture();
  });
  const mountModal = async () => {
    const wrapper = mount(HistoryManipulationModal, {
      props: { isOpen: false },
      global: {
        stubs: {
          Transition: {
            template: '<div><slot /></div>',
          },
        },
      },
    });
    wrappers.push(wrapper);
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
    expect(mockCommit).toHaveBeenCalledWith({
      chatId: toChatId({ raw: 'chat-1' }),
      messages: [
        expect.objectContaining({ parts: [expect.objectContaining({ type: "text", text: 'Msg 2' })] }),
        expect.objectContaining({ parts: [expect.objectContaining({ type: "text", text: 'Msg 1' })] }),
      ],
      systemPrompt: undefined,
    });
  });
  it('calls commitFullHistoryManipulation on save', async () => {
    const wrapper = await mountModal();
    const messageTextareas = wrapper.findAll('textarea[placeholder="Type message content..."]');
    await messageTextareas[0]!.setValue('Updated Msg 1');
    const buttons = wrapper.findAll('button');
    const saveButton = buttons.find(b => b.text().includes('Apply Changes'));
    await saveButton?.trigger('click');
    expect(mockCommit).toHaveBeenCalledWith({
      chatId: toChatId({ raw: 'chat-1' }),
      messages: [
        expect.objectContaining({ parts: [expect.objectContaining({ type: "text", text: 'Updated Msg 1' })] }),
        expect.objectContaining({ parts: [expect.objectContaining({ type: "text", text: 'Msg 2' })] }),
      ],
      systemPrompt: undefined,
    });
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
    expect(mockCommit).toHaveBeenCalledWith({
      chatId: toChatId({ raw: 'chat-1' }),
      messages: [
        expect.objectContaining({ parts: [expect.objectContaining({ type: "text", text: 'Msg 1' })] }),
        expect.objectContaining({ parts: [expect.objectContaining({ type: "text", text: 'Msg 2' })] }),
      ],
      systemPrompt: { behavior: 'override', content: 'New System Prompt' },
    });
  });
  it('commits system prompt CLEAR behavior', async () => {
    const wrapper = await mountModal();
    const clearButton = wrapper.findAll('button').find(b => b.text().toLowerCase() === 'clear');
    await clearButton!.trigger('click');
    await nextTick();
    const saveButton = wrapper.findAll('button').find(b => b.text().includes('Apply Changes'));
    await saveButton?.trigger('click');
    expect(mockCommit).toHaveBeenCalledWith({
      chatId: toChatId({ raw: 'chat-1' }),
      messages: [
        expect.objectContaining({ parts: [expect.objectContaining({ type: "text", text: 'Msg 1' })] }),
        expect.objectContaining({ parts: [expect.objectContaining({ type: "text", text: 'Msg 2' })] }),
      ],
      systemPrompt: { behavior: 'override', content: null },
    });
  });
  it('commits system prompt INHERIT behavior', async () => {
    mockCurrentChat.value = { ...chatFixture(), systemPrompt: { behavior: 'override', content: 'Old' } };
    const wrapper = await mountModal();
    const inheritButton = wrapper.findAll('button').find(b => b.text().toLowerCase() === 'inherit');
    await inheritButton!.trigger('click');
    await nextTick();
    const saveButton = wrapper.findAll('button').find(b => b.text().includes('Apply Changes'));
    await saveButton?.trigger('click');
    expect(mockCommit).toHaveBeenCalledWith({
      chatId: toChatId({ raw: 'chat-1' }),
      messages: [
        expect.objectContaining({ parts: [expect.objectContaining({ type: "text", text: 'Msg 1' })] }),
        expect.objectContaining({ parts: [expect.objectContaining({ type: "text", text: 'Msg 2' })] }),
      ],
      systemPrompt: undefined,
    });
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
      messageFixture({ id: '1', role: 'user', content: 'U1', attachments: undefined }),
      messageFixture({ id: '2', role: 'assistant', content: 'A1', attachments: undefined }),
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
      messageFixture({ id: '1', role: 'user', content: 'U1', attachments: undefined }),
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
    const mockAtt: Attachment = { id: toAttachmentId({ raw: 'att-1' }), binaryObjectId: toBinaryObjectId({ raw: 'binary-1' }), status: 'persisted', originalName: 'test.png', mimeType: 'image/png', size: 100, uploadedAt: Date.now() };
    mockActiveMessages.value = [
      messageFixture({ id: '1', role: 'user', content: 'Msg 1', attachments: [mockAtt] }),
    ];
    const mockCreateObjectURL = vi.fn().mockReturnValue('blob:test-persisted');
    global.URL.createObjectURL = mockCreateObjectURL;
    // Manual mock for this test
    const mockGetFile = vi.fn().mockResolvedValue(new Blob([''], { type: 'image/png' }));
    storageService.getFile = mockGetFile;
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
      value: [file],
    });
    await fileInput.trigger('change');
    await nextTick();
    expect(wrapper.find('img').exists()).toBe(true);
    expect(wrapper.find('img').attributes('src')).toBe('blob:test-upload');
  });
  it('can remove attachments', async () => {
    const mockAtt: Attachment = { id: toAttachmentId({ raw: 'att-1' }), binaryObjectId: toBinaryObjectId({ raw: 'binary-1' }), status: 'memory', blob: new Blob(['']), originalName: 'test.png', mimeType: 'image/png', size: 100, uploadedAt: Date.now() };
    mockActiveMessages.value = [
      messageFixture({ id: '1', role: 'user', content: 'Msg 1', attachments: [mockAtt] }),
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
            getAsFile: () => file,
          },
        ],
      },
    });
    await nextTick();
    expect(wrapper.find('img').exists()).toBe(true);
  });
  it('keeps every selected part, tool result, timestamp and interruption on a no-op edit', async () => {
    const assistant: MessageNode = {
      ...messageFixture({ id: '2', role: 'assistant', content: '', attachments: undefined }),
      role: 'assistant', createdAt: 0,
      interruption: { type: 'error', message: '保存された日本語' },
      parts: [
        { id: 'r1', type: 'reasoning', text: '  R\n', completeness: 'complete' },
        { id: 'empty', type: 'text', text: '', completeness: 'complete' },
        { id: 'body', type: 'text', text: '<think>literal</think>A ', completeness: 'partial' },
        { id: 'call', type: 'tool_call', toolCall: { id: toToolCallId({ raw: 'call-1' }), type: 'function', function: { name: 'f', arguments: '{ "x": 1 }' } } },
      ],
    };
    const tool: MessageNode = { id: toMessageId({ raw: 'tool' }), role: 'tool', createdAt: 3, modelId: undefined, lmParameters: undefined, parts: [{ id: 'result', type: 'tool_result', result: { toolCallId: toToolCallId({ raw: 'call-1' }), status: 'success', content: { type: 'text', text: '  done\n' } } }], replies: { items: [] } };
    mockActiveMessages.value = [mockActiveMessages.value[0]!, assistant, tool];
    const original = mockActiveMessages.value.map(message => copyMessageWithoutReplies({ message }));
    const wrapper = await mountModal();
    expect(wrapper.findAll('[data-testid="role-label"]').map(label => label.text())).toEqual(['User', 'Assistant', 'Tool']);
    expect(wrapper.findAll('[data-testid="history-parts"]')).toHaveLength(3);
    const callElement = wrapper.get('[data-testid="history-part-call"]');
    expect(callElement.text()).toContain('tool_call');
    const roleButtons = wrapper.findAll('button[title="Switch Role"]');
    expect(roleButtons[1]!.attributes('disabled')).toBeDefined();
    expect(roleButtons[2]!.attributes('disabled')).toBeDefined();
    expect(wrapper.findAll('button[title="Copy Message"]')[1]!.attributes('disabled')).toBeDefined();
    await wrapper.findAll('button').find(button => button.text().includes('Apply Changes'))!.trigger('click');
    expect(mockCommit.mock.calls[0]![0].messages).toEqual(original);
    expect(mockActiveMessages.value.map(message => copyMessageWithoutReplies({ message }))).toEqual(original);
  });
  it('edits each text part without folding reasoning, trimming text, or promoting partial', async () => {
    mockActiveMessages.value = [{
      ...messageFixture({ id: '2', role: 'assistant', content: '', attachments: undefined }), role: 'assistant',
      interruption: { type: 'cancelled' },
      parts: [
        { id: 'r', type: 'reasoning', text: 'R', completeness: 'complete' },
        { id: 'a', type: 'text', text: 'first', completeness: 'complete' },
        { id: 'b', type: 'text', text: 'second', completeness: 'partial' },
      ],
    }];
    const wrapper = await mountModal();
    const textareas = wrapper.findAll('textarea[placeholder="Type message content..."]');
    expect(textareas).toHaveLength(2);
    const edited = `\
  <think>literal edit</think>\\r
🙂`;
    await textareas[1]!.setValue(edited);
    await wrapper.findAll('button').find(button => button.text().includes('Apply Changes'))!.trigger('click');
    const saved = mockCommit.mock.calls[0]![0].messages[0];
    expect(saved.parts).toEqual([
      { id: 'r', type: 'reasoning', text: 'R', completeness: 'complete' },
      { id: 'a', type: 'text', text: 'first', completeness: 'complete' },
      // HTML textareas normalize CRLF on input; the application does not trim the resulting value.
      { id: 'b', type: 'text', text: edited.replace('\r\n', '\n'), completeness: 'partial' },
    ]);
    expect(saved.interruption).toEqual({ type: 'cancelled' });
    expect(mockActiveMessages.value[0]!.parts[2]).toMatchObject({ text: 'second' });
  });
  it('duplicates independent parts and leaves attachments on users with role switching disabled', async () => {
    const attachment: Attachment = { id: toAttachmentId({ raw: 'att' }), binaryObjectId: toBinaryObjectId({ raw: 'bin' }), originalName: 'x.png', mimeType: 'image/png', size: 1, uploadedAt: 1, status: 'memory', blob: new Blob(['x']) };
    mockActiveMessages.value = [messageFixture({ id: '1', role: 'user', content: 'A', attachments: [attachment] })];
    const wrapper = await mountModal();
    expect(wrapper.find('button[title="Switch Role"]').attributes('disabled')).toBeDefined();
    await wrapper.find('button[title="Copy Message"]').trigger('click');
    const areas = wrapper.findAll('textarea[placeholder="Type message content..."]');
    await areas[1]!.setValue('B');
    await wrapper.findAll('[data-testid="remove-history-attachment"]')[1]!.trigger('click');
    await wrapper.findAll('button').find(button => button.text().includes('Apply Changes'))!.trigger('click');
    const saved = mockCommit.mock.calls[0]![0].messages;
    expect(saved[0].parts).toHaveLength(2); expect(saved[1].parts).toHaveLength(1);
    expect(saved[0].parts[0].text).toBe('A'); expect(saved[1].parts[0].text).toBe('B');
    expect(mockActiveMessages.value[0]!.parts).toHaveLength(2);
  });
  it('saves to the chat whose draft was opened rather than the newly selected chat', async () => {
    const wrapper = await mountModal();
    mockCurrentChat.value = { ...chatFixture(), id: toChatId({ raw: 'other-chat' }) };
    await wrapper.findAll('button').find(button => button.text().includes('Apply Changes'))!.trigger('click');
    expect(mockCommit.mock.calls[0]![0].chatId).toEqual(toChatId({ raw: 'chat-1' }));
  });
  it('does not close a reopened dialog when an earlier save settles', async () => {
    let finish!: () => void;
    mockCommit.mockImplementationOnce(() => new Promise<void>(resolve => {
      finish = resolve;
    }));
    const wrapper = await mountModal();
    await wrapper.findAll('button').find(button => button.text().includes('Apply Changes'))!.trigger('click');
    expect(wrapper.find('[inert]').exists()).toBe(true);
    await wrapper.setProps({ isOpen: false }); await wrapper.setProps({ isOpen: true });
    finish(); await nextTick(); await nextTick();
    expect(wrapper.emitted('close')).toBeUndefined();
  });
  it('does not publish or leak a persisted preview after removal and unmount', async () => {
    let finish!: (blob: Blob) => void;
    storageService.getFile = vi.fn(() => new Promise<Blob>(resolve => {
      finish = resolve;
    }));
    const attachment: Attachment = { id: toAttachmentId({ raw: 'att' }), binaryObjectId: toBinaryObjectId({ raw: 'bin' }), originalName: 'x.png', mimeType: 'image/png', size: 1, uploadedAt: 1, status: 'persisted' };
    mockActiveMessages.value = [messageFixture({ id: '1', role: 'user', content: 'A', attachments: [attachment] })];
    const wrapper = await mountModal();
    await wrapper.get('[data-testid="remove-history-attachment"]').trigger('click');
    wrapper.unmount();
    finish(new Blob(['x'])); await nextTick(); await nextTick();
    expect(URL.createObjectURL).not.toHaveBeenCalled();
  });
  it('keeps attachment actions visible but prevents attaching media to assistant or tool rows', async () => {
    const wrapper = await mountModal();
    expect(wrapper.findAll('[data-testid="history-attach-media"]')[1]!.attributes('disabled')).toBeDefined();
    await wrapper.findAll('textarea[placeholder="Type message content..."]')[1]!.trigger('paste', { clipboardData: { items: [{ type: 'image/png', getAsFile: () => new File(['x'], 'x.png', { type: 'image/png' }) }] } });
    expect(wrapper.findAll('img')).toHaveLength(0);
  });

});

function messageFixture({ id, role, content, attachments }: { id: string; role: 'user' | 'assistant'; content: string; attachments: Attachment[] | undefined }): MessageNode {
  const common = { id: toMessageId({ raw: id }), createdAt: 1, replies: { items: [] }, modelId: undefined, lmParameters: cloneLmParameters({ lmParameters: EMPTY_LM_PARAMETERS }) };
  const body = { id: 'text', type: 'text', text: content, completeness: 'complete' } as const;
  switch (role) {
  case 'user': return { ...common, role, parts: [body, ...(attachments ?? []).map((attachment,index) => ({ id: 'attachment_' + index, type: 'attachment' as const, attachment }))] };
  case 'assistant': return { ...common, role, parts: [body], interruption: undefined };
  default: { const _ex: never = role; throw new Error('Unexpected role: ' + _ex); }
  }
}
function chatFixture(): Chat {
  return { id: toChatId({ raw: 'chat-1' }), title: 'Chat', createdAt: 1, updatedAt: 1, root: { items: [] }, currentLeafId: undefined, systemPrompt: undefined, debugEnabled: false };
}
