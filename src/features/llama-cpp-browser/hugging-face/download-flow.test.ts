// @vitest-environment node
import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { privacyFetchStream } from '@/features/privacy-fetch';
import { createFileDownloadWorker } from '@/logic/hugging-face-download/worker/impl';
import { MemoryDirectory, MemoryFile } from '@/features/stable-diffusion-cpp-browser/test-utils/storage.test-support';
import { downloadImageRecipeInWorker } from '@/features/stable-diffusion-cpp-browser/download-worker/client';
import { scanDeletionTree } from '@/features/llama-cpp-browser/runtime/deletion-plan';
import { downloadRepository, cancelDownload } from './download';
import { listHuggingFaceModels, repositoryFolder } from './storage';
import { ggufBytes } from './test-opfs';
import type { DownloadProgress } from './types';
const transport = vi.hoisted(() => ({ worker: undefined as (EventTarget & { terminate(): void }) | undefined }));
vi.mock('@/features/privacy-fetch', () => ({ privacyFetchStream: vi.fn() }));
vi.mock('@/utils/worker-transport', async importOriginal => {
  const original = await importOriginal<typeof import('@/utils/worker-transport')>();
  const local = new WeakSet<object>();
  return {
    ...original,
    wrapWorkerRemote: (args: Parameters<typeof original.wrapWorkerRemote>[0]) => {
      if (!Object.is(args.endpoint, transport.worker)) {
        return original.wrapWorkerRemote(args);
      }
      const backend = createFileDownloadWorker();
      const remote = { ...backend, cancel: async () => backend.cancel() };
      local.add(remote);
      return remote;
    },
    releaseWorkerRemote: (args: Parameters<typeof original.releaseWorkerRemote>[0]) => local.has(args.remote) ? undefined : original.releaseWorkerRemote(args),
    workerTransfer: ({ value }: { value: object }) => value,
    workerProxy: ({ value }: { value: object }) => value,
    getReadableStreamTransferSupport: async () => 'unsupported',
  };
});

const selection = { repository: 'owner/repo', revision: 'a'.repeat(40), files: [{ path: 'model.gguf', size: 128 }] };
const identity = { repository: selection.repository, revision: selection.revision, path: 'model.gguf' };
let root: MemoryDirectory;
const payload = vi.fn<({ request }: Parameters<typeof privacyFetchStream>[0]) => Promise<Awaited<ReturnType<typeof privacyFetchStream>>>>();

