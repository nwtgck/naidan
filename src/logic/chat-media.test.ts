import { describe, expect, it } from 'vitest';
import { collectChatMedia } from './chat-media';
import type { Attachment, MessageNode, UserMessageNode } from '@/01-models/types';
import { idToRaw, toAttachmentId, toBinaryObjectId, toMessageId } from '@/01-models/ids';

function imageBlock({ id }: { id: string }): string {
  return `\
\`\`\`naidan_experimental_image
{"binaryObjectId":"${id}","displayWidth":32,"displayHeight":32,"prompt":"  原文のprompt  ","steps":0,"seed":0}
\`\`\``;
}
function user({ id, parts, createdAt }: { id: string; parts: UserMessageNode['parts']; createdAt: number }): UserMessageNode {
  return { id: toMessageId({ raw: id }), role: 'user', parts, createdAt, modelId: undefined, lmParameters: undefined, replies: { items: [] } };
}
function attachment({ status }: { status: 'persisted' | 'missing' }): Attachment {
  return { id: toAttachmentId({ raw: 'attachment' }), binaryObjectId: toBinaryObjectId({ raw: 'attachment-body' }),
    originalName: 'original.png', mimeType: 'image/png', size: 8, uploadedAt: 1, status };
}

describe('collectChatMedia', () => {
  it('collects attachments and each body block in part order without changing original text', () => {
    const parts: UserMessageNode['parts'] = [
      { id: 'before', type: 'text', text: imageBlock({ id: 'generated-before' }), completeness: 'partial' },
      { id: 'file', type: 'attachment', attachment: attachment({ status: 'persisted' }) },
      { id: 'after', type: 'text', text: imageBlock({ id: 'generated-after' }), completeness: 'complete' },
    ];
    const message = user({ id: 'u', parts, createdAt: 10 });
    const before = structuredClone(message);
    const group = collectChatMedia({ messages: [message], order: 'forward' })[0]!;
    expect(group.items.map(item => idToRaw({ id: item.binaryObjectId }))).toEqual(['generated-before', 'attachment-body', 'generated-after']);
    expect(group.items.map(item => [item.index, item.total])).toEqual([[1, 3], [2, 3], [3, 3]]);
    expect(group.createdAt).toBe(10);
    expect(group.prompt).toBe('  原文のprompt  ');
    expect(group.items[0]).toMatchObject({ steps: 0, seed: 0 });
    expect(message).toEqual(before);
  });

  it('uses distinct stable view IDs for repeated binary references and different messages', () => {
    const a = user({ id: 'a', createdAt: 0, parts: [{ id: 'same', type: 'text', text: imageBlock({ id: 'same-binary' }) + imageBlock({ id: 'same-binary' }), completeness: 'complete' }] });
    const b = user({ id: 'b', createdAt: 1, parts: [{ id: 'same', type: 'text', text: imageBlock({ id: 'same-binary' }), completeness: 'complete' }] });
    const items = collectChatMedia({ messages: [a, b], order: 'forward' }).flatMap(group => group.items);
    expect(new Set(items.map(item => item.id)).size).toBe(3);
    const reversed = collectChatMedia({ messages: [a, b], order: 'reverse' });
    expect(reversed.map(group => group.messageId)).toEqual([b.id, a.id]);
    expect(reversed[1]?.items.map(item => item.id)).toEqual([items[2]?.id, items[1]?.id]);
  });

  it('does not join a split metadata fence or parse reasoning as generated images', () => {
    const block = imageBlock({ id: 'not-an-image' }); const middle = Math.floor(block.length / 2);
    const message: MessageNode = { id: toMessageId({ raw: 'a' }), role: 'assistant', createdAt: 1,
      modelId: undefined, lmParameters: undefined, interruption: undefined, replies: { items: [] },
      parts: [
        { id: 'r', type: 'reasoning', text: block, completeness: 'complete' },
        { id: 'one', type: 'text', text: block.slice(0, middle), completeness: 'complete' },
        { id: 'two', type: 'text', text: block.slice(middle), completeness: 'complete' },
      ] };
    expect(collectChatMedia({ messages: [message], order: 'forward' })).toEqual([]);
  });

  it('keeps literal think tags in the body and tolerates malformed metadata without changing storage', () => {
    const raw = '<think>literal text</think>' + imageBlock({ id: 'image' }) + `\
\`\`\`naidan_experimental_image
invalid-json
\`\`\``;
    const message = user({ id: 'u', createdAt: 1, parts: [{ id: 'p', type: 'text', text: raw, completeness: 'partial' }] });
    const groups = collectChatMedia({ messages: [message], order: 'forward' });
    expect(groups[0]?.items).toHaveLength(1);
    expect(message.parts[0]).toMatchObject({ text: raw, completeness: 'partial' });
  });

  it('ignores missing and non-image files but preserves a local memory Blob for thumbnail loading', () => {
    const persisted = attachment({ status: 'persisted' });
    const blob = new Blob(['image'], { type: 'image/png' });
    const memory: Attachment = { ...persisted, status: 'memory', blob };
    const message = user({ id: 'u', createdAt: 1, parts: [
      { id: 'missing', type: 'attachment', attachment: attachment({ status: 'missing' }) },
      { id: 'document', type: 'attachment', attachment: { ...persisted, mimeType: 'text/plain' } },
      { id: 'memory', type: 'attachment', attachment: memory },
    ] });
    const groups = collectChatMedia({ messages: [message], order: 'forward' });
    expect(groups[0]?.items).toHaveLength(1);
    expect(groups[0]?.items[0]?.memoryBlob).toBe(blob);
    expect(groups[0]?.items[0]?.name).toBe('original.png');
  });
});
