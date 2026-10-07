// @vitest-environment node
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { requestFixture } from '@/features/stable-diffusion-cpp-browser/test-fixtures';
import { finishImageGenerationSnapshot, snapshotImageGeneration } from './snapshot';
import { idToRaw } from '@/01-models/ids';
const mocks = vi.hoisted(() => ({ commit: vi.fn() }));
vi.mock('@/strings', () => ({ ensureStrings: {} }));
vi.mock('@/composables/useGlobalEvents', () => ({ useGlobalEvents: () => ({ addInfoEvent() {}, addErrorEvent() {} }) }));
vi.mock('@/utils/opfs-detection', () => ({ checkOPFSSupport: async () => true }));
vi.mock('@/00-storage/service/image-generation-history', () => ({ saveImageGenerationRecord: mocks.commit, captureImageGenerationHistoryTarget: async () => ({}) }));
import { StorageService } from '@/00-storage/service';
import { OPFSStorageProvider } from '@/00-storage/service/opfs-storage';
import { MemoryStorageProvider } from '@/00-storage/service/memory-storage';

const images = new Map<string, { blob: Blob, name: string }>();
function generation() {
  const snapshot = snapshotImageGeneration({ request: requestFixture(), createdAt: 1, sourceCommit: 'a'.repeat(40), locateFile: ({ file }) => ({ type: 'file', name: file.name, size: file.size, lastModified: file.lastModified }) });
  return finishImageGenerationSnapshot({ snapshot, result: { png: new Blob(['final'], { type: 'image/png' }), width: 256, height: 256, modelVersion: 'test', uniformOutput: false }, previews: [], elapsedMs: 1 });
}
beforeEach(() => {
  images.clear(); mocks.commit.mockReset().mockImplementation(async ({ writeImages }: { writeImages: () => Promise<void> }) => writeImages());
  vi.stubGlobal('navigator', { locks: { request: async (_name: string, callback: () => Promise<unknown>) => callback() } });
  vi.spyOn(OPFSStorageProvider.prototype, 'init').mockResolvedValue();
  vi.spyOn(OPFSStorageProvider.prototype, 'getFile').mockImplementation(async ({ binaryObjectId }) => images.get(idToRaw({ id: binaryObjectId }))?.blob ?? null);
  vi.spyOn(OPFSStorageProvider.prototype, 'getBinaryObject').mockImplementation(async ({ binaryObjectId }) => {
    const image = images.get(idToRaw({ id: binaryObjectId }));
    return image ? { id: binaryObjectId, name: image.name, mimeType: image.blob.type, size: image.blob.size, createdAt: 1 } : null;
  });
  vi.spyOn(OPFSStorageProvider.prototype, 'saveFile').mockImplementation(async ({ binaryObjectId, blob, name }) => {
    images.set(idToRaw({ id: binaryObjectId }), { blob, name });
  });
});
afterEach(() => {
  vi.restoreAllMocks(); vi.unstubAllGlobals();
});

describe('image history public storage operation', () => {
  it('uses the captured OPFS provider even when the active provider changes before byte writes', async () => {
    const service = new StorageService(); await service.init({ type: 'opfs' });
    const wait = Promise.withResolvers<void>(); const entered = Promise.withResolvers<void>();
    mocks.commit.mockImplementationOnce(async ({ writeImages }: { writeImages: () => Promise<void> }) => {
      entered.resolve(); await wait.promise; await writeImages();
    });
    const memoryWrite = vi.spyOn(MemoryStorageProvider.prototype, 'saveFile');
    const source = generation();
    const operation = service.saveImageGeneration(source);
    await entered.promise;
    source.record.request.parameters.prompt = 'mutation after start';
    await service.init({ type: 'memory' }); wait.resolve(); await operation;
    expect(service.getCurrentType()).toBe('memory'); expect(memoryWrite).not.toHaveBeenCalled();
    expect(images.size).toBe(1);
    expect(mocks.commit.mock.calls[0]?.[0].record.request.parameters.prompt).toBe('a small tree');
  });
  it('rejects memory/local storage without writing any image bytes', async () => {
    const service = new StorageService(); await service.init({ type: 'memory' });
    await expect(service.saveImageGeneration(generation())).rejects.toThrow('requires OPFS');
    expect(mocks.commit).not.toHaveBeenCalled(); expect(images.size).toBe(0);
  });
  it('refuses a missing reference and permits immutable identical retries', async () => {
    const service = new StorageService(); await service.init({ type: 'opfs' });
    const source = generation();
    await expect(service.saveImageGeneration({ record: source.record, files: [] })).rejects.toThrow('missing binary');
    await service.saveImageGeneration(source); await service.saveImageGeneration(source);
    expect(OPFSStorageProvider.prototype.saveFile).toHaveBeenCalledTimes(1);
    const file = source.files[0]!;
    await expect(service.saveImageGeneration({ record: source.record, files: [{ ...file, blob: new Blob(['other'], { type: 'image/png' }) }] })).rejects.toThrow('immutable');
    expect(await images.get(idToRaw({ id: file.binaryObjectId }))?.blob.text()).toBe('final');
  });
  it('does not overwrite an existing binary whose body cannot be read', async () => {
    const service = new StorageService(); await service.init({ type: 'opfs' });
    const source = generation(); await service.saveImageGeneration(source);
    vi.mocked(OPFSStorageProvider.prototype.getFile).mockResolvedValueOnce(null);
    await expect(service.saveImageGeneration(source)).rejects.toThrow('missing or unreadable');
    expect(OPFSStorageProvider.prototype.saveFile).toHaveBeenCalledTimes(1);
  });
  it('rejects duplicate and unreferenced input files before writing them', async () => {
    const service = new StorageService(); await service.init({ type: 'opfs' });
    const source = generation();
    await expect(service.saveImageGeneration({ record: source.record, files: [...source.files, ...source.files] })).rejects.toThrow('unique record references');
    expect(images.size).toBe(0);
    const other = generation();
    await expect(service.saveImageGeneration({ record: source.record, files: other.files })).rejects.toThrow('unique record references');
    expect(images.size).toBe(0);
  });
});


it('pins the direct save writer before a provider change, including every retry', async () => {
  const service = new StorageService(); await service.init({ type: 'opfs' });
  const writer = service.createImageGenerationHistoryWriter(); await writer.ready();
  const source = generation();
  mocks.commit.mockRejectedValueOnce(new Error('full'));
  await expect(writer.save(source)).rejects.toThrow('full');
  await service.init({ type: 'memory' });
  const memoryWrite = vi.spyOn(MemoryStorageProvider.prototype, 'saveFile');
  await writer.save(source);
  expect(memoryWrite).not.toHaveBeenCalled(); expect(images.size).toBe(1);
});
