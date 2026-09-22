// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';
import { WeshVFS } from '@/features/wesh/vfs';
import type { WeshFileHandle, WeshStat } from '@/features/wesh/types';
import { TEXT_PREVIEW_SIZE_LIMIT, MEDIA_PREVIEW_SIZE_LIMIT } from '@/features/file-explorer/logic/constants';
import { createFileExplorerWorker } from './impl';

// Exercise branch boundaries cheaply; the real sysfs integration separately
// tests the production text limit. No production constants are changed.
vi.mock('@/features/file-explorer/logic/constants', async importOriginal => ({
  ...await importOriginal<typeof import('@/features/file-explorer/logic/constants')>(),
  TEXT_PREVIEW_SIZE_LIMIT: 16, MEDIA_PREVIEW_SIZE_LIMIT: 32,
}));

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  try {
    for (const dispose of cleanup.splice(0)) await dispose();
  } finally {
    vi.restoreAllMocks();
  }
});

function inputHandle({ bytes, estimatedSize, shortRead }: {
  bytes: Uint8Array,
  estimatedSize: number,
  shortRead: number | undefined,
}) {
  let position = 0;
  const read = vi.fn(async ({ buffer, offset, length }: { buffer: Uint8Array, offset?: number, length?: number }) => {
    const destination = offset ?? 0;
    const capacity = length ?? buffer.byteLength - destination;
    const count = Math.min(capacity, bytes.byteLength - position, shortRead ?? capacity);
    buffer.set(bytes.subarray(position, position + count), destination);
    position += count;
    return { bytesRead: count };
  });
  const close = vi.fn(async (): Promise<void> => {});
  const stat: WeshStat = { size: estimatedSize, type: 'file', mode: 0o444, mtime: 0, ino: 0, uid: 0, gid: 0 };
  const handle: WeshFileHandle = {
    read, close, stat: async () => stat,
    write: async () => {
      throw new Error('Read only');
    },
    truncate: async () => {
      throw new Error('Read only');
    },
    ioctl: async () => ({ ret: 0 }),
  };
  return { handle, read, close, stat, getPosition: () => position };
}

async function fixture({ bytes, estimatedSize, shortRead }: {
  bytes: Uint8Array,
  estimatedSize: number,
  shortRead: number | undefined,
}) {
  const files: Array<ReturnType<typeof inputHandle>> = [];
  vi.spyOn(WeshVFS.prototype, 'stat').mockResolvedValue({ size: estimatedSize, type: 'file', mode: 0o444, mtime: 0, ino: 0, uid: 0, gid: 0 });
  vi.spyOn(WeshVFS.prototype, 'getNativeHandle').mockResolvedValue(null);
  const open = vi.spyOn(WeshVFS.prototype, 'open').mockImplementation(async () => {
    const file = inputHandle({ bytes, estimatedSize, shortRead }); files.push(file); return file.handle;
  });
  const worker = createFileExplorerWorker();
  const { sessionId } = await worker.prepareSession({ request: { root: { kind: 'wesh-mounts', rootName: 'Virtual', mounts: [] } } });
  cleanup.push(() => worker.disposeSession({ request: { sessionId } }));
  return { worker, sessionId, open, files };
}

