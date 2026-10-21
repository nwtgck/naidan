import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createInventoryWorker } from './impl';
import { releaseWorkerRemote } from '@/utils/worker-transport';
const mocks = vi.hoisted(() => ({ list: vi.fn(), host: vi.fn(), scan: vi.fn() }));
vi.mock('../logic/repository-store', () => ({ listImageRepositories: mocks.list, listHostImageRepositories: mocks.host }));
vi.mock('../logic/model-candidates', () => ({ scanImageRepositories: mocks.scan }));
vi.mock('@/utils/worker-transport', () => ({ releaseWorkerRemote: vi.fn() }));

beforeEach(() => {
  vi.resetAllMocks();
  mocks.list.mockResolvedValue([]);
  mocks.host.mockResolvedValue([]);
  mocks.scan.mockResolvedValue({ candidates: [], issues: [] });
  vi.stubGlobal('navigator', { storage: { getDirectory: vi.fn() } });
});

afterEach(() => vi.unstubAllGlobals());

it('lists OPFS before inspecting headers and never reuses the parser realm', async () => {
  const worker = createInventoryWorker();
  await worker.inspect(undefined, vi.fn());
  expect(mocks.list).toHaveBeenCalledOnce();
  expect(mocks.scan).toHaveBeenCalledWith(expect.objectContaining({ repositories: [] }));
  await expect(worker.inspect(undefined, vi.fn())).rejects.toThrow('single-use');
});

it('inspects explicitly supplied manual files without touching stored models', async () => {
  const entries = [{ repositoryKey: 'manual', repositoryLabel: 'manual', files: [{ relativePath: 'renamed.data', file: new File(['x'], 'renamed.data') }] }];
  await createInventoryWorker().inspect(entries, vi.fn());
  expect(mocks.list).not.toHaveBeenCalled();
  expect(mocks.scan).toHaveBeenCalledWith(expect.objectContaining({ repositories: entries }));
});

it('releases the reporting proxy when rejecting an invalid targeted inspection', async () => {
  const report = vi.fn();
  await expect(createInventoryWorker().inspect(undefined, report, undefined, ['host/invalid'])).rejects.toThrow('Only OPFS');
  expect(releaseWorkerRemote).toHaveBeenCalledWith({ remote: report });
  expect(mocks.list).not.toHaveBeenCalled();
  expect(mocks.scan).not.toHaveBeenCalled();
});

it('adds temporary repositories to OPFS and linked repositories instead of replacing them', async () => {
  const saved = { repositoryKey: 'user/saved', repositoryLabel: 'saved', files: [] };
  const linked = { repositoryKey: 'host/root/owner/repo', repositoryLabel: 'linked', files: [] };
  const temporary = { repositoryKey: 'temp/shared', repositoryLabel: 'shared', files: [{ relativePath: 'nested/model.gguf', file: new File(['x'], 'model.gguf') }] };
  mocks.list.mockResolvedValue([saved]);
  mocks.host.mockResolvedValue([linked]);
  await createInventoryWorker().inspect(undefined, vi.fn(), [{ directoryId: 'root', directoryName: 'models' }], undefined, [temporary]);
  expect(mocks.scan).toHaveBeenCalledWith(expect.objectContaining({ repositories: [saved, linked, temporary] }));
});

it('routes mixed targeted scans without sending temporary paths to the OPFS store', async () => {
  const temporary = { repositoryKey: 'temp/shared', repositoryLabel: 'shared', files: [] };
  const saved = { repositoryKey: 'user/saved', repositoryLabel: 'saved', files: [] };
  mocks.list.mockResolvedValue([saved]);
  await createInventoryWorker().inspect(undefined, vi.fn(), undefined, [saved.repositoryKey, temporary.repositoryKey], [temporary]);
  expect(mocks.list).toHaveBeenCalledWith(expect.objectContaining({ repositoryKeys: ['user/saved'] }));
  expect(mocks.scan).toHaveBeenCalledWith(expect.objectContaining({ repositories: [saved, temporary] }));
});

it('inspects temporary roots without OPFS and never persists File references', async () => {
  vi.stubGlobal('navigator', {});
  const temporary = { repositoryKey: 'temp/shared', repositoryLabel: 'shared', files: [] };
  await createInventoryWorker().inspect(undefined, vi.fn(), undefined, [temporary.repositoryKey], [temporary]);
  expect(mocks.list).not.toHaveBeenCalled();
  expect(mocks.scan).toHaveBeenCalledWith(expect.objectContaining({ repositories: [temporary] }));
});

it('rejects malformed temporary roots even on the separate additional-repository input', async () => {
  await expect(createInventoryWorker().inspect(undefined, vi.fn(), undefined, undefined, [{ repositoryKey: 'temp/../escape', repositoryLabel: 'bad', files: [] }])).rejects.toThrow();
  expect(mocks.scan).not.toHaveBeenCalled();
});
