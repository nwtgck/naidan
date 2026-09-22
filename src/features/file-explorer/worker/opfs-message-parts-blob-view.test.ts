// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MockFile, MockFileSystemDirectoryHandle, MockFileSystemFileHandle } from '@/features/wesh/mocks/InMemoryFileSystem';
import { OPFSStorageProvider, OpfsBlobReadError } from '@/00-storage/service/opfs-storage';
import { createLegacyUploadedFileId } from '@/00-storage/service/legacy-uploaded-file-id';
import { iterateAttachmentParts } from '@/00-storage/service/message-attachments';
import { toChatId, toBinaryObjectId, idToRaw } from '@/01-models/ids';
import * as io from '@/utils/blob-view-io';
import { createWorkerBlobContext } from '@/utils/worker-blob-context';
import { workerTransfer } from '@/utils/worker-transport';

const nativeRead = io.readNativeBlobRange;
const cleanups: Array<() => void> = [];
const migration = 'v1_uploaded_files_to_binary_objects';
const chatId = toChatId({ raw: 'chat-parts' });
const contentPath = 'chat-contents/chat-parts.json';
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
  vi.restoreAllMocks(); vi.unstubAllGlobals();
});
async function fixture() {
  const root = new MockFileSystemDirectoryHandle({ name: 'root' });
  vi.stubGlobal('navigator', { storage: { getDirectory: async () => root } });
  const seed = new OPFSStorageProvider(); await seed.init();
  const dir = await root.getDirectoryHandle('naidan-storage');
  async function put({ path, content }: { path: string, content: string | Uint8Array<ArrayBuffer> }) {
    const parts = path.split('/'); const name = parts.pop()!; let folder = dir;
    for (const part of parts) folder = await folder.getDirectoryHandle(part, { create: true });
    const file = await folder.getFileHandle(name, { create: true });
    const writer = await file.createWritable(); await writer.write(content); await writer.close(); return file;
  }
  await put({ path: 'chat-metas/chat-parts.json', content: JSON.stringify({ id: 'chat-parts', title: 'parts', createdAt: 1, updatedAt: 2, debugEnabled: false }) });
  const read = vi.fn(async ({ blob, offset, length }: { blob: Blob, offset: number, length: number }) => {
    const bytes = await nativeRead({ blob, offset, length });
    return workerTransfer({ value: bytes, transferables: [bytes.buffer] });
  });
  const blobs = createWorkerBlobContext({ host: { read } }); cleanups.push(() => blobs.dispose());
  const provider = new OPFSStorageProvider({ blobs });
  vi.spyOn(io, 'readNativeBlobRange').mockRejectedValue(new DOMException('Opaque Worker', 'NotReadableError'));
  vi.spyOn(MockFile.prototype, 'text').mockRejectedValue(new Error('Native text bypass'));
  vi.spyOn(MockFile.prototype, 'stream').mockImplementation(() => {
    throw new Error('Native stream bypass');
  });
  return { dir, put, seed, provider, read, blobs };
}
function modern() {
  return {
    id: 'assistant', role: 'assistant', createdAt: 0, modelId: 'model',
    // These obsolete fields deliberately disagree; parts must remain authoritative.
    content: 'DO NOT RESTORE THIS', thinking: 'OLD REASONING', timestamp: 999,
    parts: [
      { id: 'r', type: 'reasoning', text: `\
  R\\r
🙂` },
      { id: 't1', type: 'text', text: '<think>literal</think> ' },
      { id: 'c', type: 'tool_call', toolCall: { id: 'call', type: 'function', function: { name: 'lookup', arguments: ' {"q":"🙂"} ' } } },
      { id: 't2', type: 'text', text: 'partial ', completeness: 'partial' },
    ],
    interruption: { type: 'error', message: '通信が途切れました' },
    replies: { items: [{ id: 'tool', role: 'tool', createdAt: 1, parts: [
      { id: 'result', type: 'tool_result', result: { toolCallId: 'call', status: 'success', content: { type: 'text', text: 'result\r\n' } } },
    ], replies: { items: [] } }] },
    experimental: { keepFuture: { empty: '', ordered: [1, 2] } },
  };
}
function legacy({ name, mimeType, uploadedAt }: { name: string, mimeType: string, uploadedAt: number }) {
  return { id: `legacy-${name}`, role: 'user', timestamp: 0, content: `\
  raw\\r
<think>literal</think>`, attachments: [
    { id: 'legacy-dir', originalName: name, mimeType, size: 3, uploadedAt, status: 'persisted' },
  ], replies: { items: [] }, future: { preserved: [null, false, ''] } };
}
function serialized({ nodes }: { nodes: unknown[] }): string {
  const text = JSON.stringify({ root: { items: nodes }, currentLeafId: 'assistant', futureDocument: true });
  return text;
}
const textOf = ({ file }: { file: MockFileSystemFileHandle }) => new TextDecoder().decode(file.content);

