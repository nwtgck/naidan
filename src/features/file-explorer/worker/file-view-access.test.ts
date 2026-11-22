import { Blob as NodeBlob } from 'node:buffer';
import { MessageChannel } from 'node:worker_threads';
import JSZip from 'jszip';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { reactive } from 'vue';
import { MockFileSystemDirectoryHandle } from '@/features/wesh/mocks/InMemoryFileSystem';
import { WeshVFS } from '@/features/wesh/vfs';
import { ggufScalarFixture, inspectionGgufFixture } from '@/logic/model-file-inspection/gguf.test-support';
import { exposeWorkerRemote, releaseWorkerRemote, wrapWorkerRemote } from '@/utils/worker-transport';
import { readFileEditStamp, withFileViewLock, withFileViewLocks } from './file-view-access';
import { createFileExplorerWorker } from './impl';
import { createFileExplorerStreamClient } from './stream-client';
import type { FileExplorerRootDescriptor, IFileExplorerWorker } from './types';

function createJobChannel() {
  const channel = new MessageChannel();
  return {
    channel,
    port: channel.port2 as unknown as MessagePort,
    [Symbol.dispose]() {
      channel.port1.close();
      channel.port2.close();
    },
  };
}

async function prepareSession({ root }: { root: FileExplorerRootDescriptor }) {
  const worker = createFileExplorerWorker();
  const { sessionId } = await worker.prepareSession({ request: { root } });
  return {
    worker,
    sessionId,
    async [Symbol.asyncDispose]() {
      await worker.disposeSession({ request: { sessionId } });
    },
  };
}

