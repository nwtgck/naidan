import { beforeEach, describe, expect, it, vi } from 'vitest';
import { writeToOpfs, writeToOpfsWithStaging } from './utils';

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

  it('preserves the base no-op behavior when OPFS createWritable is unavailable', async () => {
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
    })).resolves.toBeUndefined();
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
});
