// @vitest-environment node
import { afterEach, describe, expect, expectTypeOf, it, vi } from 'vitest';
import { blobForTransport, createBlobContext, createNativeBlobContext, createBlobResponse, createBlobURLScope, type BlobContext, type BlobView } from './blob-view';
import { BLOB_VIEW_CHUNK_SIZE, readNativeBlobRange } from './blob-view-io';

const contexts: BlobContext[] = [];
function trackedContext() {
  const read = vi.fn(readNativeBlobRange);
  const release = vi.fn();
  const context = createBlobContext({ reader: { read }, release });
  contexts.push(context);
  return { context, read, release };
}

afterEach(() => {
  for (const context of contexts.splice(0)) context.dispose();
  vi.restoreAllMocks();
});

describe('BlobView identity and native interoperability', () => {
  it('is a separate type, not a forged Blob or a writable object', () => {
    expectTypeOf<BlobView>().not.toExtend<Blob>();
    expectTypeOf<BlobView>().not.toExtend<BlobPart>();
    expectTypeOf<BlobView>().not.toExtend<Parameters<typeof URL.createObjectURL>[0]>();
    expectTypeOf<BlobView>().not.toExtend<BodyInit>();
    const { context } = trackedContext();
    const view = context.fromNative({ blob: new Blob(['x']) });
    expect(view).not.toBeInstanceOf(Blob);
    expect(Object.isFrozen(view)).toBe(true);
    expect(() => Reflect.set(view, 'size', 100)).not.toThrow();
    expect(view.size).toBe(1);
    expect(() => blobForTransport({ blob: { ...view } })).toThrow(TypeError);
    expect(() => context.fromParts({ parts: [{ ...view }] })).toThrow(TypeError);
  });

  it('wraps, slices, combines, and exports native snapshots without reading their bytes', async () => {
    const { context, read } = trackedContext();
    const original = new Blob(['abcdef'], { type: 'TEXT/PLAIN' });
    const view = context.fromNative({ blob: original });
    const slice = view.slice({ start: 1, end: -1, contentType: 'TEXT/CSV' });
    const combined = context.fromParts({ parts: ['prefix', slice, new Uint8Array([255, 0]), view.slice({ start: 99 })], type: 'APPLICATION/OCTET-STREAM' });
    expect(view.size).toBe(6);
    expect(view.type).toBe('text/plain');
    expect(slice.type).toBe('text/csv');
    expect(blobForTransport({ blob: view })).toBe(original);
    expect(read).not.toHaveBeenCalled();
    const bytes = new Uint8Array(await blobForTransport({ blob: combined }).arrayBuffer());
    expect(bytes).toEqual(new Uint8Array([...new TextEncoder().encode('prefixbcde'), 255, 0]));
    expect(combined.type).toBe('application/octet-stream');
  });

  it.each([
    {}, { start: -3 }, { end: -2 }, { start: 1, end: 4 }, { start: 4, end: 2 },
    { start: Infinity, end: -Infinity }, { start: NaN, end: 3 }, { start: 0.5, end: 4.9 },
    { start: -99, end: 99, contentType: 'BAD\u0000TYPE' },
  ])('delegates native slice conversion for %j', async options => {
    const { context } = trackedContext();
    const blob = new Blob(['012345'], { type: 'text/plain' });
    const view = context.fromNative({ blob }).slice(options);
    const native = blob.slice(options.start, options.end, options.contentType);
    expect(view.size).toBe(native.size);
    expect(view.type).toBe(native.type);
    expect(await view.bytes()).toEqual(new Uint8Array(await native.arrayBuffer()));
  });

  it('retains the same reading origin across nested and sibling slices', async () => {
    const { context, read } = trackedContext();
    const origin = new Blob(['0123456789']);
    const parent = context.fromNative({ blob: origin });
    expect(await parent.slice({ start: 1 }).slice({ start: 2, end: 4 }).text()).toBe('34');
    expect(await parent.slice({ start: 5 }).text()).toBe('56789');
    expect(read.mock.calls.map(([request]) => request.blob.size)).toEqual([2, 5]);
    expect(read.mock.calls.every(([request]) => 'origin' in request && request.origin === origin)).toBe(true);
  });
});

