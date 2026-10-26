import { afterEach, describe, expect, it, vi } from 'vitest';
import { decodeZipBase64, encodeZipStreamAsBase64 } from './zip-base64';

function byteStream({ chunks }: { chunks: readonly Uint8Array[] }): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(chunk);
      }
      controller.close();
    },
  });
}

function readBlobBytes({ blob }: { blob: Blob }): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.addEventListener('error', () => reject(reader.error), { once: true });
    reader.addEventListener('load', () => {
      if (reader.result instanceof ArrayBuffer) {
        resolve(new Uint8Array(reader.result));
      } else {
        reject(new Error('Expected Blob bytes'));
      }
    }, { once: true });
    reader.readAsArrayBuffer(blob);
  });
}

function controlledFileReader({ readFailure }: { readFailure: Error | undefined }) {
  const instances: ControlledFileReader[] = [];
  let resolveReader: ((reader: ControlledFileReader) => void) | undefined;
  const ready = new Promise<ControlledFileReader>(resolve => {
    resolveReader = resolve;
  });
  class ControlledFileReader extends EventTarget {
    result: string | ArrayBuffer | undefined;
    error: DOMException | undefined;
    readonly added = vi.spyOn<EventTarget, 'addEventListener'>(this, 'addEventListener');
    readonly removed = vi.spyOn<EventTarget, 'removeEventListener'>(this, 'removeEventListener');
    readonly readAsDataURL = vi.fn<FileReader['readAsDataURL']>(() => {
      if (readFailure !== undefined) {
        throw readFailure;
      }
    });
    readonly abort = vi.fn<FileReader['abort']>(() => {
      this.dispatchEvent(new Event('abort'));
    });

    constructor() {
      super();
      instances.push(this);
      resolveReader?.(this);
    }
  }
  vi.stubGlobal('FileReader', ControlledFileReader);
  return { instances, ready };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('ZIP Base64 byte codec', () => {
  it('roundtrips every byte through chunked encoding and raw standard Base64', async () => {
    const bytes = Uint8Array.from({ length: 256 }, (_, index) => index);
    const stream = byteStream({ chunks: [bytes.slice(0, 127), bytes.slice(127)] });
    const serialized = await encodeZipStreamAsBase64({ stream, signal: undefined });
    expect(serialized).toBe(btoa(String.fromCharCode(...bytes)));
    expect(serialized).toContain('+');
    expect(serialized).toContain('/');
    expect(serialized).toContain('=');
    expect(serialized).not.toContain('data:');
    expect(serialized).not.toContain('%');
    expect(stream.locked).toBe(false);
    const blob = decodeZipBase64({ serialized });
    expect(blob.type).toBe('application/zip');
    expect(await readBlobBytes({ blob })).toEqual(bytes);
  });

  it('preserves a typed-array view without including adjacent buffer bytes', async () => {
    const backing = Uint8Array.of(0x11, 0xfb, 0xff, 0x22);
    const serialized = await encodeZipStreamAsBase64({ stream: byteStream({ chunks: [backing.subarray(1, 3)] }), signal: undefined });
    expect(serialized).toBe('+/8=');
  });

  it('snapshots consumed chunks before the source reuses its buffer', async () => {
    const backing = new Uint8Array(1);
    let next = 1;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        backing[0] = next++;
        controller.enqueue(backing);
        if (next === 3) {
          controller.close();
        }
      },
    }, { highWaterMark: 0 });
    const serialized = await encodeZipStreamAsBase64({ stream, signal: undefined });
    expect(await readBlobBytes({ blob: decodeZipBase64({ serialized }) })).toEqual(Uint8Array.of(1, 2));
  });

  it('does not introduce a small payload limit to the non-URL byte transport', async () => {
    const bytes = Uint8Array.from({ length: 1024 * 1024 }, (_, index) => index & 0xff);
    const chunks = Array.from({ length: 8 }, (_, index) => bytes.subarray(index * 131072, (index + 1) * 131072));
    const serialized = await encodeZipStreamAsBase64({ stream: byteStream({ chunks }), signal: undefined });
    const decoded = await readBlobBytes({ blob: decodeZipBase64({ serialized }) });
    expect(decoded.byteLength).toBe(bytes.byteLength);
    expect(decoded.findIndex((byte, index) => byte !== bytes[index])).toBe(-1);
  });

  it('supports native Base64 ASCII whitespace and line breaks without changing plus or slash', async () => {
    const blob = decodeZipBase64({ serialized: ' \t+/\r\n8=\f ' });
    expect(await readBlobBytes({ blob })).toEqual(Uint8Array.of(0xfb, 0xff));
  });

  it('retains native unpadded Base64 decoding', async () => {
    expect(await readBlobBytes({ blob: decodeZipBase64({ serialized: '+/8' }) })).toEqual(Uint8Array.of(0xfb, 0xff));
  });

  it.each(['data:application/zip;base64,+/8=', '%2B%2F8%3D', '-_8=', 'A', 'AA==junk', ' /8=', '\v+/8='])('retains InvalidCharacterError for invalid or transformed input %j', serialized => {
    expect(() => decodeZipBase64({ serialized })).toThrowError(expect.objectContaining({ name: 'InvalidCharacterError' }));
  });

  it('decodes bytes without claiming that Base64-valid content is a valid ZIP archive', async () => {
    const bytes = new TextEncoder().encode('not a ZIP archive');
    const blob = decodeZipBase64({ serialized: btoa('not a ZIP archive') });
    expect(Array.from(await readBlobBytes({ blob }))).toEqual(Array.from(bytes));
  });

  it('represents zero bytes as empty Base64 without adding a sentinel', async () => {
    expect(await encodeZipStreamAsBase64({ stream: byteStream({ chunks: [] }), signal: undefined })).toBe('');
    expect(decodeZipBase64({ serialized: '' }).size).toBe(0);
  });
});

