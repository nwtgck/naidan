import { beforeEach, describe, expect, it, vi } from 'vitest';
import { REJECTED_RESOURCE_RESPONSE_CLEANUP_TIMEOUT_MS, writeToOpfs, writeToOpfsWithStaging } from './utils';

class MemoryFileHandle {
  readonly kind = 'file' as const;
  bytes = new Uint8Array();
  createWritableCalls = 0;

  async getFile(): Promise<File> {
    const snapshot = new Uint8Array(this.bytes);
    return {
      size: snapshot.byteLength,
      stream: () => new ReadableStream<Uint8Array>({
        start: controller => {
          controller.enqueue(snapshot);
          controller.close();
        },
      }),
    } as File;
  }

  async createWritable(): Promise<WritableStream<Uint8Array>> {
    this.createWritableCalls += 1;
    const chunks: Uint8Array[] = [];
    return new WritableStream<Uint8Array>({
      write: chunk => {
        chunks.push(new Uint8Array(chunk));
      },
      close: () => {
        const length = chunks.reduce((total, chunk) => total + chunk.byteLength, 0);
        const merged = new Uint8Array(length);
        let offset = 0;
        for (const chunk of chunks) {
          merged.set(chunk, offset);
          offset += chunk.byteLength;
        }
        this.bytes = merged;
      },
    });
  }
}

class MemoryDirectoryHandle {
  readonly kind = 'directory' as const;
  readonly directories = new Map<string, MemoryDirectoryHandle>();
  readonly files = new Map<string, MemoryFileHandle>();

  async getDirectoryHandle(name: string, options?: { create?: boolean }): Promise<MemoryDirectoryHandle> {
    const existing = this.directories.get(name);
    if (existing !== undefined) return existing;
    if (options?.create === true) {
      const created = new MemoryDirectoryHandle();
      this.directories.set(name, created);
      return created;
    }
    throw notFound();
  }

  async getFileHandle(name: string, options?: { create?: boolean }): Promise<MemoryFileHandle> {
    const existing = this.files.get(name);
    if (existing !== undefined) return existing;
    if (options?.create === true) {
      const created = new MemoryFileHandle();
      this.files.set(name, created);
      return created;
    }
    throw notFound();
  }

  async removeEntry(name: string): Promise<void> {
    if (this.files.delete(name) || this.directories.delete(name)) return;
    throw notFound();
  }
}

function notFound(): Error {
  const error = new Error('Not found');
  error.name = 'NotFoundError';
  return error;
}

function modelDirectory({ root }: { root: MemoryDirectoryHandle }): MemoryDirectoryHandle {
  return root.directories.get('models')!
    .directories.get('huggingface.co')!
    .directories.get('org')!
    .directories.get('repo')!;
}

