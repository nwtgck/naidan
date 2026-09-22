// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ChatMessage } from '@/01-models/types';
import { EMPTY_LM_PARAMETERS } from '@/01-models/types';
import type { LmProvider } from '@/01-models/lm';
import { toAttachmentId, toBinaryObjectId, toMessageId, toToolCallId } from '@/01-models/ids';
import { prepareInferenceRequest } from './message-projection';

const messageId = toMessageId({ raw: 'm' });
const callId = toToolCallId({ raw: 'call-1' });
const binaryId = toBinaryObjectId({ raw: 'binary-1' });
const makeText = ({ text }: { text: string }) => ({ type: 'text' as const, text, completeness: 'complete' as const });
const makeCall = ({ argumentsText }: { argumentsText: string }) => ({
  type: 'tool_call' as const,
  toolCall: { id: callId, type: 'function' as const, function: { name: 'calculator', arguments: argumentsText } },
});
function image({ state }: { state: { status: 'memory', blob: Blob } | { status: 'persisted' | 'missing' } }): Extract<Extract<ChatMessage, { role: 'user' }>['parts'][number], { type: 'attachment' }> {
  return { type: 'attachment', attachment: {
    id: toAttachmentId({ raw: 'attachment-1' }), binaryObjectId: binaryId,
    originalName: 'image.png', mimeType: 'image/png', size: 3, uploadedAt: 1, ...state,
  } };
}
function prepare({ messages, readBinaryObject, signal }: {
  messages: readonly ChatMessage[],
  readBinaryObject: Parameters<LmProvider['chat']>[0]['readBinaryObject'],
  signal: AbortSignal | undefined,
}) {
  return prepareInferenceRequest({ messages, readBinaryObject, signal, parameters: undefined, tools: undefined });
}