describe('BlobView bytes, text and streams', () => {
  it('does not probe/read empty content or prefetch without a consumer', async () => {
    const { context, read } = trackedContext();
    const empty = context.fromNative({ blob: new Blob([]) });
    expect(await empty.text()).toBe('');
    expect(await empty.bytes()).toHaveLength(0);
    const emptyReader = empty.stream().getReader({ mode: 'byob' });
    expect((await emptyReader.read(new Uint8Array(4))).done).toBe(true);
    emptyReader.releaseLock();
    const stream = context.fromNative({ blob: new Blob(['abc']) }).stream();
    await Promise.resolve();
    expect(read).not.toHaveBeenCalled();
    await stream.cancel();
  });

  it('bounds stream requests and does not duplicate a single-chunk result', async () => {
    const { context, read } = trackedContext();
    const bytes = new Uint8Array(BLOB_VIEW_CHUNK_SIZE * 2 + 7).map((_, index) => index % 251);
    const view = context.fromNative({ blob: new Blob([bytes]) });
    const result = await view.bytes();
    expect(result.byteLength).toBe(bytes.byteLength);
    expect(result.every((value, index) => value === bytes[index])).toBe(true);
    expect(read.mock.calls.map(([request]) => [request.offset, request.length])).toEqual([
      [0, BLOB_VIEW_CHUNK_SIZE], [BLOB_VIEW_CHUNK_SIZE, BLOB_VIEW_CHUNK_SIZE], [BLOB_VIEW_CHUNK_SIZE * 2, 7],
    ]);
    // Repeated read results are independent of mutation/transfer of an earlier result.
    const small = view.slice({ start: 0, end: 3 });
    const first = await small.bytes();
    first.fill(255);
    structuredClone(first, { transfer: [first.buffer] });
    expect(await small.bytes()).toEqual(bytes.slice(0, 3));
  });

  it('decodes UTF-8 split across chunks, leading/embedded BOMs, and invalid terminal sequences', async () => {
    const { context } = trackedContext();
    const text = '\uFEFF' + 'a'.repeat(BLOB_VIEW_CHUNK_SIZE - 4) + '😀日本\uFEFF';
    const blob = new Blob([text, new Uint8Array([255, 195, 40, 226, 130])]);
    expect(await context.fromNative({ blob }).text()).toBe(await blob.text());
  });

  it('supports default and BYOB readers independently, including offsets and EOF', async () => {
    const { context, read } = trackedContext();
    const view = context.fromNative({ blob: new Blob([new Uint8Array([0, 255, 128, 7, 4])]) });
    const byob = view.stream().getReader({ mode: 'byob' });
    const supplied = new Uint8Array(9).fill(42);
    const first = await byob.read(supplied.subarray(2, 5));
    expect(first.value).toEqual(new Uint8Array([0, 255, 128]));
    expect(first.value?.byteOffset).toBe(2);
    expect(supplied.buffer.byteLength).toBe(0); // Standard BYOB ownership transfer, not RPC transfer.
    expect((await byob.read(new Uint8Array(8))).value).toEqual(new Uint8Array([7, 4]));
    expect((await byob.read(new Uint8Array(1))).done).toBe(true);
    byob.releaseLock();
    expect(await view.text()).toBe(new TextDecoder().decode(new Uint8Array([0, 255, 128, 7, 4])));
    expect(read.mock.calls.slice(0, 2).map(([request]) => request.length)).toEqual([3, 2]);
  });

  it('handles BYOB min across chunks and preserves the byte-controller alignment errors', async () => {
    const { context } = trackedContext();
    const bytes = new Uint8Array(BLOB_VIEW_CHUNK_SIZE + 8).fill(3);
    const byob = context.fromNative({ blob: new Blob([bytes]) }).stream().getReader({ mode: 'byob' });
    const result = await byob.read(new Uint8Array(bytes.length), { min: bytes.length });
    expect(result.value?.byteLength).toBe(bytes.length);
    expect((await byob.read(new Uint8Array(1))).done).toBe(true);
    byob.releaseLock();
    const unaligned = context.fromNative({ blob: new Blob([new Uint8Array([1])]) }).stream().getReader({ mode: 'byob' });
    await expect(unaligned.read(new Uint16Array(2))).rejects.toThrow(TypeError);
    unaligned.releaseLock();
  });

  it('pipes into an ordinary writable sink with backpressure and no whole-file buffer', async () => {
    const { context, read } = trackedContext();
    const view = context.fromNative({ blob: new Blob([new Uint8Array(BLOB_VIEW_CHUNK_SIZE + 1)]) });
    const blocked = Promise.withResolvers<void>();
    const started = Promise.withResolvers<void>();
    let writes = 0;
    const done = view.stream().pipeTo(new WritableStream<Uint8Array>({
      async write() {
        writes += 1;
        if (writes === 1) {
          started.resolve(); await blocked.promise;
        }
      },
    }));
    await started.promise;
    expect(read).toHaveBeenCalledOnce();
    blocked.resolve();
    await done;
    expect(writes).toBe(2);
  });

  it.each(['short', 'subview', 'shared'] as const)('rejects a %s backend result rather than silently exposing invalid data', async kind => {
    const { context, read } = trackedContext();
    switch (kind) {
    case 'short': read.mockResolvedValue(new Uint8Array(1)); break;
    case 'subview': read.mockResolvedValue(new Uint8Array(10).subarray(2, 5)); break;
    case 'shared': read.mockResolvedValue(new Uint8Array(new SharedArrayBuffer(3)) as unknown as Uint8Array<ArrayBuffer>); break;
    default: { const _ex: never = kind; throw new Error(String(_ex)); }
    }
    await expect(context.fromNative({ blob: new Blob(['abc']) }).bytes()).rejects.toThrow('exclusively owned');
  });
});

