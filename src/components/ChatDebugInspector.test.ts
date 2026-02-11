import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mount } from '@vue/test-utils';
import ChatDebugInspector from './ChatDebugInspector.vue';
import ChatDebugTreeNode from './ChatDebugTreeNode.vue';
import { nextTick } from 'vue';
import { Network } from 'lucide-vue-next';
import type { MessageNode, Chat } from '../models/types';

// Mock Lucide icons
vi.mock('lucide-vue-next', () => ({
  Bug: { template: '<span>Bug</span>' },
  X: { template: '<span>X</span>' },
  MessageSquare: { template: '<span>MessageSquare</span>' },
  Network: { template: '<span>Network</span>' },
  FileCode: { template: '<span>FileCode</span>' },
  Highlighter: { template: '<span>Highlighter</span>' },
  ZapOff: { template: '<span>ZapOff</span>' },
  ChevronLeft: { template: '<span>ChevronLeft</span>' },
  ChevronRight: { template: '<span>ChevronRight</span>' },
  ChevronDown: { template: '<span>ChevronDown</span>' },
  Copy: { template: '<span>Copy</span>' },
  Check: { template: '<span>Check</span>' },
  Image: { template: '<span>Image</span>' },
  File: { template: '<span>File</span>' },
  Cpu: { template: '<span>Cpu</span>' },
  Fingerprint: { template: '<span>Fingerprint</span>' },
  Eye: { template: '<span>Eye</span>' },
  EyeOff: { template: '<span>EyeOff</span>' },
  CornerUpRight: { template: '<span>CornerUpRight</span>' },
  ZoomIn: { template: '<span>ZoomIn</span>' },
  ZoomOut: { template: '<span>ZoomOut</span>' },
  RefreshCw: { template: '<span>RefreshCw</span>' },
  Calendar: { template: '<span>Calendar</span>' },
  Info: { template: '<span>Info</span>' },
  Download: { template: '<span>Download</span>' },
  Trash2: { template: '<span>Trash2</span>' }
}));

const mockPush = vi.fn();
vi.mock('vue-router', () => ({
  useRouter: () => ({
    push: mockPush,
    currentRoute: { value: { query: {} } }
  })
}));

vi.mock('../services/storage', () => ({
  storageService: {
    getBinaryObject: vi.fn(),
    getFile: vi.fn().mockResolvedValue(new Blob()),
  }
}));

// Mock Clipboard
Object.assign(navigator, {
  clipboard: {
    writeText: vi.fn().mockResolvedValue(undefined),
  },
});

