import { describe, expect, it } from 'vitest';
import type { ChatMessage } from '@/01-models/types';
import type { ToolExecutionResult } from '@/01-models/tool';
import { toAttachmentId, toBinaryObjectId, toMessageId, toToolCallId } from '@/01-models/ids';
import {
  firstPersistencePartsMismatch,
  persistencePartsMessageSchema,
  recordPersistencePartsMessages,
  type PersistencePartsMessage,
} from './persistence-parts-evidence';

describe('persistence parts evidence', () => {
  it('keeps empty and repeated text, reasoning boundaries, raw tags and UTF-16 content', () => {
    const raw = '🙂'.slice(0, 1);
    const message: ChatMessage = {
      id: toMessageId({ raw: 'm' }), role: 'assistant', parts: [
        { id: 'r1', type: 'reasoning', text: '', completeness: 'complete' },
        { id: 'r2', type: 'reasoning', text: ' ', completeness: 'partial' },
        { id: 't1', type: 'text', text: '', completeness: 'complete' },
        { id: 't2', type: 'text', text: '<think>literal</think>' + raw, completeness: 'partial' },
        { id: 't3', type: 'text', text: '<think>literal</think>' + raw, completeness: 'partial' },
      ],
    };
    const result = recordPersistencePartsMessages({ messages: [message] });
    expect(result).toEqual([{ id: 'm', role: 'assistant', parts: message.parts }]);
    expect(result[0]?.parts).not.toBe(message.parts);
    expect(JSON.parse(JSON.stringify(result))).toEqual(result);
  });

  it('records call IDs and argument bytes without parsing or canonicalizing them', () => {
    const result = recordPersistencePartsMessages({ messages: [{
      id: toMessageId({ raw: 'm' }), role: 'assistant', parts: [{ id: 'p', type: 'tool_call', toolCall: {
        id: toToolCallId({ raw: 'call' }), type: 'function', function: { name: 'tool', arguments: ' { "x": 1.00, "y": "\\u0061" } ' },
      } }],
    }] });
    expect(result).toEqual([{
      id: 'm', role: 'assistant', parts: [{ id: 'p', type: 'tool_call', toolCall: {
        id: 'call', type: 'function', function: { name: 'tool', arguments: ' { "x": 1.00, "y": "\\u0061" } ' },
      } }],
    }]);
  });

  it('keeps tool results structured rather than adding model-specific outcome wrappers', () => {
    const toolCallId = toToolCallId({ raw: 'call' });
    const results: ToolExecutionResult[] = [
      { toolCallId, status: 'executing' },
      { toolCallId, status: 'success', content: { type: 'text', text: ' raw result ' } },
      { toolCallId, status: 'error', error: { code: 'timeout', message: { type: 'text', text: ' timeout ' } } },
    ];
    const recorded = recordPersistencePartsMessages({ messages: [{
      id: toMessageId({ raw: 't' }), role: 'tool', parts: results.map((result, index) => ({ id: String(index), type: 'tool_result', result })),
    }] });
    expect(recorded).toEqual([{
      id: 't', role: 'tool', parts: results.map((result, index) => ({ id: String(index), type: 'tool_result', result: { ...result, toolCallId: 'call' } })),
    }]);
  });

  it('does not hide an unsupported attachment or read its bytes', () => {
    const blob = new Blob(['private image']);
    const message: ChatMessage = {
      id: toMessageId({ raw: 'u' }), role: 'user', parts: [{ id: 'p', type: 'attachment', attachment: {
        id: toAttachmentId({ raw: 'a' }), binaryObjectId: toBinaryObjectId({ raw: 'b' }),
        originalName: 'image', mimeType: 'image/png', size: blob.size, uploadedAt: 0, status: 'memory', blob,
      } }],
    };
    expect(() => recordPersistencePartsMessages({ messages: [message] })).toThrow('must not contain attachments');
  });

  it('does not replace unsupported binary tool results with an empty string', () => {
    const toolCallId = toToolCallId({ raw: 'call' });
    const content = { type: 'binary_object', id: toBinaryObjectId({ raw: 'binary' }) } as const;
    const results: ToolExecutionResult[] = [
      { toolCallId, status: 'success', content },
      { toolCallId, status: 'error', error: { code: 'other', message: content } },
    ];
    for (const result of results) {
      expect(() => recordPersistencePartsMessages({ messages: [{
        id: toMessageId({ raw: 't' }), role: 'tool', parts: [{ id: 'p', type: 'tool_result', result }],
      }] })).toThrow(/binary tool/);
    }
  });

  it('compares order, IDs, state, contents and lengths without flattening the transcript', () => {
    const message: PersistencePartsMessage = {
      id: 'a', role: 'assistant', parts: [
        { id: 'p1', type: 'text', text: 'A', completeness: 'complete' },
        { id: 'p2', type: 'text', text: 'B', completeness: 'partial' },
      ],
    };
    expect(firstPersistencePartsMismatch({ expected: [message], actual: structuredClone([message]) })).toBeUndefined();
    for (const changed of [
      { ...message, id: 'different' },
      { ...message, parts: [...message.parts].reverse() },
      { ...message, parts: [{ id: 'p1', type: 'text', text: 'AB', completeness: 'partial' }] },
      { ...message, parts: [{ id: 'p1', type: 'text', text: 'A', completeness: 'partial' }, message.parts[1]] },
    ]) {
      const actual = persistencePartsMessageSchema.parse(changed);
      expect(firstPersistencePartsMismatch({ expected: [message], actual: [actual] })).toBe(0);
    }
    expect(firstPersistencePartsMismatch({ expected: [message], actual: [] })).toBe(0);
    expect(firstPersistencePartsMismatch({ expected: [message], actual: [message, message] })).toBe(1);
  });

  it('does not parse a legacy flat record or another role into parts evidence', () => {
    expect(persistencePartsMessageSchema.safeParse({ role: 'assistant', content: 'old' }).success).toBe(false);
    expect(persistencePartsMessageSchema.safeParse({ id: 'u', role: 'user', parts: [{ id: 'p', type: 'reasoning', text: '', completeness: 'complete' }] }).success).toBe(false);
    expect(persistencePartsMessageSchema.safeParse({ id: 'a', role: 'assistant', parts: [{ id: 'p', type: 'text', text: '' }] }).success).toBe(false);
  });
});
