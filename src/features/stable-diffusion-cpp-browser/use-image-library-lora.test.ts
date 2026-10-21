// @vitest-environment node
import { afterEach, expect, it, vi } from 'vitest';
import { effectScope } from 'vue';
import { useImageLibrary } from './use-image-library';
import { importImageRepository, listImageRepositories, listHostImageRepositories } from './logic/repository-store';
import { scanImageRepositories } from './logic/model-candidates';
import { safetensorsFixture, tensor } from './test-utils/weights.test-support';
import { MemoryDirectory } from './test-utils/storage.test-support';
import { imageLoraRequests } from './lora-form';

const mocks = vi.hoisted(() => ({ get: vi.fn() }));
vi.mock('@/00-storage/service/host-model-handles', () => ({ hostModelHandles: { get: mocks.get } }));

afterEach(() => vi.unstubAllGlobals());

it('offers an adapter-only OPFS import and markerless host files separately without selecting any adapter', async () => {
  const root = new MemoryDirectory('opfs');
  vi.stubGlobal('navigator', { storage: { getDirectory: async () => root }, locks: { request: async (_name: string, _options: unknown, run: () => Promise<unknown>) => run() } });
  const fixture = safetensorsFixture({ name: 'style.safetensors', tensors: ['layer.lora_A.weight', 'layer.lora_B.weight'].map(name => tensor({ name, shape: [4, 8] })) }).file;
  const file = new File([await fixture.slice(0, fixture.size).arrayBuffer()], fixture.name);
  await importImageRepository({ input: { rootName: 'adapters', files: [{ relativePath: `styles/${file.name}`, file }] }, signal: undefined, onProgress() {} });
  const host = new MemoryDirectory('host');
  const folder = await (await (await host.getDirectoryHandle('owner', { create: true })).getDirectoryHandle('adapters', { create: true })).getDirectoryHandle('styles', { create: true });
  const writer = await (await folder.getFileHandle(file.name, { create: true })).createWritable();
  await writer.write(new Uint8Array(await file.arrayBuffer()));
  await writer.close();
  mocks.get.mockResolvedValue(host);
  const list = async () => [...await listImageRepositories({ signal: undefined }), ...await listHostImageRepositories({ directories: [{ directoryId: 'one', directoryName: 'first-root' }, { directoryId: 'two', directoryName: 'second-root' }], signal: undefined })];
  const scope = effectScope();
  const library = scope.run(() => useImageLibrary({ downloadsBlocked: () => false, blocked: () => false, onSelection: vi.fn(), dependencies: { list, scan: scanImageRepositories, import: importImageRepository, download: vi.fn() } }))!;
  using _cleanupResource = {
    [Symbol.dispose]() {
      scope.stop();
    },
  };
  await library.refresh();
  const saved = library.savedLoras.value;
  expect(library.failure.value).toBe('');
  expect(library.issues.value).toEqual([]);
  expect(saved).toHaveLength(3);
  expect(new Set(saved.map(item => item.candidateKey)).size).toBe(3);
  expect(saved.map(item => item.detail)).toEqual(expect.arrayContaining(['OPFS: user/adapters/styles/style.safetensors', 'Host: first-root/owner/adapters/styles/style.safetensors', 'Host: second-root/owner/adapters/styles/style.safetensors']));
  expect(library.selectedCandidateKey.value).toBe('');
  expect(library.selectedModels()).toBeUndefined();
  expect(library.benchmarkTargets({ selections: {} })).toEqual([]);
  library.showAll.value = true;
  expect(library.models.value).toEqual([]);
  const selected = saved[0]!;
  const requests = imageLoraRequests({ selections: [{ file: selected.file, relativePath: selected.relativePath, locationLabel: selected.detail, strength: 0.7, enabled: true }] });
  expect(requests[0]?.file).toBe(selected.file);
  expect(requests[0]?.relativePath).toBe('styles/style.safetensors');
  expect(requests[0]).not.toHaveProperty('locationLabel');
  await library.refresh();
  expect(requests[0]?.file).toBe(selected.file);
  expect(library.savedLoras.value.find(item => item.candidateKey === selected.candidateKey)?.file).not.toBe(selected.file);
  expect([...folder.children.keys()]).toEqual([file.name]);
});
