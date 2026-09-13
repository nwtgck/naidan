import { afterAll, afterEach, beforeEach, expect, it, vi } from 'vitest';
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import { ensureAllStringsForTest } from '@/strings/test-utils';
import { transformersJsService } from '..';
import type { DownloadProgressCallback } from '@/features/transformers-js/download-progress';
import TransformersJsManager from './TransformersJsManager.vue';

const preparation = vi.hoisted(() => ({ resolve: vi.fn(), reuse: vi.fn(), run: vi.fn(), dispose: vi.fn() }));
vi.mock('../download-verification/logic/resolve-public-hugging-face-revision', () => ({ resolvePublicHuggingFaceRevision: preparation.resolve }));
vi.mock('../download-verification/logic/reuse-downloaded-production-revision', () => ({ reuseDownloadedProductionRevision: preparation.reuse }));
vi.mock('../download-verification/logic/run-production-download-preparation', () => ({ runProductionDownloadPreparation: preparation.run }));
vi.mock('..', async () => {
  const { createTransformersJsService } = await import('@/features/transformers-js/index-hosted');
  const owner = createTransformersJsService({ createWorkerClient: () => {
    throw new Error('This UI control must not create an inference Worker');
  } });
  preparation.dispose.mockImplementation(owner.dispose);
  return { transformersJsService: owner.service };
});
vi.mock('@/utils/opfs-detection', () => ({ checkOPFSSupport: async () => true }));
vi.mock('@/features/transformers-js/model-support-investigation', () => ({ isModelSupportInvestigationAvailable: false }));

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((fulfill, fail) => {
    resolve = fulfill; reject = fail;
  });
  return { promise, resolve, reject };
}

