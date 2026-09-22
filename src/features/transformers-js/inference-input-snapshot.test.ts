// @vitest-environment node
import { describe, expect, expectTypeOf, it } from 'vitest';
import type { ChatMessage } from '@/01-models/types';
import { EMPTY_LM_PARAMETERS } from '@/01-models/types';
import { toToolCallId } from '@/01-models/ids';
import type { InferenceMessage, WorkerToolDefinition } from './types';
import { cloneChatMessages, cloneLmParameters, cloneWorkerTools } from './inference-input-snapshot';

// Native template inputs are deliberately not the persisted or application shape.
describe('inference input snapshots', () => {
  it('distinguishes projected messages from parts-based application history', () => {
    expectTypeOf<ChatMessage>().not.toExtend<InferenceMessage>();
    expectTypeOf<InferenceMessage>().not.toExtend<ChatMessage>();
    expectTypeOf<Parameters<typeof cloneChatMessages>[0]['messages']>().toEqualTypeOf<readonly InferenceMessage[]>();
  });

  it('does not materialize absent or undefined native tool fields', () => {
    for (const message of [
      { role: 'assistant', content: '' },
      { role: 'assistant', content: '', tool_calls: undefined, tool_call_id: undefined },
    ] satisfies InferenceMessage[]) {
      const [copy] = cloneChatMessages({ messages: [message] });
      expect(copy).toEqual({ role: 'assistant', content: '' });
      expect(Object.hasOwn(copy!, 'tool_calls')).toBe(false);
      expect(Object.hasOwn(copy!, 'tool_call_id')).toBe(false);
    }
  });

  it('retains an explicitly empty call list and empty result identifier', () => {
    const message: InferenceMessage = { role: 'tool', content: '', tool_calls: [], tool_call_id: toToolCallId({ raw: '' }) };
    const [copy] = cloneChatMessages({ messages: [message] });
    expect(copy).toEqual(message);
    expect(Object.hasOwn(copy!, 'tool_calls')).toBe(true);
    expect(Object.hasOwn(copy!, 'tool_call_id')).toBe(true);
    expect(copy!.tool_calls).not.toBe(message.tool_calls);
  });

  it('preserves literal think markup, whitespace and Unicode without parsing', () => {
    const message: InferenceMessage = { role: 'assistant', content: `\
<think>  原文🙂
</think>本文  ` };
    const [copy] = cloneChatMessages({ messages: [message] });
    expect(copy).toEqual(message);
    expect(Object.hasOwn(copy!, 'reasoning_content')).toBe(false);
    expect(Object.hasOwn(copy!, 'thinking')).toBe(false);
    expect(copy).not.toBe(message);
  });

  it('preserves multimodal boundaries and isolates nested image and text fields', () => {
    const content = [{ type: 'text' as const, text: '' }, { type: 'image_url' as const, image_url: { url: 'data:image/png;base64,AAAA' } }, { type: 'text' as const, text: '  after\r\n' }];
    const messages: InferenceMessage[] = [{ role: 'user', content }];
    const copy = cloneChatMessages({ messages });
    content[1]!.image_url!.url = 'data:image/png;base64,BBBB';
    content[2]!.text = 'edited';
    messages.push({ role: 'assistant', content: 'later' });
    expect(copy).toEqual([{ role: 'user', content: [
      { type: 'text', text: '' }, { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } }, { type: 'text', text: '  after\r\n' },
    ] }]);
  });

  it('keeps native string, empty array and repeated text elements distinct', () => {
    const messages: InferenceMessage[] = [
      { role: 'assistant', content: '' },
      { role: 'assistant', content: [] },
      { role: 'assistant', content: [{ type: 'text', text: 'A' }, { type: 'text', text: 'A' }] },
    ];
    expect(cloneChatMessages({ messages })).toEqual(messages);
  });

  it('copies call arguments exactly without parsing incomplete or formatted JSON', () => {
    for (const args of ['{ "n": 1 }', '{"n":']) {
      const call = { id: toToolCallId({ raw: 'call-1' }), type: 'function' as const, function: { name: 'f', arguments: args } };
      const messages: InferenceMessage[] = [{ role: 'assistant', content: '', tool_calls: [call] }];
      const [copy] = cloneChatMessages({ messages });
      call.function.arguments = '{}';
      call.function.name = 'changed';
      expect(copy!.tool_calls![0]!.function).toEqual({ name: 'f', arguments: args });
    }
  });

  it('keeps parameter absence and empty stop lists distinct and detaches reasoning', () => {
    expect(cloneLmParameters({ params: undefined })).toBeUndefined();
    const params = { ...EMPTY_LM_PARAMETERS, stop: [], reasoning: { effort: 'high' as const } };
    const copied = cloneLmParameters({ params });
    expect(copied).toEqual(params);
    expect(copied!.reasoning).not.toBe(params.reasoning);
    expect(copied!.stop).not.toBe(params.stop);
    const empty = cloneLmParameters({ params: EMPTY_LM_PARAMETERS });
    expect(empty!.stop).toBeUndefined();
  });

  it('detaches tool schemas without dropping JSON false and null', () => {
    const tools: WorkerToolDefinition[] = [{ type: 'function', function: { name: 'f', description: '', parameters: { type: 'object', additionalProperties: false, nested: { default: null } } } }];
    const copy = cloneWorkerTools({ tools });
    tools[0]!.function.parameters.additionalProperties = true;
    expect(copy![0]!.function.parameters).toEqual({ type: 'object', additionalProperties: false, nested: { default: null } });
    expect(cloneWorkerTools({ tools: undefined })).toBeUndefined();
    expect(cloneWorkerTools({ tools: [] })).toEqual([]);
  });
});