describe('parts-authoritative storage with a Worker BlobContext', () => {
  it('round-trips ordered reasoning/text/calls/results and interruption without resurrecting legacy fields', async () => {
    const { provider, put, read, seed } = await fixture(); await provider.init();
    const raw = serialized({ nodes: [modern()] }); const file = await put({ path: contentPath, content: raw });
    const content = await provider.loadChatContent({ id: chatId });
    if (!content) throw new Error('Expected chat content');
    const message = content.root.items[0]!;
    expect(message).toMatchObject({ createdAt: 0, parts: [
      { type: 'reasoning', text: `\
  R\\r
🙂`, completeness: 'complete' },
      { type: 'text', text: '<think>literal</think> ', completeness: 'complete' },
      { type: 'tool_call' },
      { type: 'text', text: 'partial ', completeness: 'partial' },
    ], interruption: { type: 'error', message: '通信が途切れました' } });
    for (const part of message.parts) expect(part).not.toHaveProperty('id');
    expect(textOf({ file })).toBe(raw); // Reads never perform a schema rewrite.
    // Compare the public native/context-backed save paths, without reaching
    // through the feature boundary into storage's private DTO mapper.
    await seed.saveChatContent({ id: chatId, content });
    const expected = JSON.parse(textOf({ file }));
    await provider.saveChatContent({ id: chatId, content });
    expect(JSON.parse(textOf({ file }))).toEqual(expected);
    for (const part of expected.root.items[0].parts) expect(part).not.toHaveProperty('id');
    expect(JSON.parse(textOf({ file })).root.items[0]).not.toHaveProperty('thinking');
    expect(await provider.loadChatContent({ id: chatId })).toEqual(content);
    expect(read).toHaveBeenCalled();
  });

  it('preserves an intentionally empty parts array over obsolete nonempty text', async () => {
    const { provider, put } = await fixture(); await provider.init();
    await put({ path: contentPath, content: serialized({ nodes: [{ ...modern(), parts: [], replies: { items: [] } }] }) });
    expect((await provider.loadChatContent({ id: chatId }))?.root.items[0]?.parts).toEqual([]);
  });

  it.each([null, [{ id: 'unknown', type: 'future_part' }]])('rejects invalid parts %j without falling back to legacy text or changing bytes', async parts => {
    const { provider, put } = await fixture(); await provider.init();
    const raw = JSON.stringify({ root: { items: [{ ...modern(), parts }] } });
    const file = await put({ path: contentPath, content: raw });
    await expect(provider.loadChatContent({ id: chatId })).rejects.toThrow();
    await expect(provider.loadChatContentWithoutAttachments({ id: chatId })).rejects.toThrow();
    expect(textOf({ file })).toBe(raw);
  });

  it('hydrates attachment parts in hidden branches without reordering parts or altering source JSON', async () => {
    const { provider, put } = await fixture(); await provider.init();
    await provider.saveFile({ blob: new Blob([new Uint8Array([0, 255, 128])]), binaryObjectId: toBinaryObjectId({ raw: 'binary-a1' }), name: 'renamed.bin', mimeType: 'image/png' });
    const attachment = { id: 'att-part', type: 'attachment', attachment: { id: 'att', binaryObjectId: 'binary-a1', name: 'kept.png', status: 'persisted' } };
    const hidden = { id: 'hidden', role: 'user', createdAt: 0, parts: [{ id: 'left', type: 'text', text: ' L ' }, attachment, { id: 'right', type: 'text', text: ' R ' }], replies: { items: [] } };
    const raw = serialized({ nodes: [{ ...modern(), replies: { items: [hidden] } }] });
    const file = await put({ path: contentPath, content: raw });
    const content = await provider.loadChatContent({ id: chatId }); if (!content) throw new Error('Expected content');
    expect(content.root.items[0]!.replies.items[0]!.parts.map(part => part.type)).toEqual(['text', 'attachment', 'text']);
    expect([...iterateAttachmentParts({ nodes: content.root.items })][0]?.attachment).toMatchObject({ originalName: 'kept.png', mimeType: 'image/png', size: 3, status: 'persisted' });
    expect(textOf({ file })).toBe(raw);
  });

  it('checks a corrupt shard index before touching an existing binary body or marker', async () => {
    const { provider, put, dir } = await fixture(); await provider.init();
    const body = await put({ path: 'binary-objects/a1/binary-a1.bin', content: 'old-body' });
    const index = await put({ path: 'binary-objects/a1/index.json', content: '{corrupt' });
    const shard = await (await dir.getDirectoryHandle('binary-objects')).getDirectoryHandle('a1');
    const create = vi.spyOn(shard, 'getFileHandle'); const write = vi.spyOn(body, 'createWritable');
    await expect(provider.saveFile({ blob: new Blob(['replacement']), binaryObjectId: toBinaryObjectId({ raw: 'binary-a1' }), name: 'new' })).rejects.toBeInstanceOf(SyntaxError);
    expect(write).not.toHaveBeenCalled(); expect(textOf({ file: body })).toBe('old-body'); expect(textOf({ file: index })).toBe('{corrupt');
    expect(create.mock.calls.some(([, options]) => options?.create)).toBe(false);
  });
});

