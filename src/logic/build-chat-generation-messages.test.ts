import { describe, expect, it } from 'vitest';
import { reactive } from 'vue';
import type { ChatContent, MessageNode, UserMessageNode, AssistantMessageNode } from '@/01-models/types';
import { idToRaw, toAttachmentId, toBinaryObjectId, toMessageId, toToolCallId } from '@/01-models/ids';
import { buildChatGenerationMessages } from './build-chat-generation-messages';

function user({ id, text, replies }: { id: string, text: string, replies: MessageNode[] }): UserMessageNode {
  return { id: toMessageId({ raw: id }), role: 'user', createdAt: 1, modelId: undefined, lmParameters: undefined, parts: [{ id: 'text', type: 'text', text, completeness: 'complete' }], replies: { items: replies } };
}
function assistant({ id, replies }: { id: string, replies: MessageNode[] }): AssistantMessageNode {
  return { id: toMessageId({ raw: id }), role: 'assistant', createdAt: 2, modelId: undefined, lmParameters: undefined, interruption: undefined, parts: [], replies: { items: replies } };
}

describe('buildChatGenerationMessages', () => {
  it('projects the selected branch, preserves reasoning and exact tool arguments, and excludes the active assistant', () => {
    const active = assistant({ id: 'active-assistant', replies: [] });
    const followUp = user({ id: 'follow-up', text: 'continue', replies: [active] });
    const callId = toToolCallId({ raw: 'call-1' });
    const tool: MessageNode = { id: toMessageId({ raw: 'tool-result' }), role: 'tool', createdAt: 3, modelId: undefined, lmParameters: undefined, parts: [{ id: 'result', type: 'tool_result', result: { toolCallId: callId, status: 'success', content: { type: 'text', text: '20 C' } } }], replies: { items: [followUp] } };
    const args = `\
{
  "city": "Tokyo",
  "unit": "C"
}`;
    const generated = assistant({ id: 'assistant-tool-call', replies: [tool] });
    generated.parts = [
      { id: 'r', type: 'reasoning', text: '  東京を調べる。\n', completeness: 'complete' },
      { id: 't', type: 'text', text: 'calling', completeness: 'complete' },
      { id: 'c', type: 'tool_call', toolCall: { id: callId, type: 'function', function: { name: 'lookup_weather', arguments: args } } },
    ];
    const first = user({ id: 'first-user', text: 'weather', replies: [generated, assistant({ id: 'hidden', replies: [] })] });
    const chat: ChatContent = { currentLeafId: active.id, root: { items: [first] } };
    const messages = buildChatGenerationMessages({ chat, excludedMessageId: active.id, systemPromptMessages: ['system'] });
    expect(messages).toEqual([
      { id: toMessageId({ raw: 'system_prompt_0' }), role: 'system', parts: [{ id: 'text', type: 'text', text: 'system', completeness: 'complete' }] },
      { id: first.id, role: 'user', parts: first.parts },
      { id: generated.id, role: 'assistant', parts: generated.parts },
      { id: tool.id, role: 'tool', parts: tool.parts },
      { id: followUp.id, role: 'user', parts: followUp.parts },
    ]);
    expect(messages.some(message => message.id === active.id)).toBe(false);
    expect(messages.some(message => message.id === toMessageId({ raw: 'hidden' }))).toBe(false);
    expect(messages[2]?.parts[2]).toMatchObject({ toolCall: { function: { arguments: args } } });
  });

  it('preserves multimodal user parts as references rather than choosing an API image_url representation', () => {
    const node = user({ id: 'multimodal-user', text: 'look', replies: [] });
    node.parts.push({ id: 'image', type: 'attachment', attachment: { id: toAttachmentId({ raw: 'att' }), binaryObjectId: toBinaryObjectId({ raw: 'image' }), originalName: 'image.png', mimeType: 'image/png', size: 10, uploadedAt: 1, status: 'persisted' } });
    const messages = buildChatGenerationMessages({ chat: { root: { items: [node] }, currentLeafId: node.id }, excludedMessageId: undefined, systemPromptMessages: [] });
    expect(messages).toEqual([{ id: node.id, role: 'user', parts: node.parts }]);
    expect(messages[0]?.parts).not.toBe(node.parts);
    expect(Object.hasOwn(messages[0]!, 'content')).toBe(false);
    expect(Object.hasOwn(messages[0]!, 'tool_calls')).toBe(false);
  });

  it('captures Vue-backed history synchronously before subsequent edits', () => {
    const node = user({ id: 'user', text: 'before', replies: [] });
    const chat = reactive<ChatContent>({ root: { items: [node] }, currentLeafId: node.id });
    const systems = ['  before\n'];
    const messages = buildChatGenerationMessages({ chat, excludedMessageId: undefined, systemPromptMessages: systems });
    systems[0] = 'after';
    const first = chat.root.items[0];
    if (!first || first.role !== 'user' || first.parts[0]?.type !== 'text') throw new Error('Incomplete fixture');
    first.parts[0].text = 'after';
    first.parts[0].completeness = 'partial';
    chat.root.items.length = 0;
    expect(messages.map(message => message.parts[0])).toEqual([
      { id: 'text', type: 'text', text: '  before\n', completeness: 'complete' },
      { id: 'text', type: 'text', text: 'before', completeness: 'complete' },
    ]);
  });

  it('does not turn interruption into model content, nor strip literal think tags from partial history', () => {
    const node = assistant({ id: 'partial', replies: [] });
    node.parts.push({ id: 't', type: 'text', text: '<think>原文</think>途中', completeness: 'partial' });
    node.interruption = { type: 'error', message: '日本語のエラー' };
    const [message] = buildChatGenerationMessages({ chat: { root: { items: [node] } }, excludedMessageId: undefined, systemPromptMessages: [] });
    expect(message).toEqual({ id: node.id, role: 'assistant', parts: node.parts });
    expect(message).not.toHaveProperty('interruption');
    expect(node.interruption.message).toBe('日本語のエラー');
  });

  it('keeps deterministic system IDs without colliding with stored messages', () => {
    const node = user({ id: 'system_prompt_0', text: '', replies: [] });
    const request = { chat: { root: { items: [node] } }, excludedMessageId: undefined, systemPromptMessages: ['A', 'B', ''] };
    const first = buildChatGenerationMessages(request);
    expect(first).toEqual(buildChatGenerationMessages(request));
    expect(new Set(first.map(message => idToRaw({ id: message.id }))).size).toBe(first.length);
    expect(first[0]?.id).toBe(toMessageId({ raw: 'system_prompt_0_' }));
    expect(first[2]?.parts).toEqual([{ id: 'text', type: 'text', text: '', completeness: 'complete' }]);
  });

  it('keeps the established last-branch fallback without taking sibling content', () => {
    const ignored = user({ id: 'ignored', text: 'ignored', replies: [] });
    const last = user({ id: 'last', text: 'last', replies: [] });
    const root = assistant({ id: 'root', replies: [ignored, last] });
    const messages = buildChatGenerationMessages({ chat: { root: { items: [root] }, currentLeafId: toMessageId({ raw: 'missing' }) }, excludedMessageId: undefined, systemPromptMessages: [] });
    expect(messages.map(message => message.id)).toEqual([root.id, last.id]);
  });
});
