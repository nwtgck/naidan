import { describe, it, expect } from 'vitest';
import { createBranchFromMessages, getChatBranchIterator } from './chat-tree';
import { toAttachmentId, toBinaryObjectId, toMessageId, toToolCallId } from '@/01-models/ids';
import { EMPTY_LM_PARAMETERS } from '@/01-models/types';
import { cloneLmParameters } from '@/utils/lm-parameters';
import { generateId } from '@/01-models/id';
import type { MessageId } from '@/01-models/ids';
import type { Attachment, ChatContent, MessageNode } from '@/01-models/types';
describe('chat-tree utils', () => {
  describe('literal content and explicit reasoning', () => {
    it.each([
      { content: '', thinking: undefined },
      { content: '  visible  ', thinking: 'existing' },
      { content: '  <think>partial', thinking: undefined },
      { content: '<think> only thought </think>', thinking: undefined },
      { content: ' <think> </think> visible ', thinking: undefined },
      { content: '<think> </think>', thinking: 'existing' },
      { content: ' <THINK> first </THINK>visible<think>second</think> ', thinking: 'existing' },
      { content: '  [Generation Aborted]', thinking: '' },
    ])('does not reinterpret $content while constructing stored parts', ({ content, thinking }) => {
      const [node] = createBranchFromMessages({ messages: [historyMessage({ role: 'assistant', content: content, thinking: thinking, attachments: undefined, modelId: undefined })] });
      expect(node?.parts).toEqual([
        ...(thinking === undefined ? [] : [{ type: 'reasoning', text: thinking, completeness: 'complete' }]),
        { type: 'text', text: content, completeness: 'complete' },
      ]);
      expect(node).not.toHaveProperty('content');
      expect(node).not.toHaveProperty('thinking');
      expect(node).toHaveProperty('interruption', undefined);
    });
  });
  describe('getChatBranchIterator', () => {
    it('should resolve a deeply nested current branch without recursion', () => {
      const depth = 10000;
      const root: MessageNode = {
        id: toMessageId({ raw: 'message-0' }),
        role: 'user',
        parts: [{ type: 'text', text: '0', completeness: 'complete' }],
        modelId: undefined, lmParameters: undefined,
        createdAt: 0,
        replies: { items: [] },
      };
      let current: MessageNode = root;
      for (let index = 1; index < depth; index++) {
        const common = {
          id: toMessageId({ raw: `message-${index}` }),
          parts: [{ type: 'text' as const, text: String(index), completeness: 'complete' as const }],
          modelId: undefined, lmParameters: undefined,
          createdAt: index, replies: { items: [] },
        };
        const next: MessageNode = index % 2 === 0 ? { ...common, role: 'user' } : { ...common, role: 'assistant', interruption: undefined };
        current.replies.items.push(next);
        current = next;
      }
      const content: ChatContent = {
        root: { items: [root] },
        currentLeafId: current.id,
      };
      const branch = Array.from(getChatBranchIterator({ chat: content }));
      expect(branch).toHaveLength(depth);
      expect(branch[0]?.id).toBe(root.id);
      expect(branch.at(-1)?.id).toBe(current.id);
    });
  });
  describe('createBranchFromMessages', () => {
    it('should create a chain of MessageNodes from a list of HistoryItems', () => {
      const messages: MessageNode[] = [
        historyMessage({ role: 'user', content: 'Hello', thinking: undefined, attachments: undefined, modelId: undefined }),
        historyMessage({ role: 'assistant', content: 'Hi there!', thinking: undefined, attachments: undefined, modelId: 'gpt-4' }),
        historyMessage({ role: 'user', content: 'How are you?', thinking: undefined, attachments: undefined, modelId: undefined }),
      ];
      const nodes = createBranchFromMessages({ messages });
      expect(nodes.length).toBe(3);
      // Check first node
      expect(nodes[0]!.role).toBe('user');
      expect(nodes[0]!.parts[0]).toMatchObject({ type: 'text', text: 'Hello', completeness: 'complete' });
      expect(nodes[0]!.replies.items.length).toBe(1);
      expect(nodes[0]!.replies.items[0]!.id).toBe(nodes[1]!.id);
      // Check second node
      expect(nodes[1]!.role).toBe('assistant');
      expect(nodes[1]!.parts[0]).toMatchObject({ type: 'text', text: 'Hi there!', completeness: 'complete' });
      expect(nodes[1]!.modelId).toBe('gpt-4');
      expect(nodes[1]!.replies.items.length).toBe(1);
      expect(nodes[1]!.replies.items[0]!.id).toBe(nodes[2]!.id);
      // Check third node
      expect(nodes[2]!.role).toBe('user');
      expect(nodes[2]!.parts[0]).toMatchObject({ type: 'text', text: 'How are you?', completeness: 'complete' });
      expect(nodes[2]!.replies.items.length).toBe(0);
    });
    it('should return empty array for empty input', () => {
      const nodes = createBranchFromMessages({ messages: [] });
      expect(nodes).toEqual([]);
    });
    it('should preserve thinking content for assistant', () => {
      const messages: MessageNode[] = [
        historyMessage({ role: 'assistant', content: 'I thought about it.', thinking: 'Inner thoughts', attachments: undefined, modelId: undefined }),
      ];
      const nodes = createBranchFromMessages({ messages });
      expect(nodes[0]!.parts[0]).toMatchObject({ type: 'reasoning', text: 'Inner thoughts', completeness: 'complete' });
    });
    it('should preserve attachments for user', () => {
      const messages: MessageNode[] = [
        historyMessage({ role: 'user', content: 'Here is an image.', thinking: undefined, attachments: [{ id: toAttachmentId({ raw: '1' }), binaryObjectId: toBinaryObjectId({ raw: '1' }), status: 'persisted', originalName: 'n.png', mimeType: 'image/png', size: 10, uploadedAt: 0 }], modelId: undefined }),
      ];
      const nodes = createBranchFromMessages({ messages });
      expect(nodes[0]!.parts[1]).toMatchObject({ type: 'attachment', attachment: { id: toAttachmentId({ raw: '1' }) } });
    });
    it('copies attachment metadata and parameter containers instead of retaining editor mutations', () => {
      const attachment = { id: toAttachmentId({ raw: 'a' }), binaryObjectId: toBinaryObjectId({ raw: 'b' }), originalName: 'before', mimeType: 'image/png', size: 1, uploadedAt: 0, status: 'persisted' as const };
      const [user, assistant] = createBranchFromMessages({ messages: [
        historyMessage({ role: 'user', content: '', thinking: undefined, attachments: [attachment], modelId: undefined }),
        historyMessage({ role: 'assistant', content: '', thinking: undefined, attachments: undefined, modelId: undefined }),
      ] });
      attachment.originalName = 'after';
      expect(user?.parts[1]).toMatchObject({ attachment: { originalName: 'before' } });
      expect(user?.lmParameters).not.toBe(assistant?.lmParameters);
      expect(user?.lmParameters?.reasoning).not.toBe(assistant?.lmParameters?.reasoning);
    });
    it('creates system messages without assistant-only or legacy fields', () => {
      const [system] = createBranchFromMessages({ messages: [historyMessage({ role: 'system', content: '  rules  ', thinking: undefined, attachments: undefined, modelId: undefined })] });
      expect(system).toMatchObject({ role: 'system', modelId: undefined, lmParameters: undefined, parts: [{ type: 'text', text: '  rules  ' }] });
      expect(system).not.toHaveProperty('interruption');
      expect(system).not.toHaveProperty('timestamp');
      expect(system?.createdAt).toEqual(expect.any(Number));
    });
  });
});

