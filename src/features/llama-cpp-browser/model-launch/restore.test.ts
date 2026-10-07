import { beforeEach, describe, expect, it, vi } from 'vitest';
import { modelLaunchViewState } from './history';
import { toChatId } from '@/01-models/ids';
import { restoreModelLaunchTarget } from './restore';
import { resolveModelLaunchTarget } from './target';
import type { RepositoryCatalog } from '@/features/llama-cpp-browser/hugging-face/catalog';
const io = vi.hoisted(() => ({ folder: vi.fn(), journal: vi.fn(), directories: vi.fn(), inspect: vi.fn() }));
vi.mock('../hugging-face/storage', () => ({ repositoryFolder: io.folder, readJournal: io.journal, repositoryDirectories: io.directories, isMissing: ({ error }: { error: unknown }) => error instanceof Error && error.message === 'missing' }));
vi.mock('../hugging-face/metadata-session', () => ({ getMetadataSession: () => ({ inspect: io.inspect }) }));
const catalog: RepositoryCatalog = { repository: 'owner/Model-GGUF', revision: 'b'.repeat(40), projectors: [], models: [{ label: 'Model-Q4_K_M', size: 256, files: [{ path: 'Model-Q4_K_M.gguf', size: 256 }] }] };
const target = resolveModelLaunchTarget({ input: catalog.repository, catalog }).target;
const view = modelLaunchViewState({ chatId: toChatId({ raw: 'chat' }), input: `${catalog.repository}:Q4_K_M`, modelId: target.modelId, revision: 'a'.repeat(40) });

beforeEach(() => {
  vi.resetAllMocks(); io.folder.mockResolvedValue({}); io.journal.mockRejectedValue(new Error('missing'));
  io.directories.mockResolvedValue([]); io.inspect.mockResolvedValue(catalog);
});

describe('DTO-free model launch restoration', () => {
  it('uses an interrupted download journal and keeps its old pinned revision without a network request', async () => {
    const selection = { ...target.selection, revision: 'c'.repeat(40) };
    io.journal.mockResolvedValue({ selection });
    expect(await restoreModelLaunchTarget({ view, signal: new AbortController().signal })).toEqual({ ...target, selection });
    expect(io.inspect).not.toHaveBeenCalled(); expect(io.directories).not.toHaveBeenCalled();
  });

  it('rebuilds an installed selection from existing files while offline', async () => {
    io.directories.mockResolvedValue([{ id: target.modelId, files: [{ path: target.mainFilePath, file: new File([new Uint8Array(256)], 'model.gguf') }] }]);
    expect(await restoreModelLaunchTarget({ view, signal: new AbortController().signal })).toEqual({ ...target, selection: { ...target.selection, revision: view.revision } });
    expect(io.inspect).not.toHaveBeenCalled();
  });

  it('rechecks metadata only for the same exact main file when no local plan exists', async () => {
    expect(await restoreModelLaunchTarget({ view, signal: new AbortController().signal })).toEqual(target);
    expect(io.inspect).toHaveBeenCalledWith({ input: view.input, signal: expect.any(AbortSignal), freshness: 'reuse' });
  });

  it('does not substitute another quantization when the saved model disappeared', async () => {
    io.inspect.mockResolvedValue({ ...catalog, models: [{ label: 'Q8_0', size: 256, files: [{ path: 'Model-Q8_0.gguf', size: 256 }] }] });
    await expect(restoreModelLaunchTarget({ view, signal: new AbortController().signal })).rejects.toThrow();
  });

  it('does not bypass a corrupt journal by starting remote discovery', async () => {
    io.journal.mockRejectedValue(new Error('invalid journal'));
    await expect(restoreModelLaunchTarget({ view, signal: new AbortController().signal })).rejects.toThrow('invalid journal');
    expect(io.inspect).not.toHaveBeenCalled();
  });

  it('rejects a metadata response for another repository', async () => {
    io.inspect.mockResolvedValue({ ...catalog, repository: 'other/repo' });
    await expect(restoreModelLaunchTarget({ view, signal: new AbortController().signal })).rejects.toThrow('repository changed');
  });

  it('cancels after a pending local lookup without issuing metadata requests', async () => {
    const gate = Promise.withResolvers<unknown[]>(); const controller = new AbortController(); io.directories.mockReturnValue(gate.promise);
    const pending = restoreModelLaunchTarget({ view, signal: controller.signal });
    const rejected = expect(pending).rejects.toThrow(); await vi.waitFor(() => expect(io.directories).toHaveBeenCalledOnce());
    controller.abort(); gate.resolve([]); await rejected; expect(io.inspect).not.toHaveBeenCalled();
  });

  it('does nothing for an already cancelled request', async () => {
    const controller = new AbortController(); controller.abort();
    await expect(restoreModelLaunchTarget({ view, signal: controller.signal })).rejects.toThrow();
    expect(io.folder).not.toHaveBeenCalled();
  });
});
