import { describe, expect, it, vi } from 'vitest';
import type { ChatMessage, Attachment } from '@/01-models/types';
import { toMessageId, toAttachmentId, toBinaryObjectId } from '@/01-models/ids';
import type { PromptApiMessageContent, PromptApiPrompt } from './language-model';
import { mapChatMessagesToPromptApi } from './message-mapper';

const id = toMessageId({ raw: 'message' });
function text({ value }: { value: string }) {
  return { id: 't', type: 'text' as const, text: value, completeness: 'complete' as const };
}
function image({ mimeType, status }: { mimeType: string, status: 'memory' | 'persisted' | 'missing' }): Extract<ChatMessage, { role: 'user' }>['parts'][number] {
  const common = { id: toAttachmentId({ raw: 'a' }), binaryObjectId: toBinaryObjectId({ raw: 'b' }), originalName: 'image', mimeType, size: 5, uploadedAt: 1 };
  const attachment: Attachment = status === 'memory' ? { ...common, status, blob: new Blob(['hello'], { type: mimeType }) } : { ...common, status };
  return { id: 'a', type: 'attachment', attachment };
}
function getPromptMessages({ prompt }: { prompt: PromptApiPrompt }) {
  if (typeof prompt === 'string') throw new Error('Expected message-array prompt.');
  return prompt;
}
function getImageContent({ content }: { content: string | PromptApiMessageContent[] }) {
  if (typeof content === 'string') throw new Error('Expected multimodal content.');
  const found = content.find(part => part.type === 'image');
  if (found?.type !== 'image') throw new Error('Expected image.');
  return found;
}
function map({ messages }: { messages: ChatMessage[] }) {
  return mapChatMessagesToPromptApi({ messages, readBinaryObject: undefined, signal: undefined });
}

describe('mapChatMessagesToPromptApi', () => {
  it('combines leading system messages and separates the final user prompt', async () => {
    await expect(map({ messages: [
      { id, role: 'system', parts: [text({ value: 'Global instruction' })] },
      { id, role: 'system', parts: [text({ value: 'Chat instruction' })] },
      { id, role: 'user', parts: [text({ value: 'First question' })] },
      { id, role: 'assistant', parts: [text({ value: 'First answer' })] },
      { id, role: 'user', parts: [text({ value: 'Next question' })] },
    ] })).resolves.toEqual({ initialPrompts: [
      { role: 'system', content: `\
Global instruction

Chat instruction` },
      { role: 'user', content: 'First question' }, { role: 'assistant', content: 'First answer' },
    ], prompt: 'Next question', inputMode: 'text' });
  });
  it('maps a final user image attachment to a Blob prompt', async () => {
    const result = await map({ messages: [{ id, role: 'user', parts: [text({ value: 'Describe this image.' }), image({ mimeType: 'image/png', status: 'memory' })] }] });
    expect(result.inputMode).toBe('image'); expect(result.initialPrompts).toEqual([]);
    const messages = getPromptMessages({ prompt: result.prompt });
    expect(messages).toMatchObject([{ role: 'user', content: [{ type: 'text', value: 'Describe this image.' }, { type: 'image' }] }]);
    const content = getImageContent({ content: messages[0]!.content });
    expect(content.value).toBeInstanceOf(Blob); expect(content.value.type).toBe('image/png');
    await expect(content.value.text()).resolves.toBe('hello');
  });
  it('uses image session options when an earlier user message contains an image', async () => {
    const result = await map({ messages: [
      { id, role: 'user', parts: [text({ value: 'First image' }), image({ mimeType: 'image/jpeg', status: 'memory' })] },
      { id, role: 'assistant', parts: [text({ value: 'I can see it.' })] },
      { id, role: 'user', parts: [text({ value: 'What was in it?' })] },
    ] });
    expect(result.inputMode).toBe('image'); expect(result.prompt).toBe('What was in it?');
    expect(result.initialPrompts[0]).toMatchObject({ role: 'user', content: [{ type: 'text', value: 'First image' }, { type: 'image' }] });
  });
  it('accepts text-only parts without declaring image input', async () => {
    await expect(map({ messages: [{ id, role: 'user', parts: [text({ value: 'hello' })] }] })).resolves.toEqual({ initialPrompts: [], prompt: 'hello', inputMode: 'text' });
  });
  it('rejects missing or unresolved images instead of fetching external URLs', async () => {
    for (const status of ['persisted', 'missing'] as const) {
      await expect(map({ messages: [{ id, role: 'user', parts: [image({ mimeType: 'image/png', status })] }] })).rejects.toThrow(/binary reader|missing/);
    }
  });
  it('rejects tool history without silently flattening it', async () => {
    await expect(map({ messages: [{ id, role: 'tool', parts: [] }] })).rejects.toThrow('tool history is not supported');
  });
  it('requires the final conversation message to be from the user', async () => {
    await expect(map({ messages: [{ id, role: 'user', parts: [text({ value: 'question' })] }, { id, role: 'assistant', parts: [text({ value: 'answer' })] }] })).rejects.toThrow('final message to be from the user');
  });
  it('preserves literal tags, repeated chunks and whitespace as text, not reasoning', async () => {
    const raw = '<think>literal</think>  ';
    const result = await map({ messages: [{ id, role: 'assistant', parts: [text({ value: raw }), text({ value: raw })] }, { id, role: 'user', parts: [text({ value: '' })] }] });
    expect(result.initialPrompts).toEqual([{ role: 'assistant', content: raw + raw }]); expect(result.prompt).toBe('');
  });
  it('rejects structured reasoning instead of silently omitting it', async () => {
    await expect(map({ messages: [{ id, role: 'assistant', parts: [{ id: 'r', type: 'reasoning', text: 'R', completeness: 'complete' }] }, { id, role: 'user', parts: [] }] })).rejects.toThrow('structured reasoning');
  });
  it('resolves persisted images in part order and forwards the request signal', async () => {
    const controller = new AbortController(); const reader = vi.fn(async () => new Blob(['bytes']));
    const result = await mapChatMessagesToPromptApi({ messages: [{ id, role: 'user', parts: [text({ value: 'before' }), image({ mimeType: 'image/png', status: 'persisted' }), text({ value: 'after' })] }], readBinaryObject: reader, signal: controller.signal });
    expect(reader).toHaveBeenCalledExactlyOnceWith({ binaryObjectId: toBinaryObjectId({ raw: 'b' }), signal: controller.signal });
    expect(getPromptMessages({ prompt: result.prompt })[0]!.content).toMatchObject([{ type: 'text', value: 'before' }, { type: 'image' }, { type: 'text', value: 'after' }]);
    expect(getImageContent({ content: getPromptMessages({ prompt: result.prompt })[0]!.content }).value.type).toBe('image/png');
  });
  it('rejects unsupported attachment types and aborts after a binary read', async () => {
    await expect(map({ messages: [{ id, role: 'user', parts: [image({ mimeType: 'audio/wav', status: 'memory' })] }] })).rejects.toThrow('image attachment');
    const controller = new AbortController();
    await expect(mapChatMessagesToPromptApi({ messages: [{ id, role: 'user', parts: [image({ mimeType: 'image/png', status: 'persisted' })] }], signal: controller.signal, readBinaryObject: async () => {
      controller.abort(); return new Blob();
    } })).rejects.toThrow();
  });
  it('does not allow an interleaved system message or a missing conversation', async () => {
    await expect(map({ messages: [{ id, role: 'user', parts: [] }, { id, role: 'system', parts: [] }] })).rejects.toThrow('must precede');
    await expect(map({ messages: [] })).rejects.toThrow('at least one');
  });
});