function response({ bytes, status, headers }: { bytes: Uint8Array<ArrayBuffer>, status: number, headers?: Headers }): Awaited<ReturnType<typeof privacyFetchStream>> {
  return {
    status,
    statusText: '',
    ok: status < 400,
    url: 'https://huggingface.co/owner/repo/resolve/rev/model.gguf',
    redirected: false,
    responseType: 'basic',
    policyName: 'test',
    headers: headers ?? new Headers(),
    body: new ReadableStream({
      start(controller) {
        controller.enqueue(bytes);
        controller.close();
      },
    }),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  root = new MemoryDirectory('root');
  vi.stubGlobal('navigator', { storage: { getDirectory: async () => root }, locks: { request: async (_name: string, _options: object, run: (lock: object) => Promise<unknown>) => run({}) } });
  vi.stubGlobal('Worker', class extends EventTarget {
    terminate = vi.fn();

    constructor() {
      super();
      transport.worker = this;
    }
  });
  payload.mockReset().mockImplementation(async () => response({ bytes: ggufBytes(), status: 200 }));
  vi.mocked(privacyFetchStream).mockImplementation(async args => {
    if (args.request.url.includes('/api/models/')) {
      const bytes = ggufBytes();
      return response({ status: 200, bytes: new TextEncoder().encode(JSON.stringify(['model.gguf', 'other.gguf'].map(path => ({ type: 'file', path, size: bytes.length, lfs: { size: bytes.length, oid: createHash('sha256').update(bytes).digest('hex') } })))) });
    }
    return payload(args);
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const run = ({ controller, progress }: { controller?: AbortController, progress?: ({ progress }: { progress: DownloadProgress }) => void }) => downloadRepository({ selection, signal: (controller ?? new AbortController()).signal, onProgress: progress ?? (() => {}) });

async function folder(): Promise<MemoryDirectory> {
  let directory = root;
  for (const part of ['models', 'huggingface.co', 'owner', 'repo', 'resolve', 'main']) {
    directory = await directory.getDirectoryHandle(part);
  }
  return directory;
}

describe('shared HF transfer used by llama.cpp and images', () => {
  it('verifies streamed bytes and publishes generic per-file markers', async () => {
    const progress: DownloadProgress[] = [];
    await run({ progress: ({ progress: value }) => progress.push(value) });
    expect((await listHuggingFaceModels()).map(model => model.name)).toEqual(['hf.co/owner/repo:model']);
    expect(payload).toHaveBeenCalledOnce();
    expect((await folder()).children.has('.model.gguf.pending')).toBe(false);
    expect((await folder()).children.has('.model.gguf.complete')).toBe(true);
    expect(progress.at(-1)?.fileProgress?.[0]).toEqual({ completed: 128, total: 128, state: 'complete' });
  });

  it('reuses image-acquired GGUF bytes without a second payload transfer', async () => {
    await downloadImageRecipeInWorker({ files: [identity], signal: new AbortController().signal, onProgress() {} });
    await run({});
    expect(payload).toHaveBeenCalledOnce();
    expect((await listHuggingFaceModels())[0]?.name).toBe('hf.co/owner/repo:model');
  });

  it('reuses llama.cpp-acquired GGUF bytes from the image entry point', async () => {
    await run({});
    await downloadImageRecipeInWorker({ files: [identity], signal: new AbortController().signal, onProgress() {} });
    expect(payload).toHaveBeenCalledOnce();
  });

  it.each([64, 160])('does not publish a payload with %s bytes instead of its declared size', async length => {
    payload.mockResolvedValue(response({ bytes: new Uint8Array(length), status: 200 }));
    await expect(run({})).rejects.toThrow();
    expect(await listHuggingFaceModels()).toEqual([]);
    expect((await folder()).children.has('.model.gguf.pending')).toBe(true);
  });

  it('does not publish same-sized bytes with the wrong digest', async () => {
    const bytes = ggufBytes();
    bytes[127] = 7;
    payload.mockResolvedValueOnce(response({ bytes, status: 200 }));
    await expect(run({})).rejects.toThrow('SHA-256');
    expect(await listHuggingFaceModels()).toEqual([]);
    await run({});
    expect(payload).toHaveBeenCalledTimes(2);
    expect(await listHuggingFaceModels()).toHaveLength(1);
  });

  it('keeps other same-sized existing bytes without overwriting or fetching a payload', async () => {
    await run({});
    const target = await (await folder()).getFileHandle('model.gguf');
    const original = target.data.slice();
    target.data[127] = 9;
    await expect(run({})).rejects.toMatchObject({ reason: 'existing-files' });
    expect(target.data[127]).toBe(9);
    expect(target.data.slice(0, 127)).toEqual(original.slice(0, 127));
    expect(payload).toHaveBeenCalledOnce();
  });

  it('continues from a durable generic checkpoint with validated Range and hashes the prefix', async () => {
    payload.mockResolvedValueOnce(response({ bytes: ggufBytes().slice(0, 64), status: 200 }));
    await expect(run({})).rejects.toThrow();
    payload.mockImplementationOnce(async ({ request }) => {
      expect(new Headers(request.headers).get('Range')).toBe('bytes=64-');
      return response({ bytes: ggufBytes().slice(64), status: 206, headers: new Headers({ 'Content-Range': 'bytes 64-127/128' }) });
    });
    await run({});
    expect(await listHuggingFaceModels()).toHaveLength(1);
  });

  it('restarts safely when the server ignores Range and returns the entire file', async () => {
    payload.mockResolvedValueOnce(response({ bytes: ggufBytes().slice(0, 64), status: 200 }));
    await expect(run({})).rejects.toThrow();
    await run({});
    expect(await listHuggingFaceModels()).toHaveLength(1);
    expect((await (await folder()).getFileHandle('model.gguf')).data).toEqual(ggufBytes());
  });

  it('preserves all payloads until explicit confirmed deletion', async () => {
    await run({});
    const directory = await repositoryFolder({ repository: selection.repository, create: false });
    const files = (await scanDeletionTree({ folder: directory })).files;
    expect(await cancelDownload({ repository: selection.repository, plan: { id: 'hf.co/owner/repo', files } })).toBe('deleted');
    expect(await listHuggingFaceModels()).toEqual([]);
  });

  it('aborts the privacy stream when a Worker crashes', async () => {
    let started: AbortSignal | undefined;
    payload.mockImplementation(({ request }) => new Promise((_resolve, reject) => {
      started = request.signal;
      request.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true });
      queueMicrotask(() => transport.worker?.dispatchEvent(new Event('error')));
    }));
    await expect(run({})).rejects.toThrow('Worker failed');
    await vi.waitFor(() => expect(started?.aborted).toBe(true));
  });

  it('honors cancellation during discovery before any metadata or payload request', async () => {
    const controller = new AbortController();
    await expect(run({ controller, progress: () => controller.abort() })).rejects.toThrow();
    expect(privacyFetchStream).not.toHaveBeenCalled();
  });

  it('does not pull further payload chunks while a storage write remains unacknowledged', async () => {
    const original = MemoryFile.prototype.createSyncAccessHandle;
    const gate = Promise.withResolvers<void>();
    let writes = 0;
    vi.spyOn(MemoryFile.prototype, 'createSyncAccessHandle').mockImplementation(async function(this: MemoryFile) {
      if (this.name === 'model.gguf') {
        await gate.promise;
      }
      return original.call(this);
    });
    payload.mockImplementationOnce(async () => {
      writes++;
      return response({ bytes: ggufBytes(), status: 200 });
    });
    const operation = run({});
    await vi.waitFor(() => expect((root.children.get('models') as MemoryDirectory | undefined)?.children.has('huggingface.co')).toBe(true));
    expect(writes).toBe(0);
    gate.resolve();
    await operation;
    expect(writes).toBe(1);
  });
});
