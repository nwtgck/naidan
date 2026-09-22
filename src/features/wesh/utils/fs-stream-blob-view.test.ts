// @vitest-environment node
import { MessageChannel } from 'node:worker_threads';
import * as Comlink from 'comlink';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { createBlobViewShellFixture } from '@/features/wesh/utils/blob-view.test-helpers';
import { openFileReadStream, openHandleReadStream, writeAllStreamToFile, writeAllStreamToHandle, readAllFileBytes } from '@/features/wesh/utils/fs';
import { MockFileSystemDirectoryHandle, MockFileSystemWritableFileStream } from '@/features/wesh/mocks/InMemoryFileSystem';
import { WeshVFS } from '@/features/wesh/vfs';
import type { WeshFileHandle } from '@/features/wesh/types';
import { createWorkerBlobContext, type WorkerBlobReadHost } from '@/utils/worker-blob-context';
import * as io from '@/utils/blob-view-io';
import { exposeWorkerRemote, wrapWorkerRemote, releaseWorkerRemote, workerProxy, workerTransfer, type WorkerProxy, type WorkerServerApi, type WorkerTransfer } from '@/utils/worker-transport';

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  try {
    for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  } finally {
    vi.restoreAllMocks();
  }
});

async function shellFixture() {
  const fixture = await createBlobViewShellFixture();
  cleanups.push(fixture.dispose);
  return fixture;
}

function expectBytes({ actual, expected }: { actual: Uint8Array, expected: Uint8Array }) {
  expect(actual.byteLength).toBe(expected.byteLength);
  expect(actual.every((byte, index) => byte === expected[index])).toBe(true);
}

