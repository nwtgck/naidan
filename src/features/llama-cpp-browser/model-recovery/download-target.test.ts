import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { RepositoryCatalog } from '@/features/llama-cpp-browser/hugging-face/catalog';
import { resolveRecoveryDownload } from './download-target';
const calls = vi.hoisted(() => ({ folder: vi.fn(), journal: vi.fn(), inspect: vi.fn() }));
vi.mock('../hugging-face/storage', () => ({ repositoryFolder: calls.folder, readJournal: calls.journal, isMissing: ({ error }: { error: unknown }) => error instanceof DOMException && error.name === 'NotFoundError' }));
vi.mock('../hugging-face/metadata-session', () => ({ getMetadataSession: () => ({ inspect: calls.inspect }) }));
const catalog: RepositoryCatalog = { repository: 'owner/Model', revision: 'b'.repeat(40), projectors: [], models: ['Q4_K_M','Q8_0'].map(q => ({ label: q, size: 256, files: [{ path: `nested/Model-${q}.gguf`, size: 256 }] })) };
const path = 'nested/Model-Q8_0.gguf';
const modelId = `hf.co/owner/Model:${encodeURIComponent(path)}`;
beforeEach(() => {
  vi.resetAllMocks(); calls.folder.mockResolvedValue({}); calls.journal.mockRejectedValue(new DOMException('missing', 'NotFoundError')); calls.inspect.mockResolvedValue(catalog);
});
describe('explicit ordinary-chat recovery plan', () => {
  it('selects the exact encoded file path, never the first quantization', async () => {
    const target = await resolveRecoveryDownload({ modelId, signal: new AbortController().signal });
    expect(target.modelId).toBe(modelId); expect(target.mainFilePath).toBe(path);
    expect(target.selection.files).toEqual([{ path, size: 256 }]);
  });
  it('reuses the interrupted transfer revision without external metadata', async () => {
    const selection = { repository: catalog.repository, revision: 'a'.repeat(40), files: [{ path, size: 256 }] };
    calls.journal.mockResolvedValue({ selection });
    expect((await resolveRecoveryDownload({ modelId, signal: new AbortController().signal })).selection).toEqual(selection);
    expect(calls.inspect).not.toHaveBeenCalled();
  });
  it.each(['user/model', 'hf.co/owner/Model:Q8_0', 'hf.co/owner/Model', 'hf.co/owner/Model:%2e%2e%2fsecret.gguf'])('does not guess a remote source for %s', async modelId => {
    await expect(resolveRecoveryDownload({ modelId, signal: new AbortController().signal })).rejects.toThrow();
    expect(calls.inspect).not.toHaveBeenCalled(); expect(calls.folder).not.toHaveBeenCalled();
  });
  it('does not overwrite a different interrupted download or hide permission failures', async () => {
    calls.journal.mockResolvedValueOnce({ selection: { repository: catalog.repository, revision: 'a'.repeat(40), files: [{ path: 'Other.gguf', size: 256 }] } });
    await expect(resolveRecoveryDownload({ modelId, signal: new AbortController().signal })).rejects.toThrow();
    calls.journal.mockRejectedValueOnce(new DOMException('denied', 'NotAllowedError'));
    await expect(resolveRecoveryDownload({ modelId, signal: new AbortController().signal })).rejects.toThrow();
    expect(calls.inspect).not.toHaveBeenCalled();
  });
  it('rejects changed repositories and removed exact variants', async () => {
    calls.inspect.mockResolvedValueOnce({ ...catalog, repository: 'other/Model' });
    await expect(resolveRecoveryDownload({ modelId, signal: new AbortController().signal })).rejects.toThrow('repository changed');
    calls.inspect.mockResolvedValueOnce({ ...catalog, models: [catalog.models[0]!] });
    await expect(resolveRecoveryDownload({ modelId, signal: new AbortController().signal })).rejects.toThrow();
  });
  it('stops before discovery if cancelled during a local journal read', async () => {
    const controller = new AbortController(); const gate = Promise.withResolvers<never>(); calls.journal.mockReturnValueOnce(gate.promise);
    const pending = resolveRecoveryDownload({ modelId, signal: controller.signal });
    controller.abort(); gate.reject(new DOMException('missing', 'NotFoundError'));
    await expect(pending).rejects.toThrow(); expect(calls.inspect).not.toHaveBeenCalled();
  });
});
