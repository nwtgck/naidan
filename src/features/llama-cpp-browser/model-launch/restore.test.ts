import { beforeEach, describe, expect, it, vi } from 'vitest';
import { observeLegacyModelDownload } from './restore';
import { resolveModelLaunchTarget } from './target';
import type { RepositoryCatalog } from '@/features/llama-cpp-browser/hugging-face/catalog';
import { toHostModelDirectoryId } from '@/01-models/ids';
import { modelFileMarker } from '@/logic/model-file-publication';
const io = vi.hoisted(() => ({ folder: vi.fn(), journal: vi.fn(), directories: vi.fn(), inspect: vi.fn(), registrations: vi.fn(), root: vi.fn() }));
vi.mock('../hugging-face/storage', () => ({ repositoryFolder: io.folder, readJournal: io.journal, repositoryDirectories: io.directories, isMissing: ({ error }: { error: unknown }) => error instanceof Error && error.message === 'missing' }));
vi.mock('../hugging-face/metadata-session', () => ({ getMetadataSession: () => ({ inspect: io.inspect }) }));
vi.mock('@/00-storage/service', () => ({ storageService: { loadHostModelDirectories: io.registrations } }));
vi.mock('../runtime/model-destination', () => ({ hostModelRoot: io.root }));
const catalog: RepositoryCatalog = { repository: 'owner/Model-GGUF', revision: 'b'.repeat(40), projectors: [], models: [{ label: 'Model-Q4_K_M', size: 256, files: [{ path: 'Model-Q4_K_M.gguf', size: 256 }] }] };
const target = resolveModelLaunchTarget({ input: catalog.repository, catalog }).target;
const journal = { version: 1, selection: target.selection, bytes: [64], complete: [false] };

beforeEach(() => {
  vi.resetAllMocks();
  io.folder.mockResolvedValue({});
  io.journal.mockResolvedValue(journal);
  io.directories.mockResolvedValue([]);
  io.inspect.mockResolvedValue(catalog);
  io.registrations.mockResolvedValue([{ id: toHostModelDirectoryId({ raw: 'root-id' }), name: 'Library' }]);
  io.root.mockResolvedValue({ name: 'Library' });
});

