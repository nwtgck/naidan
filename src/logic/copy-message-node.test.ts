import { describe, expect, it } from 'vitest';
import { toAttachmentId, toBinaryObjectId, toMessageId, toToolCallId } from '@/01-models/ids';
import { EMPTY_LM_PARAMETERS, type MessageNode, type AssistantMessageNode } from '@/01-models/types';
import { copyMessageWithoutReplies } from './copy-message-node';

describe('copying one history node', () => {
  it('copies assistant parts and recorded metadata without sharing mutable state', () => {
    const source: AssistantMessageNode = { id: toMessageId({ raw: 'a' }), role: 'assistant', createdAt: 123, parts: [
      { id: 'r', type: 'reasoning', text: '  R\n', completeness: 'complete' },
      { id: 't', type: 'text', text: '<think>literal</think>A', completeness: 'partial' },
      { id: 'c', type: 'tool_call', toolCall: { id: toToolCallId({ raw: 'c' }), type: 'function', function: { name: 'f', arguments: '{ "x": 1 }' } } },
    ], modelId: 'm', lmParameters: { ...EMPTY_LM_PARAMETERS, stop: ['STOP'], reasoning: { effort: 'high' } }, interruption: { type: 'error', message: '日本語' }, replies: { items: [] } };
    const copied = copyMessageWithoutReplies({ message: source });
    expect(copied).toEqual(source); expect(copied).not.toBe(source);
    if (copied.role !== 'assistant') throw new Error('Wrong role');
    const first = copied.parts[0]; if (first?.type !== 'reasoning') throw new Error('Wrong part'); first.text = 'edited';
    const call = copied.parts[2]; if (call?.type !== 'tool_call') throw new Error('Wrong part'); call.toolCall.function.arguments = '{}';
    copied.lmParameters!.stop!.push('other'); copied.lmParameters!.reasoning.effort = 'low';
    if (copied.interruption?.type !== 'error') throw new Error('Wrong reason'); copied.interruption.message = 'changed';
    expect(source.parts[0]).toMatchObject({ text: '  R\n' }); expect(source.parts[2]).toMatchObject({ toolCall: { function: { arguments: '{ "x": 1 }' } } });
    expect(source.lmParameters!.stop).toEqual(['STOP']); expect(source.lmParameters!.reasoning.effort).toBe('high');
    expect(source.interruption).toEqual({ type: 'error', message: '日本語' });
  });
  it('preserves immutable Blobs but copies attachment metadata', () => {
    const blob = new Blob(['abc']);
    const source: MessageNode = { id: toMessageId({ raw: 'u' }), role: 'user', createdAt: 1, parts: [{ id: 'attachment', type: 'attachment', attachment: { id: toAttachmentId({ raw: 'a' }), binaryObjectId: toBinaryObjectId({ raw: 'b' }), originalName: 'name', size: 3, mimeType: 'text/plain', uploadedAt: 2, status: 'memory', blob } }], modelId: undefined, lmParameters: undefined, replies: { items: [] } };
    const copied = copyMessageWithoutReplies({ message: source });
    const part = copied.parts[0]; if (part?.type !== 'attachment' || part.attachment.status !== 'memory') throw new Error('Wrong attachment');
    expect(part.attachment.blob).toBe(blob); part.attachment.originalName = 'changed';
    expect(source.parts[0]).toMatchObject({ attachment: { originalName: 'name' } });
  });
  it('copies tool result content without copying descendants or flattening binary references', () => {
    const child: MessageNode = { id: toMessageId({ raw: 's' }), role: 'system', createdAt: 2, parts: [], modelId: undefined, lmParameters: undefined, replies: { items: [] } };
    const source: MessageNode = { id: toMessageId({ raw: 't' }), role: 'tool', createdAt: 1, parts: [{ id: 'r', type: 'tool_result', result: { toolCallId: toToolCallId({ raw: 'c' }), status: 'success', content: { type: 'binary_object', id: toBinaryObjectId({ raw: 'b' }) } } }], modelId: undefined, lmParameters: undefined, replies: { items: [child] } };
    const copied = copyMessageWithoutReplies({ message: source });
    expect(copied.replies.items).toEqual([]); expect(source.replies.items).toEqual([child]);
    expect(copied.parts).toEqual(source.parts); expect(copied.parts[0]).not.toBe(source.parts[0]);
    expect(copied.createdAt).toBe(1);
  });
});