describe('native BlobView stream owners', () => {
  it.each(['direct', 'host'] as const)('streams binary to an efficient destination through %s reading', async route => {
    const fixture = await shellFixture();
    const bytes = Uint8Array.from({ length: io.BLOB_VIEW_CHUNK_SIZE + 13 }, (_, index) => index % 251);
    await fixture.writeFile({ path: '/source.bin', data: bytes });
    if (route === 'host') fixture.blockNativeReads();
    const stream = await openFileReadStream({ files: fixture.wesh.vfs, path: '/source.bin' });
    await writeAllStreamToFile({ files: fixture.wesh.vfs, path: '/copy.bin', stream, mode: 'truncate' });
    expectBytes({ actual: (await fixture.root.getFileHandle('copy.bin')).content, expected: bytes });
    expect(stream.locked).toBe(false);
    if (route === 'host') expect(fixture.read).toHaveBeenCalled();
    else expect(fixture.read).not.toHaveBeenCalled();
    expect(fixture.read.mock.calls.every(([request]) => request.length <= io.BLOB_VIEW_CHUNK_SIZE)).toBe(true);
  });

  it('closes only the failed transfer source and leaves the shared context and sibling readable', async () => {
    const fixture = await shellFixture();
    const bytes = new Uint8Array(io.BLOB_VIEW_CHUNK_SIZE * 2 + 1).fill(255);
    await fixture.writeFile({ path: '/source.bin', data: bytes });
    fixture.blockNativeReads();
    const source = await fixture.wesh.vfs.open({ path: '/source.bin', flags: {
      access: 'read', creation: 'never', truncate: 'preserve', append: 'preserve',
    } });
    const close = vi.spyOn(source, 'close');
    const stream = openHandleReadStream({ handle: source });
    const destination = await fixture.wesh.vfs.open({ path: '/copy.bin', flags: {
      access: 'write', creation: 'if-needed', truncate: 'truncate', append: 'preserve',
    } });
    const failure = new Error('Destination stopped');
    vi.spyOn(destination, 'write').mockRejectedValue(failure);
    await expect(writeAllStreamToHandle({ stream, handle: destination, closeHandle: true })).rejects.toBe(failure);
    expect(close).toHaveBeenCalledOnce(); expect(stream.locked).toBe(false);
    await expect(source.read({ buffer: new Uint8Array(1) })).rejects.toThrow('closed');
    expectBytes({ actual: await readAllFileBytes({ files: fixture.wesh.vfs, path: '/source.bin' }), expected: bytes });
  });

  it.each(['snapshot', 'seek'] as const)('aborts an append writer before handoff when %s preparation fails', async stage => {
    const fixture = await shellFixture();
    const destination = await fixture.writeFile({ path: '/target', data: 'previous' });
    const failure = new Error('Append preparation failed');
    const createWritable = destination.createWritable.bind(destination);
    const aborts: ReturnType<typeof vi.spyOn>[] = [];
    const closes: ReturnType<typeof vi.spyOn>[] = [];
    vi.spyOn(destination, 'createWritable').mockImplementation(async options => {
      const writer = await createWritable(options);
      aborts.push(vi.spyOn(writer, 'abort')); closes.push(vi.spyOn(writer, 'close'));
      switch (stage) {
      case 'snapshot': vi.mocked((destination as unknown as FileSystemFileHandle).getFile).mockRejectedValue(failure); break;
      case 'seek': vi.spyOn(writer, 'seek').mockRejectedValue(failure); break;
      default: { const _ex: never = stage; throw new Error(String(_ex)); }
      }
      return writer;
    });
    const source = await openFileReadStream({ files: fixture.wesh.vfs, path: '/target' });
    const cancel = vi.fn(async () => {
      await source.cancel();
    });
    const waiting = new ReadableStream<Uint8Array>({ cancel }, { highWaterMark: 0 });
    await expect(writeAllStreamToFile({ files: fixture.wesh.vfs, path: '/target', stream: waiting, mode: 'append' })).rejects.toBe(failure);
    expect(aborts[0]).toHaveBeenCalledExactlyOnceWith(failure); expect(closes[0]).not.toHaveBeenCalled();
    expect(cancel).toHaveBeenCalledOnce(); expect(waiting.locked).toBe(false);
    expect(new TextDecoder().decode(destination.content)).toBe('previous');
  });

  it('retains append preparation and abort failures without closing the failed writer', async () => {
    const fixture = await shellFixture();
    const destination = await fixture.writeFile({ path: '/target', data: 'previous' });
    const preparation = new Error('Seek failed'); const cleanup = new Error('Abort failed');
    const createWritable = destination.createWritable.bind(destination);
    const close = vi.fn();
    vi.spyOn(destination, 'createWritable').mockImplementation(async options => {
      const writer = await createWritable(options);
      vi.spyOn(writer, 'seek').mockRejectedValue(preparation);
      vi.spyOn(writer, 'abort').mockRejectedValue(cleanup);
      vi.spyOn(writer, 'close').mockImplementation(async () => {
        close();
      });
      return writer;
    });
    await expect(fixture.wesh.vfs.tryCreateFileWriterEfficiently({ path: '/target', mode: 'append' })).rejects.toMatchObject({ errors: [preparation, cleanup] });
    expect(close).not.toHaveBeenCalled();
  });

  it('runs real cp over partial source chunks and verifies every binary byte', async () => {
    const fixture = await shellFixture();
    const bytes = Uint8Array.from({ length: io.BLOB_VIEW_CHUNK_SIZE + 11 }, (_, index) => index % 253);
    await fixture.writeFile({ path: '/source.bin', data: bytes }); fixture.blockNativeReads();
    const copied = await fixture.execute({ script: 'cp /source.bin /target.bin', stdinText: undefined });
    expect(copied.result.exitCode).toBe(0); expect(copied.stderr.text).toBe('');
    expectBytes({ actual: (await fixture.root.getFileHandle('target.bin')).content, expected: bytes });
  });

  it.each(['open', 'zero-write'] as const)('real cp reports %s failure and closes its source rather than leaking a host reader', async stage => {
    const fixture = await shellFixture();
    await fixture.writeFile({ path: '/source.bin', data: new Uint8Array(io.BLOB_VIEW_CHUNK_SIZE + 3) });
    fixture.blockNativeReads();
    const sourceHandles: WeshFileHandle[] = [];
    const sourceCloses: ReturnType<typeof vi.spyOn>[] = [];
    const openEntry = fixture.wesh.vfs.openEntry.bind(fixture.wesh.vfs);
    vi.spyOn(fixture.wesh.vfs, 'openEntry').mockImplementation(async request => {
      const source = await openEntry(request);
      sourceHandles.push(source); sourceCloses.push(vi.spyOn(source, 'close'));
      return source;
    });
    const open = fixture.wesh.vfs.open.bind(fixture.wesh.vfs);
    vi.spyOn(fixture.wesh.vfs, 'open').mockImplementation(async request => {
      if (request.path !== '/target.bin') return open(request);
      if (stage === 'open') throw new Error('Destination unavailable');
      const target = await open(request);
      vi.spyOn(target, 'write').mockResolvedValue({ bytesWritten: 0 });
      return target;
    });
    const copied = await fixture.execute({ script: 'cp /source.bin /target.bin', stdinText: undefined });
    expect(copied.result.exitCode).toBe(1);
    expect(copied.stderr.text).toContain(stage === 'open' ? 'Destination unavailable' : 'valid write progress');
    expect(sourceCloses).toHaveLength(1); expect(sourceCloses[0]).toHaveBeenCalledOnce();
    await expect(sourceHandles[0]!.read({ buffer: new Uint8Array(1) })).rejects.toThrow('closed');
    if (stage === 'open') expect(fixture.read).not.toHaveBeenCalled();
  });

  it('closes a failed cp source before starting the next file in the same command', async () => {
    const fixture = await shellFixture();
    await fixture.writeFile({ path: '/first.bin', data: 'first' });
    await fixture.writeFile({ path: '/second.bin', data: 'second' });
    const directory = await fixture.root.getDirectoryHandle('destination', { create: true });
    fixture.blockNativeReads();
    const openEntry = fixture.wesh.vfs.openEntry.bind(fixture.wesh.vfs);
    const firstClosed = vi.fn();
    vi.spyOn(fixture.wesh.vfs, 'openEntry').mockImplementation(async request => {
      const handle = await openEntry(request);
      if (request.entry.fullPath === '/first.bin') {
        const close = handle.close.bind(handle);
        vi.spyOn(handle, 'close').mockImplementation(async () => {
          firstClosed(); await close();
        });
      }
      return handle;
    });
    const open = fixture.wesh.vfs.open.bind(fixture.wesh.vfs);
    let closedBeforeNext = 0;
    vi.spyOn(fixture.wesh.vfs, 'open').mockImplementation(async request => {
      if (request.path === '/destination/first.bin') throw new Error('First destination failed');
      if (request.path === '/destination/second.bin') closedBeforeNext = firstClosed.mock.calls.length;
      return open(request);
    });
    const result = await fixture.execute({ script: 'cp /first.bin /second.bin /destination', stdinText: undefined });
    expect(result.result.exitCode).toBe(1);
    expect(result.stderr.text).toContain('First destination failed');
    expect(closedBeforeNext).toBe(1);
    expect(new TextDecoder().decode((await directory.getFileHandle('second.bin')).content)).toBe('second');
    expect(firstClosed).toHaveBeenCalledOnce();
  });

  it('keeps the original destination on efficient source failure instead of committing its prefix', async () => {
    const fixture = await shellFixture();
    await fixture.writeFile({ path: '/source', data: new Uint8Array(io.BLOB_VIEW_CHUNK_SIZE + 1) });
    const target = await fixture.writeFile({ path: '/target', data: 'old value' });
    const input = await openFileReadStream({ files: fixture.wesh.vfs, path: '/source' });
    fixture.blockNativeReads();
    const savedRead = fixture.read.getMockImplementation()!;
    const failure = new Error('Second data read unavailable');
    fixture.read.mockImplementation(async request => {
      if (request.offset > 0 && request.length === 1) throw failure;
      return savedRead(request);
    });
    const abort = vi.spyOn(MockFileSystemWritableFileStream.prototype, 'abort');
    await expect(writeAllStreamToFile({ files: fixture.wesh.vfs, path: '/target', stream: input, mode: 'truncate' })).rejects.toBe(failure);
    expect(abort).toHaveBeenCalledExactlyOnceWith(failure);
    expect(new TextDecoder().decode(target.content)).toBe('old value'); expect(input.locked).toBe(false);
  });
});