describe('OPFS writes', () => {
  let root: MemoryDirectoryHandle;

  beforeEach(() => {
    root = new MemoryDirectoryHandle();
    vi.stubGlobal('navigator', {
      storage: { getDirectory: vi.fn(async () => root) },
    });
    vi.stubGlobal('crypto', {
      ...globalThis.crypto,
      randomUUID: vi.fn(() => 'staging-id'),
    });
  });

  it('keeps the normal cache write path to one final write and creates the completion marker', async () => {
    await writeToOpfs({
      path: 'models/huggingface.co/org/repo/model.onnx',
      response: new Response(Uint8Array.from([1, 2, 3, 4]), {
        headers: { 'Content-Length': '4' },
      }),
    });

    const directory = modelDirectory({ root });
    expect([...directory.files.get('model.onnx')!.bytes]).toEqual([1, 2, 3, 4]);
    expect(directory.files.get('model.onnx')!.createWritableCalls).toBe(1);
    expect(directory.files.has('.model.onnx.complete')).toBe(true);
    expect([...directory.files.keys()].some(name => name.includes('.staging-'))).toBe(false);
  });

  it('rejects a partial direct response before altering an existing committed file and cancels its unread body', async () => {
    const path = 'models/huggingface.co/org/repo/model.onnx';
    await writeToOpfs({ path, response: new Response(Uint8Array.of(9)) });
    const pull = vi.fn((controller: ReadableStreamDefaultController<Uint8Array>) => {
      controller.enqueue(Uint8Array.of(1, 2));
      controller.close();
    });
    const cancel = vi.fn();
    const response = new Response(new ReadableStream({ pull, cancel }, { highWaterMark: 0 }), {
      status: 206, headers: { 'Content-Length': '2', 'Content-Range': 'bytes 0-1/100' },
    });
    await expect(writeToOpfs({ path, response })).rejects.toThrow('206');
    const directory = modelDirectory({ root });
    expect([...directory.files.get('model.onnx')!.bytes]).toEqual([9]);
    expect(directory.files.get('model.onnx')!.createWritableCalls).toBe(1);
    expect(directory.files.has('.model.onnx.complete')).toBe(true);
    expect(pull).not.toHaveBeenCalled();
    expect(cancel).toHaveBeenCalledOnce();
  });

  it('rejects a staged status-200 response carrying Content-Range before creating staging or changing committed bytes', async () => {
    const path = 'models/huggingface.co/org/repo/model.onnx';
    await writeToOpfs({ path, response: new Response(Uint8Array.of(9)) });
    const pull = vi.fn((controller: ReadableStreamDefaultController<Uint8Array>) => {
      controller.enqueue(Uint8Array.of(1, 2));
      controller.close();
    });
    const cancel = vi.fn();
    const response = new Response(new ReadableStream({ pull, cancel }, { highWaterMark: 0 }), {
      status: 200, headers: { 'Content-Length': '2', 'Content-Range': 'bytes 0-1/100' },
    });
    await expect(writeToOpfsWithStaging({ path, response })).rejects.toThrow('Content-Range');
    const directory = modelDirectory({ root });
    expect([...directory.files.keys()].sort()).toEqual(['.model.onnx.complete', 'model.onnx']);
    expect([...directory.files.get('model.onnx')!.bytes]).toEqual([9]);
    expect(directory.files.get('model.onnx')!.createWritableCalls).toBe(1);
    expect(pull).not.toHaveBeenCalled();
    expect(cancel).toHaveBeenCalledOnce();
  });

  it('preserves partial-response rejection when its unread body cancellation fails', async () => {
    const cancel = vi.fn(() => {
      throw new Error('secondary cancellation failure');
    });
    const response = new Response(new ReadableStream({ cancel }, { highWaterMark: 0 }), { status: 206 });
    await expect(writeToOpfs({ path: 'models/rejected.onnx', response })).rejects.toThrow('HTTP 206');
    expect(cancel).toHaveBeenCalledOnce();
    expect(navigator.storage.getDirectory).not.toHaveBeenCalled();
  });

  it('bounds only rejected-response cleanup when cancellation never settles without publishing a file', async () => {
    vi.useFakeTimers();
    const cancellation = Promise.withResolvers<void>();
    try {
      const cancel = vi.fn(() => cancellation.promise);
      const response = new Response(new ReadableStream({ cancel }, { highWaterMark: 0 }), { status: 206 });
      let settled = false;
      const outcome = writeToOpfs({ path: 'models/rejected.onnx', response }).then(
        () => {
          settled = true; return undefined;
        },
        (error: unknown) => {
          settled = true; return error;
        },
      );
      await vi.advanceTimersByTimeAsync(REJECTED_RESOURCE_RESPONSE_CLEANUP_TIMEOUT_MS - 1);
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      expect(await outcome).toMatchObject({ message: expect.stringContaining('HTTP 206') });
      expect(cancel).toHaveBeenCalledOnce();
      expect(navigator.storage.getDirectory).not.toHaveBeenCalled();
    } finally {
      cancellation.resolve();
      vi.useRealTimers();
    }
  });

  it('rejects an unsupported OPFS writer instead of reporting an unsaved response as successful', async () => {
    const unwritableHandle = { kind: 'file' as const };
    const directory = {
      getDirectoryHandle: vi.fn(),
      getFileHandle: vi.fn(async (name: string, options?: { create?: boolean }) => {
        if (name === 'model.onnx' && options?.create === true) return unwritableHandle;
        throw notFound();
      }),
    };
    directory.getDirectoryHandle.mockImplementation(async () => directory);
    vi.stubGlobal('navigator', {
      storage: { getDirectory: vi.fn(async () => directory) },
    });

    await expect(writeToOpfs({
      path: 'models/huggingface.co/org/repo/model.onnx',
      response: new Response(Uint8Array.from([1, 2, 3, 4])),
    })).rejects.toThrow('OPFS file handle does not support createWritable');
    expect(directory.getFileHandle).toHaveBeenCalledTimes(1);
  });

  it('stages, verifies, promotes, and creates the completion marker for repair writes', async () => {
    const result = await writeToOpfsWithStaging({
      path: 'models/huggingface.co/org/repo/model.onnx',
      response: new Response(Uint8Array.from([1, 2, 3, 4]), {
        headers: { 'Content-Length': '4' },
      }),
    });

    const directory = modelDirectory({ root });
    expect(result).toEqual({ byteLength: 4 });
    expect([...directory.files.get('model.onnx')!.bytes]).toEqual([1, 2, 3, 4]);
    expect(directory.files.has('.model.onnx.complete')).toBe(true);
    expect([...directory.files.keys()].some(name => name.includes('.staging-'))).toBe(false);
  });

  it('preserves an existing complete file when staging verification fails', async () => {
    await writeToOpfsWithStaging({
      path: 'models/huggingface.co/org/repo/model.onnx',
      response: new Response(Uint8Array.from([9]), {
        headers: { 'Content-Length': '1' },
      }),
    });

    await expect(writeToOpfsWithStaging({
      path: 'models/huggingface.co/org/repo/model.onnx',
      response: new Response(Uint8Array.from([1, 2]), {
        headers: { 'Content-Length': '3' },
      }),
    })).rejects.toThrow('Staged OPFS byte length mismatch');

    const directory = modelDirectory({ root });
    expect([...directory.files.get('model.onnx')!.bytes]).toEqual([9]);
    expect(directory.files.has('.model.onnx.complete')).toBe(true);
    expect([...directory.files.keys()].some(name => name.includes('.staging-'))).toBe(false);
  });

  it.each([
    { name: 'truncated', bytes: [1, 2], declaredLength: 4 },
    { name: 'empty', bytes: [], declaredLength: 0 },
  ])('does not publish a complete marker for a $name direct cache response', async ({ bytes, declaredLength }) => {
    await expect(writeToOpfs({
      path: 'models/huggingface.co/org/repo/tokenizer.json',
      response: new Response(Uint8Array.from(bytes), {
        headers: { 'Content-Length': String(declaredLength), 'Content-Type': 'application/json' },
      }),
    })).rejects.toThrow();
    const directory = modelDirectory({ root });
    expect(directory.files.has('.tokenizer.json.complete')).toBe(false);
  });

  it('preserves the previous committed file when an incoming staging stream fails', async () => {
    const path = 'models/huggingface.co/org/repo/model.onnx';
    await writeToOpfsWithStaging({ path, response: new Response(Uint8Array.of(9)) });
    let pulls = 0;
    const source = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (pulls++ === 0) controller.enqueue(Uint8Array.of(1));
        else controller.error(new Error('Fixture transfer interrupted'));
      },
    });
    await expect(writeToOpfsWithStaging({ path, response: new Response(source) }))
      .rejects.toThrow('Fixture transfer interrupted');
    const directory = modelDirectory({ root });
    expect([...directory.files.get('model.onnx')!.bytes]).toEqual([9]);
    expect(directory.files.has('.model.onnx.complete')).toBe(true);
    expect([...directory.files.keys()].some(name => name.includes('.staging-'))).toBe(false);
  });

  it('stores an already decoded direct response without treating compressed Content-Length as its file size', async () => {
    // Native fetch exposes decoded bytes while retaining the encoding/length headers.
    await writeToOpfs({
      path: 'models/huggingface.co/org/repo/tokenizer.json',
      response: new Response(Uint8Array.of(1, 2, 3, 4), {
        headers: { 'Content-Encoding': 'gzip', 'Content-Length': '24' },
      }),
    });
    const directory = modelDirectory({ root });
    expect([...directory.files.get('tokenizer.json')!.bytes]).toEqual([1, 2, 3, 4]);
    expect(directory.files.has('.tokenizer.json.complete')).toBe(true);
  });

  it('promotes an already decoded staged response without comparing it to compressed Content-Length', async () => {
    await expect(writeToOpfsWithStaging({
      path: 'models/huggingface.co/org/repo/model.onnx',
      response: new Response(Uint8Array.of(1, 2, 3, 4), {
        headers: { 'Content-Encoding': 'gzip', 'Content-Length': '24' },
      }),
    })).resolves.toEqual({ byteLength: 4 });
    const directory = modelDirectory({ root });
    expect([...directory.files.get('model.onnx')!.bytes]).toEqual([1, 2, 3, 4]);
    expect(directory.files.has('.model.onnx.complete')).toBe(true);
  });

  it('invalidates a previous direct completion marker before a replacement response fails verification', async () => {
    const path = 'models/huggingface.co/org/repo/tokenizer.json';
    await writeToOpfs({ path, response: new Response(Uint8Array.of(9)) });
    await expect(writeToOpfs({
      path,
      response: new Response(Uint8Array.of(1, 2), { headers: { 'Content-Length': '4' } }),
    })).rejects.toThrow();
    expect(modelDirectory({ root }).files.has('.tokenizer.json.complete')).toBe(false);
  });

  it('does not retain a completion marker when the promotion writable cannot be opened', async () => {
    const path = 'models/huggingface.co/org/repo/model.onnx';
    await writeToOpfsWithStaging({ path, response: new Response(Uint8Array.of(9)) });
    const directory = modelDirectory({ root });
    const finalHandle = directory.files.get('model.onnx')!;
    const error = new Error('Fixture promotion open failure');
    vi.spyOn(finalHandle, 'createWritable').mockRejectedValueOnce(error);
    await expect(writeToOpfsWithStaging({ path, response: new Response(Uint8Array.of(1, 2)) })).rejects.toBe(error);
    expect(directory.files.has('.model.onnx.complete')).toBe(false);
    expect(directory.files.has('model.onnx')).toBe(false);
    expect([...directory.files.keys()].some(name => name.includes('.staging-'))).toBe(false);
  });

  it('does not retain a completion marker when the promotion writable fails to close', async () => {
    const path = 'models/huggingface.co/org/repo/model.onnx';
    await writeToOpfsWithStaging({ path, response: new Response(Uint8Array.of(9)) });
    const directory = modelDirectory({ root });
    const finalHandle = directory.files.get('model.onnx')!;
    const error = new Error('Fixture promotion close failure');
    vi.spyOn(finalHandle, 'createWritable').mockResolvedValueOnce(new WritableStream<Uint8Array>({
      close() {
        throw error;
      },
    }));
    await expect(writeToOpfsWithStaging({ path, response: new Response(Uint8Array.of(1, 2)) })).rejects.toBe(error);
    expect(directory.files.has('.model.onnx.complete')).toBe(false);
    expect(directory.files.has('model.onnx')).toBe(false);
    expect([...directory.files.keys()].some(name => name.includes('.staging-'))).toBe(false);
  });

  it('does not leave the previous direct marker when a replacement stream is interrupted', async () => {
    const path = 'models/huggingface.co/org/repo/tokenizer.json';
    await writeToOpfs({ path, response: new Response(Uint8Array.of(9)) });
    const error = new Error('Fixture metadata transfer interrupted');
    const source = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(Uint8Array.of(1));
        controller.error(error);
      },
    });
    await expect(writeToOpfs({ path, response: new Response(source) })).rejects.toBe(error);
    expect(modelDirectory({ root }).files.has('.tokenizer.json.complete')).toBe(false);
  });

  it('does not leave the previous direct marker when closing the replacement writable fails', async () => {
    const path = 'models/huggingface.co/org/repo/tokenizer.json';
    await writeToOpfs({ path, response: new Response(Uint8Array.of(9)) });
    const directory = modelDirectory({ root });
    const error = new Error('Fixture metadata close failure');
    vi.spyOn(directory.files.get('tokenizer.json')!, 'createWritable').mockResolvedValueOnce(new WritableStream<Uint8Array>({
      close() {
        throw error;
      },
    }));
    await expect(writeToOpfs({ path, response: new Response(Uint8Array.of(1)) })).rejects.toBe(error);
    expect(directory.files.has('.tokenizer.json.complete')).toBe(false);
  });

  it('verifies direct stored bytes against the consumed body even without Content-Length', async () => {
    const path = 'models/huggingface.co/org/repo/tokenizer.json';
    await writeToOpfs({ path, response: new Response(Uint8Array.of(9)) });
    const directory = modelDirectory({ root });
    const handle = directory.files.get('tokenizer.json')!;
    vi.spyOn(handle, 'createWritable').mockResolvedValueOnce(new WritableStream<Uint8Array>({
      close() {
        handle.bytes = Uint8Array.of(1);
      },
    }));
    await expect(writeToOpfs({ path, response: new Response(Uint8Array.of(1, 2)) })).rejects.toThrow('byte length mismatch');
    expect(directory.files.has('.tokenizer.json.complete')).toBe(false);
  });
});
