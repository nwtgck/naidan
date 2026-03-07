import { describe, it, expect } from 'vitest';
import { ref, computed, nextTick } from 'vue';
import { useChatDisplayFlow } from './useChatDisplayFlow';
import type { MessageNode } from '../models/types';
import { generateId } from '../utils/id';

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
    const activeMessages = computed(() => messages);
    const isProcessingRef = computed(() => isProcessing);
    return useChatDisplayFlow({ activeMessages, isProcessing: isProcessingRef });
  };

  it('groups internal processes: thought followed by tool', () => {
    const m1 = createAssistantMsg('<think>thinking...</think>');
    m1.toolCalls = [{ id: 'tc1', type: 'function', function: { name: 'test_tool', arguments: '{}' } }];
    const t1 = createToolNode('tc1');

    const { chatFlow } = createFlow({ messages: [m1, t1] });

    // Expect:
    // 1. Atom(thinking) from m1
    // 2. Atom(tool_calls) from m1
    // 3. Atom(tool_group) from t1
    // All grouped into 1 process_sequence
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

    // items: user(content), m1(thinking), m1(tool_calls), t1(tool_group), m2(content)
    // grouped: user(msg), sequence(m1_think, m1_tc, t1_tg), m2(msg)
    expect(chatFlow.value).toHaveLength(3);
    expect(chatFlow.value[0]?.flow.position).toBe('standalone');
    expect(chatFlow.value[1]?.flow.position).toBe('start');
    expect(chatFlow.value[2]?.flow.position).toBe('end');
  });

  it('manages summary text based on active thinking state', async () => {
    const m1 = createAssistantMsg('<think>thinking in progress...');

    const messages = ref([m1]);
    const isProcessingRef = ref(true);

    const { chatFlow, isThinkingActive } = useChatDisplayFlow({
      activeMessages: computed(() => messages.value),
      isProcessing: computed(() => isProcessingRef.value)
    });

    // 1. ACTIVE THINKING: Should NOT be grouped, and isThinkingActive should be true
    expect(chatFlow.value).toHaveLength(1);
    const item = chatFlow.value[0]!;
    expect(item.type).toBe('message');
    expect(isThinkingActive({ item: item as any })).toBe(true);

    // 2. THINKING FINISHED (by closing the tag)
    messages.value[0]!.content = '<think>thought</think>';
    isProcessingRef.value = false;
    await nextTick();

    const updatedItem = chatFlow.value[0]!;
    expect(isThinkingActive({ item: updatedItem as any })).toBe(false);
  });

  it('splits mixed message: completed thinking followed by content', () => {
    const m1 = createAssistantMsg('<think>thought</think>Actual answer');
    const { chatFlow } = createFlow({ messages: [m1] });

    // Expect:
    // 1. Atom(thinking) - internal
    // 2. Atom(content) - external
    // Not grouped because they are 1 internal + 1 external
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

    // Expectation:
    // 1. Atom(Thinking) - Internal
    // 2. Atom(Content) - External -> BREAKS SEQUENCE
    // 3. Atom(ToolCalls) - Internal
    // 4. Atom(ToolGroup) - Internal -> GROUPS WITH ToolCalls

    expect(chatFlow.value).toHaveLength(3);
    expect(chatFlow.value[0]?.type).toBe('message'); // Thinking
    expect(chatFlow.value[1]?.type).toBe('message'); // Content
    expect(chatFlow.value[2]?.type).toBe('process_sequence'); // ToolCalls + ToolGroup
  });
});
