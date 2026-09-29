// @vitest-environment node
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { hostModelHandles, type HostModelDirectoryHandle } from '@/00-storage/service/host-model-handles';
import { MemoryDirectory } from '@/features/stable-diffusion-cpp-browser/test-utils/storage';
import { ggufFixture, zImageTensors } from '@/features/stable-diffusion-cpp-browser/test-utils/weights';
import { createInventoryWorker } from './impl';

vi.mock('@/00-storage/service/host-model-handles', () => ({ hostModelHandles: { get: vi.fn() } }));
vi.mock('@/utils/worker-transport', () => ({ releaseWorkerRemote: vi.fn() }));

const directories = [{ id: 'linked', name: 'Linked models' }];
let host: MemoryDirectory, opfs: MemoryDirectory;
async function model({ root, path }: { root: MemoryDirectory, path: string[] }): Promise<void> {
  let directory = root;
  for (const name of path) directory = await directory.getDirectoryHandle(name, { create: true });
  const file = await directory.getFileHandle('image.gguf', { create: true });
  vi.spyOn(file, 'getFile').mockResolvedValue(ggufFixture({ name: 'image.gguf', tensors: zImageTensors, metadata: {}, extraBytes: 0 }).file);
}
beforeEach(async () => {
  host = new MemoryDirectory('host'); opfs = new MemoryDirectory('opfs');
  vi.mocked(hostModelHandles.get).mockReset().mockResolvedValue(host as unknown as HostModelDirectoryHandle);
  await model({ root: host, path: ['owner', 'repo'] });
});
afterEach(() => {
  vi.unstubAllGlobals(); vi.restoreAllMocks();
});

it.each(['storage', 'getDirectory'] as const)('inspects linked models when the OPFS %s API is absent', async missing => {
  vi.stubGlobal('navigator', missing === 'storage' ? {} : { storage: {} });
  const result = await createInventoryWorker().inspect(undefined, vi.fn(), directories);
  expect(result.issues).toEqual([]);
  expect(result.candidates).toHaveLength(1);
  expect(result.candidates[0]).toMatchObject({ repositoryId: 'host/linked/owner/repo', family: 'z-image', hostSource: { directoryId: 'linked' } });
});

it('inspects OPFS and linked repositories together when both are available', async () => {
  await model({ root: opfs, path: ['models', 'user', 'local'] });
  vi.stubGlobal('navigator', { storage: { getDirectory: async () => opfs } });
  const result = await createInventoryWorker().inspect(undefined, vi.fn(), directories);
  expect(result.issues).toEqual([]);
  expect(result.candidates.map(candidate => candidate.repositoryId).sort()).toEqual(['host/linked/owner/repo', 'user/local']);
  expect(result.candidates.every(candidate => candidate.family === 'z-image')).toBe(true);
});

it('returns an empty inventory when OPFS is unavailable and no directories are linked', async () => {
  vi.stubGlobal('navigator', {});
  const result = await createInventoryWorker().inspect(undefined, vi.fn());
  expect(result).toEqual({ candidates: [], issues: [] });
  expect(hostModelHandles.get).not.toHaveBeenCalled();
});

it.each(['permission', 'read'] as const)('preserves an existing OPFS %s failure instead of treating it as unavailable', async failure => {
  const cause = failure === 'permission' ? new DOMException('OPFS permission denied', 'NotAllowedError') : new Error('OPFS read failed');
  vi.stubGlobal('navigator', { storage: { getDirectory: vi.fn().mockRejectedValue(cause) } });
  await expect(createInventoryWorker().inspect(undefined, vi.fn(), directories)).rejects.toBe(cause);
  expect(hostModelHandles.get).not.toHaveBeenCalled();
});

it('keeps corrupt OPFS model diagnostics while inspecting an independent linked model', async () => {
  let directory = opfs;
  for (const name of ['models', 'user', 'broken']) directory = await directory.getDirectoryHandle(name, { create: true });
  (await directory.getFileHandle('broken.gguf', { create: true })).data = new Uint8Array([0]);
  vi.stubGlobal('navigator', { storage: { getDirectory: async () => opfs } });
  const result = await createInventoryWorker().inspect(undefined, vi.fn(), directories);
  expect(result.candidates).toHaveLength(1);
  expect(result.candidates[0]?.repositoryId).toBe('host/linked/owner/repo');
  expect(result.issues).toEqual([expect.objectContaining({ repositoryId: 'user/broken', path: 'broken.gguf' })]);
});
