import { describe, expect, it } from 'vitest';
import { readLegacyUploadedFileMetadata, remapLegacyUploadedFileReferences } from './legacy-uploaded-file-content';
import { createLegacyUploadedFileId } from './legacy-uploaded-file-id';
import { idToRaw } from '@/01-models/ids';

function legacy() {
  return {
    id: 'u', role: 'user', timestamp: 0, content: '  <think>literal</think>\r\n',
    attachments: [{ id: 'a', originalName: 'a.png', mimeType: 'image/png', size: 4, uploadedAt: 0, status: 'persisted' }],
    replies: { items: [] },
  };
}

function copyIds() {
  return new Map([['a', new Map([['a.png', 'copied-a'], ['b.png', 'copied-b']])]]);
}

describe('legacy uploaded-file reference edits', () => {
  it('preserves extra fields and reserved keys at every rewritten level', () => {
    const original = JSON.parse(JSON.stringify({ root: { items: [legacy()] }, currentLeafId: 'u' }));
    const extra = JSON.parse('{"__proto__":{"preserve":true},"constructor":"literal","other":{"a":[1,"x"]}}');
    Object.defineProperty(original, '__proto__', { value: extra.__proto__, enumerable: true });
    Object.defineProperty(original.root.items[0], '__proto__', { value: extra.__proto__, enumerable: true });
    original.root.items[0].attachments[0].extra = extra;
    original.root.items[0].experimental = { future: { value: 'unreadable but retained' } };
    const before = JSON.stringify(original);
    const result = remapLegacyUploadedFileReferences({ serialized: before, binaryObjectIds: copyIds() });
    expect(result.unresolvedReferences).toBe(0);
    expect(result.serialized).toBeDefined();
    const expected = JSON.parse(before);
    expected.root.items[0].attachments[0].binaryObjectId = 'copied-a';
    expected.root.items[0].attachments[0].name = 'a.png';
    expect(JSON.parse(result.serialized!)).toEqual(expected);
    expect(JSON.stringify(original)).toBe(before);
  });

  it('preserves modern parts and rewrites legacy attachments on hidden branches', () => {
    const modern = { id: 'new', role: 'assistant', createdAt: 0, parts: [{ id: 'r', type: 'reasoning', text: '  R\n', completeness: 'partial' }], interruption: { type: 'error', message: '日本語' }, replies: { items: [] }, future: 'kept' };
    const old = { id: 'old', role: 'assistant', content: 'A', thinking: '', timestamp: 0, replies: { items: [legacy(), legacy()] } };
    const result = remapLegacyUploadedFileReferences({ serialized: JSON.stringify({ root: { items: [modern, old], extra: true } }), binaryObjectIds: copyIds() });
    const value = JSON.parse(result.serialized!);
    expect(value.root.items[0]).toEqual(modern);
    expect(value.root.extra).toBe(true);
    expect(value.root.items[1].thinking).toBe('');
    expect(value.root.items[1].replies.items.map((node: { attachments: { binaryObjectId: string }[] }) => node.attachments[0]?.binaryObjectId)).toEqual(['copied-a', 'copied-a']);
  });

  it('returns no replacement when there is nothing to remap', () => {
    const input = { root: { items: [legacy()] } };
    const result = remapLegacyUploadedFileReferences({ serialized: JSON.stringify(input), binaryObjectIds: new Map() });
    expect(result).toEqual({ serialized: undefined, unresolvedReferences: 0 });
  });

  it('uses the original filename instead of the last copied file in a directory', () => {
    const input = legacy();
    input.attachments[0]!.originalName = 'b.png';
    const result = remapLegacyUploadedFileReferences({ serialized: JSON.stringify({ root: { items: [input] } }), binaryObjectIds: copyIds() });
    expect(JSON.parse(result.serialized!).root.items[0].attachments[0].binaryObjectId).toBe('copied-b');
  });

  it('reports an unresolved reference rather than guessing a different filename', () => {
    const input = legacy(); input.attachments[0]!.originalName = 'absent.png';
    const result = remapLegacyUploadedFileReferences({ serialized: JSON.stringify({ root: { items: [input] } }), binaryObjectIds: copyIds() });
    expect(result).toEqual({ serialized: undefined, unresolvedReferences: 1 });
  });

  it('does not remap an existing binary reference on retry', () => {
    const node = { ...legacy(), attachments: [{ id: 'a', binaryObjectId: 'already-copied', name: 'a.png', status: 'persisted' }] };
    expect(remapLegacyUploadedFileReferences({ serialized: JSON.stringify({ root: { items: [node] } }), binaryObjectIds: copyIds() }).serialized).toBeUndefined();
  });

  it('validates invalid JSON and mixed new/legacy nodes before editing', () => {
    for (const serialized of ['{broken', JSON.stringify({ root: { items: [{ ...legacy(), parts: [{ type: 'unknown' }] }] } })]) {
      expect(() => remapLegacyUploadedFileReferences({ serialized, binaryObjectIds: copyIds() })).toThrow();
    }
  });

  it('reads original MIME and uploaded time including zero without reading file bodies', () => {
    const input = { root: { items: [{ ...legacy(), replies: { items: [legacy()] } }] } };
    expect(readLegacyUploadedFileMetadata({ serialized: JSON.stringify(input) })).toEqual([
      { attachmentId: 'a', name: 'a.png', mimeType: 'image/png', createdAt: 0 },
      { attachmentId: 'a', name: 'a.png', mimeType: 'image/png', createdAt: 0 },
    ]);
  });

  it('does not fabricate old metadata from a new attachment reference', () => {
    const node = { id: 'u', role: 'user', createdAt: 0, parts: [{ id: 'a', type: 'attachment', attachment: { id: 'a', binaryObjectId: 'b', name: 'a.png', status: 'missing' } }], replies: { items: [] } };
    expect(readLegacyUploadedFileMetadata({ serialized: JSON.stringify({ root: { items: [node] } }) })).toEqual([]);
  });
});

describe('retry identity for uploaded files', () => {
  it('is stable across repeats and distinguishes directory and filename boundaries', async () => {
    const cases = [
      { attachmentId: 'a', name: 'b/c' }, { attachmentId: 'a/b', name: 'c' },
      { attachmentId: 'a', name: '日本語🙂.png' }, { attachmentId: 'a', name: '日本語🙂.PNG' },
    ];
    const ids = [];
    for (const entry of cases) {
      const first = idToRaw({ id: await createLegacyUploadedFileId(entry) });
      expect(idToRaw({ id: await createLegacyUploadedFileId(entry) })).toBe(first);
      expect(first).toMatch(/^uploaded_[0-9a-f]{64}$/u);
      ids.push(first);
    }
    expect(new Set(ids).size).toBe(cases.length);
  });
});
