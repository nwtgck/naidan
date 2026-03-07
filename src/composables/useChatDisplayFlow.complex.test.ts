import { describe, it, expect } from 'vitest';
import { computed } from 'vue';
import { useChatDisplayFlow } from './useChatDisplayFlow';
import type { MessageNode } from '../models/types';

describe('useChatDisplayFlow complex scenario', () => {
  it('correctly atomizes and groups the reported complex scenario with full JSON validation', () => {
    const messages: MessageNode[] = [
      { id: 'u1', role: 'user', content: 'Calc', timestamp: 0, replies: { items: [] }, attachments: [], lmParameters: undefined, thinking: undefined, error: undefined, modelId: undefined, toolCalls: undefined, results: undefined } as MessageNode,
      { id: 'a1', role: 'assistant', content: '<think>T1</think>', timestamp: 0, replies: { items: [] }, toolCalls: [{ id: 'tc1', type: 'function', function: { name: 'c', arguments: '{}' } }], attachments: undefined, thinking: undefined, error: undefined, modelId: 'm', lmParameters: undefined, results: undefined } as MessageNode,
      { id: 't1', role: 'tool', content: undefined, timestamp: 0, replies: { items: [] }, results: [{ toolCallId: 'tc1', status: 'success', content: { type: 'text', text: 'R1' } }], attachments: undefined, thinking: undefined, error: undefined, modelId: undefined, lmParameters: undefined, toolCalls: undefined } as MessageNode,
      { id: 'am', role: 'assistant', content: '<think>TM</think>Body', timestamp: 0, replies: { items: [] }, toolCalls: [{ id: 'tcm', type: 'function', function: { name: 'c', arguments: '{}' } }], attachments: undefined, thinking: undefined, error: undefined, modelId: 'm', lmParameters: undefined, results: undefined } as MessageNode,
      { id: 'tm', role: 'tool', content: undefined, timestamp: 0, replies: { items: [] }, results: [{ toolCallId: 'tcm', status: 'success', content: { type: 'text', text: 'RM' } }], attachments: undefined, thinking: undefined, error: undefined, modelId: undefined, lmParameters: undefined, toolCalls: undefined } as MessageNode,
      { id: 'al', role: 'assistant', content: '<think>TL</think>End', timestamp: 0, replies: { items: [] }, attachments: undefined, thinking: undefined, error: undefined, modelId: 'm', lmParameters: undefined, toolCalls: undefined, results: undefined } as MessageNode,
    ];

    const { chatFlow } = useChatDisplayFlow({
      activeMessages: computed(() => messages),
      isProcessing: computed(() => false)
    });

    const result = JSON.parse(JSON.stringify(chatFlow.value));

    const expected = [
      {
        type: 'message',
        node: expect.objectContaining({ id: 'u1' }),
        mode: 'content',
        partContent: 'Calc',
        isFirstInNode: true,
        isLastInNode: true,
        isFirstInTurn: true,
        flow: { position: 'standalone', nesting: 'none' }
      },
      {
        type: 'process_sequence',
        id: 'seq-a1-thinking',
        summary: '2 thinking steps • 1 tool execution • Used c',
        isFirstInTurn: true,
        stats: {
          thinkingSteps: 2,
          toolCallCount: 1,
          toolNames: ['c'],
          isCurrentlyThinking: false,
          isCurrentlyToolRunning: false,
          isWaiting: false
        },
        items: [
          { type: 'message', node: expect.objectContaining({ id: 'a1' }), mode: 'thinking', partContent: 'T1', isFirstInNode: true, isLastInNode: false, isFirstInTurn: true, isCompletedThinking: true, flow: { position: 'standalone', nesting: 'inside-group' } },
          { type: 'message', node: expect.objectContaining({ id: 'a1' }), mode: 'tool_calls', isFirstInNode: false, isLastInNode: true, isFirstInTurn: false, isCompletedThinking: undefined, flow: { position: 'standalone', nesting: 'inside-group' } },
          { type: 'tool_group', id: 't1', node: expect.objectContaining({ id: 't1' }), toolCalls: [expect.objectContaining({ id: 'tc1' })], flow: { position: 'standalone', nesting: 'inside-group' }, isFirstInTurn: true },
          { type: 'message', node: expect.objectContaining({ id: 'am' }), mode: 'thinking', partContent: 'TM', isFirstInNode: true, isLastInNode: false, isFirstInTurn: true, isCompletedThinking: true, flow: { position: 'standalone', nesting: 'inside-group' } }
        ],
        flow: { position: 'start', nesting: 'none' }
      },
      {
        type: 'message',
        node: expect.objectContaining({ id: 'am' }),
        mode: 'content',
        partContent: 'Body',
        isFirstInNode: false,
        isLastInNode: false,
        isFirstInTurn: false,
        flow: { position: 'middle', nesting: 'none' }
      },
      {
        type: 'process_sequence',
        id: 'seq-am-tool_calls',
        summary: '1 thinking step • 1 tool execution • Used c',
        isFirstInTurn: false,
        stats: {
          thinkingSteps: 1,
          toolCallCount: 1,
          toolNames: ['c'],
          isCurrentlyThinking: false,
          isCurrentlyToolRunning: false,
          isWaiting: false
        },
        items: [
          { type: 'message', node: expect.objectContaining({ id: 'am' }), mode: 'tool_calls', isFirstInNode: false, isLastInNode: true, isFirstInTurn: false, isCompletedThinking: undefined, flow: { position: 'standalone', nesting: 'inside-group' } },
          { type: 'tool_group', id: 'tm', node: expect.objectContaining({ id: 'tm' }), toolCalls: [expect.objectContaining({ id: 'tcm' })], flow: { position: 'standalone', nesting: 'inside-group' }, isFirstInTurn: true },
          { type: 'message', node: expect.objectContaining({ id: 'al' }), mode: 'thinking', partContent: 'TL', isFirstInNode: true, isLastInNode: false, isFirstInTurn: true, isCompletedThinking: true, flow: { position: 'standalone', nesting: 'inside-group' } }
        ],
        flow: { position: 'middle', nesting: 'none' }
      },
      {
        type: 'message',
        node: expect.objectContaining({ id: 'al' }),
        mode: 'content',
        partContent: 'End',
        isFirstInNode: false,
        isLastInNode: true,
        isFirstInTurn: false,
        flow: { position: 'end', nesting: 'none' }
      }
    ];

    expect(result).toEqual(expected);
  });

  it('correctly handles streaming state with active thinking and waiting', () => {
    const messages: MessageNode[] = [
      { id: 'u1', role: 'user', content: 'Hi', timestamp: 0, replies: { items: [] }, attachments: [], lmParameters: undefined, thinking: undefined, error: undefined, modelId: undefined, toolCalls: undefined, results: undefined } as MessageNode,
      { id: 'a1', role: 'assistant', content: 'Answer<think>Active', timestamp: 0, replies: { items: [] }, attachments: undefined, thinking: undefined, error: undefined, modelId: 'm', lmParameters: undefined, toolCalls: undefined, results: undefined } as MessageNode,
    ];

    const { chatFlow } = useChatDisplayFlow({
      activeMessages: computed(() => messages),
      isProcessing: computed(() => true)
    });

    const result = JSON.parse(JSON.stringify(chatFlow.value));

    const expected = [
      {
        type: 'message',
        node: expect.objectContaining({ id: 'u1' }),
        mode: 'content',
        partContent: 'Hi',
        isFirstInNode: true,
        isLastInNode: true,
        isFirstInTurn: true,
        flow: { position: 'standalone', nesting: 'none' }
      },
      {
        type: 'message',
        node: expect.objectContaining({ id: 'a1' }),
        mode: 'content',
        partContent: 'Answer',
        isFirstInNode: true,
        isLastInNode: false,
        isFirstInTurn: true,
        flow: { position: 'start', nesting: 'none' }
      },
      {
        type: 'message',
        node: expect.objectContaining({ id: 'a1' }),
        mode: 'thinking',
        partContent: 'Active',
        isFirstInNode: false,
        isLastInNode: true,
        isFirstInTurn: false,
        isCompletedThinking: false,
        flow: { position: 'end', nesting: 'none' }
      }
    ];

    expect(result).toEqual(expected);
  });

  it('handles multiple think blocks and intermixed tool groups', () => {
    const messages: MessageNode[] = [
      {
        id: 'a1', role: 'assistant',
        content: '<think>T1</think>C1<think>T2</think>',
        timestamp: 0, replies: { items: [] }, toolCalls: [{ id: 'tc1', type: 'function', function: { name: 'f', arguments: '{}' } }],
        attachments: undefined, thinking: undefined, error: undefined, modelId: 'm', lmParameters: undefined, results: undefined
      } as MessageNode,
      {
        id: 't1', role: 'tool', content: undefined, timestamp: 0, replies: { items: [] },
        results: [{ toolCallId: 'tc1', status: 'success', content: { type: 'text', text: 'R' } }],
        attachments: undefined, thinking: undefined, error: undefined, modelId: undefined, lmParameters: undefined, toolCalls: undefined
      } as MessageNode,
    ];

    const { chatFlow } = useChatDisplayFlow({
      activeMessages: computed(() => messages),
      isProcessing: computed(() => false)
    });

    const result = JSON.parse(JSON.stringify(chatFlow.value));

    // atoms: a1(T1), a1(C1), a1(T2), a1(TC), t1(TG)
    // grouped:
    //   message(a1, thinking, T1) -> standalone internal
    //   message(a1, content, C1) -> external (BREAKS)
    //   sequence(a1_T2, a1_TC, t1_TG) -> internal sequence

    expect(result).toHaveLength(3);
    expect(result[0].mode).toBe('thinking');
    expect(result[1].mode).toBe('content');
    expect(result[2].type).toBe('process_sequence');
    expect(result[2].items).toHaveLength(3);
  });

  it('handles empty assistant messages and single internal atoms', () => {
    const messages: MessageNode[] = [
      {
        id: 'a1', role: 'assistant', content: '', timestamp: 0, replies: { items: [] },
        attachments: undefined, thinking: undefined, error: undefined, modelId: 'm', lmParameters: undefined, toolCalls: undefined, results: undefined
      } as MessageNode,
    ];

    const { chatFlow } = useChatDisplayFlow({
      activeMessages: computed(() => messages),
      isProcessing: computed(() => true)
    });

    const result = JSON.parse(JSON.stringify(chatFlow.value));

    // atoms: a1(waiting)
    expect(result).toHaveLength(1);
    expect(result[0].mode).toBe('waiting');
    expect(result[0].isFirstInTurn).toBe(true);
  });

  it('does NOT create a sequence for a single internal atom', () => {
    const messages: MessageNode[] = [
      {
        id: 'a1', role: 'assistant', content: '<think>Just one think</think>', timestamp: 0, replies: { items: [] },
        attachments: undefined, thinking: undefined, error: undefined, modelId: 'm', lmParameters: undefined, toolCalls: undefined, results: undefined
      } as MessageNode,
    ];

    const { chatFlow } = useChatDisplayFlow({
      activeMessages: computed(() => messages),
      isProcessing: computed(() => false)
    });

    const result = JSON.parse(JSON.stringify(chatFlow.value));

    expect(result).toHaveLength(1);
    expect(result[0].type).toBe('message');
    expect(result[0].mode).toBe('thinking');
  });
});