describe('BlobView cancellation and owner lifetime', () => {
  it.each(['resolve', 'reject'] as const)('stops a consumer immediately, observing a late %s without affecting a sibling', async outcome => {
    const { context, read } = trackedContext();
    const pending = Promise.withResolvers<Uint8Array<ArrayBuffer>>();
    read.mockReturnValueOnce(pending.promise);
    const view = context.fromNative({ blob: new Blob(['abc']) });
    const streamReader = view.stream().getReader();
    const reading = streamReader.read();
    await vi.waitFor(() => expect(read).toHaveBeenCalledOnce());
    await streamReader.cancel();
    expect((await reading).done).toBe(true);
    expect(await view.text()).toBe('abc');
    if (outcome === 'resolve') pending.resolve(new Uint8Array(3));
    else pending.reject(new Error('Late IO failure'));
    await Promise.resolve();
    expect(read).toHaveBeenCalledTimes(2);
    streamReader.releaseLock();
  });

  it('aborts a pending BYOB consumer and removes operation/context listeners', async () => {
    const { context, read, release } = trackedContext();
    const pending = Promise.withResolvers<Uint8Array<ArrayBuffer>>();
    read.mockReturnValueOnce(pending.promise);
    const abort = new AbortController();
    const add = vi.spyOn(abort.signal, 'addEventListener');
    const remove = vi.spyOn(abort.signal, 'removeEventListener');
    const byob = context.fromNative({ blob: new Blob(['abc']) }).stream({ signal: abort.signal }).getReader({ mode: 'byob' });
    const operation = byob.read(new Uint8Array(8));
    const reason = new Error('Cancelled');
    const rejected = expect(operation).rejects.toBe(reason);
    await vi.waitFor(() => expect(read).toHaveBeenCalledOnce());
    abort.abort(reason);
    await rejected;
    expect(remove).toHaveBeenCalledTimes(add.mock.calls.length);
    expect(release).not.toHaveBeenCalled();
    pending.resolve(new Uint8Array(3));
    byob.releaseLock();
  });

  it('disposes once, aborts unfinished text, and retains only the native snapshot for interop', async () => {
    const { context, read, release } = trackedContext();
    const pending = Promise.withResolvers<Uint8Array<ArrayBuffer>>();
    read.mockReturnValueOnce(pending.promise);
    const native = new Blob(['abc']);
    const view = context.fromNative({ blob: native });
    const reading = view.text();
    const rejected = expect(reading).rejects.toMatchObject({ name: 'AbortError' });
    await vi.waitFor(() => expect(read).toHaveBeenCalledOnce());
    context.dispose(); context.dispose();
    await rejected;
    expect(release).toHaveBeenCalledOnce();
    await expect(view.bytes()).rejects.toMatchObject({ name: 'AbortError' });
    expect(() => view.slice({ start: 0 })).toThrow();
    expect(blobForTransport({ blob: view })).toBe(native);
    const receivingContext = createNativeBlobContext();
    try {
      expect(await receivingContext.fromNative({ blob: blobForTransport({ blob: view }) }).text()).toBe('abc');
    } finally {
      receivingContext.dispose();
    }
    pending.reject(new Error('Late failure'));
  });

  it('rejects pre-aborted empty reads and never calls the backend', async () => {
    const { context, read } = trackedContext();
    const signal = AbortSignal.abort(new Error('Already aborted'));
    const view = context.fromNative({ blob: new Blob([]) });
    await expect(view.bytes({ signal })).rejects.toBe(signal.reason);
    await expect(view.text({ signal })).rejects.toBe(signal.reason);
    expect(read).not.toHaveBeenCalled();
  });
});

