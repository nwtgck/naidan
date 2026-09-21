import { describe, expect, it, vi, beforeEach } from 'vitest';
import { toMessageId, toToolCallId, toBinaryObjectId, toAttachmentId } from '@/01-models/ids';
import { EMPTY_LM_PARAMETERS, type AssistantMessageNode, type MessageNode } from '@/01-models/types';
import { storageService } from '@/00-storage/service';
import { buildCompactRequestMessages, createCompactChatMessagesFromPrefix, createCompactBranchFromResponse, createCompactRequestPreview } from './context-compact';
vi.mock('@/00-storage/service', () => ({ storageService: { getFile: vi.fn() } }));

function assistant(): AssistantMessageNode {
  return { id: toMessageId({ raw: 'a' }), role: 'assistant', createdAt: 7, modelId: 'model', lmParameters: { ...EMPTY_LM_PARAMETERS, temperature: 0.2, reasoning: { effort: 'low' } }, interruption: { type: 'error', message: '中断' },
    parts: [{ id: 'r', type: 'reasoning', text: '  理由\n', completeness: 'complete' }, { id: 't', type: 'text', text: '<think>literal</think>途中', completeness: 'partial' }], replies: { items: [] } };
}
beforeEach(() => vi.clearAllMocks());
describe('context compaction parts', () => {
  it('keeps native reasoning, literal text, status, and order without lookup annotation', async () => {
    const a = assistant(); const before = structuredClone(a);
    const messages = await createCompactChatMessagesFromPrefix({ prefix: [a], promptMode: 'without_message_ids' });
    expect(messages).toEqual([{ id: a.id, role: 'assistant', parts: before.parts }]);
    expect(a).toEqual(before);
    a.parts[0]!.id = 'edited'; expect(messages[0]!.parts[0]!.id).toBe('r');
  });
  it('adds lookup text to a copied text part without tagging reasoning', async () => {
    const a = assistant(); const before = structuredClone(a);
    const messages = await createCompactChatMessagesFromPrefix({ prefix: [a], promptMode: 'with_message_ids' });
    expect(messages[0]!.parts[0]).toEqual(a.parts[0]);
    expect(messages[0]!.parts[1]).toMatchObject({ id: 't', text: `\
messageId=a

<think>literal</think>途中`, completeness: 'partial' });
    expect(a).toEqual(before);
  });
  it('inserts a collision-free lookup part after reasoning and before calls', async () => {
    const a = assistant(); a.parts = [{ id: 'compact_lookup', type: 'reasoning', text: 'R', completeness: 'complete' }, { id: 'c', type: 'tool_call', toolCall: { id: toToolCallId({ raw: 'c' }), type: 'function', function: { name: 'f', arguments: '{ "x": 1 }' } } }];
    const [message] = await createCompactChatMessagesFromPrefix({ prefix: [a], promptMode: 'with_message_ids' });
    expect(message!.parts.map(part => part.type)).toEqual(['reasoning', 'text', 'tool_call']);
    expect(message!.parts[1]!.id).toBe('compact_lookup_'); expect(a.parts).toHaveLength(2);
  });
  it('keeps non-image and missing attachment references for provider validation', async () => {
    const attachment = { id: toAttachmentId({ raw: 'a1' }), binaryObjectId: toBinaryObjectId({ raw: 'b1' }), originalName: 'file.txt', mimeType: 'text/plain', size: 3, uploadedAt: 1, status: 'missing' as const };
    const user: MessageNode = { id: toMessageId({ raw: 'u' }), role: 'user', createdAt: 1, modelId: undefined, lmParameters: undefined, parts: [{ id: 'att', type: 'attachment', attachment }], replies: { items: [] } };
    const [copy] = await createCompactChatMessagesFromPrefix({ prefix: [user], promptMode: 'without_message_ids' });
    expect(copy!.parts).toEqual(user.parts); expect(storageService.getFile).not.toHaveBeenCalled();
  });
  it('snapshots later messages before waiting for a tool binary result', async () => {
    const deferred = Promise.withResolvers<Blob>(); vi.mocked(storageService.getFile).mockReturnValueOnce(deferred.promise);
    const tool: MessageNode = { id: toMessageId({ raw: 'tool' }), role: 'tool', createdAt: 1, modelId: undefined, lmParameters: undefined, replies: { items: [] }, parts: [{ id: 'result', type: 'tool_result', result: { status: 'success', toolCallId: toToolCallId({ raw: 'call' }), content: { type: 'binary_object', id: toBinaryObjectId({ raw: 'binary' }) } } }] };
    const a = assistant(); const pending = createCompactChatMessagesFromPrefix({ prefix: [tool, a], promptMode: 'with_message_ids' });
    a.parts = []; deferred.resolve(new Blob(['  Result  ']));
    const messages = await pending;
    expect(messages[1]!.parts).toHaveLength(2);
    expect(messages[0]!.parts[0]).toMatchObject({ result: { content: { type: 'text', text: `\
messageId=tool

  Result  ` } } });
    expect(tool.parts[0]).toMatchObject({ result: { content: { type: 'binary_object' } } });
  });
  it('does not substitute a fabricated successful result when binary content is missing', async () => {
    vi.mocked(storageService.getFile).mockResolvedValueOnce(null);
    const tool: MessageNode = { id: toMessageId({ raw: 't' }), role: 'tool', createdAt: 1, modelId: undefined, lmParameters: undefined, replies: { items: [] }, parts: [{ id: 'r', type: 'tool_result', result: { status: 'success', toolCallId: toToolCallId({ raw: 'c' }), content: { type: 'binary_object', id: toBinaryObjectId({ raw: 'b' }) } } }] };
    await expect(createCompactChatMessagesFromPrefix({ prefix: [tool], promptMode: 'with_message_ids' })).rejects.toThrow('missing');
  });
  it('keeps suffix content, causes, references, and parameter independence', () => {
    const a = assistant(); const before = structuredClone(a); const ids = ['summary', 'copy'];
    const branch = createCompactBranchFromResponse({ compactContent: '  summary  ', suffix: [a], compactModelId: 'm', createMessageId: () => toMessageId({ raw: ids.shift()! }), now: () => 42 });
    expect(branch.compactNode.parts).toEqual([{ id: 'text', type: 'text', text: '  summary  ', completeness: 'complete' }]);
    const copy = branch.compactNode.replies.items[0]!; expect(copy).toMatchObject({ id: 'copy', createdAt: 42, parts: before.parts, interruption: before.interruption });
    if (copy.role !== 'assistant') throw new Error('Unexpected copy');
    copy.lmParameters!.temperature = 1; copy.parts[0]!.id = 'changed'; expect(a).toEqual(before);
  });
  it('builds independent request instructions with a collision-free id', () => {
    const a = assistant(); const source = { id: toMessageId({ raw: 'compact_instruction' }), role: 'assistant' as const, parts: a.parts };
    const messages = buildCompactRequestMessages({ prefix: [source], promptMode: 'without_message_ids', instructionContent: '  custom  ' });
    a.parts[0]!.id = 'changed'; expect(messages[0]!.parts[0]!.id).toBe('r');
    expect(messages[1]!.id).toBe('compact_instruction_');
    expect(messages[1]!.parts[0]).toMatchObject({ text: '  custom  ' });
    expect(createCompactRequestPreview({ messages })).toContain('[reasoning]');
  });
});

