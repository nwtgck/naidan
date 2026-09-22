import { describe, it, expect, vi, beforeEach } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import ChatDebugInspector from './ChatDebugInspector.vue';
import ChatDebugTreeNode from './ChatDebugTreeNode.vue';
import { nextTick } from 'vue';
import { NetworkIcon } from 'lucide-vue-next';
import type { MessageNode, Chat, Attachment, LmParameters } from '@/01-models/types';
import { idToRaw, toAttachmentId, toBinaryObjectId, toChatId, toMessageId } from '@/01-models/ids';
import { ensureAllStringsForTest } from '@/strings/test-utils';

// Mock Lucide icons
vi.mock('lucide-vue-next', () => ({
  BugIcon: { template: '<span>Bug</span>' },
  XIcon: { template: '<span>X</span>' },
  MessageSquareIcon: { template: '<span>MessageSquare</span>' },
  NetworkIcon: { template: '<span>Network</span>' },
  FileCodeIcon: { template: '<span>FileCode</span>' },
  HighlighterIcon: { template: '<span>Highlighter</span>' },
  ZapOffIcon: { template: '<span>ZapOff</span>' },
  ChevronLeftIcon: { template: '<span>ChevronLeft</span>' },
  ChevronRightIcon: { template: '<span>ChevronRight</span>' },
  ChevronDownIcon: { template: '<span>ChevronDown</span>' },
  CopyIcon: { template: '<span>Copy</span>' },
  CheckIcon: { template: '<span>Check</span>' },
  ImageIcon: { template: '<span>Image</span>' },
  FileIcon: { template: '<span>File</span>' },
  CpuIcon: { template: '<span>Cpu</span>' },
  FingerprintIcon: { template: '<span>Fingerprint</span>' },
  EyeIcon: { template: '<span>Eye</span>' },
  EyeOffIcon: { template: '<span>EyeOff</span>' },
  CornerUpRightIcon: { template: '<span>CornerUpRight</span>' },
  ZoomInIcon: { template: '<span>ZoomIn</span>' },
  ZoomOutIcon: { template: '<span>ZoomOut</span>' },
  RefreshCwIcon: { template: '<span>RefreshCw</span>' },
  CalendarIcon: { template: '<span>Calendar</span>' },
  InfoIcon: { template: '<span>Info</span>' },
  DownloadIcon: { template: '<span>Download</span>' },
  Trash2Icon: { template: '<span>Trash2</span>' },
}));

const mockAddErrorEvent = vi.hoisted(() => vi.fn());

vi.mock('@/composables/useGlobalEvents', () => ({
  useGlobalEvents: () => ({
    addErrorEvent: mockAddErrorEvent,
  }),
}));

const mockPush = vi.fn();
vi.mock('vue-router', () => ({
  useRouter: () => ({
    push: mockPush,
    currentRoute: { value: { query: {} } },
  }),
}));

vi.mock('../00-storage/service', () => ({
  storageService: {
    getBinaryObject: vi.fn(),
    getFile: vi.fn().mockResolvedValue(new Blob()),
  },
}));

const mockSettings = vi.hoisted(() => ({
  value: {
    experimental: {
      fakeLm: 'disabled',
    },
  },
}));

vi.mock('@/composables/useSettings', () => ({
  useSettings: () => ({
    settings: mockSettings,
  }),
}));

vi.mock('@/features/fake-lm', () => ({
  FAKE_LM_ENDPOINT_URL: 'https://fake-lm.invalid',
  useFakeLmDebugMode: () => ({
    fakeLmDebugModeAvailability: { value: 'available' },
  }),
}));

// Mock Clipboard
Object.assign(navigator, {
  clipboard: {
    writeText: vi.fn().mockResolvedValue(undefined),
  },
});

