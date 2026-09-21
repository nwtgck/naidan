import { describe, expect, expectTypeOf, it } from 'vitest';
import { ChatContentSchemaDto, ChatSchemaDto, MessageNodeSchemaDto, MessageNodeSchemaDtoV2, type MessageNodeDtoV2 } from '@/00-storage/00-dto/dto';
import { chatContentToDomain, chatContentToDto, chatToDomain, messageNodeToDomain, messageNodeToDto } from './mappers';
import type { MessageNode } from '@/01-models/types';
import { createChatMessageSnapshot } from '@/01-models/chat-message';

const legacy = ({ role }: { role: 'user' | 'assistant' | 'system' | 'tool' }) => MessageNodeSchemaDto.parse({
  id: role, role, timestamp: 10, ...(role === 'tool' ? { results: [] } : { content: '' }), replies: { items: [] },
});
const roundTrip = ({ node }: { node: MessageNode }) => messageNodeToDomain({
  dto: MessageNodeSchemaDto.parse(JSON.parse(JSON.stringify(messageNodeToDto({ domain: node })))),
});

describe('versioned message mapping', () => {
  it('always writes V2 even when every root and descendant was read from V1', () => {
    const raw = { root: { items: [
      { id: 'u', role: 'user', content: 'hello', timestamp: 1, replies: { items: [
        { id: 'visible', role: 'assistant', content: 'one', timestamp: 2, replies: { items: [] } },
        { id: 'hidden', role: 'assistant', content: 'two', timestamp: 3, replies: { items: [] } },
      ] } },
      { id: 's', role: 'system', content: '', timestamp: 0, replies: { items: [] } },
    ] }, currentLeafId: 'visible' };
    const before = JSON.stringify(raw);
    const content = chatContentToDomain({ dto: ChatContentSchemaDto.parse(raw) });
    const saved = chatContentToDto({ domain: content });
    expect(JSON.stringify(raw)).toBe(before);
    const visit = ({ nodes }: { nodes: typeof saved.root.items }) => {
      for (const node of nodes) {
        expect(MessageNodeSchemaDtoV2.safeParse(node).success).toBe(true);
        expect(Object.hasOwn(node, 'content')).toBe(false);
        visit({ nodes: node.replies.items });
      }
    };
    visit({ nodes: saved.root.items });
    expect(saved.root.items[0]?.replies.items).toHaveLength(2);
    expect(saved.currentLeafId).toBe('visible');
    expect(chatContentToDto({ domain: chatContentToDomain({ dto: ChatContentSchemaDto.parse(JSON.parse(JSON.stringify(saved))) }) })).toEqual(saved);
  });

  it('uses deterministic message-local IDs without mutating the read record', () => {
    const dto = legacy({ role: 'assistant' });
    expect(messageNodeToDomain({ dto })).toEqual(messageNodeToDomain({ dto }));
    expect(Object.hasOwn(dto, 'parts')).toBe(false);
    expect(messageNodeToDomain({ dto }).createdAt).toBe(10);
  });

  it('retains specified empty reasoning before empty text and completed calls', () => {
    const dto = MessageNodeSchemaDto.parse({ id: 'a', role: 'assistant', thinking: '', content: '', timestamp: 7,
      toolCalls: [{ id: 'call', type: 'function', function: { name: 'f', arguments: ' {"x": 1} ' } }], replies: { items: [] } });
    const node = messageNodeToDomain({ dto });
    expect(node.parts).toMatchObject([
      { type: 'reasoning', text: '', completeness: 'complete' },
      { type: 'text', text: '', completeness: 'complete' },
      { type: 'tool_call', toolCall: { function: { arguments: ' {"x": 1} ' } } },
    ]);
    expect(roundTrip({ node })).toEqual(node);
  });

  it('does not invent a reasoning part for an absent old thinking field', () => {
    const node = messageNodeToDomain({ dto: legacy({ role: 'assistant' }) });
    expect(node.parts.map(part => part.type)).toEqual(['text']);
  });

  it('retains literal tags, old stop notices, Unicode, whitespace, and split parts', () => {
    const text = `\
  <think>literal</think>🙂
[Generation Aborted]
`;
    const node = messageNodeToDomain({ dto: MessageNodeSchemaDto.parse({ id: 'a', role: 'assistant', createdAt: 0,
      parts: [{ id: 'r1', type: 'reasoning', text: '  ' }, { id: 'r2', type: 'reasoning', text: '' }, { id: 't', type: 'text', text, completeness: 'partial' }],
      interruption: { type: 'error', message: '通信が切れました: offline' }, replies: { items: [] } }) });
    expect(roundTrip({ node })).toEqual(node);
    const saved = JSON.parse(JSON.stringify(messageNodeToDto({ domain: node })));
    expect(saved.parts[0]).not.toHaveProperty('completeness');
    expect(saved.parts[2].completeness).toBe('partial');
    expect(saved.interruption.message).toBe('通信が切れました: offline');
  });

  it('preserves no part versus an explicit empty part', () => {
    for (const parts of [[], [{ id: 'p', type: 'text', text: '' }]]) {
      const node = messageNodeToDomain({ dto: MessageNodeSchemaDto.parse({ id: 'a', role: 'assistant', createdAt: 1, parts, replies: { items: [] } }) });
      expect(roundTrip({ node }).parts).toEqual(node.parts);
      expect(node.parts.length).toBe(parts.length);
    }
  });

  it('retains cancellation separately from an already completed reasoning part', () => {
    const node = messageNodeToDomain({ dto: MessageNodeSchemaDto.parse({ id: 'a', role: 'assistant', createdAt: 1,
      parts: [{ id: 'r', type: 'reasoning', text: 'R' }], interruption: { type: 'cancelled' }, replies: { items: [] } }) });
    expect(roundTrip({ node })).toEqual(node);
    expect(messageNodeToDto({ domain: node })).toMatchObject({ interruption: { type: 'cancelled' }, parts: [{ completeness: undefined }] });
  });

  it('keeps old attachment metadata in memory and writes only the V2 reference', () => {
    const node = messageNodeToDomain({ dto: MessageNodeSchemaDto.parse({ id: 'u', role: 'user', timestamp: 4, content: '',
      attachments: [{ id: 'att', originalName: 'image.png', mimeType: 'image/png', size: 123, uploadedAt: 3, status: 'persisted' }], replies: { items: [] } }) });
    expect(node.parts[1]).toMatchObject({ type: 'attachment', attachment: { mimeType: 'image/png', size: 123, uploadedAt: 3, binaryObjectId: 'att' } });
    expect(messageNodeToDto({ domain: node }).parts[1]).toEqual({ id: 'legacy_attachment_0', type: 'attachment', experimental: undefined,
      attachment: { id: 'att', name: 'image.png', binaryObjectId: 'att', status: 'persisted', experimental: undefined } });
  });

  it('preserves all tool result states and binary references without JSON reformatting', () => {
    const results = [
      { toolCallId: 'c', status: 'executing' },
      { toolCallId: 'c', status: 'success', content: { type: 'text', text: '  {"x":1}\n' } },
      { toolCallId: 'd', status: 'success', content: { type: 'binary_object', id: 'blob' } },
      { toolCallId: 'e', status: 'error', error: { code: 'execution_failed', message: { type: 'binary_object', id: 'stderr' } } },
    ];
    const node = messageNodeToDomain({ dto: MessageNodeSchemaDto.parse({ id: 't', role: 'tool', timestamp: 1, results, replies: { items: [] } }) });
    expect(roundTrip({ node })).toEqual(node);
    expect(node.parts.map(part => part.type)).toEqual(results.map(() => 'tool_result'));
  });

  it('validates very old flat messages before converting them into a tree', () => {
    const raw = { id: 'chat', title: 'Legacy', createdAt: 1, updatedAt: 1,
      messages: [{ id: 'u', role: 'user', content: 'Hi', timestamp: 1 }, { id: 'a', role: 'assistant', content: 'Hello', thinking: 'R', timestamp: 2 }] };
    const chat = chatToDomain({ dto: ChatSchemaDto.parse(raw) });
    expect(chat.root.items[0]?.parts).toMatchObject([{ type: 'text', text: 'Hi' }]);
    expect(chat.root.items[0]?.replies.items[0]?.parts).toMatchObject([{ type: 'reasoning', text: 'R' }, { type: 'text', text: 'Hello' }]);
    for (const messages of [[null], [{ id: 'a', role: 'assistant', content: 9, timestamp: 1 }]]) {
      expect(() => chatToDomain({ dto: ChatSchemaDto.parse({ ...raw, messages }) })).toThrow();
    }
  });

  it('preserves model-visible message content through the actual mapper and JSON boundary', () => {
    const records = [
      { id: 'a', role: 'assistant', createdAt: 1, interruption: { type: 'error', message: '日本語' }, parts: [
        { id: 'r', type: 'reasoning', text: `\
  R\\r
🙂` },
        { id: 't', type: 'text', text: '<think>literal</think>', completeness: 'partial' },
        { id: 'c', type: 'tool_call', toolCall: { id: 'call', type: 'function', function: { name: 'f', arguments: ' { "x": 1 } ' } } },
      ], replies: { items: [] } },
      { id: 't', role: 'tool', createdAt: 2, parts: [
        { id: 'result', type: 'tool_result', result: { toolCallId: 'call', status: 'success', content: { type: 'binary_object', id: 'binary' } } },
      ], replies: { items: [] } },
      { id: 'u', role: 'user', timestamp: 0, content: '', replies: { items: [] } },
    ];
    for (const record of records) {
      const node = messageNodeToDomain({ dto: MessageNodeSchemaDto.parse(record) });
      expect(createChatMessageSnapshot({ node: roundTrip({ node }) })).toEqual(createChatMessageSnapshot({ node }));
    }
  });

  it('has a V2-only writer return type', () => {
    expectTypeOf<ReturnType<typeof messageNodeToDto>>().toEqualTypeOf<MessageNodeDtoV2>();
    expectTypeOf<ReturnType<typeof messageNodeToDto>['replies']['items'][number]>().toEqualTypeOf<MessageNodeDtoV2>();
  });
});