describe('legacy-file migration preserves the new base while reading through BlobView', () => {
  it('preserves unknown fields and modern parts while migrating by filename to stable IDs and original metadata', async () => {
    const { provider, put, dir } = await fixture();
    await put({ path: 'migration-state.json', content: JSON.stringify({ completedMigrations: [] }) });
    const names = ['a.png', 'b.dat'];
    for (const [i, name] of names.entries()) await put({ path: `uploaded-files/legacy-dir/${name}`, content: new Uint8Array([0, 255, i]) });
    const nodes = [modern(), legacy({ name: names[0]!, mimeType: 'image/png', uploadedAt: 0 }), legacy({ name: names[1]!, mimeType: 'application/custom', uploadedAt: 7 })];
    const raw = serialized({ nodes }); const file = await put({ path: contentPath, content: raw });
    await provider.init();
    const rewritten = JSON.parse(textOf({ file })); const expected = JSON.parse(raw);
    for (const [i, name] of names.entries()) {
      const id = await createLegacyUploadedFileId({ attachmentId: 'legacy-dir', name });
      Object.assign(expected.root.items[i + 1].attachments[0], { binaryObjectId: idToRaw({ id }), name });
      const metadata = await provider.getBinaryObject({ binaryObjectId: id });
      expect(metadata).toMatchObject({ name, mimeType: i === 0 ? 'image/png' : 'application/custom', createdAt: i === 0 ? 0 : 7 });
      const data = await provider.getFile({ binaryObjectId: id }); if (!data) throw new Error('Expected migrated data');
      expect(await nativeRead({ blob: data, offset: 0, length: data.size })).toEqual(new Uint8Array([0, 255, i]));
    }
    expect(rewritten).toEqual(expected);
    await expect(dir.getDirectoryHandle('uploaded-files')).rejects.toMatchObject({ name: 'NotFoundError' });
    const state = await dir.getFileHandle('migration-state.json'); expect(JSON.parse(textOf({ file: state })).completedMigrations).toContainEqual(expect.objectContaining({ name: migration }));
  });

  it('defers ambiguous references, retains sources, and reuses the same copied IDs after repair', async () => {
    const { provider, put, dir } = await fixture();
    await put({ path: 'migration-state.json', content: JSON.stringify({ completedMigrations: [] }) });
    await put({ path: 'uploaded-files/legacy-dir/a.png', content: new Uint8Array([0, 255, 1]) });
    const file = await put({ path: contentPath, content: serialized({ nodes: [legacy({ name: 'missing.png', mimeType: 'image/png', uploadedAt: 0 })] }) });
    await provider.init();
    expect(await dir.getDirectoryHandle('uploaded-files')).toBeDefined();
    const copiedBefore = []; for await (const item of provider.listBinaryObjects()) copiedBefore.push(item.id);
    expect(copiedBefore).toHaveLength(1);
    const state = await dir.getFileHandle('migration-state.json'); expect(JSON.parse(textOf({ file: state })).completedMigrations).not.toContainEqual(expect.objectContaining({ name: migration }));
    await put({ path: contentPath, content: serialized({ nodes: [legacy({ name: 'a.png', mimeType: 'image/png', uploadedAt: 0 })] }) });
    await provider.init();
    const copiedAfter = []; for await (const item of provider.listBinaryObjects()) copiedAfter.push(item.id);
    expect(copiedAfter).toEqual(copiedBefore);
    expect(JSON.parse(textOf({ file })).root.items[0].attachments[0].binaryObjectId).toBe(copiedBefore[0]);
    await expect(dir.getDirectoryHandle('uploaded-files')).rejects.toThrow();
  });

  it.each(['metadata-pass', 'rewrite-pass'] as const)('propagates a host failure in %s without deleting sources or marking migration complete', async pass => {
    const { provider, put, dir, read } = await fixture();
    const state = await put({ path: 'migration-state.json', content: JSON.stringify({ completedMigrations: [] }) });
    await put({ path: 'uploaded-files/legacy-dir/a.png', content: new Uint8Array([0, 255, 1]) });
    const raw = serialized({ nodes: [modern(), legacy({ name: 'a.png', mimeType: 'image/png', uploadedAt: 0 })] });
    const file = await put({ path: contentPath, content: raw });
    const original = read.getMockImplementation()!; let contentReads = 0;
    read.mockImplementation(async request => {
      if ('name' in request.blob && request.blob.name === 'chat-parts.json') {
        contentReads++;
        if (contentReads === (pass === 'metadata-pass' ? 1 : 2)) throw new DOMException('Snapshot failed', 'NotReadableError');
      }
      return original(request);
    });
    await expect(provider.init()).rejects.toBeInstanceOf(OpfsBlobReadError);
    expect(textOf({ file })).toBe(raw); expect(await dir.getDirectoryHandle('uploaded-files')).toBeDefined();
    expect(JSON.parse(textOf({ file: state })).completedMigrations).not.toContainEqual(expect.objectContaining({ name: migration }));
  });
});
