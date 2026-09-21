import { describe, it, expect, beforeEach } from 'vitest';
import { computed } from 'vue';
import { useChatDisplayFlow } from './useChatDisplayFlow';
import { ensureAllStringsForTest } from '@/strings/test-utils';
import type { MessageNode, Chat } from '@/01-models/types';
import { toChatId, toMessageId, toToolCallId } from '@/01-models/ids';

describe('useChatDisplayFlow complex scenario', () => {
  beforeEach(async () => {
    await ensureAllStringsForTest({ locale: 'en' });
  });

  const createChat = (messages: MessageNode[]) => {
    // Build tree
    for (let i = 0; i < messages.length - 1; i++) {
      messages[i]!.replies.items = [messages[i+1]!];
    }
    return computed<Chat>(() => ({
      id: toChatId({ raw: 'test-chat' }),
      title: 'Test',
      root: { items: messages.length > 0 ? [messages[0]!] : [] },
      currentLeafId: messages.length > 0 ? messages[messages.length - 1]!.id : undefined,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      debugEnabled: false,
    } as Chat));
  };

  it('correctly atomizes and groups the reported complex scenario with full JSON validation', () => {
    const messages: MessageNode[] = [
      {
        id: toMessageId({ raw: 'u1' }),
        role: 'user',
        replies: { items: [] },
        lmParameters: undefined,
        modelId: undefined,
        parts: [{ id: 'text', type: 'text' as const, text: 'Calc', completeness: 'complete' as const }, ...([]).map((attachment, index) => ({ id: `attachment-${index}`, type: 'attachment' as const, attachment }))],
        createdAt: 0,
      } as MessageNode,
      {
        id: toMessageId({ raw: 'a1' }),
        role: 'assistant',
        replies: { items: [] },
        modelId: 'm',
        lmParameters: undefined,
        parts: [{ id: 'text', type: 'text' as const, text: '<think>T1</think>', completeness: 'complete' as const }, ...([{ id: toToolCallId({ raw: 'tc1' }), type: 'function' as const, function: { name: 'c', arguments: '{}' } }]).map((toolCall, index) => ({ id: `tool_call-${index}`, type: 'tool_call' as const, toolCall }))],
        createdAt: 0,
        interruption: undefined,
      } as MessageNode,
      {
        id: toMessageId({ raw: 't1' }),
        role: 'tool',
        replies: { items: [] },
        modelId: undefined,
        lmParameters: undefined,
        parts: [...([{ toolCallId: toToolCallId({ raw: 'tc1' }), status: 'success', content: { type: 'text', text: 'R1' } }]).map((result, index) => ({ id: `tool_result-${index}`, type: 'tool_result' as const, result }))],
        createdAt: 0,
      } as MessageNode,
      {
        id: toMessageId({ raw: 'am' }),
        role: 'assistant',
        replies: { items: [] },
        modelId: 'm',
        lmParameters: undefined,
        parts: [{ id: 'text', type: 'text' as const, text: '<think>TM</think>Body', completeness: 'complete' as const }, ...([{ id: toToolCallId({ raw: 'tcm' }), type: 'function' as const, function: { name: 'c', arguments: '{}' } }]).map((toolCall, index) => ({ id: `tool_call-${index}`, type: 'tool_call' as const, toolCall }))],
        createdAt: 0,
        interruption: undefined,
      } as MessageNode,
      {
        id: toMessageId({ raw: 'tm' }),
        role: 'tool',
        replies: { items: [] },
        modelId: undefined,
        lmParameters: undefined,
        parts: [...([{ toolCallId: toToolCallId({ raw: 'tcm' }), status: 'success', content: { type: 'text', text: 'RM' } }]).map((result, index) => ({ id: `tool_result-${index}`, type: 'tool_result' as const, result }))],
        createdAt: 0,
      } as MessageNode,
      {
        id: toMessageId({ raw: 'al' }),
        role: 'assistant',
        replies: { items: [] },
        modelId: 'm',
        lmParameters: undefined,
        parts: [{ id: 'text', type: 'text' as const, text: '<think>TL</think>End', completeness: 'complete' as const }],
        createdAt: 0,
        interruption: undefined,
      } as MessageNode,
    ];

    const { chatFlow } = useChatDisplayFlow({
      chat: createChat(messages),
      isProcessing: () => false,
    });

    const result = JSON.parse(JSON.stringify(chatFlow.value));

    const expected = [
      {
        type: 'message', key: expect.any(String),
        node: expect.objectContaining({ id: 'u1' }),
        mode: 'content',
        partContent: 'Calc',
        isFirstInNode: true,
        isLastInNode: true,
        isFirstInTurn: true,
        flow: { position: 'standalone', nesting: 'none' },
      },
      {
        type: 'process_sequence',
        id: `seq-${JSON.stringify(['a1', JSON.stringify(['text', 0])])}`,
        isFirstInTurn: true,
        stats: {
          thinkingSteps: 2,
          toolCallCount: 1,
          toolNames: ['c'],
          isCurrentlyThinking: false,
          isCurrentlyToolRunning: false,
          isWaiting: false,
        },
        items: [
          { type: 'message', key: expect.any(String), node: expect.objectContaining({ id: 'a1' }), mode: 'thinking', partContent: 'T1', isFirstInNode: true, isLastInNode: false, isFirstInTurn: true, isCompletedThinking: true, flow: { position: 'standalone', nesting: 'inside-group' } },
          { type: 'message', key: expect.any(String), node: expect.objectContaining({ id: 'a1' }), mode: 'tool_calls', toolCalls: expect.any(Array), isFirstInNode: false, isLastInNode: true, isFirstInTurn: false, isCompletedThinking: undefined, flow: { position: 'standalone', nesting: 'inside-group' } },
          { type: 'tool_group', id: 't1', node: expect.objectContaining({ id: 't1' }), toolCalls: [expect.objectContaining({ id: 'tc1' })], flow: { position: 'standalone', nesting: 'inside-group' }, isFirstInTurn: true },
          { type: 'message', key: expect.any(String), node: expect.objectContaining({ id: 'am' }), mode: 'thinking', partContent: 'TM', isFirstInNode: true, isLastInNode: false, isFirstInTurn: true, isCompletedThinking: true, flow: { position: 'standalone', nesting: 'inside-group' } },
        ],
        flow: { position: 'start', nesting: 'none' },
      },
      {
        type: 'message', key: expect.any(String),
        node: expect.objectContaining({ id: 'am' }),
        mode: 'content',
        partContent: 'Body',
        isFirstInNode: false,
        isLastInNode: false,
        isFirstInTurn: false,
        flow: { position: 'middle', nesting: 'none' },
      },
      {
        type: 'process_sequence',
        id: `seq-${JSON.stringify(['am', JSON.stringify(['tool_call-0'])])}`,
        isFirstInTurn: false,
        stats: {
          thinkingSteps: 1,
          toolCallCount: 1,
          toolNames: ['c'],
          isCurrentlyThinking: false,
          isCurrentlyToolRunning: false,
          isWaiting: false,
        },
        items: [
          { type: 'message', key: expect.any(String), node: expect.objectContaining({ id: 'am' }), mode: 'tool_calls', toolCalls: expect.any(Array), isFirstInNode: false, isLastInNode: true, isFirstInTurn: false, isCompletedThinking: undefined, flow: { position: 'standalone', nesting: 'inside-group' } },
          { type: 'tool_group', id: 'tm', node: expect.objectContaining({ id: 'tm' }), toolCalls: [expect.objectContaining({ id: 'tcm' })], flow: { position: 'standalone', nesting: 'inside-group' }, isFirstInTurn: true },
          { type: 'message', key: expect.any(String), node: expect.objectContaining({ id: 'al' }), mode: 'thinking', partContent: 'TL', isFirstInNode: true, isLastInNode: false, isFirstInTurn: true, isCompletedThinking: true, flow: { position: 'standalone', nesting: 'inside-group' } },
        ],
        flow: { position: 'middle', nesting: 'none' },
      },
      {
        type: 'message', key: expect.any(String),
        node: expect.objectContaining({ id: 'al' }),
        mode: 'content',
        partContent: 'End',
        isFirstInNode: false,
        isLastInNode: true,
        isFirstInTurn: false,
        flow: { position: 'end', nesting: 'none' },
      },
    ];

    expect(result).toEqual(expected);
  });

  it('correctly handles streaming state with active thinking and waiting', () => {
    const messages: MessageNode[] = [
      {
        id: toMessageId({ raw: 'u1' }),
        role: 'user',
        replies: { items: [] },
        lmParameters: undefined,
        modelId: undefined,
        parts: [{ id: 'text', type: 'text' as const, text: 'Hi', completeness: 'complete' as const }, ...([]).map((attachment, index) => ({ id: `attachment-${index}`, type: 'attachment' as const, attachment }))],
        createdAt: 0,
      } as MessageNode,
      {
        id: toMessageId({ raw: 'a1' }),
        role: 'assistant',
        replies: { items: [] },
        modelId: 'm',
        lmParameters: undefined,
        parts: [{ id: 'text', type: 'text' as const, text: 'Answer<think>Active', completeness: 'complete' as const }],
        createdAt: 0,
        interruption: undefined,
      } as MessageNode,
    ];

    const { chatFlow } = useChatDisplayFlow({
      chat: createChat(messages),
      isProcessing: () => true,
    });

    const result = JSON.parse(JSON.stringify(chatFlow.value));

    const expected = [
      {
        type: 'message', key: expect.any(String),
        node: expect.objectContaining({ id: 'u1' }),
        mode: 'content',
        partContent: 'Hi',
        isFirstInNode: true,
        isLastInNode: true,
        isFirstInTurn: true,
        flow: { position: 'standalone', nesting: 'none' },
      },
      {
        type: 'message', key: expect.any(String),
        node: expect.objectContaining({ id: 'a1' }),
        mode: 'content',
        partContent: 'Answer',
        isFirstInNode: true,
        isLastInNode: false,
        isFirstInTurn: true,
        flow: { position: 'start', nesting: 'none' },
      },
      {
        type: 'message', key: expect.any(String),
        node: expect.objectContaining({ id: 'a1' }),
        mode: 'thinking',
        partContent: 'Active',
        isFirstInNode: false,
        isLastInNode: true,
        isFirstInTurn: false,
        isCompletedThinking: false,
        flow: { position: 'end', nesting: 'none' },
      },
    ];

    expect(result).toEqual(expected);
  });

  it('handles multiple think blocks and intermixed tool groups', () => {
    const messages: MessageNode[] = [
      {
        id: toMessageId({ raw: 'a1' }),
        role: 'assistant',
        replies: { items: [] },
        modelId: 'm',
        lmParameters: undefined,
        parts: [{ id: 'text', type: 'text' as const, text: '<think>T1</think>C1<think>T2</think>', completeness: 'complete' as const }, ...([{ id: toToolCallId({ raw: 'tc1' }), type: 'function' as const, function: { name: 'f', arguments: '{}' } }]).map((toolCall, index) => ({ id: `tool_call-${index}`, type: 'tool_call' as const, toolCall }))],
        createdAt: 0,
        interruption: undefined,
      } as MessageNode,
      {
        id: toMessageId({ raw: 't1' }),
        role: 'tool',
        replies: { items: [] },
        modelId: undefined,
        lmParameters: undefined,
        parts: [...([{ toolCallId: toToolCallId({ raw: 'tc1' }), status: 'success', content: { type: 'text', text: 'R' } }]).map((result, index) => ({ id: `tool_result-${index}`, type: 'tool_result' as const, result }))],
        createdAt: 0,
      } as MessageNode,
    ];

    const { chatFlow } = useChatDisplayFlow({
      chat: createChat(messages),
      isProcessing: () => false,
    });

    const result = JSON.parse(JSON.stringify(chatFlow.value));

    expect(result).toHaveLength(3);
    expect(result[0].mode).toBe('thinking');
    expect(result[1].mode).toBe('content');
    expect(result[2].type).toBe('process_sequence');
    expect(result[2].items).toHaveLength(3);
  });

  it('handles empty assistant messages and single internal atoms', () => {
    const messages: MessageNode[] = [
      {
        id: toMessageId({ raw: 'a1' }),
        role: 'assistant',
        replies: { items: [] },
        modelId: 'm',
        lmParameters: undefined,
        parts: [{ id: 'text', type: 'text' as const, text: '', completeness: 'complete' as const }],
        createdAt: 0,
        interruption: undefined,
      } as MessageNode,
    ];

    const { chatFlow } = useChatDisplayFlow({
      chat: createChat(messages),
      isProcessing: () => true,
    });

    const result = JSON.parse(JSON.stringify(chatFlow.value));

    expect(result).toHaveLength(1);
    expect(result[0].mode).toBe('waiting');
    expect(result[0].isFirstInTurn).toBe(true);
  });

  it('does NOT create a sequence for a single internal atom', () => {
    const messages: MessageNode[] = [
      {
        id: toMessageId({ raw: 'a1' }),
        role: 'assistant',
        replies: { items: [] },
        modelId: 'm',
        lmParameters: undefined,
        parts: [{ id: 'text', type: 'text' as const, text: '<think>Just one think</think>', completeness: 'complete' as const }],
        createdAt: 0,
        interruption: undefined,
      } as MessageNode,
    ];

    const { chatFlow } = useChatDisplayFlow({
      chat: createChat(messages),
      isProcessing: () => false,
    });

    const result = JSON.parse(JSON.stringify(chatFlow.value));

    expect(result).toHaveLength(1);
    expect(result[0].type).toBe('message');
    expect(result[0].mode).toBe('thinking');
  });
});
