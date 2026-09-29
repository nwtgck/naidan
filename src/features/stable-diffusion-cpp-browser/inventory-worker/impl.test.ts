import { beforeEach, expect, it, vi } from 'vitest';
import { createInventoryWorker } from './impl';
const mocks = vi.hoisted(() => ({ list: vi.fn(), scan: vi.fn() }));
vi.mock('../logic/repository-store', () => ({ listImageRepositories: mocks.list }));
vi.mock('../logic/model-candidates', () => ({ scanImageRepositories: mocks.scan }));
vi.mock('@/utils/worker-transport', () => ({ releaseWorkerRemote: vi.fn() }));
beforeEach(() => {
  vi.resetAllMocks(); mocks.list.mockResolvedValue([]); mocks.scan.mockResolvedValue({ candidates: [], issues: [] });
});
it('lists OPFS before inspecting headers and never reuses the parser realm', async () => {
  const worker = createInventoryWorker();
  await worker.inspect(undefined, vi.fn());
  expect(mocks.list).toHaveBeenCalledOnce(); expect(mocks.scan).toHaveBeenCalledWith(expect.objectContaining({ repositories: [] }));
  await expect(worker.inspect(undefined, vi.fn())).rejects.toThrow('single-use');
});
it('inspects explicitly supplied manual files without touching stored models', async () => {
  const entries = [{ id: 'manual', name: 'manual', files: [{ path: 'renamed.data', file: new File(['x'], 'renamed.data') }] }];
  await createInventoryWorker().inspect(entries, vi.fn());
  expect(mocks.list).not.toHaveBeenCalled(); expect(mocks.scan).toHaveBeenCalledWith(expect.objectContaining({ repositories: entries }));
});
