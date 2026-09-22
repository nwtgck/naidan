// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import { WeshKernel } from '@/features/wesh/kernel';
import { WeshVFS } from '@/features/wesh/vfs';
import { createWeshOwnedBytes, WeshBrokenPipeError, WESH_EFFICIENT_FILE_WRITE_FALLBACK_REQUIRED, type WeshFileHandle, type WeshEfficientFileWriter, type WeshEfficientFileWriteResult } from '@/features/wesh/types';
import {
  readAllHandleBytes, readAllFileBytes, openHandleReadStream, openFileReadStream,
  writeAllBytesToHandle, writeAllFileBytes, writeAllStreamToHandle, writeAllStreamToFile,
} from '@/features/wesh/utils/fs';

function fileHandle() {
  return {
    read: vi.fn<WeshFileHandle['read']>().mockResolvedValue({ bytesRead: 0 }),
    write: vi.fn<WeshFileHandle['write']>().mockImplementation(async ({ buffer, offset, length }) => ({ bytesWritten: length ?? buffer.length - (offset ?? 0) })),
    close: vi.fn<WeshFileHandle['close']>().mockResolvedValue(undefined),
    stat: vi.fn<WeshFileHandle['stat']>().mockResolvedValue({ size: 0, mode: 0o644, type: 'file', mtime: 0, ino: 0, uid: 0, gid: 0 }),
    truncate: vi.fn<WeshFileHandle['truncate']>().mockResolvedValue(undefined),
    ioctl: vi.fn<WeshFileHandle['ioctl']>().mockResolvedValue({ ret: 0 }),
  };
}

function sourceStream({ chunks, end }: { chunks: Uint8Array[], end: 'close' | 'wait' }) {
  let position = 0;
  const cancel = vi.fn<(_reason: unknown) => Promise<void>>().mockResolvedValue(undefined);
  const pull = vi.fn((controller: ReadableStreamDefaultController<Uint8Array>) => {
    const chunk = chunks[position++];
    if (chunk !== undefined) controller.enqueue(chunk);
    else if (end === 'close') controller.close();
  });
  const stream = new ReadableStream<Uint8Array>({ pull, cancel }, { highWaterMark: 0 });
  return { stream, pull, cancel };
}

function fileSystem({ kind }: { kind: 'efficient' | 'fallback' | 'no-capability' }) {
  const handle = fileHandle();
  const writer = {
    write: vi.fn<WeshEfficientFileWriter['write']>().mockResolvedValue(undefined),
    close: vi.fn<WeshEfficientFileWriter['close']>().mockResolvedValue(undefined),
    abort: vi.fn<WeshEfficientFileWriter['abort']>().mockResolvedValue(undefined),
  };
  const open = vi.fn(async () => handle);
  const stat = vi.fn(async () => ({}));
  const efficient = vi.fn<() => Promise<WeshEfficientFileWriteResult>>().mockImplementation(async () => {
    switch (kind) {
    case 'efficient': return { kind: 'writer', writer };
    case 'fallback':
    case 'no-capability': return { kind: 'fallback_required', reason: WESH_EFFICIENT_FILE_WRITE_FALLBACK_REQUIRED };
    default: { const _ex: never = kind; throw new Error(String(_ex)); }
    }
  });
  return { handle, writer, open, efficient, files: { open, stat, tryCreateFileWriterEfficiently: kind === 'no-capability' ? undefined : efficient } };
}

const invalidCounts = [-1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER];

