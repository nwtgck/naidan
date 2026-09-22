import { describe, expect, it } from 'vitest';
import type { AssistantMessageNode, MessageNode, ToolMessageNode, UserMessageNode } from '@/01-models/types';
import { toAttachmentId, toBinaryObjectId, toMessageId, toToolCallId } from '@/01-models/ids';
import { renderMessageJson } from './message-json';
import { renderMessageMarkdown } from './message-markdown';

function assistant(): AssistantMessageNode {
  return { id: toMessageId({ raw: 'a' }), role: 'assistant', createdAt: 4, modelId: 'model', lmParameters: undefined,
    interruption: { type: 'error', message: '日本語の記録: offline' }, replies: { items: [] }, parts: [
      { type: 'reasoning', text: '  理由\r\n', completeness: 'complete' },
      { type: 'text', text: '<think>literal</think>🙂', completeness: 'complete' },
      { type: 'reasoning', text: '', completeness: 'partial' },
      { type: 'text', text: '', completeness: 'complete' },
      { type: 'tool_call', toolCall: { id: toToolCallId({ raw: 'c' }), type: 'function', function: { name: 'f', arguments: ' { "arg": 1 } ' } } },
    ] };
}
describe('parts in read-only sysfs projections', () => {
  it('keeps order, empty parts, raw tags, time, partial, and the recorded error language in JSON', () => {
    const node = assistant(); const before = structuredClone(node);
    expect(JSON.parse(renderMessageJson({ node }))).toEqual({
      id: 'a', role: 'assistant', createdAt: 4, modelId: 'model',
      parts: [
        { type: 'reasoning', text: '  理由\r\n' },
        { type: 'text', text: '<think>literal</think>🙂' },
        { type: 'reasoning', text: '', completeness: 'partial' },
        { type: 'text', text: '' },
        { type: 'tool_call', toolCall: { id: 'c', type: 'function', function: { name: 'f', arguments: ' { "arg": 1 } ' } } },
      ], interruption: { type: 'error', message: '日本語の記録: offline' },
    });
    expect(node).toEqual(before);
  });
  it('keeps the same part boundaries and order in Markdown without parsing literal tags', () => {
    const node = assistant(); const rendered = renderMessageMarkdown({ node });
    const headers = [...rendered.matchAll(/^## Part (.+)$/gm)].map(match => match[1]);
    expect(headers).toEqual(['1 (reasoning)', '2 (text)', '3 (reasoning)', '4 (text)', '5 (tool_call)']);
    expect(rendered).toContain('  理由\r\n'); expect(rendered).toContain('<think>literal</think>🙂');
    expect(rendered).toContain('completeness: partial'); expect(rendered).toContain('日本語の記録: offline');
  });
  it('does not serialize a memory Blob, implementation properties, or descendant bodies in a message file', () => {
    const user: UserMessageNode = { id: toMessageId({ raw: 'u' }), role: 'user', createdAt: 0, modelId: undefined, lmParameters: undefined,
      parts: [{ type: 'attachment', attachment: { id: toAttachmentId({ raw: 'att' }), binaryObjectId: toBinaryObjectId({ raw: 'bin' }), originalName: 'sample.bin', mimeType: 'application/octet-stream', size: 6, uploadedAt: 3, status: 'memory', blob: new Blob(['SECRET']) } }],
      replies: { items: [assistant()] } };
    const rendered = renderMessageJson({ node: user });
    expect(JSON.parse(rendered).parts[0]).toEqual({ type: 'attachment', attachment: {
      id: 'att', binaryObjectId: 'bin', name: 'sample.bin', mimeType: 'application/octet-stream', size: 6, uploadedAt: 3, status: 'memory', note: '[binary attachment hidden]',
    } });
    for (const value of ['blob', 'SECRET', '日本語の記録', 'replies']) expect(rendered).not.toContain(value);
  });
  it('shows initial cancellation with no synthetic text or completion part', () => {
    const node = { ...assistant(), parts: [], interruption: { type: 'cancelled' as const } };
    expect(JSON.parse(renderMessageJson({ node })).parts).toEqual([]);
    expect(renderMessageMarkdown({ node })).toContain('parts: []');
    expect(renderMessageMarkdown({ node })).not.toContain('Aborted');
  });
  it('truncates only the diagnostic tool-result view and never mutates the recorded result', () => {
    const text = 'x'.repeat(4001);
    const node: ToolMessageNode = { id: toMessageId({ raw: 'tool' }), role: 'tool', createdAt: 2, modelId: undefined, lmParameters: undefined, replies: { items: [] }, parts: [
      { type: 'tool_result', result: { toolCallId: toToolCallId({ raw: 'c' }), status: 'error', error: { code: 'execution_failed', message: { type: 'text', text } } } },
      { type: 'tool_result', result: { toolCallId: toToolCallId({ raw: 'd' }), status: 'executing' } },
      { type: 'tool_result', result: { toolCallId: toToolCallId({ raw: 'e' }), status: 'success', content: { type: 'binary_object', id: toBinaryObjectId({ raw: 'result' }) } } },
      { type: 'tool_result', result: { toolCallId: toToolCallId({ raw: 'f' }), status: 'error', error: { code: 'other', message: { type: 'binary_object', id: toBinaryObjectId({ raw: 'error' }) } } } },
    ] };
    const before = structuredClone(node); const json = JSON.parse(renderMessageJson({ node }));
    expect(json.parts[0].result.error.message.text).toBe(`${'x'.repeat(4000)}\n[truncated]`);
    expect(json.parts[1].result.status).toBe('executing');
    expect(json.parts[2].result.content.id).toBe('result');
    expect(json.parts[3].result.error.message.id).toBe('error');
    const markdown = renderMessageMarkdown({ node });
    expect(markdown).toContain('d: executing'); expect(markdown).toContain('[binary object result]'); expect(markdown).toContain('[binary object error]');
    expect(markdown).toContain(`${'x'.repeat(4000)} [truncated]`); expect(node).toEqual(before);
  });
  for (const role of ['system', 'user'] as const) {
    it(`renders ${role} text without a legacy content/timestamp wrapper`, () => {
      const node: MessageNode = { id: toMessageId({ raw: role }), role, createdAt: 0, modelId: undefined, lmParameters: undefined, parts: [{ type: 'text', text: '', completeness: 'partial' }], replies: { items: [] } };
      expect(JSON.parse(renderMessageJson({ node }))).toEqual({ id: role, role, createdAt: 0, parts: [{ type: 'text', text: '', completeness: 'partial' }] });
    });
  }
});