describe('ChatDebugInspector - Comprehensive Tree & Feature Tests', () => {
  const createNode = ({ id, role, content, replies, extra }: {
    id: string;
    role: 'user' | 'assistant' | 'system';
    content: string;
    replies: MessageNode[];
    extra: { modelId?: string; thinking?: string; error?: string; attachments?: Attachment[]; lmParameters?: LmParameters };
  }): MessageNode => {
    const common = { id: toMessageId({ raw: id }), createdAt: Date.now(), replies: { items: replies } };
    const body = { type: 'text', text: content, completeness: 'complete' } as const;
    switch (role) {
    case 'user': return { ...common, role, modelId: undefined, lmParameters: extra.lmParameters,
      parts: [body, ...(extra.attachments ?? []).map((attachment) => ({ type: 'attachment' as const, attachment }))] };
    case 'assistant': return { ...common, role, modelId: extra.modelId, lmParameters: extra.lmParameters,
      parts: [...(extra.thinking === undefined ? [] : [{ type: 'reasoning' as const, text: extra.thinking, completeness: 'complete' as const }]), body],
      interruption: extra.error === undefined ? undefined : { type: 'error', message: extra.error } };
    case 'system': return { ...common, role, modelId: undefined, lmParameters: undefined, parts: [body] };
    default: { const unhandled: never = role; throw new Error(`Unhandled role: ${unhandled}`); }
    }
  };

  const createMockChat = (rootItems: MessageNode[] = []): Chat => ({
    id: toChatId({ raw: 'chat-1' }),
    title: 'Test Chat',
    root: { items: rootItems },
    debugEnabled: true,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  });

  const mountInspector = (chat: Chat, activeMessages: MessageNode[] = []) => {
    return mount(ChatDebugInspector, {
      props: {
        show: true,
        chat,
        activeMessages,
      },
    });
  };

  beforeEach(async () => {
    await ensureAllStringsForTest({ locale: 'en' });
    vi.clearAllMocks();
  });

  it('emits a fake LM setup event from the header shortcut', async () => {
    const chat = createMockChat([]);
    const wrapper = mountInspector(chat, []);

    const button = wrapper.find('[data-testid="chat-inspector-enable-fake-lm"]');

    expect(button.exists()).toBe(true);
    expect(button.attributes('disabled')).toBeUndefined();

    await button.trigger('click');

    expect(wrapper.emitted('enable-fake-lm')).toHaveLength(1);
  });

  it('Scenario 1: Pure Linear Path (A -> B -> C)', async () => {
    const chat = createMockChat([
      createNode({ id: 'A', role: 'user', content: 'A', replies: [
        createNode({ id: 'B', role: 'assistant', content: 'B', replies: [
          createNode({ id: 'C', role: 'user', content: 'C', replies: [], extra: {} }),
        ], extra: {} }),
      ], extra: {} }),
    ]);

    const wrapper = mountInspector(chat);
    await wrapper.get('[data-testid="chat-inspector-mode-tree"]').trigger('click');
    await nextTick();

    const treeNodes = wrapper.findAllComponents(ChatDebugTreeNode);
    const linearContainers = wrapper.findAll('.ml-0');
    expect(linearContainers.length).toBeGreaterThanOrEqual(2);

    const nodeB = treeNodes.find(n => idToRaw({ id: n.props().node.id }) === 'B');
    const nodeC = treeNodes.find(n => idToRaw({ id: n.props().node.id }) === 'C');

    expect(nodeB?.props().hasLinearParent).toBe(true);
    expect(nodeC?.props().hasLinearParent).toBe(true);
    expect(nodeB?.find('.h-px').exists()).toBe(false);
  });

  it('Scenario 2: Root Branching ([A, B])', async () => {
    const chat = createMockChat([
      createNode({ id: 'A', role: 'user', content: 'A', replies: [], extra: {} }),
      createNode({ id: 'B', role: 'user', content: 'B', replies: [], extra: {} }),
    ]);

    const wrapper = mountInspector(chat);
    await wrapper.get('[data-testid="chat-inspector-mode-tree"]').trigger('click');
    await nextTick();

    const treeNodes = wrapper.findAllComponents(ChatDebugTreeNode);
    const nodeA = treeNodes.find(n => idToRaw({ id: n.props().node.id }) === 'A');
    const nodeB = treeNodes.find(n => idToRaw({ id: n.props().node.id }) === 'B');

    expect(nodeA?.find('.absolute.left-\\[-24px\\]').exists()).toBe(true);
    expect(nodeB?.find('.absolute.left-\\[-24px\\]').exists()).toBe(true);
    expect(nodeB?.find('.h-4').exists()).toBe(true);
  });

  it('Scenario 3: Branching followed by Linear (A -> [B -> D, C])', async () => {
    const chat = createMockChat([
      createNode({ id: 'A', role: 'user', content: 'A', replies: [
        createNode({ id: 'B', role: 'assistant', content: 'B', replies: [
          createNode({ id: 'D', role: 'user', content: 'D', replies: [], extra: {} }),
        ], extra: {} }),
        createNode({ id: 'C', role: 'assistant', content: 'C', replies: [], extra: {} }),
      ], extra: {} }),
    ]);

    const wrapper = mountInspector(chat);
    await wrapper.get('[data-testid="chat-inspector-mode-tree"]').trigger('click');
    await nextTick();

    const treeNodes = wrapper.findAllComponents(ChatDebugTreeNode);
    const nodeB = treeNodes.find(n => idToRaw({ id: n.props().node.id }) === 'B');
    const nodeD = treeNodes.find(n => idToRaw({ id: n.props().node.id }) === 'D');

    expect(nodeB?.find('.h-px').exists()).toBe(true);
    expect(nodeD?.find('.h-px').exists()).toBe(false);
    expect(nodeD?.props().hasLinearParent).toBe(true);
  });

  it('Scenario 4: Detail Panel Full Context Path', async () => {
    const chat = createMockChat([
      createNode({ id: 'A', role: 'user', content: 'A', replies: [
        createNode({ id: 'B', role: 'assistant', content: 'B', replies: [
          createNode({ id: 'C', role: 'user', content: 'C', replies: [], extra: {} }),
        ], extra: {} }),
      ], extra: {} }),
    ]);

    const wrapper = mountInspector(chat);
    await wrapper.get('[data-testid="chat-inspector-mode-tree"]').trigger('click');
    await nextTick();

    // Select node C
    const treeNodes = wrapper.findAllComponents(ChatDebugTreeNode);
    const nodeC = treeNodes.find(n => idToRaw({ id: n.props().node.id }) === 'C');
    await nodeC?.vm.$emit('select-node', nodeC.props().node);
    await nextTick();

    const detailPanel = wrapper.find('.flex-1.overflow-y-auto.p-8');
    const detailNodes = detailPanel.findAllComponents(ChatDebugTreeNode);

    expect(detailNodes.length).toBe(3);
    expect(idToRaw({ id: detailNodes[0].props().node.id })).toBe('A');
    expect(idToRaw({ id: detailNodes[1].props().node.id })).toBe('B');
    expect(idToRaw({ id: detailNodes[2].props().node.id })).toBe('C');
  });

  it('Scenario 5: Tree Map Collapsibility', async () => {
    const chat = createMockChat([createNode({ id: 'A', role: 'user', content: 'A', replies: [], extra: {} })]);
    const wrapper = mountInspector(chat);
    await wrapper.get('[data-testid="chat-inspector-mode-tree"]').trigger('click');
    await nextTick();

    const treeMapContainer = wrapper.find('.relative.overflow-y-auto.border-r');
    expect(treeMapContainer.classes()).toContain('w-[45%]');

    await treeMapContainer.find('button').trigger('click');
    await nextTick();

    expect(treeMapContainer.classes()).toContain('w-12');
  });

  it('Scenario 6: JSON Highlighting Toggle', async () => {
    const chat = createMockChat([createNode({ id: 'A', role: 'user', content: 'A', replies: [], extra: {} })]);
    const wrapper = mountInspector(chat);

    await wrapper.get('[data-testid="chat-inspector-mode-raw"]').trigger('click');
    await nextTick();

    const pre = wrapper.find('pre');
    expect(pre.html()).toContain('class="text-red-500');

    const toggleBtn = wrapper.find('button[title="Toggle Highlighting"]');
    await toggleBtn.trigger('click');
    await nextTick();

    expect(pre.html()).not.toContain('class="text-red-500');
  });

  it('copies the currently displayed full chat JSON', async () => {
    const nodeA = createNode({ id: 'A', role: 'user', content: 'A', replies: [], extra: {} });
    const chat = createMockChat([nodeA]);
    const wrapper = mountInspector(chat, [nodeA]);

    await wrapper.get('[data-testid="chat-inspector-mode-raw"]').trigger('click');
    await nextTick();
    await wrapper.get('[data-testid="copy-raw-json"]').trigger('click');

    expect(navigator.clipboard.writeText).toHaveBeenCalledWith(JSON.stringify(chat, null, 2));
  });

  it('shows and copies only the active branch in current-thread JSON scope', async () => {
    const nodeC = createNode({ id: 'C', role: 'assistant', content: 'C', replies: [], extra: {} });
    const nodeB = createNode({ id: 'B', role: 'user', content: 'B', replies: [nodeC], extra: {} });
    const sibling = createNode({ id: 'X', role: 'user', content: 'sibling', replies: [], extra: {} });
    const nodeA = createNode({ id: 'A', role: 'assistant', content: 'A', replies: [nodeB, sibling], extra: {} });
    const chat = createMockChat([nodeA]);
    chat.currentLeafId = nodeC.id;
    const originalChatJson = JSON.stringify(chat);
    const activeMessages = [nodeA, nodeB, nodeC];
    const wrapper = mountInspector(chat, activeMessages);

    await wrapper.get('[data-testid="chat-inspector-mode-raw"]').trigger('click');
    await nextTick();
    await wrapper.get('[data-testid="raw-json-scope-current-thread"]').trigger('click');
    await nextTick();

    const displayed = JSON.parse(wrapper.get('[data-testid="raw-json-output"]').text());
    expect(displayed.id).toBe('chat-1');
    expect(displayed.currentLeafId).toBe('C');
    expect(displayed.root.items).toHaveLength(1);
    expect(displayed.root.items[0].id).toBe('A');
    expect(displayed.root.items[0].replies.items).toHaveLength(1);
    expect(displayed.root.items[0].replies.items[0].id).toBe('B');
    expect(displayed.root.items[0].replies.items[0].replies.items).toHaveLength(1);
    expect(displayed.root.items[0].replies.items[0].replies.items[0].id).toBe('C');
    expect(displayed.root.items[0].replies.items[0].replies.items[0].replies.items).toEqual([]);
    expect(JSON.stringify(displayed)).not.toContain('sibling');
    expect(JSON.stringify(chat)).toBe(originalChatJson);

    await wrapper.get('[data-testid="copy-raw-json"]').trigger('click');
    const copied = vi.mocked(navigator.clipboard.writeText).mock.calls.at(-1)?.[0];
    expect(copied).toBe(wrapper.get('[data-testid="raw-json-output"]').text());
  });

  it('keeps copy feedback scoped to the latest JSON copy request', async () => {
    vi.useFakeTimers();
    try {
      const nodeA = createNode({ id: 'A', role: 'user', content: 'A', replies: [], extra: {} });
      const chat = createMockChat([nodeA]);
      chat.currentLeafId = nodeA.id;
      const wrapper = mountInspector(chat, [nodeA]);

      await wrapper.get('[data-testid="chat-inspector-mode-raw"]').trigger('click');
      await nextTick();

      const copyButton = wrapper.get('[data-testid="copy-raw-json"]');
      await copyButton.trigger('click');
      await flushPromises();
      expect(copyButton.text()).toContain('Check');

      vi.advanceTimersByTime(1000);
      await wrapper.get('[data-testid="raw-json-scope-current-thread"]').trigger('click');
      await nextTick();
      await copyButton.trigger('click');
      await flushPromises();
      expect(copyButton.text()).toContain('Check');

      vi.advanceTimersByTime(1000);
      await nextTick();
      expect(copyButton.text()).toContain('Check');

      vi.advanceTimersByTime(1000);
      await nextTick();
      expect(copyButton.text()).not.toContain('Check');
    } finally {
      vi.useRealTimers();
    }
  });

  it('Scenario 7: Mode Transitions', async () => {
    const nodeA = createNode({ id: 'A', role: 'user', content: 'A', replies: [], extra: {} });
    const activeMessages = [nodeA];
    const chat = createMockChat(activeMessages);
    const wrapper = mountInspector(chat, activeMessages);

    expect(wrapper.text()).toContain('A');

    await wrapper.get('[data-testid="chat-inspector-mode-raw"]').trigger('click');
    await nextTick();
    expect(wrapper.find('pre').text()).toContain('chat-1');

    await wrapper.get('[data-testid="chat-inspector-mode-tree"]').trigger('click');
    await nextTick();
    expect(wrapper.findComponent(NetworkIcon).exists()).toBe(true);
  });

  it('Scenario 8: ModelID Display', async () => {
    const nodeWithModel = createNode({ id: 'A', role: 'assistant', content: 'Response', replies: [], extra: { modelId: 'gpt-4o' } });
    const activeMessages = [nodeWithModel];

    const chat = createMockChat(activeMessages);
    const wrapper = mountInspector(chat, activeMessages);

    const treeNode = wrapper.findComponent(ChatDebugTreeNode);
    expect(treeNode.exists()).toBe(true);
    expect(treeNode.text()).toContain('assistant');
    expect(treeNode.text()).toContain('gpt-4o');
  });

  it('Scenario 9: Attachment Event Handling', async () => {
    const nodeWithAtt = createNode({ id: 'A', role: 'user', content: 'A', replies: [], extra: {
      attachments: [{
        id: toAttachmentId({ raw: 'att-1' }),
        binaryObjectId: toBinaryObjectId({ raw: 'obj-1' }),
        originalName: 'test.png',
        mimeType: 'image/png',
        size: 100,
        uploadedAt: Date.now(),
        status: 'persisted' as const,
      }],
    } });
    const activeMessages = [nodeWithAtt];

    const chat = createMockChat(activeMessages);
    const wrapper = mountInspector(chat, activeMessages);

    const treeNode = wrapper.findComponent(ChatDebugTreeNode);
    expect(treeNode.exists()).toBe(true);

    await treeNode.vm.$emit('preview-attachment', 'obj-1');
    expect(wrapper.exists()).toBe(true);
  });

  it('Scenario 10: Thinking and Error Display', async () => {
    const nodeWithDetails = createNode({ id: 'A', role: 'assistant', content: 'Final Content', replies: [], extra: {
      thinking: 'Analyzing the request...',
      error: 'Simulated API Timeout',
    } });
    const activeMessages = [nodeWithDetails];
    const chat = createMockChat(activeMessages);
    const wrapper = mountInspector(chat, activeMessages);

    const treeNode = wrapper.findComponent(ChatDebugTreeNode);
    expect(treeNode.text()).toContain('Thinking Process');
    expect(treeNode.text()).toContain('Analyzing the request...');
    expect(treeNode.text()).toContain('Error');
    expect(treeNode.text()).toContain('Simulated API Timeout');
  });

  it('Scenario 11: Copy Content Functionality', async () => {
    const node = createNode({ id: 'A', role: 'user', content: 'Target Text to Copy', replies: [], extra: {} });
    const activeMessages = [node];
    const chat = createMockChat(activeMessages);
    const wrapper = mountInspector(chat, activeMessages);

    const copyBtn = wrapper.find('[data-testid="copy-content-btn"]');
    await copyBtn.trigger('click');

    expect(navigator.clipboard.writeText).toHaveBeenCalledWith('Target Text to Copy');
  });

  it('opens the selected tree node with a message-id query parameter', async () => {
    const nodeB = createNode({ id: 'B', role: 'assistant', content: 'B content', replies: [
      createNode({ id: 'C', role: 'user', content: 'C content', replies: [], extra: {} }),
    ], extra: {} });
    const chat = createMockChat([
      createNode({ id: 'A', role: 'user', content: 'A content', replies: [nodeB], extra: {} }),
    ]);
    const wrapper = mountInspector(chat);

    await wrapper.get('[data-testid="chat-inspector-mode-tree"]').trigger('click');
    await nextTick();
    await (wrapper.vm as any).handleSelectNode({ node: nodeB });
    await nextTick();

    await wrapper.findAll('button').find(b => b.text().includes('Open at this message'))?.trigger('click');

    expect(mockPush).toHaveBeenCalledWith({ query: { 'message-id': 'B' } });
    expect(wrapper.emitted('close')).toBeTruthy();
  });

  it('Scenario 12: Empty Chat Root', async () => {
    const chat = createMockChat([]);
    const wrapper = mountInspector(chat);

    await wrapper.get('[data-testid="chat-inspector-mode-tree"]').trigger('click');
    await nextTick();

    expect(wrapper.findComponent(NetworkIcon).exists()).toBe(true);
    expect(wrapper.findAllComponents(ChatDebugTreeNode).length).toBe(0);
  });

  it('Scenario 13: JSON Content Escaping (Technical Comments Visibility)', async () => {
    const chat = createMockChat([
      createNode({ id: 'A', role: 'user', content: 'Check this <!-- technical_comment -->', replies: [], extra: {} }),
    ]);
    const wrapper = mountInspector(chat);

    await wrapper.get('[data-testid="chat-inspector-mode-raw"]').trigger('click');
    await nextTick();

    const pre = wrapper.find('pre');
    // It should be escaped so it's visible as text in v-html
    expect(pre.html()).toContain('&lt;!-- technical_comment --&gt;');
  });

  it('Scenario 14: Technical Comments remain visible when Highlighting is OFF', async () => {
    const chat = createMockChat([
      createNode({ id: 'A', role: 'user', content: 'Check this <!-- technical_comment -->', replies: [], extra: {} }),
    ]);
    const wrapper = mountInspector(chat);

    // Switch to JSON
    await wrapper.get('[data-testid="chat-inspector-mode-raw"]').trigger('click');
    await nextTick();

    // Turn OFF highlighting
    const toggleBtn = wrapper.find('button[title="Toggle Highlighting"]');
    await toggleBtn.trigger('click');
    await nextTick();

    const pre = wrapper.find('pre');
    // It should STILL be escaped even if highlighting is off
    expect(pre.html()).toContain('&lt;!-- technical_comment --&gt;');
  });

  it('reports malformed preview image metadata once per scanned node', async () => {
    await ensureAllStringsForTest({ locale: 'en' });

    const node = createNode({ id: 'A', role: 'assistant', content: `\
\`\`\`naidan_experimental_image
not-json
\`\`\`
`, replies: [], extra: {} });
    const activeMessages = [node];
    const chat = createMockChat(activeMessages);
    const clickedBinaryObjectId = toBinaryObjectId({ raw: 'clicked-image' });

    const { storageService } = await import('@/00-storage/service');
    vi.mocked(storageService.getBinaryObject).mockResolvedValue({
      id: clickedBinaryObjectId,
      mimeType: 'image/png',
      name: 'clicked.png',
      size: 1,
      createdAt: 1,
    });

    const wrapper = mountInspector(chat, activeMessages);
    const treeNode = wrapper.findComponent(ChatDebugTreeNode);

    mockAddErrorEvent.mockClear();
    treeNode.vm.$emit('preview-attachment', clickedBinaryObjectId);
    await flushPromises();

    const inspectorCalls = mockAddErrorEvent.mock.calls.filter(([event]) => (
      event.source === 'ChatDebugInspector:handlePreviewAttachment'
    ));

    expect(inspectorCalls).toHaveLength(1);
    expect(inspectorCalls[0]?.[0]).toEqual(expect.objectContaining({
      message: 'Failed to parse image metadata during preview collection.',
    }));
  });

  it('Scenario 15: Image Preview navigation is restricted to the selected path in Tree mode', async () => {
    // Branch A -> B (with image 1)
    // Branch A -> C (with image 2)
    const img1 = {
      id: toAttachmentId({ raw: 'att-1' }),
      binaryObjectId: toBinaryObjectId({ raw: 'obj-1' }),
      mimeType: 'image/png',
      status: 'persisted' as const,
      originalName: 'img1.png',
      size: 1024,
      uploadedAt: Date.now(),
    };
    const img2 = {
      id: toAttachmentId({ raw: 'att-2' }),
      binaryObjectId: toBinaryObjectId({ raw: 'obj-2' }),
      mimeType: 'image/png',
      status: 'persisted' as const,
      originalName: 'img2.png',
      size: 1024,
      uploadedAt: Date.now(),
    };

    const nodeB = createNode({ id: 'B', role: 'user', content: 'B content', replies: [], extra: { attachments: [img1] } });

    const nodeC = createNode({ id: 'C', role: 'user', content: 'C content', replies: [], extra: { attachments: [img2] } });

    const chat = createMockChat([
      createNode({ id: 'A', role: 'user', content: 'A', replies: [nodeB, nodeC], extra: {} }),
    ]);

    // Mock storageService.getBinaryObject to return valid objects
    const { storageService } = await import('@/00-storage/service');
    vi.mocked(storageService.getBinaryObject).mockImplementation(async ({ binaryObjectId }) => {
      if (idToRaw({ id: binaryObjectId }) === 'obj-1') return { id: toBinaryObjectId({ raw: 'obj-1' }), mimeType: 'image/png', name: 'img1.png' } as any;
      if (idToRaw({ id: binaryObjectId }) === 'obj-2') return { id: toBinaryObjectId({ raw: 'obj-2' }), mimeType: 'image/png', name: 'img2.png' } as any;
      return null;
    });

    const wrapper = mountInspector(chat);
    await wrapper.get('[data-testid="chat-inspector-mode-tree"]').trigger('click');
    await nextTick();

    // Directly trigger select-node on the inspector instance to update selectedNode
    await (wrapper.vm as any).handleSelectNode({ node: nodeB });
    await nextTick();

    // Now find the node B in the detail panel to trigger preview
    const detailPanel = wrapper.find('.flex-1.overflow-y-auto.p-8');
    const treeNodes = detailPanel.findAllComponents(ChatDebugTreeNode);
    const nodeBDetail = treeNodes.find((n: any) => n.props().node.id === 'B');

    // Trigger preview
    await nodeBDetail?.vm.$emit('preview-attachment', 'obj-1');
    await nextTick();
    await nextTick();
    await nextTick(); // More ticks for async storage and state propagation

    // Check preview objects
    const modal = wrapper.findComponent({ name: 'BinaryObjectPreviewModal' });
    expect(modal.exists()).toBe(true);
    const objects = modal.props('objects');

    // Should ONLY contain obj-1 (from A -> B path), NOT obj-2 (which is in branch C)
    const ids = objects.map((o: any) => o.id);
    expect(ids).toContain('obj-1');
    expect(ids).not.toContain('obj-2');
  });
  it('keeps unsaved attachment bytes when opening its preview without persisted metadata', async () => {
    const blob = new Blob(['local'], { type: 'image/png' });
    const attachment: Attachment = {
      id: toAttachmentId({ raw: 'memory-a' }), binaryObjectId: toBinaryObjectId({ raw: 'memory-b' }),
      originalName: 'memory.png', mimeType: 'image/png', size: blob.size, uploadedAt: 0, status: 'memory', blob,
    };
    const node = createNode({ id: 'memory-u', role: 'user', content: 'local', replies: [], extra: { attachments: [attachment] } });
    const { storageService } = await import('@/00-storage/service');
    vi.mocked(storageService.getBinaryObject).mockResolvedValue(null);
    const wrapper = mount(ChatDebugInspector, {
      props: { show: true, chat: createMockChat([node]), activeMessages: [node] },
      global: { stubs: { BinaryObjectPreviewModal: true } },
    });
    wrapper.getComponent(ChatDebugTreeNode).vm.$emit('preview-attachment', attachment.binaryObjectId);
    await flushPromises();
    const modal = wrapper.getComponent({ name: 'BinaryObjectPreviewModal' });
    expect(modal.props('objects')).toEqual([{
      id: attachment.binaryObjectId, name: attachment.originalName, mimeType: attachment.mimeType,
      size: blob.size, createdAt: 0, memoryBlob: blob,
    }]);
    expect(storageService.getBinaryObject).not.toHaveBeenCalled();
    wrapper.unmount();
  });

});
