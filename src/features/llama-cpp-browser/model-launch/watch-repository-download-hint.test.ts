import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { flushPromises } from '@vue/test-utils';
import { shallowRef } from 'vue';
import { downloadJobKey, type DownloadJob } from '@/features/llama-cpp-browser/hugging-face/download-queue';
import { repositoryDefaultDownloadKey } from '@/features/llama-cpp-browser/hugging-face/repository-row-download';
import { selectionSchema } from '@/features/llama-cpp-browser/hugging-face/types';
import { selectionKey } from '@/features/llama-cpp-browser/hugging-face/download-plan';
import type { installedRepositoryVariant, installedSelection } from '@/features/llama-cpp-browser/hugging-face/storage';
import { hostModelDirectoryRegistrationChangeEvent } from '@/logic/host-model-directories';
import { bundledRepositoryDownloadKey, type RepositoryModelSelection } from './bundled-repository-target';
import { watchRepositoryDownloadHint } from './watch-repository-download-hint';

const jobs = shallowRef<DownloadJob[]>([]);
const changed = shallowRef(0);
const mocks = vi.hoisted(() => ({
  verify: vi.fn<typeof installedSelection>(),
  inspect: vi.fn<typeof installedRepositoryVariant>(),
  notifyFiles: undefined as (() => void) | undefined,
}));
vi.mock('@/features/llama-cpp-browser/hugging-face/download-queue', async importOriginal => ({
  ...await importOriginal<typeof import('@/features/llama-cpp-browser/hugging-face/download-queue')>(),
  getDownloadQueue: () => ({ jobs, changed }),
}));
vi.mock('@/features/llama-cpp-browser/hugging-face/storage', () => ({ installedSelection: mocks.verify, installedRepositoryVariant: mocks.inspect }));
vi.mock('@/features/llama-cpp-browser/model-files', () => ({
  llamaCppBrowserModelFiles: {
    subscribeModelList: ({ listener }: { listener: () => void }) => {
      mocks.notifyFiles = listener;
      return () => {
        mocks.notifyFiles = undefined;
      };
    },
  },
}));

const repository = 'demo/Model-GGUF';
const variant = 'Q4_K_M';
const modelId = `hf.co/${repository}:${variant}`;
const main = { path: 'Model-Q4_K_M.gguf', size: 300 };
const plan = selectionSchema.parse({ repository, revision: 'a'.repeat(40), files: [main] });
const selection: RepositoryModelSelection = {
  source: { kind: 'bundled', repository, variant, companionPath: undefined },
  modelId,
  destination: { kind: 'opfs' },
  authorizeDestination: undefined,
};
const usage = 'translation';
const request: DownloadJob = {
  id: 1,
  key: downloadJobKey({ key: bundledRepositoryDownloadKey({ repository, variant, companionPath: undefined }), destination: selection.destination }),
  repository,
  source: 'suggestion',
  destination: selection.destination,
  status: 'downloading',
  selection: plan,
  progress: undefined,
  error: undefined,
};
let stop: (() => void) | undefined;

beforeEach(() => {
  jobs.value = [];
  mocks.verify.mockReset();
  mocks.inspect.mockReset();
});

afterEach(() => stop?.());

it('hides the first-use hint after download and restores it when the saved files are removed', async () => {
  const update = vi.fn();
  stop = watchRepositoryDownloadHint({ selection, usage, update });
  await flushPromises();
  expect(update).toHaveBeenLastCalledWith({ hidden: false });
  jobs.value = [request];
  await flushPromises();
  expect(update).toHaveBeenLastCalledWith({ hidden: true });
  mocks.verify.mockResolvedValueOnce({ modelId, size: main.size, importedAt: 0 });
  jobs.value = [{ ...request, status: 'complete' }];
  await flushPromises();
  expect(mocks.verify).toHaveBeenCalledExactlyOnceWith({ selection: plan, destination: selection.destination });
  expect(update).toHaveBeenLastCalledWith({ hidden: true });
  mocks.notifyFiles?.();
  await flushPromises();
  expect(update).toHaveBeenLastCalledWith({ hidden: false });
});

it('keeps the hint for a different variant or a different linked folder', async () => {
  const update = vi.fn();
  stop = watchRepositoryDownloadHint({ selection, usage, update });
  const searchKey = repositoryDefaultDownloadKey({ repository, usage });
  const destination = { kind: 'host', directoryId: 'some-folder' } as const;
  jobs.value = [
    { ...request, id: 2, status: 'complete', key: downloadJobKey({ key: searchKey, destination }), destination },
    { ...request, id: 3, status: 'complete', key: downloadJobKey({ key: searchKey, destination: selection.destination }), selection: { ...plan, files: [{ ...main, path: 'Model-Q8_0.gguf' }] } },
  ];
  await flushPromises();
  expect(mocks.verify).not.toHaveBeenCalled();
  expect(update).toHaveBeenLastCalledWith({ hidden: false });
});

it('rechecks saved files when a linked folder is reconnected', async () => {
  const update = vi.fn();
  const destination = { kind: 'host', directoryId: 'linked-folder' } as const;
  stop = watchRepositoryDownloadHint({ selection: { ...selection, destination }, usage, update });
  await flushPromises();
  expect(update).toHaveBeenLastCalledWith({ hidden: false });
  mocks.inspect.mockResolvedValueOnce({ modelId: `host/Folder/${repository}:${variant}`, size: main.size, importedAt: 0 });
  window.dispatchEvent(new Event(hostModelDirectoryRegistrationChangeEvent));
  await flushPromises();
  expect(mocks.inspect).toHaveBeenLastCalledWith(expect.objectContaining({ repository, variant, destination }));
  expect(update).toHaveBeenLastCalledWith({ hidden: true });
});

it('rechecks a bundled choice after the configuration downloads under a resolved file key', async () => {
  const update = vi.fn();
  stop = watchRepositoryDownloadHint({ selection, usage, update });
  await flushPromises();
  expect(update).toHaveBeenLastCalledWith({ hidden: false });
  mocks.inspect.mockResolvedValueOnce({ modelId, size: main.size, importedAt: 0 });
  jobs.value = [{ ...request, source: 'repository', key: downloadJobKey({ key: selectionKey({ selection: plan }), destination: selection.destination }), status: 'complete' }];
  changed.value++;
  await flushPromises();
  expect(update).toHaveBeenLastCalledWith({ hidden: true });
  window.dispatchEvent(new Event('focus'));
  await flushPromises();
  expect(update).toHaveBeenLastCalledWith({ hidden: false });
});
