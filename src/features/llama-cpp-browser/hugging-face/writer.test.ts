import { prepareModelRemoval } from '@/features/llama-cpp-browser/runtime/model-store';
import { deleteRepository } from './storage';
import { openSyncAccess } from './sync-access';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDownloadWriter } from './writer';
import { listHuggingFaceModels, listPendingDownloads, readJournal, repositoryFolder, selectedFile, writeJournal, withRepositoryLock } from './storage';
import { ggufBytes, memoryDirectory } from './test-opfs';
import type { DownloadSelection } from './types';
vi.mock('@/utils/worker-transport', async importOriginal => ({ ...await importOriginal<typeof import('@/utils/worker-transport')>(), releaseWorkerProxyArgument: vi.fn() }));
const selection: DownloadSelection = { repository: 'owner/repo', revision: 'a'.repeat(40), files: [{ path: 'nested/model.gguf', size: 128 }] };
beforeEach(() => {
  const root = memoryDirectory({ name: '' }); vi.stubGlobal('navigator', { storage: { getDirectory: async () => root } });
});
afterEach(() => vi.unstubAllGlobals());
describe('resumable GGUF storage writer', () => {
  it('hides partial files, flushes a paused prefix, resumes after reload and publishes actual files', async () => {
    let writer = createDownloadWriter(); await writer.begin({ selection }); await writer.open({ fileIndex: 0, start: 0 });
    await writer.append({ bytes: ggufBytes().slice(0, 48) }); await writer.pause();
    expect(await listHuggingFaceModels()).toEqual([]); expect((await listPendingDownloads())[0]?.bytes).toEqual([48]);
    writer = createDownloadWriter(); expect(await writer.begin({ selection })).toMatchObject({ status: 'ready', journal: { bytes: [48] } });
    await writer.open({ fileIndex: 0, start: 48 }); await writer.append({ bytes: ggufBytes().slice(48) }); await writer.finishFile(); await writer.finish();
    expect(await listPendingDownloads()).toEqual([]);
    expect(await listHuggingFaceModels()).toEqual([{ id: 'hf.co/owner/repo:nested%2Fmodel.gguf', name: 'hf.co/owner/repo:nested/model', size: 128, importedAt: 123 }]);
  });
  it('discards unrecorded suffixes and rejects smaller files than the journal', async () => {
    const writer = createDownloadWriter(); await writer.begin({ selection });
    const folder = await repositoryFolder({ repository: selection.repository, create: false }); const handle = await selectedFile({ folder, path: selection.files[0]!.path, create: false });
    const access = await openSyncAccess({ handle }); access.write(ggufBytes(), { at: 0 }); access.close();
    await createDownloadWriter().begin({ selection }); expect((await handle.getFile()).size).toBe(0);
    const journal = await readJournal({ folder }); journal.bytes[0] = 12; await writeJournal({ folder, journal });
    await expect(createDownloadWriter().begin({ selection })).rejects.toThrow('differs');
  });
  it('cancels a transferred reader without treating cancellation as EOF publication', async () => {
    const writer = createDownloadWriter(); await writer.begin({ selection }); await writer.open({ fileIndex: 0, start: 0 });
    const waiting = Promise.withResolvers<void>(); let pulls = 0;
    const stream = new ReadableStream<Uint8Array<ArrayBuffer>>({ pull(controller) {
      if (pulls++ === 0) controller.enqueue(ggufBytes().slice(0, 64)); else waiting.resolve();
    } }, { highWaterMark: 0 });
    const consumed = writer.consume({ stream }, async () => {}); const rejected = expect(consumed).rejects.toThrow('Download paused');
    await waiting.promise; await writer.stop(); await rejected; await writer.pause();
    expect((await listPendingDownloads())[0]?.bytes).toEqual([64]); expect(await listHuggingFaceModels()).toEqual([]);
  });
  it('refuses another revision or quantization while partial and after publication', async () => {
    const writer = createDownloadWriter(); await writer.begin({ selection });
    await expect(createDownloadWriter().begin({ selection: { ...selection, revision: 'b'.repeat(40) } })).resolves.toEqual({ status: 'conflict', reason: 'different-download' });
    await writer.open({ fileIndex: 0, start: 0 }); await writer.append({ bytes: ggufBytes() }); await writer.finishFile(); await writer.finish();
    await expect(createDownloadWriter().begin({ selection })).resolves.toEqual({ status: 'conflict', reason: 'existing-files' });
  });
  it('adds a projector after a text-only install using read-only source comparison', async () => {
    let writer = createDownloadWriter(); await writer.begin({ selection });
    await writer.open({ fileIndex: 0, start: 0 }); await writer.append({ bytes: ggufBytes() }); await writer.finishFile(); await writer.finish();
    const folder = await repositoryFolder({ repository: selection.repository, create: false });
    const handle = await selectedFile({ folder, path: selection.files[0]!.path, create: false });
    const before = new Uint8Array(await (await handle.getFile()).arrayBuffer());
    const upgrade = { ...selection, files: [...selection.files, { path: 'mmproj-F16.gguf', size: 128 }] };
    writer = createDownloadWriter();
    expect(await writer.begin({ selection: upgrade })).toMatchObject({ status: 'ready', journal: { reused: [true, false] } });
    await writer.open({ fileIndex: 0, start: 0 }); await writer.append({ bytes: ggufBytes() }); await writer.finishFile();
    expect(new Uint8Array(await (await handle.getFile()).arrayBuffer())).toEqual(before);
    await writer.open({ fileIndex: 1, start: 0 }); await writer.append({ bytes: ggufBytes() }); await writer.finishFile(); await writer.finish();
    expect(await listPendingDownloads()).toEqual([]);
    expect(await listHuggingFaceModels()).toHaveLength(1);
  });
  it('never truncates an installed main model when a multimodal upgrade source differs', async () => {
    let writer = createDownloadWriter(); await writer.begin({ selection });
    await writer.open({ fileIndex: 0, start: 0 }); await writer.append({ bytes: ggufBytes() }); await writer.finishFile(); await writer.finish();
    const folder = await repositoryFolder({ repository: selection.repository, create: false });
    const handle = await selectedFile({ folder, path: selection.files[0]!.path, create: false });
    writer = createDownloadWriter(); await writer.begin({ selection: { ...selection, files: [...selection.files, { path: 'mmproj-F16.gguf', size: 128 }] } });
    await writer.open({ fileIndex: 0, start: 0 });
    const changed = ggufBytes(); changed[80] = 12;
    await expect(writer.append({ bytes: changed })).rejects.toThrow('Existing model differs');
    await writer.pause();
    expect(new Uint8Array(await (await handle.getFile()).arrayBuffer())).toEqual(ggufBytes());
    expect((await listPendingDownloads())[0]?.reused).toEqual([true, false]);
  });
  it('keeps an installed main model when a paused multimodal upgrade is cancelled and deleted', async () => {
    let writer = createDownloadWriter(); await writer.begin({ selection });
    await writer.open({ fileIndex: 0, start: 0 }); await writer.append({ bytes: ggufBytes() }); await writer.finishFile(); await writer.finish();
    const folder = await repositoryFolder({ repository: selection.repository, create: false });
    const handle = await selectedFile({ folder, path: selection.files[0]!.path, create: false });
    const upgrade = { ...selection, files: [...selection.files, { path: 'mmproj-F16.gguf', size: 128 }] };
    writer = createDownloadWriter(); await writer.begin({ selection: upgrade });
    await writer.open({ fileIndex: 0, start: 0 }); await writer.append({ bytes: ggufBytes() }); await writer.finishFile();
    await writer.open({ fileIndex: 1, start: 0 }); await writer.append({ bytes: ggufBytes().slice(0, 48) }); await writer.pause();
    vi.stubGlobal('navigator', { ...navigator, locks: {
      request: async (_name: string, optionsOrCallback: object | (() => Promise<unknown>), callback?: (lock: object) => Promise<unknown>) => callback ? callback({}) : typeof optionsOrCallback === 'function' ? optionsOrCallback() : undefined,
    } });
    const { plan } = await prepareModelRemoval({ id: 'hf.co/owner/repo' });
    expect(plan.files.some(file => file.path === selection.files[0]!.path)).toBe(false);
    expect(await deleteRepository({ repository: selection.repository, plan })).toBe('deleted');
    expect(new Uint8Array(await (await handle.getFile()).arrayBuffer())).toEqual(ggufBytes());
    expect(await listPendingDownloads()).toEqual([]);
    expect(await listHuggingFaceModels()).toHaveLength(1);
    await expect(folder.getFileHandle('mmproj-F16.gguf')).rejects.toMatchObject({ name: 'NotFoundError' });
  });
  it('allows empty nested directories but preserves any existing file', async () => {
    const folder = await repositoryFolder({ repository: selection.repository, create: true });
    await (await folder.getDirectoryHandle('unused', { create: true })).getDirectoryHandle('empty', { create: true });
    await (await folder.getDirectoryHandle('nested', { create: true })).getDirectoryHandle('model.gguf', { create: true });
    expect(await createDownloadWriter().begin({ selection })).toMatchObject({ status: 'ready' });
    await expect(folder.getDirectoryHandle('unused')).rejects.toMatchObject({ name: 'NotFoundError' });
    const other = await repositoryFolder({ repository: 'owner/protected', create: true });
    const nested = await other.getDirectoryHandle('nested', { create: true });
    await nested.getFileHandle('keep.txt', { create: true });
    expect(await createDownloadWriter().begin({ selection: { ...selection, repository: 'owner/protected' } })).toMatchObject({ status: 'ready' });
    expect((await (await nested.getFileHandle('keep.txt')).getFile()).size).toBe(0);
  });
  it('rejects concurrent operations for the same repository across callers', async () => {
    const locks = new Set<string>();
    vi.stubGlobal('navigator', { ...navigator, locks: { request: async (name: string, _options: object, operation: (lock: object | undefined) => Promise<unknown>) => {
      if (locks.has(name)) return operation(undefined);
      locks.add(name); try {
        return await operation({});
      } finally {
        locks.delete(name);
      }
    } } });
    const gate = Promise.withResolvers<void>();
    const first = withRepositoryLock({ repository: selection.repository, operation: () => gate.promise });
    await expect(withRepositoryLock({ repository: selection.repository, operation: async () => {} })).rejects.toThrow('busy');
    gate.resolve(); await first;
    await expect(withRepositoryLock({ repository: selection.repository, operation: async () => 'released' })).resolves.toBe('released');
  });
  it('requires complete bodies and valid GGUF headers before publication', async () => {
    const writer = createDownloadWriter(); await writer.begin({ selection }); await writer.open({ fileIndex: 0, start: 0 });
    await writer.append({ bytes: new Uint8Array(127) }); await expect(writer.finishFile()).rejects.toThrow('Incomplete');
    await expect(writer.append({ bytes: new Uint8Array(2) })).rejects.toThrow('exceeds');
    await writer.append({ bytes: new Uint8Array(1) }); await writer.finishFile(); await expect(writer.finish()).rejects.toThrow('Invalid downloaded GGUF');
    expect(await listHuggingFaceModels()).toEqual([]);
  });
});