describe('File Explorer virtual preview and download', () => {
  it('bounds underestimated text by actual bytes and reopens from zero for force', async () => {
    const text = 'x'.repeat(TEXT_PREVIEW_SIZE_LIMIT * 4);
    const { worker, sessionId, files, open } = await fixture({ bytes: new TextEncoder().encode(text), estimatedSize: 1, shortRead: 3 });
    expect(await worker.readPreview({ request: { sessionId, path: '/input.txt', mode: 'bounded' } })).toMatchObject({ kind: 'text', oversized: true, rawText: '', displayText: '' });
    expect(files[0]?.getPosition()).toBe(TEXT_PREVIEW_SIZE_LIMIT + 1);
    expect(files[0]?.close).toHaveBeenCalledOnce();
    expect(await worker.readPreview({ request: { sessionId, path: '/input.txt', mode: 'force' } })).toMatchObject({ kind: 'text', oversized: false, rawText: text, displayText: text });
    expect(files[1]?.getPosition()).toBe(text.length);
    expect(files[1]?.close).toHaveBeenCalledOnce();
    expect(open).toHaveBeenCalledTimes(2);
  });

  it('does not reject small text because its stat estimate is large', async () => {
    const { worker, sessionId, files } = await fixture({ bytes: new TextEncoder().encode('hello'), estimatedSize: Number.MAX_SAFE_INTEGER, shortRead: 1 });
    expect(await worker.readPreview({ request: { sessionId, path: '/input.txt', mode: 'bounded' } })).toMatchObject({ kind: 'text', oversized: false, rawText: 'hello' });
    expect(files[0]?.read).toHaveBeenCalledTimes(6);
  });

  it('accepts exact byte-limit UTF-8 JSON and formats complete input only', async () => {
    const text = '{"x":"日"}'.padEnd(TEXT_PREVIEW_SIZE_LIMIT - 2);
    const { worker, sessionId, files } = await fixture({ bytes: new TextEncoder().encode(text), estimatedSize: 1, shortRead: 1 });
    expect(await worker.readPreview({ request: { sessionId, path: '/input.json', mode: 'bounded' } })).toMatchObject({
      kind: 'text', oversized: false, rawText: text, displayText: JSON.stringify({ x: '日' }, null, 2), languageHint: 'json',
    });
    expect(files[0]?.getPosition()).toBe(TEXT_PREVIEW_SIZE_LIMIT);
    expect(files[0]?.read).toHaveBeenCalledTimes(TEXT_PREVIEW_SIZE_LIMIT + 1);
  });

  it('preserves raw invalid JSON and the existing language hint', async () => {
    const text = '{not json';
    const { worker, sessionId } = await fixture({ bytes: new TextEncoder().encode(text), estimatedSize: 1, shortRead: 1 });
    expect(await worker.readPreview({ request: { sessionId, path: '/input.json', mode: 'bounded' } })).toMatchObject({ kind: 'text', rawText: text, displayText: text, languageHint: 'json', oversized: false });
  });

  it.each([
    { path: '/image.png', mediaKind: 'image' },
    { path: '/sound.wav', mediaKind: 'audio' },
    { path: '/movie.mp4', mediaKind: 'video' },
  ])('bounds $mediaKind and supports forced binary-preserving reading', async ({ path, mediaKind }) => {
    const bytes = new Uint8Array(MEDIA_PREVIEW_SIZE_LIMIT + 7).fill(255); bytes.set([0, 195, 40]);
    const { worker, sessionId, files } = await fixture({ bytes, estimatedSize: 0, shortRead: 3 });
    const bounded = await worker.readPreview({ request: { sessionId, path, mode: 'bounded' } });
    expect(bounded).toMatchObject({ kind: 'media', mediaKind, oversized: true, mimeType: '' });
    if (bounded.kind !== 'media') throw new Error('Expected media preview');
    expect(bounded.blob.size).toBe(0);
    expect(files[0]?.getPosition()).toBe(MEDIA_PREVIEW_SIZE_LIMIT + 1);
    expect(files[0]?.close).toHaveBeenCalledOnce();
    const forced = await worker.readPreview({ request: { sessionId, path, mode: 'force' } });
    if (forced.kind !== 'media') throw new Error('Expected media preview');
    expect(forced.oversized).toBe(false);
    expect(new Uint8Array(await forced.blob.arrayBuffer())).toEqual(bytes);
    expect(files[1]?.close).toHaveBeenCalledOnce();
  });

  it('accepts an exact-limit media file despite an oversized stat estimate', async () => {
    const bytes = new Uint8Array(MEDIA_PREVIEW_SIZE_LIMIT).fill(255);
    const { worker, sessionId } = await fixture({ bytes, estimatedSize: Number.MAX_SAFE_INTEGER, shortRead: undefined });
    const result = await worker.readPreview({ request: { sessionId, path: '/image.png', mode: 'bounded' } });
    if (result.kind !== 'media') throw new Error('Expected media');
    expect(result.oversized).toBe(false);
    expect(new Uint8Array(await result.blob.arrayBuffer())).toEqual(bytes);
  });

  it('does not open binary data solely to show a placeholder', async () => {
    const { worker, sessionId, open } = await fixture({ bytes: new Uint8Array([255]), estimatedSize: 1, shortRead: undefined });
    expect(await worker.readPreview({ request: { sessionId, path: '/data', mode: 'force' } })).toEqual({ kind: 'binary', oversized: false });
    expect(open).not.toHaveBeenCalled();
  });

  it('keeps existence and permission checks even for a binary placeholder', async () => {
    const { worker, sessionId, open } = await fixture({ bytes: new Uint8Array([255]), estimatedSize: 1, shortRead: undefined });
    const error = new DOMException('Access denied', 'NotAllowedError');
    vi.mocked(WeshVFS.prototype.stat).mockRejectedValue(error);
    await expect(worker.readPreview({ request: { sessionId, path: '/data', mode: 'force' } })).rejects.toBe(error);
    expect(open).not.toHaveBeenCalled();
  });

  it('does not apply preview limits or text decoding to file retrieval', async () => {
    const bytes = Uint8Array.from({ length: MEDIA_PREVIEW_SIZE_LIMIT * 2 }, (_, i) => i % 256);
    const { worker, sessionId, files } = await fixture({ bytes, estimatedSize: 0, shortRead: 1 });
    const result = await worker.readFile({ request: { sessionId, path: '/data' } });
    expect(new Uint8Array(await result.blob.arrayBuffer())).toEqual(bytes);
    expect(files[0]?.getPosition()).toBe(bytes.byteLength);
    expect(files[0]?.close).toHaveBeenCalledOnce();
  });

  it.each(['readPreview', 'readFile'] as const)('does not return a result from %s after disposal during a pending read', async operation => {
    const { worker, sessionId, open } = await fixture({ bytes: new TextEncoder().encode('input'), estimatedSize: 0, shortRead: undefined });
    const file = inputHandle({ bytes: new TextEncoder().encode('input'), estimatedSize: 0, shortRead: undefined });
    const late = Promise.withResolvers<{ bytesRead: number }>();
    file.read.mockReturnValueOnce(late.promise); open.mockResolvedValueOnce(file.handle);
    const reading = worker[operation]({ request: { sessionId, path: '/input.txt', mode: 'force' } });
    const rejection = expect(reading).rejects.toMatchObject({ name: 'AbortError' });
    await vi.waitFor(() => expect(file.read).toHaveBeenCalledOnce());
    await worker.disposeSession({ request: { sessionId } });
    await rejection;
    expect(file.close).toHaveBeenCalledOnce();
    late.reject(new Error('Late read error'));
  });

  it('closes a late-opened virtual handle without starting its content read', async () => {
    const { worker, sessionId, open } = await fixture({ bytes: new Uint8Array([1]), estimatedSize: 1, shortRead: undefined });
    const file = inputHandle({ bytes: new Uint8Array([1]), estimatedSize: 1, shortRead: undefined });
    const late = Promise.withResolvers<WeshFileHandle>();
    open.mockReturnValueOnce(late.promise);
    const reading = worker.readFile({ request: { sessionId, path: '/data' } });
    const rejection = expect(reading).rejects.toMatchObject({ name: 'AbortError' });
    await vi.waitFor(() => expect(open).toHaveBeenCalledOnce());
    await worker.disposeSession({ request: { sessionId } });
    late.resolve(file.handle);
    await rejection;
    expect(file.close).toHaveBeenCalledOnce();
    expect(file.read).not.toHaveBeenCalled();
  });

  it('does not hide a source error or retry by opening the file again', async () => {
    const { worker, sessionId, open } = await fixture({ bytes: new Uint8Array([1]), estimatedSize: 1, shortRead: undefined });
    const file = inputHandle({ bytes: new Uint8Array([1]), estimatedSize: 1, shortRead: undefined });
    const error = new DOMException('Cannot read source', 'NotReadableError');
    file.read.mockRejectedValue(error); open.mockResolvedValueOnce(file.handle);
    await expect(worker.readPreview({ request: { sessionId, path: '/input.txt', mode: 'bounded' } })).rejects.toBe(error);
    expect(file.close).toHaveBeenCalledOnce();
    expect(open).toHaveBeenCalledOnce();
  });
});
