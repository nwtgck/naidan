// @vitest-environment node
import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryDirectory, MemoryFile, type MemoryMoves } from '@/utils/file-system-publication/memory.test-support';
import { listHostImageRepositories, listImageRepositories } from '@/features/stable-diffusion-cpp-browser/logic/repository-store';
import { createFileMoveSupportCache } from '@/utils/file-system-publication';
import { readModelFileReceipt } from '@/logic/model-file-publication';
import { acquireHuggingFaceFiles } from './acquire';
import { saveHuggingFaceFile } from './file';
import type { DownloadFetch } from './fetch-types';
import type { DownloadDestination } from '@/01-models/download';

const host = vi.hoisted(() => ({ get: vi.fn() }));
vi.mock('@/00-storage/service/host-model-handles', () => ({ hostModelHandles: host }));
const bytes = new Uint8Array(128).fill(7);
const source = { repository: 'org/repo', revision: 'a'.repeat(40), path: 'weights/model.gguf', size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') };
let root: MemoryDirectory, moves: MemoryMoves;

beforeEach(() => {
  moves = { calls: [] };
  root = new MemoryDirectory('root', moves);
  host.get.mockResolvedValue(root);
  vi.stubGlobal('navigator', { storage: { getDirectory: async () => root }, locks: { request: async (_name: string, _options: object, run: (lock: object) => Promise<unknown>) => run({ mode: 'exclusive' }) } });
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

async function folder({ kind }: { kind: 'opfs' | 'host' }): Promise<MemoryDirectory> {
  let directory = root;
  for (const name of kind === 'opfs' ? ['models', 'huggingface.co', 'org', 'repo', 'resolve', 'main', 'weights'] : ['org', 'repo', 'weights']) {
    directory = await directory.getDirectoryHandle(name, { create: true });
  }
  return directory;
}

async function put({ directory, name, data }: { directory: MemoryDirectory, name: string, data: Uint8Array<ArrayBuffer> }): Promise<MemoryFile> {
  const handle = await directory.getFileHandle(name, { create: true });
  handle.data = data.slice();
  handle.modified++;
  return handle;
}

const transfer: DownloadFetch = async ({ request }) => {
  const offset = Number(new Headers(request.headers).get('range')?.match(/^bytes=(\d+)-$/)?.[1] ?? 0);
  return {
    status: offset ? 206 : 200,
    statusText: '',
    ok: true,
    url: '',
    redirected: false,
    responseType: 'basic',
    policyName: 'test',
    headers: new Headers({ 'content-length': String(bytes.length - offset), ...(offset ? { 'content-range': `bytes ${offset}-${bytes.length - 1}/${bytes.length}` } : {}) }),
    body: new ReadableStream({
      start(controller) {
        for (let at = offset; at < bytes.length; at += 32) {
          controller.enqueue(bytes.slice(at, at + 32));
        }
        controller.close();
      },
    }),
  };
};

function argumentsFor({ kind }: { kind: 'opfs' | 'host' }): Parameters<typeof saveHuggingFaceFile>[0] {
  const destination: DownloadDestination = kind === 'host' ? { kind, directoryId: 'linked' } : { kind };
  return { file: source, destination, signal: new AbortController().signal, expectedRoot: kind === 'host' ? root as unknown as FileSystemDirectoryHandle : undefined, validation: 'none', report: () => undefined, fetch: transfer };
}

describe.each(['opfs', 'host'] as const)('%s complete acquisition', kind => {
  it('resolves remote metadata without creating any persistent completion state', async () => {
    const directory = await folder({ kind });
    const fetch: DownloadFetch = async ({ request }) => {
      if (request.url.includes('/api/models/')) {
        const metadata = new TextEncoder().encode(JSON.stringify([
          { type: 'file', path: source.path, size: source.size, lfs: { oid: source.sha256, size: source.size } },
        ]));
        return {
          ...await transfer({ request }),
          status: 200,
          headers: new Headers({ 'content-length': String(metadata.length) }),
          body: new ReadableStream({
            start(controller) {
              controller.enqueue(metadata);
              controller.close();
            },
          }),
        };
      }
      return transfer({ request });
    };
    await acquireHuggingFaceFiles({
      files: [{ repository: source.repository, revision: source.revision, path: source.path }],
      signal: new AbortController().signal,
      onProgress: () => undefined,
      fetch,
      destination: kind === 'host' ? { kind, directoryId: 'linked' } : { kind },
      expectedRoot: kind === 'host' ? root as unknown as FileSystemDirectoryHandle : undefined,
      validation: 'none',
    });
    expect([...directory.children.keys()]).toEqual(['model.gguf']);
  });
});

describe.each(['opfs', 'host'] as const)('%s move downloads', kind => {
  it('writes ONLY .tmp during transfer and leaves ONLY the final name on completion', async () => {
    const directory = await folder({ kind });
    let observed = false;
    await saveHuggingFaceFile({
      ...argumentsFor({ kind }),
      report: ({ progress }) => {
        if (progress.phase === 'transferring') {
          observed = true;
          expect([...directory.children.keys()]).toEqual(['model.gguf.tmp']);
        }
      },
    });
    expect(observed).toBe(true);
    expect((await directory.getFileHandle('model.gguf')).data).toEqual(bytes);
    expect([...directory.children.keys()]).toEqual(['model.gguf']);
    const snapshot = await (await directory.getFileHandle('model.gguf')).getFile();
    expect(await readModelFileReceipt({ directory: directory as unknown as FileSystemDirectoryHandle, name: 'model.gguf', file: snapshot })).toBeUndefined();
  });

  it('stores interrupted bytes only in .tmp, then uses Range to resume without a journal', async () => {
    const directory = await folder({ kind });
    const abort = new AbortController();
    await expect(saveHuggingFaceFile({
      ...argumentsFor({ kind }),
      signal: abort.signal,
      report: ({ progress }) => {
        if (progress.phase === 'transferring' && progress.bytes >= 32) {
          abort.abort();
        }
      },
    })).rejects.toMatchObject({ name: 'AbortError' });
    expect([...directory.children.keys()]).toEqual(['model.gguf.tmp']);
    const saved = await directory.getFileHandle('model.gguf.tmp');
    expect(saved.data.byteLength).toBe(32);
    const fetch = vi.fn(transfer);
    await saveHuggingFaceFile({ ...argumentsFor({ kind }), fetch });
    expect(new Headers(fetch.mock.calls[0]![0].request.headers).get('range')).toBe('bytes=32-');
    expect([...directory.children.keys()]).toEqual(['model.gguf']);
    expect((await directory.getFileHandle('model.gguf')).data).toEqual(bytes);
  });

  it('publishes verified full-size .tmp without refetching or creating markers', async () => {
    const directory = await folder({ kind });
    await put({ directory, name: 'model.gguf.tmp', data: bytes });
    const fetch = vi.fn(transfer);
    await saveHuggingFaceFile({ ...argumentsFor({ kind }), fetch });
    expect(fetch).not.toHaveBeenCalled();
    expect([...directory.children.keys()]).toEqual(['model.gguf']);
  });

  it('restarts a corrupt full-size .tmp on explicit retry and preserves a foreign final', async () => {
    const directory = await folder({ kind });
    const wrong = await put({ directory, name: 'model.gguf.tmp', data: new Uint8Array(bytes.length).fill(9) });
    await saveHuggingFaceFile(argumentsFor({ kind }));
    expect(directory.children.has('model.gguf.tmp')).toBe(false);
    expect(directory.children.get('model.gguf')).toBe(wrong);
    expect((await directory.getFileHandle('model.gguf')).data).toEqual(bytes);
    const final = await put({ directory, name: 'model.gguf', data: new Uint8Array(bytes.length).fill(8) });
    await expect(saveHuggingFaceFile(argumentsFor({ kind }))).rejects.toThrow('Existing file differs');
    expect(directory.children.get('model.gguf')).toBe(final);
  });

  it('restarts from byte zero if a server ignores Range on an existing partial .tmp', async () => {
    const directory = await folder({ kind });
    await put({ directory, name: 'model.gguf.tmp', data: bytes.slice(0, 32) });
    const fetch: DownloadFetch = vi.fn(async ({ request }) => {
      expect(new Headers(request.headers).get('range')).toBe('bytes=32-');
      return {
        ...await transfer({ request: { ...request, headers: undefined } }),
        status: 200,
        headers: new Headers({ 'content-length': String(bytes.length) }),
      };
    });
    await saveHuggingFaceFile({ ...argumentsFor({ kind }), fetch });
    expect((await directory.getFileHandle('model.gguf')).data).toEqual(bytes);
    expect([...directory.children.keys()]).toEqual(['model.gguf']);
  });

  it('rejects an invalid Range response without making a published file', async () => {
    const directory = await folder({ kind });
    await put({ directory, name: 'model.gguf.tmp', data: bytes.slice(0, 32) });
    const fetch: DownloadFetch = async ({ request }) => ({
      ...await transfer({ request }),
      headers: new Headers({ 'content-range': 'bytes 0-127/128' }),
    });
    await expect(saveHuggingFaceFile({ ...argumentsFor({ kind }), fetch })).rejects.toThrow('Content-Range');
    expect([...directory.children.keys()]).toEqual(['model.gguf.tmp']);
    expect((await directory.getFileHandle('model.gguf.tmp')).data).toEqual(bytes.slice(0, 32));
  });

  it('recovers an already moved final without reopening a writer or writing a receipt', async () => {
    const directory = await folder({ kind });
    await saveHuggingFaceFile(argumentsFor({ kind }));
    const final = await directory.getFileHandle('model.gguf');
    using writer = vi.spyOn(final, 'createWritable').mockRejectedValue(new Error('Must not write'));
    using sync = vi.spyOn(final, 'createSyncAccessHandle').mockRejectedValue(new Error('Must not write'));
    const fetch = vi.fn(transfer);
    await saveHuggingFaceFile({ ...argumentsFor({ kind }), fetch });
    expect(fetch).not.toHaveBeenCalled();
    expect(writer).not.toHaveBeenCalled();
    expect(sync).not.toHaveBeenCalled();
    expect([...directory.children.keys()]).toEqual(['model.gguf']);
  });

  it('keeps staged bytes when move fails, then moves on an explicit retry without a download', async () => {
    const directory = await folder({ kind });
    moves.beforeMove = ({ to }) => {
      if (to === 'model.gguf') {
        throw new DOMException('Locked', 'NoModificationAllowedError');
      }
    };
    await expect(saveHuggingFaceFile(argumentsFor({ kind }))).rejects.toThrow('Locked');
    expect([...directory.children.keys()]).toEqual(['model.gguf.tmp']);
    moves.beforeMove = undefined;
    const fetch = vi.fn(transfer);
    await saveHuggingFaceFile({ ...argumentsFor({ kind }), fetch });
    expect(fetch).not.toHaveBeenCalled();
    expect([...directory.children.keys()]).toEqual(['model.gguf']);
  });

  it('does not overwrite a final created while the transfer was in progress', async () => {
    const directory = await folder({ kind });
    const foreign = new MemoryFile('model.gguf');
    foreign.data = new Uint8Array([1]);
    await expect(saveHuggingFaceFile({
      ...argumentsFor({ kind }),
      report: ({ progress }) => {
        if (progress.phase === 'transferring' && progress.bytes === bytes.length) {
          directory.children.set('model.gguf', foreign);
        }
      },
    })).rejects.toThrow('already exists');
    expect(directory.children.get('model.gguf')).toBe(foreign);
    expect((await directory.getFileHandle('model.gguf.tmp')).data).toEqual(bytes);
  });

  it('reads new markerless files and hides .tmp without creating or probing during read', async () => {
    await folder({ kind });
    moves.beforeMove = ({ to }) => {
      if (to === 'model.gguf') {
        throw new Error('Pause');
      }
    };
    await expect(saveHuggingFaceFile(argumentsFor({ kind }))).rejects.toThrow('Pause');
    const count = moves.calls.length;
    const repositories = kind === 'host'
      ? await listHostImageRepositories({ directories: [{ directoryId: 'linked', directoryName: 'Models' }], signal: undefined })
      : await listImageRepositories({ signal: undefined });
    expect(repositories[0]?.files.some(entry => entry.relativePath === 'weights/model.gguf.tmp')).toBe(false);
    expect(moves.calls.length).toBe(count);
    moves.beforeMove = undefined;
    await saveHuggingFaceFile(argumentsFor({ kind }));
    const completed = kind === 'host'
      ? await listHostImageRepositories({ directories: [{ directoryId: 'linked', directoryName: 'Models' }], signal: undefined })
      : await listImageRepositories({ signal: undefined });
    expect(completed[0]?.files.map(entry => entry.relativePath)).toEqual(['weights/model.gguf']);
    expect(completed[0]?.files[0]?.receipt).toBeUndefined();
  });

  it('preserves existing legacy receipt verbatim on verified file reuse', async () => {
    const directory = await folder({ kind });
    await put({ directory, name: 'model.gguf', data: bytes });
    const receipt = await put({ directory, name: '.model.gguf.complete', data: new TextEncoder().encode('historical') });
    const fetch = vi.fn(transfer);
    await saveHuggingFaceFile({ ...argumentsFor({ kind }), fetch });
    expect(fetch).not.toHaveBeenCalled();
    expect(directory.children.get('.model.gguf.complete')).toBe(receipt);
    expect(await (await receipt.getFile()).text()).toBe('historical');
  });

  it('continues base pending in the old protocol, including its .complete', async () => {
    const directory = await folder({ kind });
    await put({ directory, name: 'model.gguf', data: bytes.slice(0, 32) });
    await put({ directory, name: '.model.gguf.pending', data: new TextEncoder().encode(JSON.stringify({ version: 2, kind: 'naidan-file-download', source, bytes: 32, state: 'partial' })) });
    await saveHuggingFaceFile(argumentsFor({ kind }));
    expect([...directory.children.keys()].sort()).toEqual(['.model.gguf.complete', 'model.gguf']);
    expect((await directory.getFileHandle('model.gguf')).data).toEqual(bytes);
  });

  it('uses old fallback when the move probe reports non-support before writing', async () => {
    const directory = await folder({ kind });
    moves.beforeMove = () => {
      throw new DOMException('Unsupported', 'NotSupportedError');
    };
    await saveHuggingFaceFile(argumentsFor({ kind }));
    expect([...directory.children.keys()].sort()).toEqual(['.model.gguf.complete', 'model.gguf']);
  });

  it('does not treat permissions errors as unsupported', async () => {
    const directory = await folder({ kind });
    moves.beforeMove = () => {
      throw new DOMException('Permission', 'NotAllowedError');
    };
    const fetch = vi.fn(transfer);
    await expect(saveHuggingFaceFile({ ...argumentsFor({ kind }), fetch })).rejects.toThrow('Permission');
    expect(fetch).not.toHaveBeenCalled();
    expect(directory.children.size).toBe(0);
  });

  it('does not replace legacy pending with an incompatible staged file', async () => {
    const directory = await folder({ kind });
    const tmp = await put({ directory, name: 'model.gguf.tmp', data: bytes.slice(0, 32) });
    await put({ directory, name: '.model.gguf.pending', data: new TextEncoder().encode(JSON.stringify({ version: 2, kind: 'naidan-file-download', source, bytes: 0, state: 'partial' })) });
    await expect(saveHuggingFaceFile(argumentsFor({ kind }))).rejects.toThrow('Legacy journal conflicts');
    expect(directory.children.get('model.gguf.tmp')).toBe(tmp);
  });
});

it('reuses the cached probe between downloads and never probes in the reader', async () => {
  const directory = await folder({ kind: 'opfs' });
  const support = createFileMoveSupportCache();
  await saveHuggingFaceFile({ ...argumentsFor({ kind: 'opfs' }), moveSupport: support });
  await saveHuggingFaceFile({ ...argumentsFor({ kind: 'opfs' }), file: { ...source, path: 'weights/other.gguf' }, moveSupport: support });
  expect(moves.calls.filter(call => call.to.endsWith('.tmp'))).toHaveLength(1);
  const count = moves.calls.length;
  moves.beforeMove = () => {
    throw new Error('Reader must not probe');
  };
  const repositories = await listImageRepositories({ signal: undefined });
  expect(repositories[0]?.files.map(file => file.relativePath)).toEqual(['weights/model.gguf', 'weights/other.gguf']);
  expect(moves.calls).toHaveLength(count);
  expect([...directory.children.keys()].sort()).toEqual(['model.gguf', 'other.gguf']);
});
