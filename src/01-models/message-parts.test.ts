import { describe, expect, expectTypeOf, it } from 'vitest';
import type { ChatGenerationItem, ChatGenerationResult, LmProvider } from './lm';
import type { AssistantMessageNode, ChatMessage, MessageNode, ToolCall, ToolMessageNode } from './types';
import type { ToolExecutionResult } from './tool';
import { toMessageId, toToolCallId } from './ids';

// These tests exercise the model contract, not a provider or the storage mapper.
describe('message parts', () => {
  it('keeps ordered reasoning, literal tags, and a completed call as separate parts', () => {
    const node: AssistantMessageNode = {
      id: toMessageId({ raw: 'assistant-1' }),
      role: 'assistant',
      createdAt: 12,
      modelId: undefined,
      lmParameters: undefined,
      parts: [
        { type: 'reasoning', text: '  Reason\n', completeness: 'complete' },
        { type: 'text', text: '<think>literal</think>', completeness: 'partial' },
        { type: 'tool_call', toolCall: {
          id: toToolCallId({ raw: 'call-1' }), type: 'function',
          function: { name: 'calculator', arguments: ' { "expression": "1 + 1" } ' },
        } },
      ],
      interruption: { type: 'cancelled' },
      replies: { items: [] },
    };

    expect(node.parts.map(part => part.type)).toEqual(['reasoning', 'text', 'tool_call']);
    expect(node.parts[0]).toMatchObject({ text: '  Reason\n', completeness: 'complete' });
    expect(node.parts[1]).toMatchObject({ text: '<think>literal</think>', completeness: 'partial' });
    expect(node.parts[2]).toMatchObject({ toolCall: { function: { arguments: ' { "expression": "1 + 1" } ' } } });
    const history: ChatMessage = { id: node.id, role: node.role, parts: node.parts };
    expect(history.parts).toBe(node.parts);
    expect(Object.hasOwn(history, 'interruption')).toBe(false);
    expect(Object.hasOwn(history, 'replies')).toBe(false);
  });

  it('distinguishes no text part from an explicitly empty text part', () => {
    const absent: AssistantMessageNode['parts'] = [];
    const empty: AssistantMessageNode['parts'] = [{ type: 'text', text: '', completeness: 'complete' }];
    expect(absent).not.toEqual(empty);
  });

  it('reuses tool payloads and requires explicit application completeness', () => {
    type AssistantPart = AssistantMessageNode['parts'][number];
    expectTypeOf<Extract<AssistantPart, { type: 'tool_call' }>['toolCall']>().toEqualTypeOf<ToolCall>();
    expectTypeOf<ToolMessageNode['parts'][number]['result']>().toEqualTypeOf<ToolExecutionResult>();
    expectTypeOf<Extract<AssistantPart, { type: 'text' }>['completeness']>().toEqualTypeOf<'complete' | 'partial'>();
    expectTypeOf<Extract<AssistantPart, { type: 'attachment' | 'tool_call_draft' }>>().toEqualTypeOf<never>();
    expectTypeOf<Extract<keyof MessageNode, 'content' | 'thinking' | 'timestamp'>>().toEqualTypeOf<never>();
  });

  it('uses a local nested generation contract with explicit arguments and no resume mode', () => {
    type Request = Parameters<LmProvider['chat']>[0];
    type OptionalKeys<T> = { [K in keyof T]-?: object extends Pick<T, K> ? K : never }[keyof T];
    expectTypeOf<OptionalKeys<Request>>().toEqualTypeOf<never>();
    expectTypeOf<Extract<keyof Request, 'onChunk' | 'onEvent' | 'generationMode' | 'output'>>().toEqualTypeOf<never>();
    expectTypeOf<ReturnType<LmProvider['chat']>>().toEqualTypeOf<AsyncIterable<ChatGenerationItem>>();
    expectTypeOf<Extract<ChatGenerationResult, { type: 'finished' }>['next']>().toEqualTypeOf<'user' | 'tool_results'>();
    expectTypeOf<Extract<ChatGenerationItem, { type: 'text' | 'reasoning' }>['chunks']>().toEqualTypeOf<AsyncIterable<string>>();
  });
});
