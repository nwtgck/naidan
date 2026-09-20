import { openSyncAccess } from './sync-access';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDownloadWriter } from './writer';
import { listHuggingFaceModels, listPendingDownloads, readJournal, repositoryFolder, selectedFile, writeJournal, withRepositoryLock } from './storage';
import { ggufBytes, memoryDirectory } from './test-opfs';
import type { DownloadSelection } from './types';
vi.mock('@/utils/worker-transport', () => ({ releaseWorkerRemote: vi.fn() }));
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
