import { describe, it, expect } from 'vitest';
import { ref, computed, nextTick } from 'vue';
import { useChatDisplayFlow } from './useChatDisplayFlow';
import type { MessageNode, Chat } from '@/models/types';
import { generateId } from '@/utils/id';

describe('useChatDisplayFlow', () => {
  const createAssistantMsg = (content: string): MessageNode => ({
    id: generateId(),
    role: 'assistant',
    content,
    timestamp: Date.now(),
    replies: { items: [] }
  } as MessageNode);

  const createToolNode = (toolCallId: string): MessageNode => ({
    id: generateId(),
    role: 'tool',
    content: undefined,
    attachments: undefined,
    thinking: undefined,
    error: undefined,
    modelId: undefined,
    lmParameters: undefined,
    toolCalls: undefined,
    results: [{
      toolCallId,
      status: 'success',
      content: { type: 'text', text: 'ok' }
    }],
    timestamp: Date.now(),
    replies: { items: [] }
  } as MessageNode);

  const createFlow = ({ messages, isProcessing = false }: { messages: MessageNode[], isProcessing?: boolean }) => {
    // Mock the hierarchical structure that getChatBranchIterator expects
    for (let i = 0; i < messages.length - 1; i++) {
      messages[i]!.replies.items = [messages[i+1]!];
    }

    const chat = computed<Chat>(() => ({
      id: 'test-chat',
      title: 'Test',
      root: { items: messages.length > 0 ? [messages[0]!] : [] },
      currentLeafId: messages.length > 0 ? messages[messages.length - 1]!.id : null,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      debugEnabled: false
    } as Chat));

    return useChatDisplayFlow({
      chat,
      isProcessing: () => isProcessing
    });
  };

  it('groups internal processes: thought followed by tool', () => {
    const m1 = createAssistantMsg('<think>thinking...</think>');
    m1.toolCalls = [{ id: 'tc1', type: 'function', function: { name: 'test_tool', arguments: '{}' } }];
    const t1 = createToolNode('tc1');

    const { chatFlow } = createFlow({ messages: [m1, t1] });

    expect(chatFlow.value).toHaveLength(1);
    const first = chatFlow.value[0];
    expect(first?.type).toBe('process_sequence');
    if (first?.type === 'process_sequence') {
      expect(first.items).toHaveLength(3);
    }
  });

  it('groups internal processes: tool followed by thought', () => {
    const m1 = createAssistantMsg('');
    m1.toolCalls = [{ id: 'tc1', type: 'function', function: { name: 'test_tool', arguments: '{}' } }];
    const t1 = createToolNode('tc1');
    const m2 = createAssistantMsg('<think>thinking...</think>');

    const { chatFlow } = createFlow({ messages: [m1, t1, m2] });

    expect(chatFlow.value).toHaveLength(1);
    expect(chatFlow.value[0]?.type).toBe('process_sequence');
  });

  it('does NOT group a single internal process', () => {
    const m1 = createAssistantMsg('<think>thinking...</think>');
    const { chatFlow } = createFlow({ messages: [m1] });

    expect(chatFlow.value).toHaveLength(1);
    expect(chatFlow.value[0]?.type).toBe('message');
  });

  it('correctly calculates sequence position metadata', () => {
    const user = { role: 'user', content: 'hi', id: 'u1', timestamp: 0, replies: { items: [] } } as MessageNode;
    const m1 = createAssistantMsg('<think>thinking...</think>');
    m1.toolCalls = [{ id: 'tc1', type: 'function', function: { name: 'test_tool', arguments: '{}' } }];
    const t1 = createToolNode('tc1');
    const m2 = createAssistantMsg('Final answer');

    const { chatFlow } = createFlow({ messages: [user, m1, t1, m2] });

    expect(chatFlow.value).toHaveLength(3);
    expect(chatFlow.value[0]?.flow.position).toBe('standalone');
    expect(chatFlow.value[1]?.flow.position).toBe('start');
    expect(chatFlow.value[2]?.flow.position).toBe('end');
  });

  it('manages summary text based on active thinking state', async () => {
    const m1 = createAssistantMsg('<think>thinking in progress...');

    const messages = ref([m1]);
    const isProcessingRef = ref(true);

    const chat = computed<Chat>(() => ({
      id: 'test-chat',
      title: 'Test',
      root: { items: messages.value.length > 0 ? [messages.value[0]!] : [] },
      currentLeafId: messages.value.length > 0 ? messages.value[messages.value.length - 1]!.id : null,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      debugEnabled: false
    } as Chat));

    const { chatFlow, isThinkingActive } = useChatDisplayFlow({
      chat,
      isProcessing: () => isProcessingRef.value
    });

    expect(chatFlow.value).toHaveLength(1);
    const item = chatFlow.value[0]!;
    expect(item.type).toBe('message');
    expect(isThinkingActive({ item: item as any })).toBe(true);

    messages.value[0]!.content = '<think>thought</think>';
    isProcessingRef.value = false;
    await nextTick();

    const updatedItem = chatFlow.value[0]!;
    expect(isThinkingActive({ item: updatedItem as any })).toBe(false);
  });

  it('splits mixed message: completed thinking followed by content', () => {
    const m1 = createAssistantMsg('<think>thought</think>Actual answer');
    const { chatFlow } = createFlow({ messages: [m1] });

    expect(chatFlow.value).toHaveLength(2);
    expect(chatFlow.value[0]?.type).toBe('message');
    expect((chatFlow.value[0] as any).mode).toBe('thinking');
    expect(chatFlow.value[1]?.type).toBe('message');
    expect((chatFlow.value[1] as any).mode).toBe('content');
  });

  it('groups assistant message with content if it has tool calls (the original bug)', () => {
    const m1 = createAssistantMsg('<think>thinking...</think>Partially done...');
    m1.toolCalls = [{ id: 'tc1', type: 'function', function: { name: 'calc', arguments: '{}' } }];
    const t1 = createToolNode('tc1');

    const { chatFlow } = createFlow({ messages: [m1, t1] });

    expect(chatFlow.value).toHaveLength(3);
    expect(chatFlow.value[0]?.type).toBe('message'); // Thinking
    expect(chatFlow.value[1]?.type).toBe('message'); // Content
    expect(chatFlow.value[2]?.type).toBe('process_sequence'); // ToolCalls + ToolGroup
  });
});
