// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import type { LmProvider } from '@/01-models/lm';
import { EMPTY_LM_PARAMETERS, type ChatMessage } from '@/01-models/types';
import { toMessageId, toAttachmentId, toBinaryObjectId, toToolCallId } from '@/01-models/ids';
import { prepareLlamaCppRequest } from './message-projection';

const id = toMessageId({ raw: 'message' });
const callId = toToolCallId({ raw: 'call' });
const binaryObjectId = toBinaryObjectId({ raw: 'binary' });
const text = ({ value }: { value: string }) => ({ type: 'text' as const, text: value, completeness: 'complete' as const });
const reasoning = ({ value }: { value: string }) => ({ type: 'reasoning' as const, text: value, completeness: 'complete' as const });
const call = () => ({ type: 'tool_call' as const, toolCall: { id: callId, type: 'function' as const, function: { name: 'calculator', arguments: ' { "value": 1.0 } ' } } });
const image = ({ status }: { status: 'persisted' | 'missing' | 'memory' }): Extract<Extract<ChatMessage, { role: 'user' }>['parts'][number], { type: 'attachment' }> => ({
  type: 'attachment', attachment: {
    id: toAttachmentId({ raw: 'image' }), binaryObjectId, originalName: 'image.png', mimeType: 'image/png', size: 3, uploadedAt: 1,
    ...(status === 'memory' ? { status, blob: new Blob(['png'], { type: 'image/png' }) } : { status }),
  },
});
function request({ messages }: { messages: ChatMessage[] }): Parameters<LmProvider['chat']>[0] {
  return { messages, model: 'user/test', parameters: undefined, tools: undefined, readBinaryObject: undefined, debug: undefined, signal: undefined };
}

