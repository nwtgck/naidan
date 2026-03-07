import { describe, it, expect } from 'vitest';
import { ref, computed, nextTick } from 'vue';
import { useChatDisplayFlow } from './useChatDisplayFlow';
import type { DisplayMessage, MessageNode, CombinedToolCall } from '../models/types';
import { generateId } from '../utils/id';

describe('useChatDisplayFlow', () => {
  const createAssistantMsg = (content: string): DisplayMessage => ({
    type: 'message',
    node: {
      id: generateId(),
      role: 'assistant',
      content,
      timestamp: Date.now(),
      replies: { items: [] }
    } as MessageNode
  });

  const createToolGroup = (): DisplayMessage => ({
    type: 'tool_group',
    id: generateId(),
    toolCalls: [
      {
        id: 'tc1',
        nodeId: 'n1',
        call: { id: 'tc1', type: 'function', function: { name: 'test_tool', arguments: '{}' } },
        result: { toolCallId: 'tc1', status: 'success', content: { type: 'text', text: 'ok' } }
      }
    ] as CombinedToolCall[]
  });

  const createFlow = (messages: DisplayMessage[]) => {
    const activeDisplayMessages = computed(() => messages);
    const isProcessing = computed(() => false);
    return useChatDisplayFlow({ activeDisplayMessages, isProcessing });
  };

  it('groups internal processes: thought followed by tool', () => {
    const m1 = createAssistantMsg('<think>thinking...</think>');
    const t1 = createToolGroup();
    const { chatFlow } = createFlow([m1, t1]);

    expect(chatFlow.value).toHaveLength(1);
    const first = chatFlow.value[0];
    expect(first?.type).toBe('process_sequence');
    if (first?.type === 'process_sequence') {
      expect(first.items).toHaveLength(2);
    }
  });

  it('groups internal processes: tool followed by thought', () => {
    const t1 = createToolGroup();
    const m1 = createAssistantMsg('<think>thinking...</think>');
    const { chatFlow } = createFlow([t1, m1]);

    expect(chatFlow.value).toHaveLength(1);
    expect(chatFlow.value[0]?.type).toBe('process_sequence');
  });

  it('does NOT group a single internal process', () => {
    const m1 = createAssistantMsg('<think>thinking...</think>');
    const { chatFlow } = createFlow([m1]);

    expect(chatFlow.value).toHaveLength(1);
    expect(chatFlow.value[0]?.type).toBe('message');
  });

  it('correctly calculates sequence position metadata', () => {
    const user = { type: 'message', node: { role: 'user', content: 'hi', id: 'u1', timestamp: 0, replies: { items: [] } } } as DisplayMessage;
    const m1 = createAssistantMsg('<think>thinking...</think>');
    const t1 = createToolGroup();
    const m2 = createAssistantMsg('Final answer');
    
    const { chatFlow } = createFlow([user, m1, t1, m2]);

    expect(chatFlow.value).toHaveLength(3); 
    expect(chatFlow.value[0]?.flow.position).toBe('standalone');
    expect(chatFlow.value[1]?.flow.position).toBe('start');
    expect(chatFlow.value[2]?.flow.position).toBe('end');
  });

  it('manages summary text based on active thinking state', async () => {
    const m1 = createAssistantMsg('<think>thinking in progress...');
    const t1 = createToolGroup();
    
    const activeMessages = ref([m1, t1]);
    const isProcessingRef = ref(true);
    const isProcessing = computed(() => isProcessingRef.value);
    
    const { chatFlow } = useChatDisplayFlow({ 
      activeDisplayMessages: computed(() => activeMessages.value), 
      isProcessing 
    });
    
    const first = chatFlow.value[0];
    expect(first?.type).toBe('process_sequence');
    if (first?.type === 'process_sequence') {
      // 1. ACTIVE THINKING: Should show Thinking... along with counts
      expect(first.summary).toContain('Thinking...');
      expect(first.summary).toContain('1 thinking step'); // Now includes count even while active
      expect(first.summary).toContain('Used test_tool');
      expect(first.stats.isCurrentlyThinking).toBe(true);
      
      // 2. THINKING FINISHED
      isProcessingRef.value = false;
      await nextTick();
      
      const updatedFirst = chatFlow.value[0];
      if (updatedFirst?.type === 'process_sequence') {
        // "Thinking..." should be removed
        expect(updatedFirst.summary).not.toContain('Thinking...');
        // But counts and tool info remain
        expect(updatedFirst.summary).toContain('1 thinking step');
        expect(updatedFirst.summary).toContain('Used test_tool');
        expect(updatedFirst.stats.isCurrentlyThinking).toBe(false);
      }
    }
  });
});