// No production model or Worker is loaded by this boundary suite.
describe('parts to Transformers.js inference input', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('keeps literal think text, whitespace and partial history unchanged', async () => {
    const raw = `\
<think>  literal🙂
</think> answer  `;
    const text = { ...makeText({ text: raw }), completeness: 'partial' as const };
    const result = await prepare({ messages: [{ id: messageId, role: 'assistant', parts: [text] }], readBinaryObject: undefined, signal: undefined });
    expect(result).toEqual({ messages: [{ role: 'assistant', content: raw }], params: undefined, tools: undefined });
    expect(text.completeness).toBe('partial');
    expect(Object.hasOwn(result.messages[0]!, 'reasoning_content')).toBe(false);
    expect(Object.hasOwn(result.messages[0]!, 'tool_calls')).toBe(false);
  });

  it('keeps absent body, explicit empty text and multiple text boundaries distinct', async () => {
    const messages: ChatMessage[] = [
      { id: messageId, role: 'assistant', parts: [] },
      { id: messageId, role: 'assistant', parts: [makeText({ text: '' })] },
      { id: messageId, role: 'system', parts: [makeText({ text: '' }), { ...makeText({ text: ' R ' }), }] },
    ];
    const result = await prepare({ messages, readBinaryObject: undefined, signal: undefined });
    expect(result.messages).toEqual([
      { role: 'assistant', content: [] }, { role: 'assistant', content: '' },
      { role: 'system', content: [{ type: 'text', text: '' }, { type: 'text', text: ' R ' }] },
    ]);
  });

  it('does not deduplicate identical text parts', async () => {
    const result = await prepare({ messages: [{ id: messageId, role: 'user', parts: [makeText({ text: 'A' }), { ...makeText({ text: 'A' }), }] }], readBinaryObject: undefined, signal: undefined });
    expect(result.messages[0]!.content).toEqual([{ type: 'text', text: 'A' }, { type: 'text', text: 'A' }]);
  });

  it('retains complete calls, argument spelling and field absence without parsing arguments', async () => {
    for (const argumentsText of [' { "n": 1 } ', '{"partial":']) {
      const result = await prepare({ messages: [{ id: messageId, role: 'assistant', parts: [makeCall({ argumentsText })] }], readBinaryObject: undefined, signal: undefined });
      expect(result.messages).toEqual([{ role: 'assistant', content: [], tool_calls: [makeCall({ argumentsText }).toolCall] }]);
      expect(Object.hasOwn(result.messages[0]!, 'tool_call_id')).toBe(false);
    }
  });

  it('preserves the order of calls after body text', async () => {
    const second = { ...makeCall({ argumentsText: '{}' }), id: 'call-2' };
    second.toolCall.id = toToolCallId({ raw: 'call-2' });
    const result = await prepare({ messages: [{ id: messageId, role: 'assistant', parts: [makeText({ text: 'prefix' }), makeCall({ argumentsText: ' {} ' }), second] }], readBinaryObject: undefined, signal: undefined });
    expect(result.messages[0]).toEqual({ role: 'assistant', content: 'prefix', tool_calls: [makeCall({ argumentsText: ' {} ' }).toolCall, second.toolCall] });
  });

  it('rejects text after a call instead of silently moving it before the call', async () => {
    await expect(prepare({ messages: [{ id: messageId, role: 'assistant', parts: [makeCall({ argumentsText: '{}' }), makeText({ text: 'after' })] }], readBinaryObject: undefined, signal: undefined })).rejects.toThrow('text after a tool call');
  });

  it('preserves a single leading reasoning part, including empty and partial, for the model adapter', async () => {
    for (const text of ['', ' R ']) {
      for (const completeness of ['complete', 'partial'] as const) {
        const original: ChatMessage = { id: messageId, role: 'assistant', parts: [{ type: 'reasoning', text, completeness }, makeText({ text: '<think>literal</think>' })] };
        const result = await prepare({ messages: [original], readBinaryObject: undefined, signal: undefined });
        expect(result.messages).toEqual([{ role: 'assistant', content: '<think>literal</think>', reasoning: { text, completeness } }]);
        expect(original.parts[0]).toEqual({ type: 'reasoning', text, completeness });
      }
    }
  });

  it('does not combine repeated reasoning parts or reorder reasoning after text or calls', async () => {
    const reason = { type: 'reasoning' as const, text: 'R', completeness: 'complete' as const };
    for (const parts of [[reason, { ...reason, id: 'r2' }], [makeText({ text: '' }), reason], [makeCall({ argumentsText: '{}' }), reason]]) {
      await expect(prepare({ messages: [{ id: messageId, role: 'assistant', parts }], readBinaryObject: undefined, signal: undefined })).rejects.toThrow('single leading reasoning');
    }
  });

  it('validates the entire history before resolving any binaries', async () => {
    const read = vi.fn();
    await expect(prepare({ messages: [
      { id: messageId, role: 'user', parts: [image({ state: { status: 'persisted' } })] },
      { id: messageId, role: 'assistant', parts: [makeText({ text: '' }), { type: 'reasoning', text: '', completeness: 'partial' }] },
    ], readBinaryObject: read, signal: undefined })).rejects.toThrow('single leading reasoning');
    expect(read).not.toHaveBeenCalled();
  });

  it('encodes memory images locally without using fetch or the binary resolver', async () => {
    const fetch = vi.fn(); vi.stubGlobal('fetch', fetch);
    const read = vi.fn();
    const result = await prepare({ messages: [{ id: messageId, role: 'user', parts: [
      makeText({ text: 'before' }), image({ state: { status: 'memory', blob: new Blob([new Uint8Array([0, 1, 255])]) } }), { ...makeText({ text: '' }), },
    ] }], readBinaryObject: read, signal: undefined });
    expect(result.messages[0]!.content).toEqual([
      { type: 'text', text: 'before' }, { type: 'image_url', image_url: { url: 'data:image/png;base64,AAH/' } }, { type: 'text', text: '' },
    ]);
    expect(fetch).not.toHaveBeenCalled(); expect(read).not.toHaveBeenCalled();
  });

  it('passes the exact binary identifier and signal to the caller resolver', async () => {
    const signal = new AbortController().signal;
    const read = vi.fn<NonNullable<Parameters<LmProvider['chat']>[0]['readBinaryObject']>>().mockResolvedValue(new Blob(['abc']));
    const result = await prepare({ messages: [{ id: messageId, role: 'user', parts: [image({ state: { status: 'persisted' } })] }], readBinaryObject: read, signal });
    expect(read).toHaveBeenCalledExactlyOnceWith({ binaryObjectId: binaryId, signal });
    expect(result.messages[0]!.content).toEqual([{ type: 'image_url', image_url: { url: 'data:image/png;base64,YWJj' } }]);
  });

  it('does not ignore missing attachments, absent resolvers, or unsupported file kinds', async () => {
    await expect(prepare({ messages: [{ id: messageId, role: 'user', parts: [image({ state: { status: 'missing' } })] }], readBinaryObject: undefined, signal: undefined })).rejects.toThrow('missing');
    await expect(prepare({ messages: [{ id: messageId, role: 'user', parts: [image({ state: { status: 'persisted' } })] }], readBinaryObject: undefined, signal: undefined })).rejects.toThrow('No binary reader');
    const file = image({ state: { status: 'memory', blob: new Blob(['text']) } }); file.attachment.mimeType = 'text/plain';
    await expect(prepare({ messages: [{ id: messageId, role: 'user', parts: [file] }], readBinaryObject: undefined, signal: undefined })).rejects.toThrow('image attachments only');
  });

  it('keeps message, call, parameters and declaration snapshots stable while a binary read waits', async () => {
    const pending = Promise.withResolvers<Blob>();
    const file = image({ state: { status: 'persisted' } });
    const call = makeCall({ argumentsText: ' { "n": 1 } ' });
    const messages: ChatMessage[] = [{ id: messageId, role: 'user', parts: [file] }, { id: messageId, role: 'assistant', parts: [call] }];
    const parameters = { ...EMPTY_LM_PARAMETERS, stop: [' stop '], reasoning: { effort: 'high' as const } };
    const tools = [{ name: 'calculator', description: '', parameters: { type: 'object', properties: { n: { default: null } }, additionalProperties: false } }];
    const result = prepareInferenceRequest({ messages, parameters, tools, readBinaryObject: () => pending.promise, signal: undefined });
    file.attachment.mimeType = 'image/jpeg';
    call.toolCall.function.arguments = '{}'; parameters.stop[0] = 'changed'; tools[0]!.parameters.additionalProperties = true;
    messages.push({ id: messageId, role: 'system', parts: [] });
    pending.resolve(new Blob(['x']));
    const prepared = await result;
    expect(prepared.messages).toHaveLength(2);
    expect(prepared.messages[0]!.content).toEqual([{ type: 'image_url', image_url: { url: 'data:image/png;base64,eA==' } }]);
    expect(prepared.messages[1]!.tool_calls![0]!.function.arguments).toBe(' { "n": 1 } ');
    expect(prepared.params!.stop).toEqual([' stop ']);
    expect(prepared.tools![0]!.function.parameters).toEqual({ type: 'object', properties: { n: { default: null } }, additionalProperties: false });
  });

  it('does not materialize unspecified settings or declarations', async () => {
    const prepared = await prepare({ messages: [], signal: undefined, readBinaryObject: undefined });
    expect(prepared).toEqual({ messages: [], params: undefined, tools: undefined });
    expect((await prepareInferenceRequest({ messages: [], parameters: EMPTY_LM_PARAMETERS, tools: [], readBinaryObject: undefined, signal: undefined })).tools).toEqual([]);
  });

  it('rejects non-JSON tool declarations before reading binaries', async () => {
    const read = vi.fn();
    const bad = { type: 'object', bad: () => {} };
    const tools = [{ name: 'f', description: '', parameters: bad }];
    // @ts-expect-error Exercise a malformed caller at the serialization boundary.
    await expect(prepareInferenceRequest({ messages: [], parameters: undefined, tools, readBinaryObject: read, signal: undefined })).rejects.toThrow();
    expect(read).not.toHaveBeenCalled();
  });

  it('preserves inline tool success and error text and expands each result in order', async () => {
    const result = await prepare({ messages: [{ id: messageId, role: 'tool', parts: [
      { type: 'tool_result', result: { toolCallId: callId, status: 'success', content: { type: 'text', text: '  result\r\n' } } },
      { type: 'tool_result', result: { toolCallId: toToolCallId({ raw: 'call-2' }), status: 'error', error: { code: 'invalid_arguments', message: { type: 'text', text: '説明' } } } },
    ] }], readBinaryObject: undefined, signal: undefined });
    expect(result.messages).toEqual([
      { role: 'tool', tool_call_id: callId, content: '  result\r\n' },
      { role: 'tool', tool_call_id: toToolCallId({ raw: 'call-2' }), content: 'Error [invalid_arguments]: 説明' },
    ]);
  });

  it('preserves a tool result BOM and Unicode across a binary reference', async () => {
    const value = '\uFEFF  🙂e\u0301\r\n';
    const read = vi.fn().mockResolvedValue(new Blob([new TextEncoder().encode(value)]));
    const result = await prepare({ messages: [{ id: messageId, role: 'tool', parts: [{ type: 'tool_result', result: { toolCallId: callId, status: 'success', content: { type: 'binary_object', id: binaryId } } }] }], readBinaryObject: read, signal: undefined });
    expect(result.messages[0]!.content).toBe(value);
  });

  it('does not replace invalid tool result bytes with replacement characters', async () => {
    const read = vi.fn().mockResolvedValue(new Blob([new Uint8Array([0xff])]));
    await expect(prepare({ messages: [{ id: messageId, role: 'tool', parts: [{ type: 'tool_result', result: { toolCallId: callId, status: 'success', content: { type: 'binary_object', id: binaryId } } }] }], readBinaryObject: read, signal: undefined })).rejects.toThrow();
  });

  it('rejects unresolved or empty tool results without inventing content', async () => {
    for (const parts of [[], [{ type: 'tool_result' as const, result: { toolCallId: callId, status: 'executing' as const } }]]) {
      await expect(prepare({ messages: [{ id: messageId, role: 'tool', parts }], readBinaryObject: undefined, signal: undefined })).rejects.toThrow();
    }
  });

  it('retains the original resolver error rather than yielding empty content', async () => {
    const error = new Error('local blob unavailable');
    await expect(prepare({ messages: [{ id: messageId, role: 'user', parts: [image({ state: { status: 'persisted' } })] }], readBinaryObject: async () => {
      throw error;
    }, signal: undefined })).rejects.toBe(error);
  });

  it('does not begin resolution for an already aborted request', async () => {
    const controller = new AbortController(); controller.abort(new Error('stop'));
    const read = vi.fn();
    await expect(prepare({ messages: [{ id: messageId, role: 'user', parts: [image({ state: { status: 'persisted' } })] }], readBinaryObject: read, signal: controller.signal })).rejects.toThrow('stop');
    expect(read).not.toHaveBeenCalled();
  });

  it('does not publish a request if a resolver returns after cancellation', async () => {
    const pending = Promise.withResolvers<Blob>(); const controller = new AbortController();
    const result = prepare({ messages: [{ id: messageId, role: 'user', parts: [image({ state: { status: 'persisted' } })] }], readBinaryObject: () => pending.promise, signal: controller.signal });
    controller.abort(new Error('stop')); pending.resolve(new Blob(['x']));
    await expect(result).rejects.toThrow('stop');
  });
});