describe('ChatDebugInspector - Comprehensive Tree & Feature Tests', () => {
  const createNode = (id: string, role: 'user' | 'assistant' | 'system', content: string, replies: MessageNode[] = []): MessageNode => ({
    id,
    role,
    content,
    timestamp: Date.now(),
    replies: { items: replies }
  });

  const createMockChat = (rootItems: MessageNode[] = []): Chat => ({
    id: 'chat-1',
    title: 'Test Chat',
    root: { items: rootItems },
    debugEnabled: true,
    createdAt: Date.now(),
    updatedAt: Date.now()
  });

  const mountInspector = (chat: Chat, activeMessages: MessageNode[] = []) => {
    return mount(ChatDebugInspector, {
      props: {
        show: true,
        chat,
        activeMessages
      }
    });
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('Scenario 1: Pure Linear Path (A -> B -> C)', async () => {
    const chat = createMockChat([
      createNode('A', 'user', 'A', [
        createNode('B', 'assistant', 'B', [
          createNode('C', 'user', 'C')
        ])
      ])
    ]);

    const wrapper = mountInspector(chat);
    await wrapper.findAll('button').find(b => b.text().includes('Tree'))?.trigger('click');
    await nextTick();

    const treeNodes = wrapper.findAllComponents(ChatDebugTreeNode);
    const linearContainers = wrapper.findAll('.ml-0');
    expect(linearContainers.length).toBeGreaterThanOrEqual(2);

    const nodeB = treeNodes.find(n => n.props().node.id === 'B');
    const nodeC = treeNodes.find(n => n.props().node.id === 'C');
    
    expect(nodeB?.props().hasLinearParent).toBe(true);
    expect(nodeC?.props().hasLinearParent).toBe(true);
    expect(nodeB?.find('.h-px').exists()).toBe(false); 
  });

  it('Scenario 2: Root Branching ([A, B])', async () => {
    const chat = createMockChat([
      createNode('A', 'user', 'A'),
      createNode('B', 'user', 'B')
    ]);

    const wrapper = mountInspector(chat);
    await wrapper.findAll('button').find(b => b.text().includes('Tree'))?.trigger('click');
    await nextTick();

    const treeNodes = wrapper.findAllComponents(ChatDebugTreeNode);
    const nodeA = treeNodes.find(n => n.props().node.id === 'A');
    const nodeB = treeNodes.find(n => n.props().node.id === 'B');

    expect(nodeA?.find('.absolute.left-\\[-24px\\]').exists()).toBe(true);
    expect(nodeB?.find('.absolute.left-\\[-24px\\]').exists()).toBe(true);
    expect(nodeB?.find('.h-4').exists()).toBe(true);
  });

  it('Scenario 3: Branching followed by Linear (A -> [B -> D, C])', async () => {
    const chat = createMockChat([
      createNode('A', 'user', 'A', [
        createNode('B', 'assistant', 'B', [
          createNode('D', 'user', 'D')
        ]),
        createNode('C', 'assistant', 'C')
      ])
    ]);

    const wrapper = mountInspector(chat);
    await wrapper.findAll('button').find(b => b.text().includes('Tree'))?.trigger('click');
    await nextTick();

    const treeNodes = wrapper.findAllComponents(ChatDebugTreeNode);
    const nodeB = treeNodes.find(n => n.props().node.id === 'B');
    const nodeD = treeNodes.find(n => n.props().node.id === 'D');

    expect(nodeB?.find('.h-px').exists()).toBe(true);
    expect(nodeD?.find('.h-px').exists()).toBe(false);
    expect(nodeD?.props().hasLinearParent).toBe(true);
  });

  it('Scenario 4: Detail Panel Full Context Path', async () => {
    const chat = createMockChat([
      createNode('A', 'user', 'A', [
        createNode('B', 'assistant', 'B', [
          createNode('C', 'user', 'C')
        ])
      ])
    ]);

    const wrapper = mountInspector(chat);
    await wrapper.findAll('button').find(b => b.text().includes('Tree'))?.trigger('click');
    await nextTick();

    // Select node C
    const treeNodes = wrapper.findAllComponents(ChatDebugTreeNode);
    const nodeC = treeNodes.find(n => n.props().node.id === 'C');
    await nodeC?.vm.$emit('select-node', nodeC.props().node);
    await nextTick();

    const detailPanel = wrapper.find('.flex-1.overflow-y-auto.p-8');
    const detailNodes = detailPanel.findAllComponents(ChatDebugTreeNode);
    
    expect(detailNodes.length).toBe(3);
    expect(detailNodes[0].props().node.id).toBe('A');
    expect(detailNodes[1].props().node.id).toBe('B');
    expect(detailNodes[2].props().node.id).toBe('C');
  });

  it('Scenario 5: Tree Map Collapsibility', async () => {
    const chat = createMockChat([createNode('A', 'user', 'A')]);
    const wrapper = mountInspector(chat);
    await wrapper.findAll('button').find(b => b.text().includes('Tree'))?.trigger('click');
    await nextTick();

    const treeMapContainer = wrapper.find('.relative.overflow-y-auto.border-r');
    expect(treeMapContainer.classes()).toContain('w-[45%]');

    await treeMapContainer.find('button').trigger('click');
    await nextTick();

    expect(treeMapContainer.classes()).toContain('w-12');
  });

  it('Scenario 6: JSON Highlighting Toggle', async () => {
    const chat = createMockChat([createNode('A', 'user', 'A')]);
    const wrapper = mountInspector(chat);
    
    await wrapper.findAll('button').find(b => b.text().includes('Full JSON'))?.trigger('click');
    await nextTick();

    const pre = wrapper.find('pre');
    expect(pre.html()).toContain('class="text-red-500'); 

    const toggleBtn = wrapper.find('button[title="Toggle Highlighting"]');
    await toggleBtn.trigger('click');
    await nextTick();

    expect(pre.html()).not.toContain('class="text-red-500'); 
  });

  it('Scenario 7: Mode Transitions', async () => {
    const nodeA = createNode('A', 'user', 'A');
    const activeMessages = [nodeA];
    const chat = createMockChat(activeMessages);
    const wrapper = mountInspector(chat, activeMessages);

    expect(wrapper.text()).toContain('A');

    await wrapper.findAll('button').find(b => b.text().includes('Full JSON'))?.trigger('click');
    await nextTick();
    expect(wrapper.find('pre').text()).toContain('chat-1');

    await wrapper.findAll('button').find(b => b.text().includes('Tree'))?.trigger('click');
    await nextTick();
    expect(wrapper.findComponent(Network).exists()).toBe(true);
  });

  it('Scenario 8: ModelID Display', async () => {
    const node = createNode('A', 'assistant', 'Response');
    const nodeWithModel = { ...node, modelId: 'gpt-4o' };
    const activeMessages = [nodeWithModel];
    
    const chat = createMockChat(activeMessages);
    const wrapper = mountInspector(chat, activeMessages);

    const treeNode = wrapper.findComponent(ChatDebugTreeNode);
    expect(treeNode.exists()).toBe(true);
    expect(treeNode.text()).toContain('assistant');
    expect(treeNode.text()).toContain('gpt-4o');
  });

  it('Scenario 9: Attachment Event Handling', async () => {
    const node = createNode('A', 'user', 'A');
    const nodeWithAtt = { ...node, attachments: [{ 
      id: 'att-1', 
      binaryObjectId: 'obj-1', 
      originalName: 'test.png', 
      mimeType: 'image/png', 
      size: 100, 
      uploadedAt: Date.now(),
      status: 'persisted' as const
    }] };
    const activeMessages = [nodeWithAtt];
    
    const chat = createMockChat(activeMessages);
    const wrapper = mountInspector(chat, activeMessages);

    const treeNode = wrapper.findComponent(ChatDebugTreeNode);
    expect(treeNode.exists()).toBe(true);
    
    await treeNode.vm.$emit('preview-attachment', 'obj-1');
    expect(wrapper.exists()).toBe(true);
  });

  it('Scenario 10: Thinking and Error Display', async () => {
    const node = createNode('A', 'assistant', 'Final Content');
    const nodeWithDetails = { 
      ...node, 
      thinking: 'Analyzing the request...',
      error: 'Simulated API Timeout'
    };
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
    const node = createNode('A', 'user', 'Target Text to Copy');
    const activeMessages = [node];
    const chat = createMockChat(activeMessages);
    const wrapper = mountInspector(chat, activeMessages);

    const copyBtn = wrapper.find('[data-testid="copy-content-btn"]');
    await copyBtn.trigger('click');

    expect(navigator.clipboard.writeText).toHaveBeenCalledWith('Target Text to Copy');
  });

  it('Scenario 12: Empty Chat Root', async () => {
    const chat = createMockChat([]);
    const wrapper = mountInspector(chat);

    await wrapper.findAll('button').find(b => b.text().includes('Tree'))?.trigger('click');
    await nextTick();

    expect(wrapper.findComponent(Network).exists()).toBe(true);
    expect(wrapper.findAllComponents(ChatDebugTreeNode).length).toBe(0);
  });

  it('Scenario 13: JSON Content Escaping (Technical Comments Visibility)', async () => {
    const chat = createMockChat([
      createNode('A', 'user', 'Check this <!-- technical_comment -->')
    ]);
    const wrapper = mountInspector(chat);
    
    await wrapper.findAll('button').find(b => b.text().includes('Full JSON'))?.trigger('click');
    await nextTick();

    const pre = wrapper.find('pre');
    // It should be escaped so it's visible as text in v-html
    expect(pre.html()).toContain('&lt;!-- technical_comment --&gt;');
  });

  it('Scenario 14: Technical Comments remain visible when Highlighting is OFF', async () => {
    const chat = createMockChat([
      createNode('A', 'user', 'Check this <!-- technical_comment -->')
    ]);
    const wrapper = mountInspector(chat);
    
    // Switch to Full JSON
    await wrapper.findAll('button').find(b => b.text().includes('Full JSON'))?.trigger('click');
    await nextTick();

    // Turn OFF highlighting
    const toggleBtn = wrapper.find('button[title="Toggle Highlighting"]');
    await toggleBtn.trigger('click');
    await nextTick();

    const pre = wrapper.find('pre');
    // It should STILL be escaped even if highlighting is off
    expect(pre.html()).toContain('&lt;!-- technical_comment --&gt;');
  });

  it('Scenario 15: Image Preview navigation is restricted to the selected path in Tree mode', async () => {
    // Branch A -> B (with image 1)
    // Branch A -> C (with image 2)
    const img1 = { 
      id: 'att-1', 
      binaryObjectId: 'obj-1', 
      mimeType: 'image/png', 
      status: 'persisted' as const,
      originalName: 'img1.png',
      size: 1024,
      uploadedAt: Date.now()
    };
    const img2 = { 
      id: 'att-2', 
      binaryObjectId: 'obj-2', 
      mimeType: 'image/png', 
      status: 'persisted' as const,
      originalName: 'img2.png',
      size: 1024,
      uploadedAt: Date.now()
    };

    const nodeB = createNode('B', 'assistant', 'B content', []);
    nodeB.attachments = [img1];
    
    const nodeC = createNode('C', 'assistant', 'C content', []);
    nodeC.attachments = [img2];

    const chat = createMockChat([
      createNode('A', 'user', 'A', [nodeB, nodeC])
    ]);
    
    // Mock storageService.getBinaryObject to return valid objects
    const { storageService } = await import('../services/storage');
    vi.mocked(storageService.getBinaryObject).mockImplementation(async ({ binaryObjectId }) => {
      if (binaryObjectId === 'obj-1') return { id: 'obj-1', mimeType: 'image/png', name: 'img1.png' } as any;
      if (binaryObjectId === 'obj-2') return { id: 'obj-2', mimeType: 'image/png', name: 'img2.png' } as any;
      return null;
    });

    const wrapper = mountInspector(chat);
    await wrapper.findAll('button').find(b => b.text().includes('Tree'))?.trigger('click');
    await nextTick();

    // Directly trigger select-node on the inspector instance to update selectedNode
    await (wrapper.vm as any).handleSelectNode(nodeB);
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
});