describe('File Explorer bounded reads and writes', () => {
  beforeEach(() => {
    // The jsdom Blob omits streaming and arrayBuffer. Use the platform Blob
    // contract exercised by real worker transports without launching a browser.
    vi.stubGlobal('Blob', NodeBlob);
    vi.stubGlobal('MessageChannel', MessageChannel);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('uses the same Web Lock for canonically equivalent native names', async () => {
    const request = vi.fn().mockImplementation((_name, _options, run) => run());
    vi.stubGlobal('navigator', { locks: { request } });
    const { signal } = new AbortController();
    const run = vi.fn().mockResolvedValue('written');

    await expect(withFileViewLock({ name: 'CAFÉ.gguf', signal, run })).resolves.toBe('written');
    await expect(withFileViewLock({ name: 'cafe\u0301.gguf', signal, run })).resolves.toBe('written');

    expect(request.mock.calls).toEqual([
      ['naidan:file-explorer:save:café.gguf', { mode: 'exclusive', signal }, run],
      ['naidan:file-explorer:save:café.gguf', { mode: 'exclusive', signal }, run],
    ]);
    expect(run).toHaveBeenCalledTimes(2);
  });

  it.each(['shared', 'exclusive'] as const)('requests the %s directory Web Lock before the ordered name locks', async mode => {
    const request = vi.fn().mockImplementation((_name, _options, run) => run());
    vi.stubGlobal('navigator', { locks: { request } });
    const { signal } = new AbortController();

    await withFileViewLocks({ names: ['z.txt', 'a.txt', 'A.TXT'], mode, signal, run: async () => undefined });

    expect(request.mock.calls.map(([name, options]) => [name, options])).toEqual([
      ['naidan:file-explorer:directory-transfer', { mode, signal }],
      ['naidan:file-explorer:save:a.txt', { mode: 'exclusive', signal }],
      ['naidan:file-explorer:save:z.txt', { mode: 'exclusive', signal }],
    ]);
  });

  it('fingerprints only bounded windows of a large file snapshot', async () => {
    const directory = new MockFileSystemDirectoryHandle({ name: 'work' });
    const handle = await directory.getFileHandle('weights.gguf', { create: true });
    handle.content = new Uint8Array(3 * 1024 * 1024);
    const snapshot = await handle.getFile();
    const slice = vi.spyOn(snapshot, 'slice');
    const readWhole = vi.spyOn(snapshot, 'arrayBuffer');
    const { signal } = new AbortController();

    await expect(readFileEditStamp({ file: snapshot, signal })).resolves.toMatchObject({ size: snapshot.size });

    expect(slice.mock.calls).toEqual([[0, 64 * 1024], [snapshot.size - 64 * 1024, snapshot.size]]);
    expect(readWhole).not.toHaveBeenCalled();
  });

  it('reads a bounded prefix and retains a native random-access snapshot', async () => {
    const directory = new MockFileSystemDirectoryHandle({ name: 'work' });
    const handle = await directory.getFileHandle('notes.txt', { create: true });
    handle.content = new TextEncoder().encode('contents');
    const snapshot = await handle.getFile();
    const readWhole = vi.spyOn(snapshot, 'arrayBuffer');
    vi.spyOn(handle, 'getFile').mockResolvedValue(snapshot);
    await using session = await prepareSession({
      root: { kind: 'native-directory', rootName: 'work', handle: directory as unknown as FileSystemDirectoryHandle, readOnly: true },
    });
    using prefixJob = createJobChannel();
    const prefix = await session.worker.readFileForView({
      request: { sessionId: session.sessionId, path: '/notes.txt', mode: 'prefix', maxBytes: 3 },
      port: prefixJob.port,
    });
    expect(prefix).toMatchObject({ kind: 'file', name: 'notes.txt', size: 8, partial: true });
    if (prefix.kind !== 'file') {
      throw new Error('Expected native file information');
    }
    expect(await prefix.blob.text()).toBe('con');
    expect(prefix.revision).toBeUndefined();

    using snapshotJob = createJobChannel();
    const file = await session.worker.readFileForView({
      request: { sessionId: session.sessionId, path: '/notes.txt', mode: 'snapshot' },
      port: snapshotJob.port,
    });
    expect(file).toMatchObject({ kind: 'file', blob: snapshot, partial: false });
    expect(readWhole).not.toHaveBeenCalled();
  });

  it('reads the overview, inspects, pages and rewrites GGUF over the shared Worker transport', async () => {
    const directory = new MockFileSystemDirectoryHandle({ name: 'work' });
    await using session = await prepareSession({
      root: { kind: 'native-directory', rootName: 'work', handle: directory as unknown as FileSystemDirectoryHandle, readOnly: true },
    });
    using job = createJobChannel();
    exposeWorkerRemote<IFileExplorerWorker>({ api: session.worker, endpoint: job.channel.port1 as unknown as MessagePort });
    const remote = wrapWorkerRemote<IFileExplorerWorker>({ endpoint: job.port });
    const client = createFileExplorerStreamClient({ remote, sessionId: session.sessionId, worker: new EventTarget() });
    using _client = {
      [Symbol.dispose]() {
        client.disposeStreams();
        releaseWorkerRemote({ remote });
      },
    };

    const key = 'tokenizer.chat_template';
    const before = 'template before';
    const after = 'template with an edited body';
    const body = new Uint8Array([1, 2, 3, 4]);
    const fixture = inspectionGgufFixture({
      metadata: [
        ggufScalarFixture({ key, type: 8, value: before }),
        ggufScalarFixture({ key: 'general.name', type: 8, value: 'Fixture model' }),
      ],
      tensors: [{ name: 'fixture.weight', shape: [1], dtype: 0, offset: 0 }],
      dataBytes: body.byteLength,
      alignment: 32,
    });
    const file = new Blob([await fixture.file.slice(0, fixture.file.size - body.byteLength).arrayBuffer(), body]);
    const access = client.fileAccess;
    await expect(access.inspectModelOverview({ file })).resolves.toStrictEqual({
      status: 'weights',
      value: {
        format: 'gguf',
        version: 3,
        split: undefined,
        name: 'Fixture model',
        architecture: undefined,
        metadataCount: 2,
        tensorCount: 1,
      },
    });
    const original = await access.inspectModel({ file });
    if (original.status !== 'weights' || !original.value.metadata[0]) {
      throw new Error('Expected inspectable model metadata');
    }
    const entry = reactive(original.value.metadata[0]);
    expect(entry).toMatchObject({ key, value: undefined });
    await expect(access.readModelMetadataValue({ file, entry, start: 0, limit: 1 })).resolves.toEqual({ values: [before], next: undefined });

    const rewrite = await access.prepareGgufMetadataRewrite({ file, changes: { [key]: after } });
    const edited = new Blob([rewrite.header, file.slice(rewrite.bodyOffset)]);
    const inspection = await access.inspectModel({ file: edited });
    if (inspection.status !== 'weights' || !inspection.value.metadata[0]) {
      throw new Error('Expected readable rewritten GGUF');
    }
    await expect(access.readModelMetadataValue({ file: edited, entry: inspection.value.metadata[0], start: 0, limit: 1 })).resolves.toEqual({ values: [after], next: undefined });
    expect(new Uint8Array(await edited.slice(inspection.value.dataOffset).arrayBuffer())).toEqual(body);
  });

  it('streams a ZIP prefix and rejects unsupported random access', async () => {
    const zip = new JSZip();
    zip.file('notes.txt', 'contents');
    const bytes = await zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE' });
    await using session = await prepareSession({
      root: { kind: 'archive-root', rootName: 'archive.zip', archive: { format: 'zip', source: { kind: 'blob', blob: new Blob([Uint8Array.from(bytes).buffer]) } } },
    });
    using prefixJob = createJobChannel();
    const prefix = await session.worker.readFileForView({
      request: { sessionId: session.sessionId, path: '/notes.txt', mode: 'prefix', maxBytes: 3 },
      port: prefixJob.port,
    });
    expect(prefix).toMatchObject({ kind: 'file', size: 8, partial: true });
    if (prefix.kind !== 'file') {
      throw new Error('Expected archive file information');
    }
    expect(await prefix.blob.text()).toBe('con');
    expect(prefix.revision).toBeUndefined();

    using boundedJob = createJobChannel();
    await expect(session.worker.readFileForView({
      request: { sessionId: session.sessionId, path: '/notes.txt', mode: 'bounded', maxBytes: 3 },
      port: boundedJob.port,
    })).resolves.toEqual({ kind: 'too-large', name: 'notes.txt', size: 8 });

    using snapshotJob = createJobChannel();
    await expect(session.worker.readFileForView({
      request: { sessionId: session.sessionId, path: '/notes.txt', mode: 'snapshot' },
      port: snapshotJob.port,
    })).resolves.toEqual({ kind: 'unsupported', name: 'notes.txt' });
  });

  it('reads only the requested virtual prefix plus one byte for truncation', async () => {
    const directory = new MockFileSystemDirectoryHandle({ name: 'work' });
    const handle = await directory.getFileHandle('notes.txt', { create: true });
    handle.content = new TextEncoder().encode('contents');
    await using session = await prepareSession({
      root: { kind: 'wesh-mounts', rootName: 'work', mounts: [{ type: 'directory', path: '/work', handle: directory as unknown as FileSystemDirectoryHandle, readOnly: true }] },
    });
    vi.spyOn(WeshVFS.prototype, 'getNativeHandle').mockResolvedValue(null);
    const open = WeshVFS.prototype.open;
    const lengths: number[] = [];
    const close = vi.fn();
    vi.spyOn(WeshVFS.prototype, 'open').mockImplementation(async function (this: WeshVFS, input) {
      const opened = await open.call(this, input);
      const read = opened.read.bind(opened);
      const closeHandle = opened.close.bind(opened);
      opened.read = (args) => {
        lengths.push(args.buffer.byteLength);
        return read(args);
      };
      opened.close = () => {
        close();
        return closeHandle();
      };
      return opened;
    });
    using job = createJobChannel();
    const result = await session.worker.readFileForView({
      request: { sessionId: session.sessionId, path: '/work/notes.txt', mode: 'prefix', maxBytes: 3 },
      port: job.port,
    });
    expect(result).toMatchObject({ kind: 'file', size: undefined, partial: true });
    expect(lengths).toEqual([4]);
    expect(close).toHaveBeenCalledOnce();
  });

  it('saves changes and returns a revision for the new version', async () => {
    const directory = new MockFileSystemDirectoryHandle({ name: 'work' });
    const handle = await directory.getFileHandle('notes.txt', { create: true });
    handle.content = new TextEncoder().encode('before');
    await using session = await prepareSession({
      root: { kind: 'native-directory', rootName: 'work', handle: directory as unknown as FileSystemDirectoryHandle, readOnly: false },
    });
    using readJob = createJobChannel();
    const original = await session.worker.readFileForView({
      request: { sessionId: session.sessionId, path: '/notes.txt', mode: 'bounded', maxBytes: 100 },
      port: readJob.port,
    });
    if (original.kind !== 'file' || !original.revision) {
      throw new Error('Expected an editable revision');
    }
    using saveJob = createJobChannel();
    const result = await session.worker.saveFileForView({
      request: {
        sessionId: session.sessionId,
        target: { kind: 'replace', path: '/notes.txt', revision: original.revision },
        blob: new Blob(['after']),
      },
      port: saveJob.port,
    });
    expect(result.path).toBe('/notes.txt');
    expect(result.revision).toEqual(expect.any(String));
    expect(result.revision).not.toBe(original.revision);
    expect(await (await handle.getFile()).text()).toBe('after');

    using staleSave = createJobChannel();
    await expect(session.worker.saveFileForView({
      request: {
        sessionId: session.sessionId,
        target: { kind: 'replace', path: '/notes.txt', revision: original.revision },
        blob: new Blob(['outdated']),
      },
      port: staleSave.port,
    })).rejects.toMatchObject({ name: 'InvalidStateError' });
    expect(await (await handle.getFile()).text()).toBe('after');
  });

  it('serializes aliased saves across sessions and reads the committed revision in the saving session', async () => {
    const directory = new MockFileSystemDirectoryHandle({ name: 'work' });
    const child = await directory.getDirectoryHandle('documents', { create: true });
    const handle = await child.getFileHandle('notes.txt', { create: true });
    handle.content = new TextEncoder().encode('before');
    vi.stubGlobal('navigator', {});
    await using first = await prepareSession({
      root: { kind: 'native-directory', rootName: 'work', handle: directory as unknown as FileSystemDirectoryHandle, readOnly: false },
    });
    await using second = await prepareSession({
      root: { kind: 'native-directory', rootName: 'documents', handle: child as unknown as FileSystemDirectoryHandle, readOnly: false },
    });
    const firstPath = '/documents/notes.txt';
    const secondPath = '/notes.txt';
    using firstReadJob = createJobChannel();
    using secondReadJob = createJobChannel();
    const firstRead = await first.worker.readFileForView({
      request: { sessionId: first.sessionId, path: firstPath, mode: 'bounded', maxBytes: 100 },
      port: firstReadJob.port,
    });
    const secondRead = await second.worker.readFileForView({
      request: { sessionId: second.sessionId, path: secondPath, mode: 'bounded', maxBytes: 100 },
      port: secondReadJob.port,
    });
    if (firstRead.kind !== 'file' || !firstRead.revision || secondRead.kind !== 'file' || !secondRead.revision) {
      throw new Error('Expected both sessions to capture the original file version');
    }

    const writable = await handle.createWritable();
    const realClose = writable.close.bind(writable);
    const getFile = handle.getFile.bind(handle);
    const enteredRevisionCheck = Promise.withResolvers<void>();
    const resumeRevisionCheck = Promise.withResolvers<void>();
    using _resume = {
      [Symbol.dispose]() {
        resumeRevisionCheck.resolve();
      },
    };
    vi.spyOn(writable, 'close').mockImplementation(async () => {
      await realClose();
      vi.spyOn(handle, 'getFile').mockImplementationOnce(async () => {
        enteredRevisionCheck.resolve();
        await resumeRevisionCheck.promise;
        return getFile();
      });
    });
    const openWritable = vi.spyOn(handle, 'createWritable').mockResolvedValueOnce(writable);
    using firstSaveJob = createJobChannel();
    const firstSave = first.worker.saveFileForView({
      request: {
        sessionId: first.sessionId,
        target: { kind: 'replace', path: firstPath, revision: firstRead.revision },
        blob: new Blob(['first']),
      },
      port: firstSaveJob.port,
    });
    await Promise.race([
      enteredRevisionCheck.promise,
      firstSave.then(() => {
        throw new Error('The save completed before checking its committed revision');
      }),
    ]);
    using secondSaveJob = createJobChannel();
    const staleSave = second.worker.saveFileForView({
      request: {
        sessionId: second.sessionId,
        target: { kind: 'replace', path: secondPath, revision: secondRead.revision },
        blob: new Blob(['stale']),
      },
      port: secondSaveJob.port,
    });
    const finishedSave = vi.fn();
    void staleSave.then(finishedSave, finishedSave);
    using queuedReadJob = createJobChannel();
    const queuedRead = first.worker.readFileForView({
      request: { sessionId: first.sessionId, path: firstPath, mode: 'bounded', maxBytes: 100 },
      port: queuedReadJob.port,
    });
    const finishedRead = vi.fn();
    void queuedRead.then(finishedRead, finishedRead);
    await new Promise<void>(resolve => setTimeout(resolve, 0));
    expect(openWritable).toHaveBeenCalledOnce();
    expect(finishedSave).not.toHaveBeenCalled();
    expect(finishedRead).not.toHaveBeenCalled();

    resumeRevisionCheck.resolve();
    const saved = await firstSave;
    expect(saved.revision).toEqual(expect.any(String));
    await expect(staleSave).rejects.toMatchObject({ name: 'InvalidStateError' });
    const reopened = await queuedRead;
    if (reopened.kind !== 'file') {
      throw new Error('Expected reopened file information');
    }
    expect(reopened.revision).toBe(saved.revision);
    expect(await reopened.blob.text()).toBe('first');
    expect(await (await handle.getFile()).text()).toBe('first');
  });

  it('withholds the revision if an external edit wins immediately after commit', async () => {
    const directory = new MockFileSystemDirectoryHandle({ name: 'work' });
    const handle = await directory.getFileHandle('notes.txt', { create: true });
    handle.content = new TextEncoder().encode('before');
    await using session = await prepareSession({
      root: { kind: 'native-directory', rootName: 'work', handle: directory as unknown as FileSystemDirectoryHandle, readOnly: false },
    });
    using readJob = createJobChannel();
    const original = await session.worker.readFileForView({
      request: { sessionId: session.sessionId, path: '/notes.txt', mode: 'bounded', maxBytes: 100 },
      port: readJob.port,
    });
    if (original.kind !== 'file' || !original.revision) {
      throw new Error('Expected an editable revision');
    }
    const writable = await handle.createWritable();
    const realClose = writable.close.bind(writable);
    vi.spyOn(handle, 'createWritable').mockResolvedValueOnce(writable);
    vi.spyOn(writable, 'close').mockImplementation(async () => {
      await realClose();
      handle.content = new TextEncoder().encode('other');
    });
    using saveJob = createJobChannel();
    await expect(session.worker.saveFileForView({
      request: {
        sessionId: session.sessionId,
        target: { kind: 'replace', path: '/notes.txt', revision: original.revision },
        blob: new Blob(['after']),
      },
      port: saveJob.port,
    })).resolves.toEqual({ path: '/notes.txt', revision: undefined });
    expect(await (await handle.getFile()).text()).toBe('other');
  });

  it('aborts the pending write when an external edit changes the source before commit', async () => {
    const directory = new MockFileSystemDirectoryHandle({ name: 'work' });
    const handle = await directory.getFileHandle('notes.txt', { create: true });
    handle.content = new TextEncoder().encode('before');
    await using session = await prepareSession({
      root: { kind: 'native-directory', rootName: 'work', handle: directory as unknown as FileSystemDirectoryHandle, readOnly: false },
    });
    using readJob = createJobChannel();
    const original = await session.worker.readFileForView({
      request: { sessionId: session.sessionId, path: '/notes.txt', mode: 'bounded', maxBytes: 100 },
      port: readJob.port,
    });
    if (original.kind !== 'file' || !original.revision) {
      throw new Error('Expected an editable revision');
    }
    const writable = await handle.createWritable();
    const write = writable.write.bind(writable);
    vi.spyOn(handle, 'createWritable').mockResolvedValue(writable);
    vi.spyOn(writable, 'write').mockImplementation(async bytes => {
      await write(bytes);
      // Same byte count and timestamp, enough to defeat stamp-only checks.
      handle.content = new TextEncoder().encode('edited');
    });
    const close = vi.spyOn(writable, 'close');
    using saveJob = createJobChannel();
    await expect(session.worker.saveFileForView({
      request: {
        sessionId: session.sessionId,
        target: { kind: 'replace', path: '/notes.txt', revision: original.revision },
        blob: new Blob(['attempted']),
      },
      port: saveJob.port,
    })).rejects.toMatchObject({ name: 'InvalidStateError' });
    expect(close).not.toHaveBeenCalled();
    expect(await (await handle.getFile()).text()).toBe('edited');
  });

  it('saves a copy without overwriting a file with the same name', async () => {
    const directory = new MockFileSystemDirectoryHandle({ name: 'work' });
    const handle = await directory.getFileHandle('notes.txt', { create: true });
    handle.content = new TextEncoder().encode('before');
    await using session = await prepareSession({
      root: { kind: 'native-directory', rootName: 'work', handle: directory as unknown as FileSystemDirectoryHandle, readOnly: false },
    });

    using collision = createJobChannel();
    await expect(session.worker.saveFileForView({
      request: {
        sessionId: session.sessionId,
        target: { kind: 'create', directoryPath: '/', name: 'notes.txt' },
        blob: new Blob(['attempted']),
      },
      port: collision.port,
    })).rejects.toMatchObject({ name: 'InvalidModificationError' });
    using saveJob = createJobChannel();
    const result = await session.worker.saveFileForView({
      request: {
        sessionId: session.sessionId,
        target: { kind: 'create', directoryPath: '/', name: 'copy.txt' },
        blob: new Blob(['copy']),
      },
      port: saveJob.port,
    });
    expect(result.path).toBe('/copy.txt');
    expect(await (await handle.getFile()).text()).toBe('before');
    expect(await (await (await directory.getFileHandle('copy.txt')).getFile()).text()).toBe('copy');
  });

  it.each(['moveEntries', 'renameEntry'] as const)('prevents a child save from committing while %s removes a copied directory', async operation => {
    const directory = new MockFileSystemDirectoryHandle({ name: 'work' });
    const project = await directory.getDirectoryHandle('project', { create: true });
    const leaf = await project.getFileHandle('leaf.txt', { create: true });
    leaf.content = new TextEncoder().encode('copied content');
    const target = await directory.getDirectoryHandle('target', { create: true });
    const root = { kind: 'native-directory', rootName: 'work', handle: directory as unknown as FileSystemDirectoryHandle, readOnly: false } as const;
    await using editor = await prepareSession({ root });
    await using explorer = await prepareSession({ root });
    using readJob = createJobChannel();
    const opened = await editor.worker.readFileForView({
      request: { sessionId: editor.sessionId, path: '/project/leaf.txt', mode: 'bounded', maxBytes: 100 },
      port: readJob.port,
    });
    if (opened.kind !== 'file' || !opened.revision) {
      throw new Error('Expected an editable file');
    }

    const removing = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const remove = directory.removeEntry.bind(directory);
    vi.spyOn(directory, 'removeEntry').mockImplementation(async (name, options) => {
      if (name === 'project') {
        removing.resolve();
        await release.promise;
      }
      return remove(name, options);
    });
    const transfer = {
      moveEntries: {
        destination: () => target.getDirectoryHandle('project'),
        run: () => explorer.worker.moveEntries({ request: { sessionId: explorer.sessionId, sourcePaths: ['/project'], targetDirectoryPath: '/target' } }),
      },
      renameEntry: {
        destination: () => directory.getDirectoryHandle('renamed'),
        run: () => explorer.worker.renameEntry({ request: { sessionId: explorer.sessionId, path: '/project', newName: 'renamed' } }),
      },
    }[operation];
    const transferring = transfer.run();
    await removing.promise;

    using saveJob = createJobChannel();
    const createWritable = vi.spyOn(leaf, 'createWritable');
    const saving = editor.worker.saveFileForView({
      request: {
        sessionId: editor.sessionId,
        target: { kind: 'replace', path: '/project/leaf.txt', revision: opened.revision },
        blob: new Blob(['new content']),
      },
      port: saveJob.port,
    });
    const outcomes = Promise.allSettled([transferring, saving]);
    try {
      await new Promise<void>(resolve => setTimeout(resolve, 0));
      expect(createWritable).not.toHaveBeenCalled();
    } finally {
      release.resolve();
    }
    expect(await outcomes).toEqual([
      { status: 'fulfilled', value: undefined },
      { status: 'rejected', reason: expect.objectContaining({ name: 'InvalidStateError' }) },
    ]);
    const moved = await (await transfer.destination()).getFileHandle('leaf.txt');
    expect(await (await moved.getFile()).text()).toBe('copied content');
    await expect(directory.getDirectoryHandle('project')).rejects.toMatchObject({ name: 'NotFoundError' });
  });

  it('preserves an empty Save As destination after a failed write', async () => {
    const directory = new MockFileSystemDirectoryHandle({ name: 'work' });
    const open = directory.getFileHandle.bind(directory);
    vi.spyOn(directory, 'getFileHandle').mockImplementation(async (name, options) => {
      const handle = await open(name, options);
      if (options?.create) {
        vi.spyOn(handle, 'createWritable').mockRejectedValue(new DOMException('Cannot write', 'QuotaExceededError'));
      }
      return handle;
    });
    await using session = await prepareSession({
      root: { kind: 'native-directory', rootName: 'work', handle: directory as unknown as FileSystemDirectoryHandle, readOnly: false },
    });
    using job = createJobChannel();
    await expect(session.worker.saveFileForView({
      request: {
        sessionId: session.sessionId,
        target: { kind: 'create', directoryPath: '/', name: 'copy.txt' },
        blob: new Blob(['copy']),
      },
      port: job.port,
    })).rejects.toMatchObject({ name: 'QuotaExceededError' });
    expect((await (await directory.getFileHandle('copy.txt')).getFile()).size).toBe(0);
  });

  it('leaves the original intact when a save is cancelled while writing', async () => {
    const directory = new MockFileSystemDirectoryHandle({ name: 'work' });
    const handle = await directory.getFileHandle('notes.txt', { create: true });
    handle.content = new TextEncoder().encode('before');
    await using session = await prepareSession({
      root: { kind: 'native-directory', rootName: 'work', handle: directory as unknown as FileSystemDirectoryHandle, readOnly: false },
    });
    using readJob = createJobChannel();
    const original = await session.worker.readFileForView({
      request: { sessionId: session.sessionId, path: '/notes.txt', mode: 'bounded', maxBytes: 100 },
      port: readJob.port,
    });
    if (original.kind !== 'file' || !original.revision) {
      throw new Error('Expected an editable revision');
    }
    const writable = await handle.createWritable();
    const write = writable.write.bind(writable);
    const started = Promise.withResolvers<void>();
    const resume = Promise.withResolvers<void>();
    vi.spyOn(handle, 'createWritable').mockResolvedValue(writable);
    vi.spyOn(writable, 'write').mockImplementation(async bytes => {
      started.resolve();
      await resume.promise;
      await write(bytes);
    });
    const close = vi.spyOn(writable, 'close');
    using saveJob = createJobChannel();
    const pending = session.worker.saveFileForView({
      request: {
        sessionId: session.sessionId,
        target: { kind: 'replace', path: '/notes.txt', revision: original.revision },
        blob: new Blob(['attempted']),
      },
      port: saveJob.port,
    });
    void pending.catch(() => undefined);
    await started.promise;
    const acknowledged = new Promise<void>(resolve => {
      saveJob.channel.port2.once('message', () => resolve());
    });
    saveJob.channel.port1.postMessage({ type: 'cancel' });
    await acknowledged;
    resume.resolve();
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    expect(close).not.toHaveBeenCalled();
    expect(await (await handle.getFile()).text()).toBe('before');
  });

  it('protects the application settings file in the OPFS root', async () => {
    const directory = new MockFileSystemDirectoryHandle({ name: 'work' });
    const app = await directory.getDirectoryHandle('naidan-storage', { create: true });
    const handle = await app.getFileHandle('settings.json', { create: true });
    handle.content = new TextEncoder().encode('{}');
    vi.stubGlobal('navigator', { storage: { getDirectory: async () => directory } });
    await using session = await prepareSession({ root: { kind: 'opfs-root', rootName: 'work' } });
    using readJob = createJobChannel();
    const original = await session.worker.readFileForView({
      request: { sessionId: session.sessionId, path: '/naidan-storage/settings.json', mode: 'bounded', maxBytes: 100 },
      port: readJob.port,
    });
    expect(original).toMatchObject({ kind: 'file', revision: undefined });

    using writeJob = createJobChannel();
    await expect(session.worker.saveFileForView({
      request: {
        sessionId: session.sessionId,
        target: { kind: 'replace', path: '/naidan-storage/settings.json', revision: 'invented' },
        blob: new Blob(['attempted']),
      },
      port: writeJob.port,
    })).rejects.toMatchObject({ name: 'NotAllowedError' });
    expect(await (await handle.getFile()).text()).toBe('{}');
  });
});