describe('ZIP Base64 cancellation and cleanup', () => {
  it('cancels an already-aborted input without reading, locking, or creating a FileReader', async () => {
    const fileReader = controlledFileReader({ readFailure: undefined });
    const cancel = vi.fn();
    const pull = vi.fn();
    const stream = new ReadableStream<Uint8Array>({ cancel, pull }, { highWaterMark: 0 });
    const getReader = vi.spyOn(stream, 'getReader');
    const controller = new AbortController();
    const reason = new DOMException('Already cancelled', 'AbortError');
    controller.abort(reason);
    await expect(encodeZipStreamAsBase64({ stream, signal: controller.signal })).rejects.toBe(reason);
    expect(cancel).toHaveBeenCalledOnce();
    expect(cancel).toHaveBeenCalledWith(reason);
    expect(pull).not.toHaveBeenCalled();
    expect(getReader).not.toHaveBeenCalled();
    expect(fileReader.instances).toHaveLength(0);
    expect(stream.locked).toBe(false);
  });

  it('aborts a pending read promptly even when underlying cancellation never completes', async () => {
    const fileReader = controlledFileReader({ readFailure: undefined });
    const cancel = vi.fn(() => new Promise<void>(() => undefined));
    const stream = new ReadableStream<Uint8Array>({ cancel }, { highWaterMark: 0 });
    const controller = new AbortController();
    const added = vi.spyOn(controller.signal, 'addEventListener');
    const removed = vi.spyOn(controller.signal, 'removeEventListener');
    const reason = new DOMException('Cancelled while reading', 'AbortError');
    const pending = encodeZipStreamAsBase64({ stream, signal: controller.signal });
    const rejected = expect(pending).rejects.toBe(reason);
    controller.abort(reason);
    await rejected;
    expect(cancel).toHaveBeenCalledOnce();
    expect(cancel).toHaveBeenCalledWith(reason);
    expect(stream.locked).toBe(false);
    expect(fileReader.instances).toHaveLength(0);
    for (const [type, listener] of added.mock.calls) {
      expect(removed).toHaveBeenCalledWith(type, listener);
    }
  });

  it('preserves the abort reason when stream cancellation itself fails', async () => {
    const reason = new DOMException('Cancelled', 'AbortError');
    const cancel = vi.fn(() => Promise.reject(new Error('Cancellation cleanup failed')));
    const stream = new ReadableStream<Uint8Array>({ cancel }, { highWaterMark: 0 });
    const controller = new AbortController();
    const pending = encodeZipStreamAsBase64({ stream, signal: controller.signal });
    const rejected = expect(pending).rejects.toBe(reason);
    controller.abort(reason);
    await rejected;
    expect(stream.locked).toBe(false);
  });

  it('releases the reader and signal listener when the source fails', async () => {
    const fileReader = controlledFileReader({ readFailure: undefined });
    const failure = new Error('Source failed');
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.error(failure);
      },
    });
    const controller = new AbortController();
    const added = vi.spyOn(controller.signal, 'addEventListener');
    const removed = vi.spyOn(controller.signal, 'removeEventListener');
    await expect(encodeZipStreamAsBase64({ stream, signal: controller.signal })).rejects.toBe(failure);
    expect(stream.locked).toBe(false);
    expect(fileReader.instances).toHaveLength(0);
    for (const [type, listener] of added.mock.calls) {
      expect(removed).toHaveBeenCalledWith(type, listener);
    }
  });

  it('does not release a stream reader owned by another caller', async () => {
    const stream = byteStream({ chunks: [] });
    const reader = stream.getReader();
    using cleanup = {
      [Symbol.dispose]() {
        reader.releaseLock();
      },
    };
    void cleanup;
    await expect(encodeZipStreamAsBase64({ stream, signal: undefined })).rejects.toBeInstanceOf(TypeError);
    expect(stream.locked).toBe(true);
  });

  it('removes FileReader and signal listeners after successful encoding', async () => {
    const fileReader = controlledFileReader({ readFailure: undefined });
    const controller = new AbortController();
    const added = vi.spyOn(controller.signal, 'addEventListener');
    const removed = vi.spyOn(controller.signal, 'removeEventListener');
    const stream = byteStream({ chunks: [] });
    const pending = encodeZipStreamAsBase64({ stream, signal: controller.signal });
    const reader = await fileReader.ready;
    reader.result = 'data:application/zip;base64,+/8=';
    reader.dispatchEvent(new Event('load'));
    expect(await pending).toBe('+/8=');
    expect(stream.locked).toBe(false);
    expect(reader.removed.mock.calls.map(([type]) => type).sort()).toEqual(['abort', 'error', 'load']);
    for (const [type, listener] of reader.added.mock.calls) {
      expect(reader.removed).toHaveBeenCalledWith(type, listener);
    }
    for (const [type, listener] of added.mock.calls) {
      expect(removed).toHaveBeenCalledWith(type, listener);
    }
    controller.abort();
    expect(reader.abort).not.toHaveBeenCalled();
  });

  it('aborts FileReader work and removes every listener', async () => {
    const fileReader = controlledFileReader({ readFailure: undefined });
    const controller = new AbortController();
    const added = vi.spyOn(controller.signal, 'addEventListener');
    const removed = vi.spyOn(controller.signal, 'removeEventListener');
    const stream = byteStream({ chunks: [] });
    const pending = encodeZipStreamAsBase64({ stream, signal: controller.signal });
    const reader = await fileReader.ready;
    const reason = new DOMException('Cancelled while encoding', 'AbortError');
    const rejected = expect(pending).rejects.toBe(reason);
    controller.abort(reason);
    await rejected;
    expect(reader.abort).toHaveBeenCalledOnce();
    expect(stream.locked).toBe(false);
    expect(reader.removed.mock.calls.map(([type]) => type).sort()).toEqual(['abort', 'error', 'load']);
    for (const [type, listener] of reader.added.mock.calls) {
      expect(reader.removed).toHaveBeenCalledWith(type, listener);
    }
    for (const [type, listener] of added.mock.calls) {
      expect(removed).toHaveBeenCalledWith(type, listener);
    }
    reader.result = 'data:application/zip;base64,bGF0ZQ==';
    reader.dispatchEvent(new Event('load'));
    await expect(pending).rejects.toBe(reason);
    expect(reader.removed).toHaveBeenCalledTimes(3);
  });

  it('retains the requested cancellation if FileReader.abort throws', async () => {
    const fileReader = controlledFileReader({ readFailure: undefined });
    const controller = new AbortController();
    const pending = encodeZipStreamAsBase64({ stream: byteStream({ chunks: [] }), signal: controller.signal });
    const reader = await fileReader.ready;
    reader.abort.mockImplementation(() => {
      throw new Error('Abort failed');
    });
    const reason = new DOMException('Cancelled', 'AbortError');
    const rejected = expect(pending).rejects.toBe(reason);
    controller.abort(reason);
    await rejected;
    expect(reader.removed).toHaveBeenCalledTimes(3);
  });

  it('cleans up when readAsDataURL throws synchronously', async () => {
    const failure = new Error('Cannot start FileReader');
    const fileReader = controlledFileReader({ readFailure: failure });
    await expect(encodeZipStreamAsBase64({ stream: byteStream({ chunks: [] }), signal: undefined })).rejects.toBe(failure);
    const reader = await fileReader.ready;
    expect(reader.removed).toHaveBeenCalledTimes(3);
  });

  it('preserves FileReader errors and removes listeners', async () => {
    const fileReader = controlledFileReader({ readFailure: undefined });
    const pending = encodeZipStreamAsBase64({ stream: byteStream({ chunks: [] }), signal: undefined });
    const reader = await fileReader.ready;
    const failure = new DOMException('Cannot read ZIP', 'NotReadableError');
    reader.error = failure;
    const rejected = expect(pending).rejects.toBe(failure);
    reader.dispatchEvent(new Event('error'));
    await rejected;
    expect(reader.removed).toHaveBeenCalledTimes(3);
  });

  it('reports a native FileReader abort as AbortError', async () => {
    const fileReader = controlledFileReader({ readFailure: undefined });
    const pending = encodeZipStreamAsBase64({ stream: byteStream({ chunks: [] }), signal: undefined });
    const reader = await fileReader.ready;
    const rejected = expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    reader.abort();
    await rejected;
    expect(reader.removed).toHaveBeenCalledTimes(3);
  });

  it.each([undefined, new ArrayBuffer(0), 'not a data URL', 'data:application/zip,bytes'])('rejects an unexpected FileReader result %j and cleans up', async result => {
    const fileReader = controlledFileReader({ readFailure: undefined });
    const pending = encodeZipStreamAsBase64({ stream: byteStream({ chunks: [] }), signal: undefined });
    const reader = await fileReader.ready;
    reader.result = result;
    const rejected = expect(pending).rejects.toThrow('Failed to encode ZIP as Base64');
    reader.dispatchEvent(new Event('load'));
    await rejected;
    expect(reader.removed).toHaveBeenCalledTimes(3);
  });
});