// Test-only endpoint: exercise the helpers with real clone/proxy/transfer, not a new production API.
interface StreamCopyProbe {
  init(request: { target: 'efficient' | 'handle' }, host: WorkerProxy<WorkerBlobReadHost>): Promise<void>,
  copy(request: { blob: Blob, fail: boolean }): Promise<number>,
  bytes(): Promise<WorkerTransfer<Uint8Array<ArrayBuffer>>>,
  dispose(): Promise<void>,
}
const savedRead = Blob.prototype.arrayBuffer;

async function streamTransport({ target }: { target: 'efficient' | 'handle' }) {
  const channel = new MessageChannel();
  const root = new MockFileSystemDirectoryHandle({ name: 'root' });
  let context: ReturnType<typeof createWorkerBlobContext> | undefined;
  let files: WeshVFS | undefined;
  let sink: 'efficient' | 'handle' = target;
  const inputCancels = vi.fn();
  const server: WorkerServerApi<StreamCopyProbe> = {
    async init(request, host) {
      const validated = z.object({ target: z.enum(['efficient', 'handle']) }).parse(request);
      sink = validated.target;
      context = createWorkerBlobContext({ host });
      files = new WeshVFS({ rootHandle: root as unknown as FileSystemDirectoryHandle, blobs: context });
    },
    async copy(request) {
      const { blob, fail } = z.object({ blob: z.instanceof(Blob), fail: z.boolean() }).parse(request);
      if (context === undefined || files === undefined) throw new Error('Not ready');
      const nativeStream = context.fromNative({ blob }).stream();
      const input = nativeStream.getReader();
      const stream = new ReadableStream<Uint8Array>({
        async pull(controller) {
          const next = await input.read();
          if (next.done) {
            input.releaseLock(); controller.close();
          } else controller.enqueue(next.value);
        },
        async cancel(reason) {
          inputCancels(reason);
          try {
            await input.cancel(reason);
          } finally {
            input.releaseLock();
          }
        },
      }, { highWaterMark: 0 });
      switch (sink) {
      case 'efficient': {
        const owner = files;
        await writeAllStreamToFile({
          files: {
            open: owner.open.bind(owner), stat: owner.stat.bind(owner),
            async tryCreateFileWriterEfficiently(options) {
              const result = await owner.tryCreateFileWriterEfficiently(options);
              if (result.kind !== 'writer' || !fail) return result;
              return { ...result, writer: { ...result.writer, async write() {
                throw new Error('Sink failed');
              } } };
            },
          }, path: '/out', stream, mode: 'truncate',
        });
        break;
      }
      case 'handle': {
        const handle = await files.open({ path: '/out', flags: { access: 'write', creation: 'if-needed', truncate: 'truncate', append: 'preserve' } });
        if (fail) vi.spyOn(handle, 'write').mockRejectedValue(new Error('Sink failed'));
        await writeAllStreamToHandle({ stream, handle, closeHandle: true });
        break;
      }
      default: { const _ex: never = sink; throw new Error(String(_ex)); }
      }
      return z.number().int().nonnegative().parse((await root.getFileHandle('out')).content.byteLength);
    },
    async bytes() {
      const bytes = Uint8Array.from((await root.getFileHandle('out')).content);
      return workerTransfer({ value: bytes, transferables: [bytes.buffer] });
    },
    async dispose() {
      context?.dispose();
    },
  };
  exposeWorkerRemote<StreamCopyProbe>({ api: server, endpoint: channel.port1 as unknown as MessagePort });
  const remote = wrapWorkerRemote<StreamCopyProbe>({ endpoint: channel.port2 as unknown as MessagePort });
  const returned: ArrayBuffer[] = [];
  const read = vi.fn(async ({ blob, offset, length }: { blob: Blob, offset: number, length: number }) => {
    const buffer = await savedRead.call(blob.slice(offset, offset + length)); returned.push(buffer);
    return workerTransfer({ value: new Uint8Array(buffer), transferables: [buffer] });
  });
  const finalized = vi.fn();
  const host = Object.assign({ read }, { [Comlink.finalizer]: finalized });
  vi.spyOn(io, 'readNativeBlobRange').mockRejectedValue(new DOMException('Worker read unavailable', 'NotReadableError'));
  await remote.init({ target }, workerProxy({ value: host }));
  cleanups.push(async () => {
    try {
      await remote.dispose(); await vi.waitFor(() => expect(finalized).toHaveBeenCalledOnce());
    } finally {
      context?.dispose(); releaseWorkerRemote({ remote }); channel.port1.close(); channel.port2.close();
    }
  });
  return { remote, returned, read, finalized, inputCancels };
}