describe('all-byte helpers validate progress, not estimated sizes', () => {
  it.each(invalidCounts)('rejects invalid read count %s without closing a borrowed handle', async bytesRead => {
    const handle = fileHandle();
    handle.read.mockResolvedValueOnce({ bytesRead });
    await expect(readAllHandleBytes({ handle })).rejects.toThrow('invalid read count');
    expect(handle.read).toHaveBeenCalledOnce();
    expect(handle.close).not.toHaveBeenCalled();
  });

  it.each([0, ...invalidCounts])('rejects invalid write progress %s without silently succeeding or retrying', async bytesWritten => {
    const handle = fileHandle();
    handle.write.mockResolvedValueOnce({ bytesWritten }).mockRejectedValue(new Error('Unexpected retry'));
    await expect(writeAllBytesToHandle({ handle, data: new Uint8Array([1, 2, 3]) })).rejects.toThrow('valid write progress');
    expect(handle.write).toHaveBeenCalledOnce();
    expect(handle.close).not.toHaveBeenCalled();
  });

  it('reads positive short results to EOF without trusting stat and leaves borrowed handles open', async () => {
    const handle = fileHandle();
    handle.read.mockImplementationOnce(async ({ buffer }) => {
      buffer.set([0, 255]); return { bytesRead: 2 };
    });
    handle.read.mockImplementationOnce(async ({ buffer }) => {
      buffer[0] = 128; return { bytesRead: 1 };
    });
    expect(await readAllHandleBytes({ handle })).toEqual(new Uint8Array([0, 255, 128]));
    expect(handle.stat).not.toHaveBeenCalled();
    expect(handle.read).toHaveBeenCalledTimes(3);
    expect(handle.close).not.toHaveBeenCalled();
  });

  it('writes the exact remainder after each short write and does not call write for empty input', async () => {
    const handle = fileHandle();
    handle.write.mockResolvedValue({ bytesWritten: 1 });
    const data = new Uint8Array([0, 255, 128]);
    await writeAllBytesToHandle({ handle, data });
    expect(handle.write.mock.calls.map(([{ offset, length }]) => [offset, length])).toEqual([[0, 3], [1, 2], [2, 1]]);
    await writeAllBytesToHandle({ handle, data: new Uint8Array(0) });
    expect(handle.write).toHaveBeenCalledTimes(3);
    expect(handle.close).not.toHaveBeenCalled();
  });

  it.each(['read', 'write'] as const)('retains %s and close failures for an owned file', async operation => {
    const system = fileSystem({ kind: 'no-capability' });
    const primary = new Error('I/O failed'); const secondary = new Error('Close failed');
    system.handle.read.mockRejectedValue(primary);
    system.handle.write.mockRejectedValue(primary);
    system.handle.close.mockRejectedValue(secondary);
    const result = operation === 'read'
      ? readAllFileBytes({ files: system.files, path: '/data' })
      : writeAllFileBytes({ files: system.files, path: '/data', data: new Uint8Array([1]) });
    await expect(result).rejects.toMatchObject({ errors: [primary, secondary] });
    expect(system.handle.close).toHaveBeenCalledOnce();
  });

  it('does not report a zero-progress whole-file write as successful', async () => {
    const system = fileSystem({ kind: 'no-capability' });
    system.handle.write.mockResolvedValue({ bytesWritten: 0 });
    await expect(writeAllFileBytes({ files: system.files, path: '/data', data: new Uint8Array([1]) })).rejects.toThrow('valid write progress');
    expect(system.handle.close).toHaveBeenCalledOnce();
  });
});

