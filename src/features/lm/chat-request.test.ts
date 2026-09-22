import { describe, expect, it, vi } from 'vitest';
import { buildApiChatMessages, snapshotChatRequest } from './chat-request';
import type { ChatMessage } from '@/01-models/types';
import { EMPTY_LM_PARAMETERS } from '@/01-models/types';
import { toAttachmentId, toBinaryObjectId, toMessageId, toToolCallId } from '@/01-models/ids';

const id = toMessageId({ raw: 'm' });
function text({ value }: { value: string }) {
  return { type: 'text' as const, text: value, completeness: 'complete' as const };
}
describe('remote chat request projection', () => {
  it('keeps reasoning separate and literal tags in text without updating the source', async () => {
    const message: ChatMessage = { id, role: 'assistant', parts: [{ type: 'reasoning', text: '  R\n', completeness: 'complete' }, text({ value: '<think>literal</think>' }), { type: 'tool_call', toolCall: { id: toToolCallId({ raw: 'call' }), type: 'function', function: { name: 'f', arguments: ' {"value": 1} ' } } }] };
    const before = JSON.stringify(message);
    const value = await buildApiChatMessages({ messages: [message], readBinaryObject: undefined, signal: undefined });
    expect(value).toEqual([{ role: 'assistant', content: '<think>literal</think>', reasoning_content: '  R\n', tool_call_id: undefined, tool_calls: [{ id: 'call', type: 'function', function: { name: 'f', arguments: ' {"value": 1} ' } }] }]);
    expect(JSON.stringify(message)).toBe(before);
  });
  it('does not silently regroup unrepresentable interleaved history', async () => {
    const m: ChatMessage = { id, role: 'assistant', parts: [text({ value: 'A' }), { type: 'reasoning', text: 'R', completeness: 'complete' }] };
    await expect(buildApiChatMessages({ messages: [m], readBinaryObject: undefined, signal: undefined })).rejects.toThrow('cannot represent');
  });
  it('distinguishes missing assistant text from an explicitly empty text part', async () => {
    const messages: ChatMessage[] = [{ id, role: 'assistant', parts: [] }, { id, role: 'assistant', parts: [text({ value: '' })] }];
    const result = await buildApiChatMessages({ messages, readBinaryObject: undefined, signal: undefined });
    expect(result[0]?.content).toBeUndefined(); expect(result[1]?.content).toBe('');
  });
  it('resolves images and text attachments at the API boundary in source order', async () => {
    const attachment = { id: toAttachmentId({ raw: 'a' }), binaryObjectId: toBinaryObjectId({ raw: 'image' }), originalName: 'image.png', mimeType: 'image/png', size: 1, uploadedAt: 2, status: 'persisted' as const };
    const m: ChatMessage = { id, role: 'user', parts: [text({ value: 'before' }), { type: 'attachment', attachment }, text({ value: 'after' })] };
    const reader = vi.fn(async () => new Blob([new Uint8Array([1])], { type: 'image/png' }));
    const [result] = await buildApiChatMessages({ messages: [m], readBinaryObject: reader, signal: undefined });
    expect(result?.content).toEqual([{ type: 'text', text: 'before' }, { type: 'image_url', image_url: { url: 'data:image/png;base64,AQ==' } }, { type: 'text', text: 'after' }]);
    expect(reader).toHaveBeenCalledExactlyOnceWith({ binaryObjectId: attachment.binaryObjectId, signal: undefined });
  });
  it('refuses missing attachments and unresolved executing tool results', async () => {
    const m: ChatMessage = { id, role: 'tool', parts: [{ type: 'tool_result', result: { toolCallId: toToolCallId({ raw: 'c' }), status: 'executing' } }] };
    await expect(buildApiChatMessages({ messages: [m], readBinaryObject: undefined, signal: undefined })).rejects.toThrow('executing');
  });
  it('reconstructs stored tool errors using the same format as live errors', async () => {
    const m: ChatMessage = { id, role: 'tool', parts: [{ type: 'tool_result', result: { toolCallId: toToolCallId({ raw: 'c' }), status: 'error', error: { code: 'invalid_arguments', message: { type: 'binary_object', id: toBinaryObjectId({ raw: 'b' }) } } } }] };
    const [result] = await buildApiChatMessages({ messages: [m], readBinaryObject: async () => new Blob(['説明']), signal: undefined });
    expect(result?.content).toBe('Error [invalid_arguments]: 説明'); expect(result?.tool_call_id).toBe('c');
  });
  it('captures mutable messages, tool schemas, and parameters before any async read', () => {
    const part = text({ value: 'A' }); const parameters = { ...EMPTY_LM_PARAMETERS, stop: ['stop'], reasoning: { effort: 'low' as const } };
    const schema = { type: 'object', properties: { value: { type: 'string' } } };
    const snapshot = snapshotChatRequest({ messages: [{ id, role: 'user', parts: [part] }], parameters, tools: [{ name: 'f', description: 'D', parameters: schema }] });
    part.text = 'B'; parameters.stop.push('changed'); schema.properties.value.type = 'number';
    expect(snapshot.messages[0]?.parts[0]).toMatchObject({ text: 'A' }); expect(snapshot.parameters?.stop).toEqual(['stop']);
    expect(snapshot.tools?.[0]?.parameters).toEqual({ type: 'object', properties: { value: { type: 'string' } } });
  });
});