describe('parts to llama.cpp input', () => {
  it('preserves literal tags and whitespace in text instead of inferring reasoning', async () => {
    const raw = '<think> literal </think>  🙂\r\n';
    const input = request({ messages: [{ id, role: 'assistant', parts: [{ ...text({ value: raw }), completeness: 'partial' }] }] });
    const prepared = await prepareLlamaCppRequest(input);
    expect(prepared.messages).toEqual([{ role: 'assistant', content: raw }]);
    expect(input.messages[0]?.parts[0]).toMatchObject({ completeness: 'partial', text: raw });
  });

  it('keeps a leading reasoning field separate from the body and call arguments', async () => {
    for (const value of ['', '  R\r\n']) {
      const prepared = await prepareLlamaCppRequest(request({ messages: [{ id, role: 'assistant', parts: [reasoning({ value }), text({ value: '<think>literal</think>' }), call()] }] }));
      expect(prepared.messages).toEqual([{ role: 'assistant', content: '<think>literal</think>', reasoning_content: value, tool_calls: [{ ...call().toolCall, id: 'call' }] }]);
    }
  });

  it('joins text-only content only at this native input boundary without deduplication', async () => {
    const prepared = await prepareLlamaCppRequest(request({ messages: [{ id, role: 'user', parts: [text({ value: 'A' }), { ...text({ value: 'A' }), }] }] }));
    expect(prepared.messages).toEqual([{ role: 'user', content: 'AA' }]);
  });

  it('uses an empty native content field for a call-only assistant without changing history', async () => {
    const messages: ChatMessage[] = [{ id, role: 'assistant', parts: [call()] }];
    expect((await prepareLlamaCppRequest(request({ messages }))).messages[0]?.content).toBe('');
    expect(messages[0]?.parts).toHaveLength(1);
  });

  it('rejects repeated, partial, or out-of-order reasoning rather than moving or closing it', async () => {
    for (const parts of [[reasoning({ value: 'R' }), reasoning({ value: 'S' })], [{ ...reasoning({ value: 'R' }), completeness: 'partial' as const }], [text({ value: '' }), reasoning({ value: 'R' })], [call(), reasoning({ value: 'R' })]]) {
      await expect(prepareLlamaCppRequest(request({ messages: [{ id, role: 'assistant', parts }] }))).rejects.toThrow('unsupported-input');
    }
  });

  it('rejects text after a call instead of using reordered history for a later tool turn', async () => {
    await expect(prepareLlamaCppRequest(request({ messages: [{ id, role: 'assistant', parts: [call(), text({ value: 'after' })] }] }))).rejects.toThrow('unsupported-input');
  });

  it('passes image blobs and content order directly without a base64 round trip', async () => {
    const attachment = image({ status: 'memory' });
    const read = vi.fn();
    const prepared = await prepareLlamaCppRequest({ ...request({ messages: [{ id, role: 'user', parts: [text({ value: 'before' }), attachment, text({ value: '' })] }] }), readBinaryObject: read });
    expect(prepared.messages).toEqual([{ role: 'user', content: [{ type: 'text', text: 'before' }, { type: 'image', blob: expect.any(Blob) }, { type: 'text', text: '' }] }]);
    expect(read).not.toHaveBeenCalled();
    if (attachment.attachment.status !== 'memory') throw new Error('Expected fixture blob.');
    expect((prepared.messages[0]?.content as { blob?: Blob }[])[1]?.blob).toBe(attachment.attachment.blob);
  });

  it('resolves persisted images locally and fixes the whole request before the read waits', async () => {
    const pending = Promise.withResolvers<Blob>(); const read = vi.fn(() => pending.promise);
    const imagePart = image({ status: 'persisted' }); const toolPart = call();
    const messages: ChatMessage[] = [{ id, role: 'user', parts: [imagePart] }, { id, role: 'assistant', parts: [toolPart] }];
    const parameters = { ...EMPTY_LM_PARAMETERS, stop: [' stop '], reasoning: { effort: 'high' as const } };
    const tools = [{ name: 'calculator', description: '', parameters: { type: 'object', properties: { value: { type: 'number' } } } }];
    const controller = new AbortController();
    const operation = prepareLlamaCppRequest({ ...request({ messages }), parameters, tools, debug: 'on', signal: controller.signal, readBinaryObject: read });
    toolPart.toolCall.function.arguments = '{}'; parameters.stop[0] = 'changed'; tools[0]!.parameters.properties.value.type = 'string'; messages.push({ id, role: 'user', parts: [] });
    pending.resolve(new Blob(['png'])); const prepared = await operation;
    expect(prepared.messages).toHaveLength(2); expect(prepared.messages[1]?.tool_calls?.[0]?.function.arguments).toBe(' { "value": 1.0 } ');
    expect(prepared.stop).toEqual([' stop ']); expect(prepared.tools?.[0]?.function.parameters.properties).toEqual({ value: { type: 'number' } });
    expect(prepared.reasoningEffort).toBe('high'); expect(prepared.debug).toBe('on');
    expect(read).toHaveBeenCalledExactlyOnceWith({ binaryObjectId, signal: controller.signal });
  });

  it('does not silently drop missing, unreadable, or nonimage attachments', async () => {
    for (const status of ['missing', 'persisted'] as const) await expect(prepareLlamaCppRequest(request({ messages: [{ id, role: 'user', parts: [image({ status })] }] }))).rejects.toThrow('unsupported-input');
    const file = image({ status: 'memory' }); file.attachment.mimeType = 'application/pdf';
    await expect(prepareLlamaCppRequest(request({ messages: [{ id, role: 'user', parts: [file] }] }))).rejects.toThrow('unsupported-input');
  });

  it('matches each tool result to its call and keeps error and binary content', async () => {
    const raw = '\uFEFF  🙂\r\n';
    const prepared = await prepareLlamaCppRequest({ ...request({ messages: [
      { id, role: 'assistant', parts: [call()] },
      { id, role: 'tool', parts: [
        { type: 'tool_result', result: { toolCallId: callId, status: 'success', content: { type: 'binary_object', id: binaryObjectId } } },
        { type: 'tool_result', result: { toolCallId: callId, status: 'error', error: { code: 'other', message: { type: 'text', text: '失敗' } } } },
      ] },
    ] }), readBinaryObject: async () => new Blob([raw]) });
    expect(prepared.messages.slice(1)).toEqual([{ role: 'tool', tool_call_id: 'call', name: 'calculator', content: raw }, { role: 'tool', tool_call_id: 'call', name: 'calculator', content: 'Error [other]: 失敗' }]);
  });

  it('rejects unbound and still executing tool results before inference', async () => {
    const result = { id, role: 'tool' as const, parts: [{ type: 'tool_result' as const, result: { toolCallId: callId, status: 'executing' as const } }] };
    await expect(prepareLlamaCppRequest(request({ messages: [result] }))).rejects.toThrow('unsupported-input');
    await expect(prepareLlamaCppRequest(request({ messages: [{ id, role: 'assistant', parts: [call()] }, result] }))).rejects.toThrow('unsupported-input');
  });

  it('checks cancellation after an asynchronous image read', async () => {
    const controller = new AbortController();
    await expect(prepareLlamaCppRequest({ ...request({ messages: [{ id, role: 'user', parts: [image({ status: 'persisted' })] }] }), signal: controller.signal, readBinaryObject: async () => {
      controller.abort(); return new Blob();
    } })).rejects.toThrow();
  });
});