describe('read-only interrupted model download observation', () => {
  it('uses only an interrupted journal and its pinned revision without fetching metadata', async () => {
    const selection = { ...target.selection, revision: 'c'.repeat(40) };
    io.journal.mockResolvedValue({ ...journal, selection });
    const observed = await observeLegacyModelDownload({ modelId: target.modelId, signal: new AbortController().signal });
    expect(observed).toMatchObject({ target: { ...target, selection }, destination: { kind: 'opfs' } });
    expect(io.folder).toHaveBeenCalledExactlyOnceWith({ repository: catalog.repository, create: false, destination: { kind: 'opfs' } });
    expect(io.inspect).not.toHaveBeenCalled();
    expect(io.directories).not.toHaveBeenCalled();
  });

  it('leaves installed files to ordinary Chat instead of fabricating a revision from navigation history', async () => {
    io.journal.mockRejectedValue(new Error('missing'));
    const primaryFile = { relativePath: target.mainFilePath, file: new File([new Uint8Array(256)], 'model.gguf') };
    io.directories.mockResolvedValue([{ primaryFile, projectorFile: undefined, files: [primaryFile] }]);
    expect(await observeLegacyModelDownload({ modelId: target.modelId, signal: new AbortController().signal })).toBeUndefined();
    expect(io.directories).not.toHaveBeenCalled();
    expect(io.inspect).not.toHaveBeenCalled();
  });

  it('requires an explicit operation instead of fetching metadata when no local journal exists', async () => {
    io.journal.mockRejectedValue(new Error('missing'));
    expect(await observeLegacyModelDownload({ modelId: target.modelId, signal: new AbortController().signal })).toBeUndefined();
    expect(io.inspect).not.toHaveBeenCalled();
  });

  it('rejects a journal that does not describe one unambiguous model', async () => {
    io.journal.mockResolvedValue({ ...journal, selection: { ...target.selection, files: [...target.selection.files, { path: 'Other-Q8_0.gguf', size: 256 }] } });
    await expect(observeLegacyModelDownload({ modelId: target.modelId, signal: new AbortController().signal })).rejects.toThrow();
    expect(io.inspect).not.toHaveBeenCalled();
  });

  it('does not substitute another quantization for the current resolved model', async () => {
    expect(await observeLegacyModelDownload({ modelId: 'hf.co/owner/Model-GGUF:Q8_0', signal: new AbortController().signal })).toBeUndefined();
    expect(io.inspect).not.toHaveBeenCalled();
  });

  it('does not bypass a corrupt journal by starting remote discovery', async () => {
    io.journal.mockRejectedValue(new Error('invalid journal'));
    await expect(observeLegacyModelDownload({ modelId: target.modelId, signal: new AbortController().signal })).rejects.toThrow('invalid journal');
    expect(io.inspect).not.toHaveBeenCalled();
  });

  it('does not consult even a cached metadata response when the journal belongs to another repository', async () => {
    io.journal.mockResolvedValue({ ...journal, selection: { ...target.selection, repository: 'other/repo' } });
    expect(await observeLegacyModelDownload({ modelId: target.modelId, signal: new AbortController().signal })).toBeUndefined();
    expect(io.inspect).not.toHaveBeenCalled();
  });

  it('cancels after a pending local lookup without issuing metadata requests', async () => {
    const gate = Promise.withResolvers<unknown>();
    const controller = new AbortController();
    io.journal.mockReturnValue(gate.promise);
    const pending = observeLegacyModelDownload({ modelId: target.modelId, signal: controller.signal });
    const rejected = expect(pending).rejects.toThrow();
    await vi.waitFor(() => expect(io.journal).toHaveBeenCalledOnce());
    controller.abort();
    gate.resolve(journal);
    await rejected;
    expect(io.inspect).not.toHaveBeenCalled();
  });

  it('does nothing for an already cancelled request', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(observeLegacyModelDownload({ modelId: target.modelId, signal: controller.signal })).rejects.toThrow();
    expect(io.folder).not.toHaveBeenCalled();
  });

  it('resolves the current host alias and reads only that destination without requesting permission', async () => {
    const root = { requestPermission: vi.fn() };
    io.root.mockResolvedValue(root);
    const observed = await observeLegacyModelDownload({ modelId: 'host/Library/owner/Model-GGUF:Q4_K_M', signal: new AbortController().signal });
    expect(observed).toMatchObject({ effectiveModelId: 'host/Library/owner/Model-GGUF:Q4_K_M', destination: { kind: 'host', directoryId: 'root-id' }, target });
    expect(observed?.expectedRoot).toBe(root);
    expect(io.root).toHaveBeenCalledExactlyOnceWith({ destination: { kind: 'host', directoryId: 'root-id' }, mode: 'read' });
    expect(io.folder).toHaveBeenCalledExactlyOnceWith({ repository: catalog.repository, create: false, destination: { kind: 'host', directoryId: 'root-id' } });
    expect(root.requestPermission).not.toHaveBeenCalled();
  });

  it('never falls back to OPFS when the current host root cannot be read', async () => {
    io.root.mockRejectedValue(new Error('permission required'));
    await expect(observeLegacyModelDownload({ modelId: 'host/Library/owner/Model-GGUF:Q4_K_M', signal: new AbortController().signal })).rejects.toThrow('permission required');
    expect(io.folder).not.toHaveBeenCalled();
    expect(io.inspect).not.toHaveBeenCalled();
  });

  it('does not invent a full plan from a modern per-file pending marker without a legacy aggregate journal', async () => {
    const actual = await vi.importActual<typeof import('@/features/llama-cpp-browser/hugging-face/storage')>('../hugging-face/storage');
    const markerName = modelFileMarker({ name: target.mainFilePath, state: 'pending' });
    const markers = new Map([[markerName, { version: 2, kind: 'naidan-file-download', source: { repository: catalog.repository, revision: catalog.revision, path: target.mainFilePath, size: 256, sha256: 'a'.repeat(64) }, bytes: 64, state: 'partial' }]]);
    const folder = {
      getFileHandle: vi.fn(async (name: string) => {
        const marker = markers.get(name);
        if (marker === undefined) {
          throw new Error('missing');
        }
        return { getFile: async () => new File([JSON.stringify(marker)], name) };
      }),
    };
    io.folder.mockResolvedValue(folder);
    io.journal.mockImplementation(actual.readJournal);
    expect(await observeLegacyModelDownload({ modelId: target.modelId, signal: new AbortController().signal })).toBeUndefined();
    expect(markers.has(markerName)).toBe(true);
    expect(folder.getFileHandle).toHaveBeenCalledExactlyOnceWith('.llama-cpp-import-pending');
    expect(io.inspect).not.toHaveBeenCalled();
    expect(io.directories).not.toHaveBeenCalled();
  });
});