describe('stream helpers over real Comlink byte transfers', () => {
  it.each(['efficient', 'handle'] as const)('preserves binary %s output without disposing the host before a second operation', async target => {
    const t = await streamTransport({ target });
    const bytes = Uint8Array.from({ length: io.BLOB_VIEW_CHUNK_SIZE + 7 }, (_, index) => index % 251);
    expect(await t.remote.copy({ blob: new Blob([bytes]), fail: false })).toBe(bytes.byteLength);
    expectBytes({ actual: await t.remote.bytes(), expected: bytes });
    expect(t.inputCancels).not.toHaveBeenCalled(); expect(t.finalized).not.toHaveBeenCalled();
    expect(t.returned.every(buffer => buffer.byteLength === 0)).toBe(true);
    expect(await t.remote.copy({ blob: new Blob(['second']), fail: false })).toBe(6);
    expect(new TextDecoder().decode(await t.remote.bytes())).toBe('second');
  });

  it.each(['efficient', 'handle'] as const)('cancels only the failing %s input and keeps the shared host usable', async target => {
    const t = await streamTransport({ target });
    const bytes = new Uint8Array(io.BLOB_VIEW_CHUNK_SIZE * 2 + 1);
    await expect(t.remote.copy({ blob: new Blob([bytes]), fail: true })).rejects.toThrow('Sink failed');
    expect(t.inputCancels).toHaveBeenCalledOnce(); expect(t.finalized).not.toHaveBeenCalled();
    // One capability probe and just the first data chunk: no post-failure read-ahead.
    expect(t.read.mock.calls.map(([request]) => request.length)).toEqual([3, io.BLOB_VIEW_CHUNK_SIZE]);
    expect(await t.remote.copy({ blob: new Blob(['retry']), fail: false })).toBe(5);
    expect(new TextDecoder().decode(await t.remote.bytes())).toBe('retry');
    expect(t.returned.every(buffer => buffer.byteLength === 0)).toBe(true);
  });
});