describe('handle-to-stream ownership', () => {
  it.each([0, -1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])('rejects chunk size %s before taking ownership', chunkSize => {
    const handle = fileHandle();
    expect(() => openHandleReadStream({ handle, chunkSize })).toThrow(RangeError);
    expect(handle.read).not.toHaveBeenCalled();
    expect(handle.close).not.toHaveBeenCalled();
  });

  it('does not prefetch without demand, preserves short chunks and closes once at EOF', async () => {
    const handle = fileHandle();
    handle.read.mockImplementationOnce(async ({ buffer }) => {
      buffer[0] = 255; return { bytesRead: 1 };
    });
    const stream = openHandleReadStream({ handle, chunkSize: 8 });
    const reader = stream.getReader();
    await Promise.resolve();
    expect(handle.read).not.toHaveBeenCalled();
    const first = await reader.read();
    expect(first.value).toEqual(new Uint8Array([255]));
    expect(first.value?.buffer.byteLength).toBe(1);
    await Promise.resolve();
    expect(handle.read).toHaveBeenCalledOnce();
    expect(await reader.read()).toEqual({ done: true, value: undefined });
    await reader.cancel(); reader.releaseLock();
    expect(handle.close).toHaveBeenCalledOnce();
  });

  it('closes a never-consumed stream without reading the input', async () => {
    const handle = fileHandle();
    const stream = openHandleReadStream({ handle });
    await stream.cancel('Not needed');
    expect(handle.read).not.toHaveBeenCalled();
    expect(handle.close).toHaveBeenCalledOnce();
  });

  it.each(['bytes', 'eof', 'rejection'] as const)('ignores late %s after cancellation and never closes twice', async kind => {
    const handle = fileHandle();
    const gate = Promise.withResolvers<{ bytesRead: number }>();
    handle.read.mockReturnValue(gate.promise);
    const stream = openHandleReadStream({ handle });
    const reader = stream.getReader();
    const pending = reader.read();
    await vi.waitFor(() => expect(handle.read).toHaveBeenCalledOnce());
    await reader.cancel('Stopped');
    expect(await pending).toEqual({ done: true, value: undefined });
    switch (kind) {
    case 'bytes': gate.resolve({ bytesRead: 1 }); break;
    case 'eof': gate.resolve({ bytesRead: 0 }); break;
    case 'rejection': gate.reject(new Error('Late I/O failure')); break;
    default: { const _ex: never = kind; throw new Error(String(_ex)); }
    }
    // Let the pending pull settle, rather than asserting before its catch runs.
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(handle.close).toHaveBeenCalledOnce();
    reader.releaseLock();
  });

  it.each(['eof', 'read-error'] as const)('does not re-close after %s cleanup fails', async kind => {
    const handle = fileHandle();
    const readError = new Error('Read failed'); const closeError = new Error('Close failed');
    if (kind === 'read-error') handle.read.mockRejectedValue(readError);
    handle.close.mockRejectedValue(closeError);
    const reader = openHandleReadStream({ handle }).getReader();
    const assertion = expect(reader.read()).rejects;
    if (kind === 'eof') await assertion.toBe(closeError);
    else await assertion.toMatchObject({ errors: [readError, closeError] });
    expect(handle.close).toHaveBeenCalledOnce();
    reader.releaseLock();
  });

  it('shares in-flight EOF cleanup with cancel and exposes its failure to the cancelling caller', async () => {
    const handle = fileHandle();
    const gate = Promise.withResolvers<void>();
    handle.close.mockReturnValue(gate.promise);
    const reader = openHandleReadStream({ handle }).getReader();
    const pending = reader.read();
    await vi.waitFor(() => expect(handle.close).toHaveBeenCalledOnce());
    const error = new Error('Cleanup failed');
    const cancel = reader.cancel(); const rejected = expect(cancel).rejects.toBe(error);
    gate.reject(error);
    await rejected;
    expect(await pending).toEqual({ done: true, value: undefined });
    expect(handle.close).toHaveBeenCalledOnce();
    reader.releaseLock();
  });

  it.each(invalidCounts)('rejects invalid streamed read count %s and closes the handle', async bytesRead => {
    const handle = fileHandle();
    handle.read.mockResolvedValueOnce({ bytesRead });
    const reader = openHandleReadStream({ handle, chunkSize: 4 }).getReader();
    await expect(reader.read()).rejects.toThrow('invalid read count');
    expect(handle.close).toHaveBeenCalledOnce(); reader.releaseLock();
  });

  it('openFileReadStream transfers the fallback handle to the lazy stream', async () => {
    const system = fileSystem({ kind: 'no-capability' });
    const stream = await openFileReadStream({ files: system.files, path: '/data' });
    expect(system.handle.read).not.toHaveBeenCalled();
    await stream.cancel();
    expect(system.handle.close).toHaveBeenCalledOnce();
  });
});