let wrapper: VueWrapper | undefined;
beforeEach(async () => {
  await ensureAllStringsForTest({ locale: 'en' });
  vi.stubGlobal('__BUILD_MODE_IS_STANDALONE__', false);
  vi.stubGlobal('fetch', vi.fn(() => {
    throw new Error('UI controls forbid network access');
  }));
  vi.spyOn(transformersJsService, 'listCachedModels').mockResolvedValue([]);
  preparation.resolve.mockResolvedValue({ normalizedModelId: 'fixture/model', requestedRevision: 'main', resolvedRevision: 'a'.repeat(40) });
  preparation.reuse.mockResolvedValue({ reused: false });
});
afterEach(() => {
  wrapper?.unmount();
  wrapper = undefined;
  expect(fetch).not.toHaveBeenCalled();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
afterAll(async () => {
  await preparation.dispose();
});

// Revision/preparation are explicitly synthetic controls. The service, progress
// tracker, subscription and Vue rendering are real; this is not model evidence.
it('renders initial zero before revision resolution and every planned row before any transfer event', async () => {
  const revision = deferred<{ resolvedRevision: string }>();
  const entered = deferred<DownloadProgressCallback>();
  const finish = deferred<{ status: 'accepted' }>();
  preparation.resolve.mockReturnValueOnce(revision.promise);
  preparation.run.mockImplementationOnce(({ onDownloadProgress }: { onDownloadProgress: DownloadProgressCallback }) => {
    entered.resolve(onDownloadProgress);
    return finish.promise;
  });
  wrapper = mount(TransformersJsManager);
  await flushPromises();
  const running = transformersJsService.downloadModel({ modelId: 'fixture/model' });
  try {
    await flushPromises();
    expect(wrapper.get('[data-testid="download-overall-progress"]').text()).toBe('0%');
    expect(wrapper.text()).toContain('Resolving revision');
    revision.resolve({ resolvedRevision: 'a'.repeat(40) });
    const observe = await entered.promise;
    observe({ event: { kind: 'candidate', index: 0, count: 2, candidate: { device: 'wasm', dtype: 'q4' } } });
    observe({ event: { kind: 'plan', index: 0, paths: ['onnx/model.onnx', 'onnx/model.onnx_data'] } });
    await flushPromises();
    const rows = wrapper.findAll('[data-testid="download-file-row"]');
    expect(rows).toHaveLength(2);
    expect(rows[0]!.text()).toContain('onnx/model.onnx');
    expect(rows[1]!.text()).toContain('onnx/model.onnx_data');
    expect(rows.every(row => row.text().includes('Queued') && row.text().includes('Unknown'))).toBe(true);
    expect(wrapper.text()).toContain('Candidate 1 of 2');
    expect(wrapper.text()).toContain('not a remaining-time estimate');
  } finally {
    revision.resolve({ resolvedRevision: 'a'.repeat(40) });
    finish.resolve({ status: 'accepted' });
    await running;
  }
});

it('keeps actual file percentages separate from overall work and retains saving and terminal rows', async () => {
  const entered = deferred<DownloadProgressCallback>();
  const finish = deferred<{ status: 'accepted' }>();
  preparation.run.mockImplementationOnce(({ onDownloadProgress }: { onDownloadProgress: DownloadProgressCallback }) => {
    entered.resolve(onDownloadProgress);
    return finish.promise;
  });
  wrapper = mount(TransformersJsManager);
  await flushPromises();
  const running = transformersJsService.downloadModel({ modelId: 'fixture/model' });
  try {
    const observe = await entered.promise;
    observe({ event: { kind: 'candidate', index: 0, count: 2, candidate: { device: 'wasm', dtype: 'q4' } } });
    observe({ event: { kind: 'plan', index: 0, paths: ['onnx/model.onnx', 'onnx/model.onnx_data'] } });
    observe({ event: { kind: 'file', index: 0, info: { status: 'progress', file: 'onnx/model.onnx', loaded: 9, total: 10 } } });
    await flushPromises();
    expect(wrapper.get('[data-testid="download-file-row"]').text()).toContain('90%');
    expect(wrapper.get('[data-testid="download-overall-progress"]').text()).toBe('27%');
    observe({ event: { kind: 'file', index: 0, info: { status: 'saving', file: 'onnx/model.onnx', loaded: 10, total: 10 } } });
    observe({ event: { kind: 'file', index: 0, info: { status: 'cached', file: 'onnx/model.onnx_data', loaded: 20, total: 20 } } });
    await flushPromises();
    expect(wrapper.findAll('[data-testid="download-file-row"]')[0]!.text()).toContain('Saving');
    expect(wrapper.findAll('[data-testid="download-file-row"]')[1]!.text()).toContain('Cached');
    expect(wrapper.get('[data-testid="download-byte-summary"]').text()).toContain('Received: 10.0 B');
    expect(wrapper.get('[data-testid="download-byte-summary"]').text()).toContain('Cached: 20.0 B');
    observe({ event: { kind: 'file', index: 0, info: { status: 'done', file: 'onnx/model.onnx', loaded: 10, total: 10 } } });
    observe({ event: { kind: 'acceptance', index: 0 } });
    await flushPromises();
    expect(wrapper.text()).toContain('Checking model usability');
    expect(wrapper.get('[data-testid="download-overall-progress"]').text()).not.toBe('100%');
    finish.resolve({ status: 'accepted' });
    await running;
    await flushPromises();
    expect(wrapper.get('[data-testid="download-overall-progress"]').text()).toBe('100%');
    expect(wrapper.findAll('[data-testid="download-file-row"]')).toHaveLength(2);
    expect(wrapper.get('[data-testid="download-file-row"]').text()).toContain('Complete');
  } finally {
    finish.resolve({ status: 'accepted' });
    await running;
  }
});

it('retains a failed file with a nonpositive unknown length and does not turn failure into full completion', async () => {
  const entered = deferred<DownloadProgressCallback>();
  const finish = deferred<never>();
  preparation.run.mockImplementationOnce(({ onDownloadProgress }: { onDownloadProgress: DownloadProgressCallback }) => {
    entered.resolve(onDownloadProgress);
    return finish.promise;
  });
  wrapper = mount(TransformersJsManager);
  await flushPromises();
  const failure = new Error('Synthetic storage failure');
  const running = transformersJsService.downloadModel({ modelId: 'fixture/model' });
  const result = running.catch(error => error);
  try {
    const observe = await entered.promise;
    observe({ event: { kind: 'candidate', index: 0, count: 2, candidate: { device: 'wasm', dtype: 'q4' } } });
    observe({ event: { kind: 'plan', index: 0, paths: ['onnx/model.onnx'] } });
    observe({ event: { kind: 'file', index: 0, info: { status: 'error', file: 'onnx/model.onnx', loaded: 3, total: 0 } } });
    finish.reject(failure);
    expect(await result).toBe(failure);
    await flushPromises();
    expect(wrapper.get('[data-testid="download-file-row"]').text()).toContain('Error');
    expect(wrapper.get('[data-testid="download-file-row"]').text()).toContain('Unknown');
    expect(wrapper.get('[data-testid="download-file-row"]').text()).toContain('3.0 B / Unknown');
    expect(wrapper.get('[data-testid="download-file-row"]').find('[role="progressbar"]').exists()).toBe(false);
    expect(wrapper.get('[data-testid="download-progress"]').text()).toContain('Synthetic storage failure');
    expect(wrapper.get('[data-testid="download-overall-progress"]').text()).not.toBe('100%');
    await wrapper.get('[data-testid="dismiss-download-failure"]').trigger('click');
    expect(wrapper.find('[data-testid="download-progress"]').exists()).toBe(false);
    expect(transformersJsService.getState().downloadProgress?.phase).toBe('failed');
  } finally {
    finish.reject(failure);
    await result;
  }
});

it('preserves the existing Load view when Download progress is absent', async () => {
  // Only this legacy-view control supplies a service-state stub; it does not
  // claim that a real model has been loaded.
  const state = transformersJsService.getState();
  vi.spyOn(transformersJsService, 'getState').mockReturnValue({
    ...state, status: 'loading', progress: 45, downloadProgress: undefined,
    error: undefined, isLoadingFromCache: true,
  });
  wrapper = mount(TransformersJsManager);
  expect(wrapper.find('[data-testid="download-progress"]').exists()).toBe(false);
  expect(wrapper.text()).toContain('Initializing Engine...');
  expect(wrapper.text()).toContain('45%');
  expect(wrapper.get('.bg-blue-600').attributes('style')).toContain('width: 45%');
});