describe('Blob native operation adapters', () => {
  it('creates fetchable native URLs for the exact slice without reading and owns their revocation', async () => {
    const { context, read } = trackedContext();
    const first = createBlobURLScope();
    const second = createBlobURLScope();
    const view = context.fromNative({ blob: new Blob(['prefix-content-suffix'], { type: 'text/plain' }) }).slice({ start: 7, end: 14, contentType: 'text/plain' });
    const a = first.createObjectURL({ blob: view });
    const b = second.createObjectURL({ blob: view });
    try {
      expect(a.url).not.toBe(b.url);
      expect(read).not.toHaveBeenCalled();
      context.dispose();
      const response = await fetch(a.url);
      expect(response.headers.get('Content-Type')).toBe('text/plain');
      expect(await response.text()).toBe('content');
      a.revoke(); a.revoke(); first.dispose(); first.dispose();
      await expect(fetch(a.url)).rejects.toThrow();
      expect(await (await fetch(b.url)).text()).toBe('content');
      expect(() => first.createObjectURL({ blob: view })).toThrow('disposed');
    } finally {
      first.dispose(); second.dispose();
    }
    await expect(fetch(b.url)).rejects.toThrow();
  });

  it('accepts existing native Blobs at the URL boundary without treating other objects as views', () => {
    const { context } = trackedContext();
    const scope = createBlobURLScope();
    const create = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:test');
    const revoke = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
    const native = new Blob(['abc']);
    const url = scope.createObjectURL({ blob: native });
    expect(create).toHaveBeenCalledWith(native);
    url.revoke(); scope.dispose();
    expect(revoke).toHaveBeenCalledOnce();
    expect(() => blobForTransport({ blob: { ...context.fromNative({ blob: native }) } })).toThrow(TypeError);
  });

  it('preserves header/status options and reads a Response through the safe stream', async () => {
    const { context, read } = trackedContext();
    const view = context.fromNative({ blob: new Blob(['body'], { type: 'text/plain' }) });
    const original = new Headers({ 'X-Test': 'yes' });
    const response = createBlobResponse({ blob: view, init: { status: 201, headers: original }, signal: undefined });
    expect(response.status).toBe(201);
    expect(response.headers.get('Content-Type')).toBe('text/plain');
    expect(original.has('Content-Type')).toBe(false);
    expect(await response.text()).toBe('body');
    expect(read).toHaveBeenCalledOnce();
    const explicit = createBlobResponse({ blob: view, init: { headers: { 'Content-Type': 'application/custom' } }, signal: undefined });
    expect(explicit.headers.get('Content-Type')).toBe('application/custom');
    await explicit.body?.cancel();
  });

  it('releases a stream when Response construction rejects and does not read ahead', () => {
    const { context, read } = trackedContext();
    const signal = new AbortController().signal;
    const add = vi.spyOn(signal, 'addEventListener');
    const remove = vi.spyOn(signal, 'removeEventListener');
    expect(() => createBlobResponse({ blob: context.fromNative({ blob: new Blob(['x']) }), init: { status: 204 }, signal })).toThrow();
    expect(read).not.toHaveBeenCalled();
    expect(remove).toHaveBeenCalledTimes(add.mock.calls.length);
  });
});