describe('stream-to-handle ownership', () => {
  it.each([true, false])('cancels a failed write input and respects closeHandle=%s', async closeHandle => {
    const handle = fileHandle(); const error = new Error('Disk full');
    handle.write.mockRejectedValue(error);
    const source = sourceStream({ chunks: [new Uint8Array([1, 2])], end: 'wait' });
    await expect(writeAllStreamToHandle({ stream: source.stream, handle, closeHandle })).rejects.toBe(error);
    expect(source.cancel).toHaveBeenCalledExactlyOnceWith(error);
    expect(source.pull).toHaveBeenCalledOnce();
    expect(source.stream.locked).toBe(false);
    expect(handle.close).toHaveBeenCalledTimes(closeHandle ? 1 : 0);
  });

  it('rejects zero write progress, cancels the source and closes an owned handle', async () => {
    const handle = fileHandle(); handle.write.mockResolvedValue({ bytesWritten: 0 });
    const source = sourceStream({ chunks: [new Uint8Array([1])], end: 'wait' });
    await expect(writeAllStreamToHandle({ stream: source.stream, handle, closeHandle: true })).rejects.toThrow('valid write progress');
    expect(source.cancel).toHaveBeenCalledOnce();
    expect(handle.close).toHaveBeenCalledOnce();
  });

  it('keeps the primary error and attempts both cleanups even when both fail', async () => {
    const handle = fileHandle(); const primary = new Error('Write failed');
    const cancelled = new Error('Cancel failed'); const closed = new Error('Close failed');
    handle.write.mockRejectedValue(primary); handle.close.mockRejectedValue(closed);
    const source = sourceStream({ chunks: [new Uint8Array([1])], end: 'wait' });
    source.cancel.mockRejectedValue(cancelled);
    await expect(writeAllStreamToHandle({ stream: source.stream, handle, closeHandle: true })).rejects.toMatchObject({ errors: [primary, cancelled, closed] });
    expect(source.stream.locked).toBe(false); expect(handle.close).toHaveBeenCalledOnce();
  });

  it('starts target cleanup even while source cancellation is still pending', async () => {
    const handle = fileHandle(); const error = new Error('Write failed');
    handle.write.mockRejectedValue(error);
    const gate = Promise.withResolvers<void>();
    const source = sourceStream({ chunks: [new Uint8Array([1])], end: 'wait' });
    source.cancel.mockReturnValue(gate.promise);
    const operation = writeAllStreamToHandle({ stream: source.stream, handle, closeHandle: true });
    const rejected = expect(operation).rejects.toBe(error);
    await vi.waitFor(() => expect(handle.close).toHaveBeenCalledOnce());
    expect(source.cancel).toHaveBeenCalledOnce();
    expect(source.stream.locked).toBe(true);
    gate.resolve(); await rejected;
    expect(source.stream.locked).toBe(false);
  });

  it.each([true, false])('does not cancel somebody else\'s locked input; closes only owned handle=%s', async closeHandle => {
    const source = sourceStream({ chunks: [], end: 'wait' });
    const owner = source.stream.getReader(); const handle = fileHandle();
    await expect(writeAllStreamToHandle({ stream: source.stream, handle, closeHandle })).rejects.toBeInstanceOf(TypeError);
    expect(source.cancel).not.toHaveBeenCalled();
    expect(handle.close).toHaveBeenCalledTimes(closeHandle ? 1 : 0);
    expect(source.stream.locked).toBe(true); await owner.cancel(); owner.releaseLock();
  });

  it('retains ownership-aware writes without copying their chunks or sending empty chunks', async () => {
    const handle = { ...fileHandle(), writeOwned: vi.fn<WeshFileHandle['writeOwned'] & object>().mockResolvedValue(undefined) };
    const bytes = new Uint8Array([0, 255, 128]);
    const source = sourceStream({ chunks: [new Uint8Array(0), bytes], end: 'close' });
    await writeAllStreamToHandle({ stream: source.stream, handle, closeHandle: false });
    expect(handle.writeOwned).toHaveBeenCalledOnce();
    expect(handle.writeOwned.mock.calls[0]?.[0].chunk.bytes).toBe(bytes);
    expect(handle.write).not.toHaveBeenCalled(); expect(handle.close).not.toHaveBeenCalled();
    expect(source.cancel).not.toHaveBeenCalled(); expect(source.stream.locked).toBe(false);
  });

  it('preserves even an undefined rejection instead of resolving after cleanup', async () => {
    const handle = fileHandle(); handle.write.mockRejectedValue(undefined);
    const source = sourceStream({ chunks: [new Uint8Array([1])], end: 'wait' });
    await expect(writeAllStreamToHandle({ stream: source.stream, handle, closeHandle: true })).rejects.toBeUndefined();
    expect(source.cancel).toHaveBeenCalledOnce(); expect(handle.close).toHaveBeenCalledOnce();
  });
});