describe('context compaction tool text storage parity', () => {
  function toolNode({ status, content }: {
    status: 'success' | 'error',
    content: import('@/01-models/tool').TextOrBinaryObject,
  }): import('@/01-models/types').ToolMessageNode {
    const toolCallId = toToolCallId({ raw: 'c' });
    return {
      id: toMessageId({ raw: 'tool' }), role: 'tool', createdAt: 3,
      modelId: undefined, lmParameters: undefined, replies: { items: [] },
      parts: [{ id: 'result', type: 'tool_result', result: status === 'success'
        ? { toolCallId, status, content }
        : { toolCallId, status, error: { code: 'other', message: content } } }],
    };
  }
  for (const status of ['success', 'error'] as const) {
    it.each([
      { name: 'empty text', text: '' },
      { name: 'BOM and verbatim text', text: '\uFEFF  R🙂\r\n<think>literal</think> ' },
      { name: 'two leading BOMs', text: '\uFEFF\uFEFF' },
    ])(`${status}: preserves $name with lookup annotations before and after binary storage`, async ({ text }) => {
      const inline = toolNode({ status, content: { type: 'text', text } });
      const stored = toolNode({ status, content: { type: 'binary_object', id: toBinaryObjectId({ raw: 'tool-body' }) } });
      const before = structuredClone(stored);
      vi.mocked(storageService.getFile).mockResolvedValueOnce(new Blob([text], { type: 'text/plain' }));
      const direct = await createCompactChatMessagesFromPrefix({ prefix: [inline], promptMode: 'with_message_ids' });
      const restored = await createCompactChatMessagesFromPrefix({ prefix: [stored], promptMode: 'with_message_ids' });
      const message = restored[0];
      if (message?.role !== 'tool') throw new Error('Expected tool message.');
      const part = message.parts[0];
      if (!part) throw new Error('Missing result.');
      const expected = { type: 'text', text: `messageId=tool\n\n${text}` };
      expect(part.result).toEqual(status === 'success'
        ? { toolCallId: toToolCallId({ raw: 'c' }), status, content: expected }
        : { toolCallId: toToolCallId({ raw: 'c' }), status, error: { code: 'other', message: expected } });
      expect(restored).toEqual(direct);
      expect(stored).toEqual(before);
    });
    it.each([
      { name: 'invalid UTF-8', bytes: [0xff] },
      { name: 'truncated UTF-8', bytes: [0xe3, 0x81] },
    ])(`${status}: refuses $name instead of embedding fabricated lookup text`, async ({ bytes }) => {
      const stored = toolNode({ status, content: { type: 'binary_object', id: toBinaryObjectId({ raw: 'tool-body' }) } });
      const before = structuredClone(stored);
      vi.mocked(storageService.getFile).mockResolvedValueOnce(new Blob([Uint8Array.from(bytes)]));
      await expect(createCompactChatMessagesFromPrefix({ prefix: [stored], promptMode: 'with_message_ids' })).rejects.toThrow();
      expect(stored).toEqual(before);
    });
  }
  it('does not read or rewrite the binary reference when no lookup annotation is requested', async () => {
    const node = toolNode({ status: 'success', content: { type: 'binary_object', id: toBinaryObjectId({ raw: 'tool-body' }) } });
    const [message] = await createCompactChatMessagesFromPrefix({ prefix: [node], promptMode: 'without_message_ids' });
    expect(message).toEqual({ id: node.id, role: 'tool', parts: node.parts });
    expect(storageService.getFile).not.toHaveBeenCalled();
  });
});
