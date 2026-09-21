import { describe, expect, it } from 'vitest';
import { createChatMessageSnapshot } from './chat-message';
import type { AssistantMessageNode, MessageNode, ToolMessageNode, UserMessageNode, Attachment } from './types';
import { toAttachmentId, toBinaryObjectId, toMessageId, toToolCallId } from './ids';

function assistant(): AssistantMessageNode {
  return {
    id: toMessageId({ raw: 'a' }), role: 'assistant', createdAt: 15,
    modelId: 'model', lmParameters: undefined, interruption: { type: 'error', message: '日本語の失敗' },
    parts: [
      { id: 'r', type: 'reasoning', text: `\
  R\\r
🙂`, completeness: 'complete' },
      { id: 't', type: 'text', text: '<think>literal</think>', completeness: 'partial' },
      { id: 'r2', type: 'reasoning', text: '', completeness: 'partial' },
      { id: 'c', type: 'tool_call', toolCall: { id: toToolCallId({ raw: 'c' }), type: 'function', function: { name: 'f', arguments: ' { "x": 1 } ' } } },
    ], replies: { items: [] },
  };
}

describe('createChatMessageSnapshot', () => {
  it('retains ordered parts, empty text and original strings but not storage metadata', () => {
    const node = assistant();
    const snapshot = createChatMessageSnapshot({ node });
    expect(snapshot).toEqual({ id: node.id, role: 'assistant', parts: node.parts });
    expect(Object.keys(snapshot).sort()).toEqual(['id', 'parts', 'role']);
    expect(snapshot.parts).not.toBe(node.parts);
    snapshot.parts.forEach((part, index) => expect(part).not.toBe(node.parts[index]));
  });

  it('does not retain mutable tool-call arguments or completed/partial fields', () => {
    const node = assistant();
    const snapshot = createChatMessageSnapshot({ node });
    const call = node.parts.find(part => part.type === 'tool_call');
    const reasoning = node.parts.find(part => part.type === 'reasoning');
    if (!call || !reasoning) throw new Error('Incomplete fixture');
    call.toolCall.function.arguments = '{}';
    call.toolCall.function.name = 'other';
    reasoning.text = 'changed';
    reasoning.completeness = 'partial';
    node.parts.reverse();
    expect(snapshot.parts[0]).toEqual({ id: 'r', type: 'reasoning', text: `\
  R\\r
🙂`, completeness: 'complete' });
    expect(snapshot.parts[3]).toMatchObject({ toolCall: { function: { name: 'f', arguments: ' { "x": 1 } ' } } });
  });

  it.each(['persisted', 'memory', 'missing'] as const)('copies %s attachment metadata without resolving or dropping the reference', (status) => {
    const blob = new Blob(['original']);
    const common = { id: toAttachmentId({ raw: 'att' }), binaryObjectId: toBinaryObjectId({ raw: 'binary' }), originalName: 'a.png', mimeType: 'image/png', size: 8, uploadedAt: 9 };
    const attachment: Attachment = (() => {
      switch (status) {
      case 'memory': return { ...common, status, blob };
      case 'persisted': return { ...common, status };
      case 'missing': return { ...common, status };
      default: { const _ex: never = status; throw new Error(`Unhandled status: ${_ex}`); }
      }
    })();
    const node: UserMessageNode = { id: toMessageId({ raw: 'u' }), role: 'user', createdAt: 1, modelId: undefined, lmParameters: undefined, parts: [{ id: 'att', type: 'attachment', attachment }], replies: { items: [] } };
    const snapshot = createChatMessageSnapshot({ node });
    expect(snapshot.parts).toEqual(node.parts);
    attachment.originalName = 'changed';
    if (snapshot.role !== 'user') throw new Error('Expected user');
    const part = snapshot.parts[0];
    if (part?.type !== 'attachment') throw new Error('Expected attachment');
    expect(part.attachment.originalName).toBe('a.png');
    expect(part.attachment.binaryObjectId).toBe(common.binaryObjectId);
    switch (part.attachment.status) {
    case 'memory': expect(part.attachment.blob).toBe(blob); break;
    case 'persisted':
    case 'missing': expect(Object.hasOwn(part.attachment, 'blob')).toBe(false); break;
    default: { const _ex: never = part.attachment; throw new Error(`Unhandled attachment: ${_ex}`); }
    }
  });

  it('preserves every tool status and binary reference, copying nested error/text payloads', () => {
    const callId = toToolCallId({ raw: 'c' });
    const binaryId = toBinaryObjectId({ raw: 'b' });
    const node: ToolMessageNode = { id: toMessageId({ raw: 'tool' }), role: 'tool', modelId: undefined, lmParameters: undefined, createdAt: 1, replies: { items: [] }, parts: [
      { id: 'a', type: 'tool_result', result: { toolCallId: callId, status: 'executing' } },
      { id: 'b', type: 'tool_result', result: { toolCallId: callId, status: 'success', content: { type: 'text', text: '  result\n' } } },
      { id: 'c', type: 'tool_result', result: { toolCallId: callId, status: 'success', content: { type: 'binary_object', id: binaryId } } },
      { id: 'd', type: 'tool_result', result: { toolCallId: callId, status: 'error', error: { code: 'other', message: { type: 'text', text: '失敗' } } } },
      { id: 'e', type: 'tool_result', result: { toolCallId: callId, status: 'error', error: { code: 'timeout', message: { type: 'binary_object', id: binaryId } } } },
    ] };
    const expected = structuredClone(node.parts);
    const snapshot = createChatMessageSnapshot({ node });
    for (const part of node.parts) {
      switch (part.result.status) {
      case 'executing': break;
      case 'success': part.result.content = { type: 'text', text: 'changed' }; break;
      case 'error': part.result.error.code = 'execution_failed'; part.result.error.message = { type: 'text', text: 'changed' }; break;
      default: { const _ex: never = part.result; throw new Error(`Unhandled result: ${_ex}`); }
      }
    }
    expect(snapshot.parts).toEqual(expected);
  });

  it('does not create a text part when a message has no parts', () => {
    const node: MessageNode = { id: toMessageId({ raw: 's' }), role: 'system', modelId: undefined, lmParameters: undefined, createdAt: 1, replies: { items: [] }, parts: [] };
    expect(createChatMessageSnapshot({ node }).parts).toEqual([]);
    node.parts.push({ id: 'empty', type: 'text', text: '', completeness: 'complete' });
    expect(createChatMessageSnapshot({ node }).parts).toEqual([{ id: 'empty', type: 'text', text: '', completeness: 'complete' }]);
  });
});