describe('stream-to-path acquisitions and cleanup', () => {
  it.each(['efficient', 'fallback', 'no-capability'] as const)('does not acquire a %s destination for a locked input', async kind => {
    const system = fileSystem({ kind }); const source = sourceStream({ chunks: [], end: 'wait' });
    const owner = source.stream.getReader();
    await expect(writeAllStreamToFile({ files: system.files, path: '/data', stream: source.stream, mode: 'truncate' })).rejects.toBeInstanceOf(TypeError);
    expect(system.open).not.toHaveBeenCalled(); expect(system.efficient).not.toHaveBeenCalled();
    expect(source.cancel).not.toHaveBeenCalled();
    await owner.cancel(); owner.releaseLock();
  });

  it.each(['efficient', 'fallback', 'no-capability'] as const)('cancels input when %s acquisition fails before reading any chunks', async kind => {
    const system = fileSystem({ kind }); const error = new Error('Open failed');
    system.open.mockRejectedValue(error);
    if (kind === 'efficient') system.efficient.mockRejectedValue(error);
    const source = sourceStream({ chunks: [new Uint8Array([1])], end: 'wait' });
    await expect(writeAllStreamToFile({ files: system.files, path: '/data', stream: source.stream, mode: 'truncate' })).rejects.toBe(error);
    expect(source.pull).not.toHaveBeenCalled();
    expect(source.cancel).toHaveBeenCalledExactlyOnceWith(error); expect(source.stream.locked).toBe(false);
    expect(system.handle.close).not.toHaveBeenCalled(); expect(system.writer.abort).not.toHaveBeenCalled();
  });

  it.each(['truncate', 'append'] as const)('passes %s to the fallback without losing positive short writes', async mode => {
    const system = fileSystem({ kind: 'fallback' }); system.handle.write.mockResolvedValue({ bytesWritten: 1 });
    const source = sourceStream({ chunks: [new Uint8Array(0), new Uint8Array([1, 2, 3])], end: 'close' });
    await writeAllStreamToFile({ files: system.files, path: '/data', stream: source.stream, mode });
    expect(system.handle.write.mock.calls.map(([{ offset, length }]) => [offset, length])).toEqual([[0, 3], [1, 2], [2, 1]]);
    expect(system.open).toHaveBeenCalledWith({ path: '/data', flags: {
      access: 'write', creation: 'if-needed', truncate: mode === 'truncate' ? 'truncate' : 'preserve', append: mode === 'append' ? 'append' : 'preserve',
    } });
    expect(system.handle.close).toHaveBeenCalledOnce(); expect(source.cancel).not.toHaveBeenCalled();
    expect(source.stream.locked).toBe(false);
  });

  it('aborts a failed efficient writer and cancels its input with the original reason', async () => {
    const system = fileSystem({ kind: 'efficient' }); const error = new Error('Write failed');
    system.writer.write.mockRejectedValue(error);
    const source = sourceStream({ chunks: [new Uint8Array([1])], end: 'wait' });
    await expect(writeAllStreamToFile({ files: system.files, path: '/data', stream: source.stream, mode: 'truncate' })).rejects.toBe(error);
    expect(system.writer.abort).toHaveBeenCalledExactlyOnceWith({ reason: error });
    expect(system.writer.close).not.toHaveBeenCalled(); expect(system.open).not.toHaveBeenCalled();
    expect(source.cancel).toHaveBeenCalledExactlyOnceWith(error); expect(source.stream.locked).toBe(false);
  });

  it('does not replace writer failure with cancellation or abort failure', async () => {
    const system = fileSystem({ kind: 'efficient' });
    const writeError = new Error('Write failed'); const cancelError = new Error('Cancel failed'); const abortError = new Error('Abort failed');
    system.writer.write.mockRejectedValue(writeError); system.writer.abort.mockRejectedValue(abortError);
    const source = sourceStream({ chunks: [new Uint8Array([1])], end: 'wait' }); source.cancel.mockRejectedValue(cancelError);
    await expect(writeAllStreamToFile({ files: system.files, path: '/data', stream: source.stream, mode: 'truncate' })).rejects.toMatchObject({ errors: [writeError, cancelError, abortError] });
    expect(source.stream.locked).toBe(false); expect(system.writer.abort).toHaveBeenCalledOnce();
  });

  it.each(['efficient', 'fallback'] as const)('preserves a source error in the %s branch without duplicating it on cancel', async kind => {
    const system = fileSystem({ kind }); const error = new Error('Source unavailable');
    const stream = new ReadableStream<Uint8Array>({ pull(controller) {
      controller.error(error);
    } }, { highWaterMark: 0 });
    await expect(writeAllStreamToFile({ files: system.files, path: '/data', stream, mode: 'truncate' })).rejects.toBe(error);
    if (kind === 'efficient') expect(system.writer.abort).toHaveBeenCalledExactlyOnceWith({ reason: error });
    else expect(system.handle.close).toHaveBeenCalledOnce();
    expect(stream.locked).toBe(false);
  });

  it('aborts when final efficient close fails, and does not cancel an exhausted input', async () => {
    const system = fileSystem({ kind: 'efficient' }); const error = new Error('Commit failed');
    system.writer.close.mockRejectedValue(error);
    const source = sourceStream({ chunks: [new Uint8Array([1])], end: 'close' });
    await expect(writeAllStreamToFile({ files: system.files, path: '/data', stream: source.stream, mode: 'truncate' })).rejects.toBe(error);
    expect(system.writer.close).toHaveBeenCalledOnce(); expect(system.writer.abort).toHaveBeenCalledExactlyOnceWith({ reason: error });
    expect(source.cancel).not.toHaveBeenCalled(); expect(source.stream.locked).toBe(false);
  });

  it('commits a successful efficient writer exactly once and keeps binary chunks unchanged', async () => {
    const system = fileSystem({ kind: 'efficient' }); const bytes = new Uint8Array([0, 255, 128]);
    const source = sourceStream({ chunks: [new Uint8Array(0), bytes], end: 'close' });
    await writeAllStreamToFile({ files: system.files, path: '/data', stream: source.stream, mode: 'append' });
    expect(system.writer.write).toHaveBeenCalledExactlyOnceWith({ chunk: bytes });
    expect(system.writer.close).toHaveBeenCalledOnce(); expect(system.writer.abort).not.toHaveBeenCalled();
    expect(source.cancel).not.toHaveBeenCalled(); expect(source.stream.locked).toBe(false);
  });
});


