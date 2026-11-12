// @vitest-environment node
import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryDirectory, MemoryFile, type MemoryMoves } from '@/utils/file-system-publication/memory.test-support';
import { prepareRepositoryRemoval, removeStoredModel } from '@/features/llama-cpp-browser/runtime/model-store';
import { listHostImageRepositories, listImageRepositories } from '@/features/stable-diffusion-cpp-browser/logic/repository-store';
import { createFileMoveSupportCache } from '@/utils/file-system-publication';
import { readModelFileReceipt } from '@/logic/model-file-publication';
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

describe.each(['opfs', 'host'] as const)('%s move downloads', kind => {
  it('explicitly removes an interrupted download and its journal, not unrelated files', async () => {
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
    const foreign = await put({ directory, name: 'unowned.tmp', data: new Uint8Array([4]) });
    const location = kind === 'host' ? { kind: 'host' as const, directoryId: 'linked', repository: source.repository } : { kind: 'hugging-face' as const, repository: source.repository };
    const { plan } = await prepareRepositoryRemoval({ location, signal: undefined });
    expect(plan.files.map(file => file.relativePath).sort()).toEqual(['weights/.model.gguf.pending', 'weights/model.gguf.tmp']);
    expect(await removeStoredModel({ plan })).toBe('deleted');
    expect([...directory.children.keys()]).toEqual(['unowned.tmp']);
    expect(directory.children.get('unowned.tmp')).toBe(foreign);
  });

  it("does not expand a staging pathname into another file's completion and pending markers", async () => {
    const directory = await folder({ kind });
    moves.beforeMove = ({ to }) => {
      if (to === 'model.gguf') {
        throw new Error('Pause before publication');
      }
    };
    await expect(saveHuggingFaceFile(argumentsFor({ kind }))).rejects.toThrow('Pause');
    const foreignReceipt = await put({ directory, name: '.model.gguf.tmp.complete', data: new TextEncoder().encode('foreign receipt') });
    const foreignPending = await put({ directory, name: '.model.gguf.tmp.pending', data: new TextEncoder().encode(JSON.stringify({ version: 2, kind: 'naidan-file-download', source: { ...source, repository: 'other/repo', path: 'weights/model.gguf.tmp' }, bytes: 0, state: 'partial' })) });
    const location = kind === 'host' ? { kind: 'host' as const, directoryId: 'linked', repository: source.repository } : { kind: 'hugging-face' as const, repository: source.repository };
    const { plan } = await prepareRepositoryRemoval({ location, signal: undefined });
    expect(plan.files.map(file => file.relativePath).sort()).toEqual(['weights/.model.gguf.pending', 'weights/model.gguf.tmp']);
    expect(await removeStoredModel({ plan })).toBe('deleted');
    expect(directory.children.get('.model.gguf.tmp.complete')).toBe(foreignReceipt);
    expect(directory.children.get('.model.gguf.tmp.pending')).toBe(foreignPending);
  });

  it('leaves oversized unrelated pending files out of its deletion plan', async () => {
    const directory = await folder({ kind });
    moves.beforeMove = ({ to }) => {
      if (to === 'model.gguf') {
        throw new Error('Pause before publication');
      }
    };
    await expect(saveHuggingFaceFile(argumentsFor({ kind }))).rejects.toThrow('Pause');
    const foreign = await put({ directory, name: '.unrelated.pending', data: new Uint8Array(64 * 1024 + 1) });
    const location = kind === 'host' ? { kind: 'host' as const, directoryId: 'linked', repository: source.repository } : { kind: 'hugging-face' as const, repository: source.repository };
    const { plan } = await prepareRepositoryRemoval({ location, signal: undefined });
    expect(plan.files.map(file => file.relativePath).sort()).toEqual(['weights/.model.gguf.pending', 'weights/model.gguf.tmp']);
    expect(await removeStoredModel({ plan })).toBe('deleted');
    expect(directory.children.get('.unrelated.pending')).toBe(foreign);
  });

  it('hides owned staging from image readers without probing or hiding ordinary tmp files', async () => {
    const directory = await folder({ kind });
    moves.beforeMove = ({ to }) => {
      if (to === 'model.gguf') {
        throw new Error('Pause before publication');
      }
    };
    await expect(saveHuggingFaceFile(argumentsFor({ kind }))).rejects.toThrow('Pause');
    const ordinary = await put({ directory, name: 'notes.tmp', data: new TextEncoder().encode('ordinary') });
    const probes = moves.calls.length;
    const repositories = kind === 'host'
      ? await listHostImageRepositories({ directories: [{ directoryId: 'linked', directoryName: 'Models' }], signal: undefined })
      : await listImageRepositories({ signal: undefined });
    expect(repositories).toHaveLength(1);
    expect(repositories[0]!.files.some(file => file.relativePath === 'weights/model.gguf.tmp')).toBe(false);
    expect(repositories[0]!.issues?.some(issue => issue.relativePath === 'weights/model.gguf.tmp')).toBe(true);
    if (kind === 'host') {
      expect(repositories[0]!.files.some(file => file.relativePath === 'weights/notes.tmp')).toBe(true);
    }
    expect(directory.children.get('notes.tmp')).toBe(ordinary);
    expect(moves.calls).toHaveLength(probes);
  });

  it('records the actual post-move snapshot in the existing completion receipt', async () => {
    const directory = await folder({ kind });
    moves.afterMove = async ({ to }) => {
      if (to === 'model.gguf') {
        (await directory.getFileHandle(to)).modified += 100;
      }
    };
    await saveHuggingFaceFile(argumentsFor({ kind }));
    const snapshot = await (await directory.getFileHandle('model.gguf')).getFile();
    const receipt = await readModelFileReceipt({ directory: directory as unknown as FileSystemDirectoryHandle, name: 'model.gguf', file: snapshot });
    expect(receipt?.lastModified).toBe(snapshot.lastModified);
    expect(receipt?.source).toEqual({ kind: 'hugging-face', repository: source.repository, revision: source.revision, path: source.path, sha256: source.sha256 });
    expect([...directory.children.keys()].sort()).toEqual(['.model.gguf.complete', 'model.gguf']);
  });

  it('preserves the journal and old receipt when deleting the owned payload fails', async () => {
    const directory = await folder({ kind });
    moves.beforeMove = ({ to }) => {
      if (to === 'model.gguf') {
        throw new Error('Pause before publication');
      }
    };
    await expect(saveHuggingFaceFile(argumentsFor({ kind }))).rejects.toThrow('Pause');
    const oldReceipt = await put({ directory, name: '.model.gguf.complete', data: new TextEncoder().encode('old receipt') });
    const location = kind === 'host' ? { kind: 'host' as const, directoryId: 'linked', repository: source.repository } : { kind: 'hugging-face' as const, repository: source.repository };
    const { plan } = await prepareRepositoryRemoval({ location, signal: undefined });
    const remove = directory.removeEntry.bind(directory);
    using failure = vi.spyOn(directory, 'removeEntry').mockImplementation(async (name, options) => {
      if (name === 'model.gguf.tmp') {
        throw new DOMException('Busy', 'NoModificationAllowedError');
      }
      return remove(name, options);
    });
    await expect(removeStoredModel({ plan })).rejects.toThrow('Busy');
    expect(directory.children.has('.model.gguf.pending')).toBe(true);
    expect(directory.children.get('.model.gguf.complete')).toBe(oldReceipt);
    expect(directory.children.has('model.gguf.tmp')).toBe(true);
    failure.mockRestore();
    expect(await removeStoredModel({ plan })).toBe('deleted');
    expect(directory.children.size).toBe(0);
  });

  it('preserves a corrupt full-size owned final on this attempt, then restarts explicitly', async () => {
    const directory = await folder({ kind });
    const final = await put({ directory, name: 'model.gguf', data: new Uint8Array(bytes.length).fill(9) });
    const journal = await put({ directory, name: '.model.gguf.pending', data: new TextEncoder().encode(JSON.stringify({ version: 2, kind: 'naidan-file-download', source, bytes: bytes.length, state: 'partial' })) });
    const fetch = vi.fn(transfer);
    await expect(saveHuggingFaceFile({ ...argumentsFor({ kind }), fetch })).rejects.toThrow('SHA-256');
    expect(final.data).toEqual(new Uint8Array(bytes.length).fill(9));
    expect(fetch).not.toHaveBeenCalled();
    expect(JSON.parse(await (await journal.getFile()).text()).state).toBe('invalid');
    await saveHuggingFaceFile({ ...argumentsFor({ kind }), fetch });
    expect(final.data).toEqual(bytes);
    expect(fetch).toHaveBeenCalledOnce();
    expect([...directory.children.keys()].sort()).toEqual(['.model.gguf.complete', 'model.gguf']);
  });

  it("does not adopt another download's staged bytes as a legitimate .tmp target", async () => {
    const directory = await folder({ kind });
    const staged = await put({ directory, name: 'model.gguf.tmp', data: bytes });
    const journal = await put({ directory, name: '.model.gguf.pending', data: new TextEncoder().encode(JSON.stringify({ version: 2, kind: 'naidan-file-download', source, bytes: bytes.length, state: 'partial' })) });
    const fetch = vi.fn(transfer);
    await expect(saveHuggingFaceFile({ ...argumentsFor({ kind }), file: { ...source, path: 'weights/model.gguf.tmp' }, fetch })).rejects.toThrow('staging for another');
    expect(fetch).not.toHaveBeenCalled();
    expect([...directory.children.values()]).toEqual([staged, journal]);
  });

  it("can save a legitimate .tmp target when it is not another download's staging", async () => {
    const directory = await folder({ kind });
    await saveHuggingFaceFile({ ...argumentsFor({ kind }), file: { ...source, path: 'weights/extra.tmp' } });
    expect((await directory.getFileHandle('extra.tmp')).data).toEqual(bytes);
    expect([...directory.children.keys()].sort()).toEqual(['.extra.tmp.complete', 'extra.tmp']);
  });

  it('resumes an empty base-version journal without a schema upgrade', async () => {
    const directory = await folder({ kind });
    await put({ directory, name: '.model.gguf.pending', data: new TextEncoder().encode(JSON.stringify({ version: 2, kind: 'naidan-file-download', source, bytes: 0, state: 'partial' })) });
    await saveHuggingFaceFile(argumentsFor({ kind }));
    expect((await directory.getFileHandle('model.gguf')).data).toEqual(bytes);
    expect(directory.children.has('.model.gguf.complete')).toBe(true);
    expect(directory.children.has('.model.gguf.pending')).toBe(false);
    expect([...directory.children.keys()].sort()).toEqual(['.model.gguf.complete', 'model.gguf']);
  });

  it('recovers a receipt write failure after move without copying or downloading again', async () => {
    const directory = await folder({ kind });
    const original = MemoryFile.prototype.createWritable;
    let failed = false;
    using interception = vi.spyOn(MemoryFile.prototype, 'createWritable').mockImplementation(async function (this: MemoryFile, options) {
      if (this.name === '.model.gguf.complete' && !failed) {
        failed = true;
        throw new DOMException('Full', 'QuotaExceededError');
      }
      return original.call(this, options);
    });
    await expect(saveHuggingFaceFile(argumentsFor({ kind }))).rejects.toThrow('Full');
    expect(interception).toHaveBeenCalled();
    expect(directory.children.has('model.gguf.tmp')).toBe(false);
    expect((await directory.getFileHandle('model.gguf')).data).toEqual(bytes);
    const pending = JSON.parse(await (await directory.getFileHandle('.model.gguf.pending')).getFile().then(file => file.text()));
    expect(pending).toEqual({ version: 2, kind: 'naidan-file-download', source, bytes: bytes.length, state: 'partial' });
    interception.mockRestore();
    const final = await directory.getFileHandle('model.gguf');
    using writer = vi.spyOn(final, 'createWritable').mockRejectedValue(new Error('Final must not reopen'));
    using sync = vi.spyOn(final, 'createSyncAccessHandle').mockRejectedValue(new Error('Final must not reopen'));
    const fetch = vi.fn(transfer);
    await saveHuggingFaceFile({ ...argumentsFor({ kind }), fetch });
    expect(fetch).not.toHaveBeenCalled();
    expect(writer).not.toHaveBeenCalled();
    expect(sync).not.toHaveBeenCalled();
    expect([...directory.children.keys()].sort()).toEqual(['.model.gguf.complete', 'model.gguf']);
  });

  it('rejects deletion after pending staging changes following confirmation', async () => {
    const directory = await folder({ kind });
    moves.beforeMove = ({ to }) => {
      if (to === 'model.gguf') {
        throw new Error('Stop before move');
      }
    };
    await expect(saveHuggingFaceFile(argumentsFor({ kind }))).rejects.toThrow('Stop before move');
    const location = kind === 'host' ? { kind: 'host' as const, directoryId: 'linked', repository: source.repository } : { kind: 'hugging-face' as const, repository: source.repository };
    const { plan } = await prepareRepositoryRemoval({ location, signal: undefined });
    const temporary = await directory.getFileHandle('model.gguf.tmp');
    temporary.modified++;
    expect(await removeStoredModel({ plan })).toBe('changed');
    expect(directory.children.get('model.gguf.tmp')).toBe(temporary);
    expect(directory.children.has('.model.gguf.pending')).toBe(true);
  });

  it('writes only .tmp until validation, then leaves only the base-format receipt and final', async () => {
    const directory = await folder({ kind });
    let observed = false;
    await saveHuggingFaceFile({
      ...argumentsFor({ kind }),
      report: ({ progress }) => {
        if (progress.phase === 'transferring') {
          observed = true;
          expect(directory.children.has('model.gguf')).toBe(false);
          expect(directory.children.has('model.gguf.tmp')).toBe(true);
          expect(directory.children.has('.model.gguf.pending')).toBe(true);
        }
      },
    });
    expect(observed).toBe(true);
    expect((await directory.getFileHandle('model.gguf')).data).toEqual(bytes);
    expect([...directory.children.keys()].sort()).toEqual(['.model.gguf.complete', 'model.gguf'].sort());
    const file = await (await directory.getFileHandle('model.gguf')).getFile();
    const receipt = await readModelFileReceipt({ directory: directory as unknown as FileSystemDirectoryHandle, name: 'model.gguf', file });
    expect(receipt).toMatchObject({ version: 1, source: { kind: 'hugging-face', repository: source.repository, revision: source.revision, path: source.path, sha256: source.sha256 } });
  });

  it('uses the legacy protocol when the pre-write move probe is aborted', async () => {
    const directory = await folder({ kind });
    moves.beforeMove = () => {
      throw new DOMException('Disabled move', 'AbortError');
    };
    await saveHuggingFaceFile(argumentsFor({ kind }));
    expect((await directory.getFileHandle('model.gguf')).data).toEqual(bytes);
    expect(directory.children.has('.model.gguf.complete')).toBe(true);
    expect(directory.children.has('model.gguf.tmp')).toBe(false);
  });

  it('resumes a partial .tmp using Range and never exposes the partial final name', async () => {
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
    const journal = JSON.parse(await (await directory.getFileHandle('.model.gguf.pending')).getFile().then(file => file.text()));
    expect(journal).toMatchObject({ version: 2, bytes: 32 });
    expect(directory.children.has('model.gguf')).toBe(false);
    const fetch = vi.fn(transfer);
    await saveHuggingFaceFile({ ...argumentsFor({ kind }), fetch });
    expect(new Headers(fetch.mock.calls[0]![0].request.headers).get('range')).toBe('bytes=32-');
    expect((await directory.getFileHandle('model.gguf')).data).toEqual(bytes);
    expect(directory.children.has('.model.gguf.complete')).toBe(true);
  });

  it('recovers a crash after move without reopening the final writer or downloading again', async () => {
    const directory = await folder({ kind });
    const abort = new AbortController();
    moves.afterMove = ({ to }) => {
      if (to === 'model.gguf') {
        abort.abort();
      }
    };
    await expect(saveHuggingFaceFile({ ...argumentsFor({ kind }), signal: abort.signal })).rejects.toMatchObject({ name: 'AbortError' });
    expect(directory.children.has('model.gguf.tmp')).toBe(false);
    expect(directory.children.has('.model.gguf.pending')).toBe(true);
    const final = await directory.getFileHandle('model.gguf');
    using syncWriter = vi.spyOn(final, 'createSyncAccessHandle').mockRejectedValue(new Error('Final writer must not reopen'));
    using asyncWriter = vi.spyOn(final, 'createWritable').mockRejectedValue(new Error('Final writer must not reopen'));
    moves.beforeMove = () => {
      throw new DOMException('Capability changed', 'NotSupportedError');
    };
    const fetch = vi.fn(transfer);
    await saveHuggingFaceFile({ ...argumentsFor({ kind }), fetch });
    expect(fetch).not.toHaveBeenCalled();
    expect(syncWriter).not.toHaveBeenCalled();
    expect(asyncWriter).not.toHaveBeenCalled();
    expect(directory.children.has('.model.gguf.pending')).toBe(false);
    expect(directory.children.has('.model.gguf.complete')).toBe(true);
  });

  it('keeps verified staging on a move failure, and retries without another payload', async () => {
    const directory = await folder({ kind });
    moves.beforeMove = ({ to }) => {
      if (to === 'model.gguf') {
        throw new DOMException('Locked', 'NoModificationAllowedError');
      }
    };
    await expect(saveHuggingFaceFile(argumentsFor({ kind }))).rejects.toThrow('Locked');
    expect(directory.children.has('model.gguf')).toBe(false);
    expect((await directory.getFileHandle('model.gguf.tmp')).data).toEqual(bytes);
    moves.beforeMove = undefined;
    const fetch = vi.fn(transfer);
    await saveHuggingFaceFile({ ...argumentsFor({ kind }), fetch });
    expect(fetch).not.toHaveBeenCalled();
    expect((await directory.getFileHandle('model.gguf')).data).toEqual(bytes);
  });

  it('preserves both files if a final appeared while staging', async () => {
    const directory = await folder({ kind });
    const foreign = new MemoryFile('model.gguf');
    foreign.data = new Uint8Array([9]);
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
    await expect(saveHuggingFaceFile(argumentsFor({ kind }))).rejects.toThrow('conflicting files');
    expect(foreign.data).toEqual(new Uint8Array([9]));
  });

  it('does not claim an unowned .tmp or create a pending marker for it', async () => {
    const directory = await folder({ kind });
    const foreign = await put({ directory, name: 'model.gguf.tmp', data: new Uint8Array([9]) });
    await expect(saveHuggingFaceFile(argumentsFor({ kind }))).rejects.toThrow('unowned temporary');
    expect(directory.children.get('model.gguf.tmp')).toBe(foreign);
    expect(directory.children.has('.model.gguf.pending')).toBe(false);
  });

  it('adopts verified old bytes using the existing receipt format without deleting the receipt', async () => {
    const directory = await folder({ kind });
    const final = await put({ directory, name: 'model.gguf', data: bytes });
    const markerBytes = new TextEncoder().encode('{"historical":"preserve exactly"}');
    const marker = await put({ directory, name: '.model.gguf.complete', data: markerBytes });
    const fetch = vi.fn(transfer);
    using remove = vi.spyOn(directory, 'removeEntry');
    await saveHuggingFaceFile({ ...argumentsFor({ kind }), fetch });
    expect(fetch).not.toHaveBeenCalled();
    expect(directory.children.get('model.gguf')).toBe(final);
    expect(directory.children.get('.model.gguf.complete')).toBe(marker);
    expect(remove).not.toHaveBeenCalled();
    expect(JSON.parse(await (await marker.getFile()).text()).source).toMatchObject({ repository: source.repository, revision: source.revision });
    expect(moves.calls.filter(call => call.to === 'model.gguf')).toHaveLength(0);
  });

  it('updates pinned provenance only after fully verifying an already published final', async () => {
    const directory = await folder({ kind });
    await saveHuggingFaceFile(argumentsFor({ kind }));
    const final = await directory.getFileHandle('model.gguf');
    const fetch = vi.fn(transfer);
    const updated = { ...source, revision: 'b'.repeat(40) };
    await saveHuggingFaceFile({ ...argumentsFor({ kind }), file: updated, fetch });
    const receipt = await readModelFileReceipt({ directory: directory as unknown as FileSystemDirectoryHandle, name: 'model.gguf', file: await final.getFile() });
    expect(receipt?.source).toMatchObject({ revision: updated.revision });
    expect(fetch).not.toHaveBeenCalled();
    expect(directory.children.get('model.gguf')).toBe(final);
    expect(directory.children.has('.model.gguf.complete')).toBe(true);
    await expect(saveHuggingFaceFile({ ...argumentsFor({ kind }), file: { ...source, sha256: '0'.repeat(64) } })).rejects.toThrow('differs');
    expect((await readModelFileReceipt({ directory: directory as unknown as FileSystemDirectoryHandle, name: 'model.gguf', file: await final.getFile() }))?.source).toMatchObject({ revision: updated.revision });
  });

  it('does not mistake same-sized old incomplete bytes for a completed move', async () => {
    const directory = await folder({ kind });
    const final = await put({ directory, name: 'model.gguf', data: new Uint8Array(bytes.length).fill(9) });
    await expect(saveHuggingFaceFile(argumentsFor({ kind }))).rejects.toThrow('differs from the pinned source');
    expect(directory.children.get('model.gguf')).toBe(final);
    expect(moves.calls).toHaveLength(0);
  });

  it('continues an existing v2 journal using legacy publication, even on a move-capable browser', async () => {
    const directory = await folder({ kind });
    await put({ directory, name: 'model.gguf', data: bytes.slice(0, 32) });
    await put({ directory, name: '.model.gguf.pending', data: new TextEncoder().encode(JSON.stringify({ version: 2, kind: 'naidan-file-download', source, bytes: 32, state: 'partial' })) });
    await saveHuggingFaceFile(argumentsFor({ kind }));
    expect(directory.children.has('.model.gguf.complete')).toBe(true);
    expect(moves.calls).toHaveLength(0);
  });

  it('falls back only on explicit non-support before starting a new file', async () => {
    const directory = await folder({ kind });
    moves.beforeMove = () => {
      throw new DOMException('Unavailable', 'NotSupportedError');
    };
    await saveHuggingFaceFile(argumentsFor({ kind }));
    expect((await directory.getFileHandle('model.gguf')).data).toEqual(bytes);
    expect(directory.children.has('.model.gguf.complete')).toBe(true);
  });

  it('does not weaken permission failures into a direct-write fallback', async () => {
    const directory = await folder({ kind });
    moves.beforeMove = () => {
      throw new DOMException('Permission lost', 'NotAllowedError');
    };
    const fetch = vi.fn(transfer);
    await expect(saveHuggingFaceFile({ ...argumentsFor({ kind }), fetch })).rejects.toThrow('Permission lost');
    expect(fetch).not.toHaveBeenCalled();
    expect(directory.children.size).toBe(0);
  });

  it('preserves a missing nonempty journal body instead of redownloading into a new file', async () => {
    const directory = await folder({ kind });
    const marker = await put({ directory, name: '.model.gguf.pending', data: new TextEncoder().encode(JSON.stringify({ version: 2, kind: 'naidan-file-download', source, bytes: 32, state: 'partial' })) });
    const fetch = vi.fn(transfer);
    await expect(saveHuggingFaceFile({ ...argumentsFor({ kind }), fetch })).rejects.toThrow('missing');
    expect(fetch).not.toHaveBeenCalled();
    expect([...directory.children.values()]).toEqual([marker]);
    expect(moves.calls).toHaveLength(0);
  });

  it('preserves staging and the journal when move becomes unsupported between sessions', async () => {
    const directory = await folder({ kind });
    moves.beforeMove = ({ to }) => {
      if (to === 'model.gguf') {
        throw new DOMException('Locked', 'NoModificationAllowedError');
      }
    };
    await expect(saveHuggingFaceFile(argumentsFor({ kind }))).rejects.toThrow('Locked');
    const staged = await directory.getFileHandle('model.gguf.tmp');
    moves.beforeMove = () => {
      throw new DOMException('Unsupported', 'NotSupportedError');
    };
    const fetch = vi.fn(transfer);
    await expect(saveHuggingFaceFile({ ...argumentsFor({ kind }), fetch })).rejects.toMatchObject({ name: 'NotSupportedError' });
    expect(fetch).not.toHaveBeenCalled();
    expect(directory.children.get('model.gguf.tmp')).toBe(staged);
    expect([...directory.children.keys()].sort()).toEqual(['.model.gguf.pending', 'model.gguf.tmp']);
  });
});

it('reuses one in-memory probe for multiple files and reads new publications without probing', async () => {
  const directory = await folder({ kind: 'opfs' });
  const support = createFileMoveSupportCache();
  await saveHuggingFaceFile({ ...argumentsFor({ kind: 'opfs' }), moveSupport: support });
  await saveHuggingFaceFile({ ...argumentsFor({ kind: 'opfs' }), file: { ...source, path: 'weights/other.gguf' }, moveSupport: support });
  expect(moves.calls.filter(call => call.to.endsWith('.tmp'))).toHaveLength(1);
  const count = moves.calls.length;
  moves.beforeMove = () => {
    throw new Error('Read-only inventory must not probe');
  };
  const repositories = await listImageRepositories({ signal: undefined });
  expect(repositories[0]?.files.map(file => file.relativePath)).toEqual(['weights/model.gguf', 'weights/other.gguf']);
  expect(repositories[0]?.files.every(file => file.receipt?.version === 1)).toBe(true);
  expect(moves.calls).toHaveLength(count);
  expect(directory.children.has('.model.gguf.complete')).toBe(true);
});
