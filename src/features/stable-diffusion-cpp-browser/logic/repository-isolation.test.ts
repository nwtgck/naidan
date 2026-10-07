// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { hostModelHandles, type HostModelDirectoryHandle } from '@/00-storage/service/host-model-handles';
import { MemoryDirectory } from '@/features/stable-diffusion-cpp-browser/test-utils/storage';
import { listHostImageRepositories, listImageRepositories } from './repository-store';
import { createInventoryWorker } from '@/features/stable-diffusion-cpp-browser/inventory-worker/impl';
import { ggufFixture, zImageTensors } from '@/features/stable-diffusion-cpp-browser/test-utils/weights';

vi.mock('@/00-storage/service/host-model-handles', () => ({ hostModelHandles: { get: vi.fn() } }));
let root: MemoryDirectory;

beforeEach(() => {
  root = new MemoryDirectory('root');
  vi.stubGlobal('navigator', { storage: { getDirectory: async () => root } });
  vi.mocked(hostModelHandles.get).mockResolvedValue(root as unknown as HostModelDirectoryHandle);
});

afterEach(() => {
  vi.restoreAllMocks(); vi.unstubAllGlobals();
});

describe.each(['opfs', 'host'] as const)('%s repository failure isolation', kind => {
  async function fixtures() {
    let parent = root;
    for (const name of kind === 'opfs' ? ['models', 'user'] : ['owner']) parent = await parent.getDirectoryHandle(name, { create: true });
    const bad = await parent.getDirectoryHandle('bad', { create: true });
    await bad.getFileHandle('already-read.gguf', { create: true });
    const unreadable = await bad.getFileHandle('unreadable.gguf', { create: true });
    const good = await parent.getDirectoryHandle('good', { create: true });
    await good.getFileHandle('model.gguf', { create: true });
    return { bad, unreadable, good };
  }
  function list({ signal }: { signal: AbortSignal | undefined }) {
    return kind === 'opfs' ? listImageRepositories({ signal }) : listHostImageRepositories({ directories: [{ id: 'linked', name: 'Models' }], signal });
  }
  const prefix = kind === 'opfs' ? 'user' : 'host/linked/owner';

  it.each(['NotReadableError', 'NotFoundError'])('keeps a readable sibling when getFile fails with %s', async name => {
    const { unreadable } = await fixtures();
    vi.spyOn(unreadable, 'getFile').mockRejectedValue(new DOMException('Source file is unavailable', name));
    const result = await list({ signal: undefined });
    expect(result.map(repo => repo.id)).toEqual([`${prefix}/bad`, `${prefix}/good`]);
    expect(result[0]?.files).toEqual([]);
    expect(result[0]?.issues).toEqual([{ path: '', message: 'Source file is unavailable' }]);
    expect(result[1]?.files.map(file => file.path)).toEqual(['model.gguf']);
  });

  it('reports unsafe paths without exposing the partially read repository', async () => {
    const { bad } = await fixtures();
    await bad.getFileHandle('bad\\name.gguf', { create: true });
    const result = await list({ signal: undefined });
    expect(result[0]?.files).toEqual([]);
    expect(result[0]?.issues?.[0]?.message).toContain('Unsafe path');
    expect(result[1]?.id).toBe(`${prefix}/good`);
  });

  it('keeps the path nesting limit and does not return partial files', async () => {
    const { bad } = await fixtures();
    let folder = bad;
    for (let index = 0; index < 65; index++) folder = await folder.getDirectoryHandle('nested', { create: true });
    const result = await list({ signal: undefined });
    expect(result[0]?.files).toEqual([]);
    expect(result[0]?.issues?.[0]?.message).toContain('Unsafe path');
    expect(result[1]?.id).toBe(`${prefix}/good`);
  });

  it('keeps the repository entry limit and continues with the next repository', async () => {
    const { bad } = await fixtures();
    vi.spyOn(bad, 'entries').mockImplementation(async function* () {
      for (let index = 0; index <= 20_000; index++) yield [String(index), new MemoryDirectory(String(index))];
    });
    const result = await list({ signal: undefined });
    expect(result[0]?.files).toEqual([]);
    expect(result[0]?.issues?.[0]?.message).toContain('too many entries');
    expect(result[1]?.id).toBe(`${prefix}/good`);
  });

  it.each(['signal', 'filesystem'] as const)('propagates cancellation from %s without visiting another repository', async source => {
    const { unreadable, good } = await fixtures();
    const controller = new AbortController(), error = new DOMException('Inspection stopped', 'AbortError');
    vi.spyOn(unreadable, 'getFile').mockImplementation(async () => {
      if (source === 'signal') controller.abort(error);
      throw error;
    });
    const nextRead = vi.spyOn(good, 'entries');
    await expect(list({ signal: controller.signal })).rejects.toBe(error);
    expect(nextRead).not.toHaveBeenCalled();
  });
});

it('continues through the inventory worker from an unreadable OPFS repository to a valid host model', async () => {
  let broken = root;
  for (const name of ['models', 'user', 'broken']) broken = await broken.getDirectoryHandle(name, { create: true });
  const unreadable = await broken.getFileHandle('weights.gguf', { create: true });
  vi.spyOn(unreadable, 'getFile').mockRejectedValue(new DOMException('OPFS file is unavailable', 'NotReadableError'));
  const host = new MemoryDirectory('host');
  const good = await (await host.getDirectoryHandle('owner', { create: true })).getDirectoryHandle('good', { create: true });
  const handle = await good.getFileHandle('weights.gguf', { create: true });
  const fixture = ggufFixture({ name: 'weights.gguf', tensors: zImageTensors, metadata: {}, extraBytes: 0 });
  vi.spyOn(handle, 'getFile').mockResolvedValue(fixture.file);
  vi.mocked(hostModelHandles.get).mockResolvedValue(host as unknown as HostModelDirectoryHandle);
  const inventory = await createInventoryWorker().inspect(undefined, vi.fn(), [{ id: 'linked', name: 'Models' }]);
  expect(inventory.issues).toEqual([{ repositoryId: 'user/broken', path: '', message: 'OPFS file is unavailable' }]);
  expect(inventory.candidates).toHaveLength(1);
  expect(inventory.candidates[0]).toMatchObject({ repositoryId: 'host/linked/owner/good', family: 'z-image', issue: undefined });
});