describe('kernel-owned chunks implemented with borrowed writes', () => {
  async function bind() {
    const kernel = new WeshKernel({ vfs: new WeshVFS({ rootHandle: undefined }) });
    const { pid } = await kernel.spawn({ image: 'test', args: [] });
    const sink = fileHandle();
    const handle = kernel.bindFileHandle({ pid, handle: sink, trackOwnership: true });
    return { kernel, pid, handle, sink };
  }

  it.each([0, ...invalidCounts])('rejects invalid progress %s instead of acknowledging an unwritten owned chunk', async bytesWritten => {
    const { handle, sink } = await bind();
    sink.write.mockResolvedValueOnce({ bytesWritten });
    try {
      await expect(handle.writeOwned!({ chunk: createWeshOwnedBytes({ bytes: new Uint8Array([1, 2, 3]) }) })).rejects.toThrow('valid write progress');
      expect(sink.write).toHaveBeenCalledOnce();
      // A failed operation is not a poisoned wrapper; the next request is distinct.
      await handle.writeOwned!({ chunk: createWeshOwnedBytes({ bytes: new Uint8Array([4]) }) });
      expect(sink.write).toHaveBeenCalledTimes(2);
    } finally {
      await handle.close();
    }
  });

  it('continues after positive short writes without copying the owned buffer', async () => {
    const { handle, sink } = await bind();
    const bytes = new Uint8Array([1, 2, 3]);
    sink.write.mockResolvedValue({ bytesWritten: 1 });
    try {
      await handle.writeOwned!({ chunk: createWeshOwnedBytes({ bytes }) });
      expect(sink.write.mock.calls.map(([{ offset, length }]) => [offset, length])).toEqual([[0, 3], [1, 2], [2, 1]]);
      expect(sink.write.mock.calls.every(([{ buffer }]) => buffer === bytes)).toBe(true);
    } finally {
      await handle.close();
    }
  });

  it('keeps kernel SIGPIPE termination distinct from an open destination making no progress', async () => {
    const { kernel, pid, handle, sink } = await bind();
    sink.write.mockRejectedValue(new WeshBrokenPipeError());
    await handle.writeOwned!({ chunk: createWeshOwnedBytes({ bytes: new Uint8Array([1]) }) });
    expect(kernel.getWaitStatus({ pid })).toEqual({ kind: 'signaled', signal: 13 });
    expect(sink.close).toHaveBeenCalledOnce();
    await handle.close();
    expect(sink.close).toHaveBeenCalledOnce();
  });

  it('keeps explicit descriptor close while an owned write is pending as termination', async () => {
    const { handle, sink } = await bind();
    const gate = Promise.withResolvers<{ bytesWritten: number }>();
    sink.write.mockReturnValue(gate.promise);
    const operation = handle.writeOwned!({ chunk: createWeshOwnedBytes({ bytes: new Uint8Array([1]) }) });
    await vi.waitFor(() => expect(sink.write).toHaveBeenCalledOnce());
    await handle.close();
    gate.resolve({ bytesWritten: 0 });
    await operation;
    expect(sink.close).toHaveBeenCalledOnce();
  });
});
