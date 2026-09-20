import { openSyncAccess } from './sync-access';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDownloadWriter } from './writer';
import { ggufBytes, memoryDirectory } from './test-opfs';
import { listHuggingFaceModels, readJournal, repositoryFolder, selectedFile, resolveRepositoryModel } from './storage';
import { cancelDownload } from './download';
import { planStoredModelRemoval, prepareModelRemoval, removeStoredModel } from '@/features/llama-cpp-browser/runtime/model-store';
import { quantizationChoices } from './presentation';
import { groupModelFiles } from './catalog';
import type { DownloadSelection } from './types';
vi.mock('@/utils/worker-transport', () => ({ releaseWorkerRemote: vi.fn() }));
const repository = 'owner/Model-GGUF'; const revision = 'a'.repeat(40);
const projector = { path: 'mmproj-Q8_0.gguf', size: 128 };
const selection = ({ quant }: { quant: string }): DownloadSelection => ({ repository, revision, files: [{ path: `Model-${quant}.gguf`, size: 128 }, projector] });
beforeEach(() => {
  const root = memoryDirectory({ name: '' });
  vi.stubGlobal('navigator', { storage: { getDirectory: async () => root }, locks: {
    request: async (_name: string, optionsOrCallback: object | (() => Promise<unknown>), callback?: (lock: object) => Promise<unknown>) => callback ? callback({}) : typeof optionsOrCallback === 'function' ? optionsOrCallback() : undefined,
  } });
});
afterEach(() => vi.unstubAllGlobals());
async function publish({ input }: { input: DownloadSelection }): Promise<void> {
  const writer = createDownloadWriter(); expect(await writer.begin({ selection: input })).toMatchObject({ status: 'ready' });
  for (let fileIndex = 0; fileIndex < input.files.length; fileIndex++) {
    await writer.open({ fileIndex, start: 0 }); await writer.append({ bytes: ggufBytes() }); await writer.finishFile();
  }
  await writer.finish();
}
describe('independent HF variants in one repository', () => {
  it('keeps Q4 available during Q8 download, cancels only owned files, and preserves Q4 identity after Q8 publication', async () => {
    await publish({ input: selection({ quant: 'Q4_K_M' }) });
    const before = await resolveRepositoryModel({ name: `hf.co/${repository}:Q4_K_M` });
    const writer = createDownloadWriter(); expect(await writer.begin({ selection: selection({ quant: 'Q8_0' }) })).toMatchObject({ journal: { reused: [false, true] } });
    await writer.open({ fileIndex: 0, start: 0 }); await writer.append({ bytes: ggufBytes().slice(0, 48) }); await writer.pause();
    expect((await listHuggingFaceModels()).map(model => model.name)).toEqual([`hf.co/${repository}:Q4_K_M`]);
    expect((await resolveRepositoryModel({ name: `hf.co/${repository}:Q4_K_M` })).files.map(file => file.path)).toEqual(before.files.map(file => file.path));
    const plan = await planStoredModelRemoval({ id: `hf.co/${repository}` });
    expect(plan.files.map(file => file.path)).toEqual(['.llama-cpp-import-pending', 'Model-Q8_0.gguf']);
    expect(await cancelDownload({ repository, plan })).toBe('deleted');
    await publish({ input: selection({ quant: 'Q8_0' }) });
    const after = await resolveRepositoryModel({ name: `hf.co/${repository}:Q4_K_M` });
    expect(after.id).toBe(before.id); expect(after.name).toBe(before.name);
    expect(after.files.map(file => [file.path, file.file.size, file.file.lastModified, file.handle])).toEqual(before.files.map(file => [file.path, file.file.size, file.file.lastModified, file.handle]));
    expect((await listHuggingFaceModels()).map(model => model.name)).toEqual([`hf.co/${repository}:Q4_K_M`, `hf.co/${repository}:Q8_0`]);
    await expect(resolveRepositoryModel({ name: `hf.co/${repository}` })).rejects.toThrow('unsupported-input');
  });
  it('keeps a split model selector stable when a same-stem unsplit variant is added', async () => {
    const splitSelection: DownloadSelection = { repository, revision, files: [{ path: 'Model-Q4_K_M-00001-of-00002.gguf', size: 128 }, { path: 'Model-Q4_K_M-00002-of-00002.gguf', size: 128 }, projector] };
    await publish({ input: splitSelection });
    const before = await resolveRepositoryModel({ name: `hf.co/${repository}` });
    expect(before.name).toBe(`hf.co/${repository}:Q4_K_M (split-00002)`);
    await publish({ input: selection({ quant: 'Q4_K_M' }) });
    const after = await resolveRepositoryModel({ name: before.name }); expect(after.id).toBe(before.id); expect(after.files.map(file => file.path)).toEqual(before.files.map(file => file.path));
    expect((await resolveRepositoryModel({ name: `hf.co/${repository}:Q4_K_M` })).files).toHaveLength(2);
  });
  it('verifies shared files byte by byte without overwriting them and restarts verification after pause', async () => {
    await publish({ input: selection({ quant: 'Q4_K_M' }) });
    const writer = createDownloadWriter(); await writer.begin({ selection: selection({ quant: 'Q8_0' }) });
    await writer.open({ fileIndex: 1, start: 0 }); const changed = ggufBytes(); changed[127] = 1;
    await expect(writer.append({ bytes: changed })).rejects.toThrow('Shared projector differs'); await writer.pause();
    const folder = await repositoryFolder({ repository, create: false }); const handle = await selectedFile({ folder, path: projector.path, create: false });
    expect(new Uint8Array(await (await handle.getFile()).arrayBuffer())).toEqual(ggufBytes());
    expect((await readJournal({ folder })).reused).toEqual([false, true]);
    const resumed = createDownloadWriter(); await resumed.begin({ selection: selection({ quant: 'Q8_0' }) });
    await resumed.open({ fileIndex: 1, start: 0 }); await resumed.append({ bytes: ggufBytes().slice(0, 48) }); await resumed.pause();
    expect(await createDownloadWriter().begin({ selection: selection({ quant: 'Q8_0' }) })).toMatchObject({ journal: { bytes: [0, 0], complete: [false, false], reused: [false, true] } });
    expect((await listHuggingFaceModels())[0]?.name).toBe(`hf.co/${repository}:Q4_K_M`);
  });
  it('rejects another projector path before modifying the repository and uses a deterministic external projector preference', async () => {
    await publish({ input: selection({ quant: 'Q4_K_M' }) });
    const conflict = await createDownloadWriter().begin({ selection: { ...selection({ quant: 'Q8_0' }), files: [{ path: 'Model-Q8_0.gguf', size: 128 }, { path: 'mmproj-F16.gguf', size: 128 }] } });
    expect(conflict).toEqual({ status: 'conflict', reason: 'projector-conflict' });
    const folder = await repositoryFolder({ repository, create: false });
    await expect(selectedFile({ folder, path: 'Model-Q8_0.gguf', create: false })).rejects.toMatchObject({ name: 'NotFoundError' });
    const extra = await selectedFile({ folder, path: 'mmproj-BF16.gguf', create: true }); const sync = await openSyncAccess({ handle: extra }); sync.write(ggufBytes(), { at: 0 }); sync.close();
    const loaded = await resolveRepositoryModel({ name: `hf.co/${repository}:Q4_K_M` });
    expect(loaded.projectorPath).toBe('mmproj-Q8_0.gguf'); expect(loaded.files).toHaveLength(2);
  });
  it('deletes only the selected variant and follows the explicit shared-file choice even when another variant uses it', async () => {
    await publish({ input: selection({ quant: 'Q4_K_M' }) }); await publish({ input: selection({ quant: 'Q8_0' }) });
    const q4 = await resolveRepositoryModel({ name: `hf.co/${repository}:Q4_K_M` });
    const request = await prepareModelRemoval({ id: q4.id });
    expect(request.affectedVariants).toBe(1); expect(request.plan.files.map(file => file.path)).toEqual(['Model-Q4_K_M.gguf']);
    expect(request.sharedPlan?.files.map(file => file.path)).toEqual(['Model-Q4_K_M.gguf', 'mmproj-Q8_0.gguf']);
    expect(await removeStoredModel({ plan: request.plan })).toBe('deleted');
    expect((await resolveRepositoryModel({ name: `hf.co/${repository}:Q8_0` })).projectorPath).toBe(projector.path);
    await publish({ input: selection({ quant: 'Q4_K_M' }) });
    const again = await prepareModelRemoval({ id: q4.id }); expect(await removeStoredModel({ plan: again.sharedPlan! })).toBe('deleted');
    expect((await resolveRepositoryModel({ name: `hf.co/${repository}:Q8_0` })).projectorPath).toBeUndefined();
  });
  it('derives distinct variant labels without removing vendor markers and keeps identities stable as files are added', () => {
    const paths = ['Model-Q4_K_M.gguf', 'Model-AWQ-Q4_K_M.gguf', 'Model-QAD-Q4_0.gguf', 'Model-Q4_0.gguf', 'Model-UD-Q4_K_XL-00001-of-00002.gguf', 'Model-UD-Q4_K_XL-00002-of-00002.gguf'];
    const models = groupModelFiles({ files: paths.map(path => ({ path, size: 128 })) }).models;
    const choices = quantizationChoices({ repository, models });
    expect(choices.map(choice => choice.label)).toEqual(['Q4_K_M', 'AWQ-Q4_K_M', 'Q4_0', 'QAD-Q4_0', 'UD-Q4_K_XL']);
    const alone = quantizationChoices({ repository, models: [models[0]!] })[0]!;
    expect(choices.find(choice => choice.id === alone.id)?.label).toBe(alone.label);
    expect(quantizationChoices({ repository, models: groupModelFiles({ files: [{ path: 'Model-UD-Q4_K_XL.gguf', size: 128 }] }).models })[0]?.label).toBe('UD-Q4_K_XL');
  });
});