describe('full-part history preservation', () => {
  it('preserves tool call/result identity, state and metadata while assigning fresh message IDs', () => {
    const assistant: MessageNode = { ...historyMessage({ role: 'assistant', content: '', thinking: undefined, modelId: 'm', attachments: undefined }), role: 'assistant', interruption: { type: 'error', message: '日本語' }, parts: [
      { type: 'text', text: '', completeness: 'complete' },
      { type: 'reasoning', text: '  R\n', completeness: 'partial' },
      { type: 'tool_call', toolCall: { id: toToolCallId({ raw: 'call' }), type: 'function', function: { name: 'f', arguments: '{ "x": 1 }' } } },
    ] };
    const tool: MessageNode = { id: toMessageId({ raw: 'tool' }), role: 'tool', createdAt: 99, modelId: undefined, lmParameters: undefined, parts: [{ type: 'tool_result', result: { toolCallId: toToolCallId({ raw: 'call' }), status: 'executing' } }], replies: { items: [] } };
    assistant.replies.items.push(tool, { ...tool, id: toMessageId({ raw: 'sibling' }) });
    const before = JSON.stringify(assistant);
    const nodes = createBranchFromMessages({ messages: [assistant, tool] });
    expect(nodes.map(node => node.parts)).toEqual([assistant.parts, tool.parts]);
    expect(nodes.map(node => node.createdAt)).toEqual([assistant.createdAt, tool.createdAt]);
    expect(nodes[0]!.id).not.toBe(assistant.id); expect(nodes[1]!.id).not.toBe(tool.id);
    expect(nodes[0]!.replies.items).toEqual([nodes[1]]);
    expect(nodes[0]).toMatchObject({ interruption: { type: 'error', message: '日本語' } });
    const first = nodes[0]!; if (first.role !== 'assistant') throw new Error('Expected assistant');
    const call = first.parts[2]; if (call?.type !== 'tool_call') throw new Error('Expected call');
    call.toolCall.function.arguments = 'edited';
    expect(JSON.stringify(assistant)).toBe(before);
  });
  it('copies a long selected path without recursively copying its branches', () => {
    const messages = Array.from({ length: 2500 }, () => historyMessage({ role: 'user', content: 'x', thinking: undefined, modelId: undefined, attachments: undefined }));
    for (let index = 0; index < messages.length - 1; index++) messages[index]!.replies.items.push(messages[index + 1]!);
    const nodes = createBranchFromMessages({ messages });
    expect(nodes).toHaveLength(2500); expect(nodes.at(-1)!.replies.items).toEqual([]);
    expect(nodes[0]!.replies.items[0]).toBe(nodes[1]);
  });
});

function historyMessage({ role, content, thinking, attachments, modelId }: { role: 'user' | 'assistant' | 'system'; content: string; thinking: string | undefined; attachments: Attachment[] | undefined; modelId: string | undefined }): MessageNode {
  const common = { id: generateId<MessageId>(), createdAt: 3, replies: { items: [] } };
  const body = { type: 'text', text: content, completeness: 'complete' } as const;
  switch (role) {
  case 'user': return { ...common, role, modelId: undefined, lmParameters: cloneLmParameters({ lmParameters: EMPTY_LM_PARAMETERS }), parts: [body, ...(attachments ?? []).map((attachment) => ({ type: 'attachment' as const, attachment }))] };
  case 'assistant': return { ...common, role, modelId, lmParameters: cloneLmParameters({ lmParameters: EMPTY_LM_PARAMETERS }), interruption: undefined, parts: [...(thinking === undefined ? [] : [{ type: 'reasoning' as const, text: thinking, completeness: 'complete' as const }]), body] };
  case 'system': return { ...common, role, modelId: undefined, lmParameters: undefined, parts: [body] };
  default: { const _ex: never = role; throw new Error('Unexpected role: ' + _ex); }
  }
}