describe('persisted tool text decoding', () => {
  const toolCallId = toToolCallId({ raw: 'call-utf8' });
  const binaryObjectId = toBinaryObjectId({ raw: 'result-utf8' });
  function message({ bytesReference }: { bytesReference: boolean }): ChatMessage {
    return { id, role: 'tool', parts: [{ type: 'tool_result', result: {
      toolCallId, status: 'success',
      content: bytesReference ? { type: 'binary_object', id: binaryObjectId } : { type: 'text', text: '\uFEFF  結果🙂\r\n' },
    } }] };
  }
  it('keeps the leading BOM as tool content instead of treating it as file framing', async () => {
    const inline = await buildApiChatMessages({ messages: [message({ bytesReference: false })], readBinaryObject: undefined, signal: undefined });
    const stored = await buildApiChatMessages({ messages: [message({ bytesReference: true })], readBinaryObject: async () => new Blob(['\uFEFF  結果🙂\r\n']), signal: undefined });
    expect(stored[0]?.content).toBe('\uFEFF  結果🙂\r\n');
    expect(stored).toEqual(inline);
  });
  it.each([
    { name: 'invalid leading byte', bytes: [0xff] },
    { name: 'truncated multibyte sequence', bytes: [0xe3, 0x81] },
    { name: 'invalid continuation byte', bytes: [0xe3, 0x28, 0x82] },
    { name: 'encoded surrogate', bytes: [0xed, 0xa0, 0x80] },
  ])('rejects $name rather than creating replacement text', async ({ bytes }) => {
    const readBinaryObject = vi.fn(async () => new Blob([Uint8Array.from(bytes)]));
    await expect(buildApiChatMessages({ messages: [message({ bytesReference: true })], readBinaryObject, signal: undefined })).rejects.toThrow();
    expect(readBinaryObject).toHaveBeenCalledExactlyOnceWith({ binaryObjectId, signal: undefined });
  });
  it('accepts an explicitly encoded replacement character without substituting other bytes', async () => {
    const [stored] = await buildApiChatMessages({ messages: [message({ bytesReference: true })], readBinaryObject: async () => new Blob(['\uFFFD']), signal: undefined });
    expect(stored?.content).toBe('\uFFFD');
  });
  it('checks cancellation again after the asynchronous binary read', async () => {
    const controller = new AbortController();
    const pendingRead = Promise.withResolvers<ArrayBuffer>();
    const blob = new Blob(['unused']);
    const read = vi.spyOn(blob, 'arrayBuffer').mockImplementation(() => pendingRead.promise);
    const task = buildApiChatMessages({ messages: [message({ bytesReference: true })], readBinaryObject: async () => blob, signal: controller.signal });
    // Attach a rejection observer before interrupting or completing the read.
    const observed = task.then(value => ({ type: 'value' as const, value }), error => ({ type: 'error' as const, error }));
    try {
      await vi.waitFor(() => expect(read).toHaveBeenCalledOnce(), { timeout: 500 });
      const reason = new Error('cancelled during tool byte read');
      controller.abort(reason);
      pendingRead.resolve(new TextEncoder().encode('ignored').buffer);
      expect(await observed).toEqual({ type: 'error', error: reason });
    } finally {
      pendingRead.resolve(new ArrayBuffer(0));
      await observed;
    }
  });
});
