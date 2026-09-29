import { describe, expect, it, beforeEach } from 'vitest';
import { iterateAttachmentParts } from './message-attachments';
import { LocalStorageProvider } from './local-storage';
import { MemoryStorageProvider } from './memory-storage';
import { toAttachmentId, toBinaryObjectId, toChatId, toMessageId, idToRaw } from '@/01-models/ids';
import type { MessageNode, UserMessageNode } from '@/01-models/types';
import { STORAGE_KEY_PREFIX } from '@/constants';

function user({ id, replies }: { id: string, replies: MessageNode[] }): UserMessageNode {
  return {
    id: toMessageId({ raw: id }), role: 'user', createdAt: 1, modelId: undefined, lmParameters: undefined,
    parts: [{ type: 'attachment', attachment: {
      id: toAttachmentId({ raw: `${id}-attachment` }), binaryObjectId: toBinaryObjectId({ raw: `${id}-binary` }),
      originalName: `${id}.txt`, mimeType: 'text/plain', size: 1, uploadedAt: 1, status: 'persisted',
    } }], replies: { items: replies },
  };
}

describe('attachment parts in storage', () => {
  beforeEach(() => localStorage.clear());

  it('visits every root and hidden descendant through non-user messages', () => {
    const hidden = user({ id: 'hidden', replies: [] });
    const tool: MessageNode = { id: toMessageId({ raw: 'tool' }), role: 'tool', createdAt: 1, modelId: undefined, lmParameters: undefined, parts: [], replies: { items: [hidden] } };
    const root = user({ id: 'root', replies: [tool, user({ id: 'sibling', replies: [] })] });
    const next = user({ id: 'next', replies: [] });
    const parts = [...iterateAttachmentParts({ nodes: [root, next] })];
    expect(parts.map(part => part.attachment.originalName)).toEqual(['root.txt', 'hidden.txt', 'sibling.txt', 'next.txt']);
    expect(parts[1]).toBe(hidden.parts[0]);
    parts[1]!.attachment = { ...parts[1]!.attachment, status: 'missing' };
    expect(hidden.parts[0]).toMatchObject({ attachment: { status: 'missing' } });
  });

  it('does not recurse on the JavaScript stack when traversing a deep branch', () => {
    let node: MessageNode = user({ id: 'leaf', replies: [] });
    for (let index = 0; index < 12000; index++) {
      node = { id: toMessageId({ raw: `system-${index}` }), role: 'system', createdAt: 1, modelId: undefined, lmParameters: undefined, parts: [], replies: { items: [node] } };
    }
    expect([...iterateAttachmentParts({ nodes: [node] })].map(part => part.attachment.originalName)).toEqual(['leaf.txt']);
  });

  it.each(['local', 'memory'] as const)('restores memory blobs inside nested parts with %s storage', async (kind) => {
    const provider = (() => {
      switch (kind) {
      case 'local': return new LocalStorageProvider();
      case 'memory': return new MemoryStorageProvider();
      default: {
        const _ex: never = kind;
        throw new Error(`Unhandled storage kind: ${_ex}`);
      }
      }
    })();
    const leaf = user({ id: 'leaf', replies: [] });
    const attachment = leaf.parts[0];
    if (attachment?.type !== 'attachment') throw new Error('Fixture attachment is missing');
    const blob = new Blob(['original']);
    attachment.attachment = { ...attachment.attachment, status: 'memory', blob };
    const root: MessageNode = { id: toMessageId({ raw: 'assistant' }), role: 'assistant', createdAt: 1, modelId: undefined, lmParameters: undefined, interruption: { type: 'cancelled' }, parts: [{ type: 'text', text: 'partial', completeness: 'partial' }], replies: { items: [leaf] } };
    const id = toChatId({ raw: 'chat' });
    await provider.saveChatContent({ id, content: { root: { items: [root] }, currentLeafId: leaf.id } });
    const loaded = await provider.loadChatContent({ id });
    expect(loaded?.root.items[0]).toMatchObject({ interruption: { type: 'cancelled' }, parts: [{ type: 'text', text: 'partial', completeness: 'partial' }] });
    const restored = [...iterateAttachmentParts({ nodes: loaded!.root.items })][0]!.attachment;
    expect(restored.status).toBe('memory');
    switch (restored.status) {
    case 'memory': expect(restored.blob).toBe(blob); break;
    case 'missing':
    case 'persisted': throw new Error('Expected restored memory attachment');
    default: {
      const _ex: never = restored;
      throw new Error(`Unhandled attachment: ${_ex}`);
    }
    }
  });

  it('does not rewrite legacy local data on read and converts the whole saved tree', async () => {
    const id = toChatId({ raw: 'legacy-chat' });
    const key = `${STORAGE_KEY_PREFIX}lsp:chat_content:${idToRaw({ id })}`;
    const legacy = { root: { items: [{ id: 'a', role: 'assistant', timestamp: 4, content: '<think>raw</think> A', thinking: '', replies: { items: [{ id: 'b', role: 'system', timestamp: 5, content: '', replies: { items: [] } }] } }] } };
    const bytes = JSON.stringify(legacy);
    localStorage.setItem(key, bytes);
    const provider = new LocalStorageProvider();
    const loaded = await provider.loadChatContent({ id });
    expect(localStorage.getItem(key)).toBe(bytes);
    expect(loaded?.root.items[0]).toMatchObject({ createdAt: 4, parts: [{ type: 'reasoning', text: '' }, { type: 'text', text: '<think>raw</think> A' }] });
    await provider.saveChatContent({ id, content: loaded! });
    const saved = JSON.parse(localStorage.getItem(key)!);
    expect(saved.root.items[0].parts.map((part: { type: string }) => part.type)).toEqual(['reasoning', 'text']);
    expect(saved.root.items[0].replies.items[0].parts).toEqual([{ type: 'text', text: '' }]);
    expect(saved.root.items[0]).not.toHaveProperty('content');
    expect(saved.root.items[0].replies.items[0]).not.toHaveProperty('timestamp');
  });
});
