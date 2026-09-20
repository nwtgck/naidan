import { prepareModelRemoval } from '@/features/llama-cpp-browser/runtime/model-store';
import { DownloadConflictError } from '@/features/llama-cpp-browser/hugging-face/types';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import { ensureAllStringsForTest } from '@/strings/test-utils';
import { discoverRepository } from '@/features/llama-cpp-browser/hugging-face/catalog';
import { downloadRepository, cancelDownload } from '@/features/llama-cpp-browser/hugging-face/download';
import { listPendingDownloads } from '@/features/llama-cpp-browser/hugging-face/storage';
import LlamaCppBrowserHuggingFaceManager from './LlamaCppBrowserHuggingFaceManager.vue';
vi.mock('@/features/llama-cpp-browser/hugging-face/catalog', () => ({ discoverRepository: vi.fn() }));
vi.mock('@/features/llama-cpp-browser/hugging-face/download', () => ({ downloadRepository: vi.fn(), cancelDownload: vi.fn() }));
vi.mock('@/features/llama-cpp-browser/hugging-face/storage', () => ({ listPendingDownloads: vi.fn() }));
const confirm = vi.hoisted(() => vi.fn());
vi.mock('@/composables/useConfirm', () => ({ useConfirm: () => ({ showConfirm: confirm }) }));
vi.mock('../runtime/model-store', () => ({ prepareModelRemoval: vi.fn() }));
const plan = { id: 'hf.co/owner/repo', files: [{ path: 'model-Q4_K_M.gguf', size: 48, lastModified: 1 }] };
const selection = { repository: 'owner/repo', revision: 'a'.repeat(40), files: [{ path: 'model-Q4_K_M.gguf', size: 128 }] };
const wrappers: VueWrapper[] = [];
function render(): VueWrapper {
  const wrapper = mount(LlamaCppBrowserHuggingFaceManager, { props: { disabled: false } }); wrappers.push(wrapper); return wrapper;
}
beforeEach(async () => {
  vi.resetAllMocks(); confirm.mockResolvedValue(true); vi.mocked(prepareModelRemoval).mockResolvedValue({ plan, sharedPlan: undefined, affectedVariants: 0 }); vi.mocked(cancelDownload).mockResolvedValue('deleted'); vi.mocked(listPendingDownloads).mockResolvedValue([]); await ensureAllStringsForTest({ locale: 'en' });
});
afterEach(() => {
  for (const wrapper of wrappers.splice(0)) wrapper.unmount();
  vi.useRealTimers();
});
describe('Hugging Face download controls', () => {
  it('selects a complete quantization group and an independent optional projector', async () => {
    vi.mocked(discoverRepository).mockResolvedValue({ repository: selection.repository, revision: selection.revision, models: [{ label: 'model-Q4_K_M.gguf', files: selection.files, size: 128 }], projectors: [{ path: 'mmproj-F16.gguf', size: 64 }] });
    const wrapper = render(); await flushPromises();
    await wrapper.get('[data-testid="llama-hf-repository"]').setValue('owner/repo'); await wrapper.get('[data-testid="llama-hf-inspect"]').trigger('click'); await flushPromises();
    expect(wrapper.get('[data-testid="llama-hf-download"]').attributes('disabled')).toBeUndefined();
    expect(wrapper.get<HTMLSelectElement>('[data-testid="llama-hf-model"]').element.value).toBe('model-Q4_K_M.gguf');
    expect(wrapper.get('[data-testid="llama-hf-model"]').text()).toContain('model-Q4_K_M · 0.1 KiB');
    expect(wrapper.get('[data-testid="llama-hf-multimodal"]').attributes('aria-checked')).toBe('true');
    expect(wrapper.get('[data-testid="llama-hf-details"]').text()).toContain('mmproj-F16.gguf');
    expect(wrapper.get('[data-testid="llama-hf-projector"]').text()).toContain('F16 · 0.1 KiB');
    expect(wrapper.get('[data-testid="llama-hf-repository-link"]').attributes('href')).toBe('https://huggingface.co/owner/repo');
    await wrapper.get('[data-testid="llama-hf-download"]').trigger('click'); await flushPromises();
    expect(downloadRepository).toHaveBeenCalledWith(expect.objectContaining({ selection: { ...selection, files: [...selection.files, { path: 'mmproj-F16.gguf', size: 64 }] } }));
    expect(wrapper.emitted('changed')).toHaveLength(1);
  });
  it('keeps an explicit quantization and multimodal OFF when checking the same repository again', async () => {
    const models = ['model-Q8_0.gguf', 'model-Q4_K_M.gguf'].map(path => ({ label: path, files: [{ path, size: 128 }], size: 128 }));
    vi.mocked(discoverRepository).mockResolvedValue({ repository: selection.repository, revision: selection.revision, models, projectors: [{ path: 'mmproj.gguf', size: 64 }] });
    const wrapper = render(); await flushPromises();
    await wrapper.get('[data-testid="llama-hf-repository"]').setValue('owner/repo'); await wrapper.get('[data-testid="llama-hf-inspect"]').trigger('click'); await flushPromises();
    await wrapper.get('[data-testid="llama-hf-model"]').setValue('model-Q8_0.gguf'); await wrapper.get('[data-testid="llama-hf-multimodal"]').trigger('click');
    await wrapper.get('[data-testid="llama-hf-inspect"]').trigger('click'); await flushPromises();
    expect(wrapper.get<HTMLSelectElement>('[data-testid="llama-hf-model"]').element.value).toBe('model-Q8_0.gguf');
    expect(wrapper.get('[data-testid="llama-hf-multimodal"]').attributes('aria-checked')).toBe('false');
    await wrapper.get('[data-testid="llama-hf-download"]').trigger('click'); await flushPromises();
    expect(vi.mocked(downloadRepository).mock.calls[0]?.[0].selection.files).toEqual([{ path: 'model-Q8_0.gguf', size: 128 }]);
  });
  it('keeps distinct variants directly selectable and hides multimodal controls when unavailable', async () => {
    const models = ['base-Q4_K_M.gguf', 'other-Q4_K_M.gguf'].map(path => ({ label: path, files: [{ path, size: 128 }], size: 128 }));
    vi.mocked(discoverRepository).mockResolvedValue({ repository: selection.repository, revision: selection.revision, models, projectors: [] });
    const wrapper = render(); await flushPromises();
    await wrapper.get('[data-testid="llama-hf-repository"]').setValue('owner/repo'); await wrapper.get('[data-testid="llama-hf-inspect"]').trigger('click'); await flushPromises();
    expect(wrapper.get('[data-testid="llama-hf-model"]').text()).toContain('base-Q4_K_M · 0.1 KiB');
    expect(wrapper.find('[data-testid="llama-hf-selection-required"]').exists()).toBe(false);
    expect(wrapper.get('[data-testid="llama-hf-download"]').attributes('disabled')).toBeUndefined();
    expect(wrapper.find('[data-testid="llama-hf-multimodal"]').exists()).toBe(false);
    await wrapper.get('[data-testid="llama-hf-model"]').setValue('other-Q4_K_M.gguf');
    expect(wrapper.get('[data-testid="llama-hf-download"]').attributes('disabled')).toBeUndefined();
    expect(wrapper.get('[data-testid="llama-hf-files"]').text()).toContain('other-Q4_K_M.gguf');
  });
  it.each([
    { failure: new DownloadConflictError({ reason: 'existing-files' }), message: 'Model files already exist' },
    { failure: new DownloadConflictError({ reason: 'different-download' }), message: 'A different download already exists' },
    { failure: new Error('private source path and network details'), message: 'The operation failed. Retry or resume' },
  ])('explains the download failure without exposing raw details: $message', async ({ failure, message }) => {
    vi.mocked(discoverRepository).mockResolvedValue({ repository: selection.repository, revision: selection.revision, models: [{ label: 'model-Q4_K_M.gguf', files: selection.files, size: 128 }], projectors: [] });
    vi.mocked(downloadRepository).mockRejectedValueOnce(failure);
    const wrapper = render(); await flushPromises();
    await wrapper.get('[data-testid="llama-hf-repository"]').setValue('owner/repo'); await wrapper.get('[data-testid="llama-hf-inspect"]').trigger('click'); await flushPromises();
    await wrapper.get('[data-testid="llama-hf-download"]').trigger('click'); await flushPromises();
    const alert = wrapper.get('[role="alert"]').text(); expect(alert).toContain(message);
    expect(alert).not.toContain('private source path');
    if (failure instanceof DownloadConflictError) expect(alert).not.toContain('Retry or resume');
  });
  it('keeps pending files when deletion confirmation is cancelled and refreshes a changed plan', async () => {
    vi.mocked(listPendingDownloads).mockResolvedValue([{ version: 1, selection, bytes: [48], complete: [false] }]);
    const wrapper = render(); await flushPromises();
    await wrapper.get('[data-testid="llama-hf-delete"]').trigger('click'); await flushPromises();
    await wrapper.get('[data-testid="dialog-cancel-button"]').trigger('click'); await flushPromises();
    expect(cancelDownload).not.toHaveBeenCalled();
    vi.mocked(cancelDownload).mockResolvedValueOnce('changed');
    await wrapper.get('[data-testid="llama-hf-delete"]').trigger('click'); await flushPromises();
    await wrapper.get('[data-testid="dialog-confirm-button"]').trigger('click'); await flushPromises();
    expect(prepareModelRemoval).toHaveBeenCalledTimes(2);
    expect(wrapper.get('[role="alert"]').text()).toContain('Deletion stopped because the files changed');
    expect(listPendingDownloads).toHaveBeenCalledTimes(2);
  });
  it.each(['complete', 'pause', 'unmount'] as const)('updates remaining time independently of events and disposes its clock on %s', async ending => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'performance'] });
    vi.mocked(listPendingDownloads).mockResolvedValue([{ version: 1, selection, bytes: [64], complete: [false] }]);
    const gate = Promise.withResolvers<void>();
    let report: Parameters<typeof downloadRepository>[0]['onProgress'] | undefined;
    vi.mocked(downloadRepository).mockImplementation(({ signal, onProgress }) => {
      report = onProgress; onProgress({ progress: { completed: 64, total: 128, processed: 0, phase: 'transferring' } });
      signal.addEventListener('abort', () => gate.reject(new DOMException('paused', 'AbortError')), { once: true }); return gate.promise;
    });
    const wrapper = render(); await flushPromises(); await wrapper.get('[data-testid="llama-hf-resume"]').trigger('click'); await flushPromises();
    expect(wrapper.get('[data-testid="llama-hf-remaining"]').text()).toBe('Estimating remaining time…');
    for (let tick = 1; tick <= 3; tick++) {
      report!({ progress: { completed: 64 + tick * 10, total: 128, processed: tick * 10, phase: 'transferring' } });
      await vi.advanceTimersByTimeAsync(1000);
    }
    expect(wrapper.get('[data-testid="llama-hf-remaining"]').text()).toBe('About 5 seconds remaining');
    report!({ progress: { completed: 94, total: 36104, processed: 30, phase: 'transferring' } }); await flushPromises();
    expect(wrapper.get('[data-testid="llama-hf-remaining"]').text()).toBe('About 1 h 10 min remaining');
    await vi.advanceTimersByTimeAsync(10000);
    expect(wrapper.get('[data-testid="llama-hf-remaining"]').text()).toBe('Estimating remaining time…');
    report!({ progress: { completed: 128, total: 128, processed: 64, phase: 'verifying' } }); await flushPromises();
    expect(wrapper.get('[data-testid="llama-hf-remaining"]').text()).toBe('Performing final checks…');
    expect(vi.getTimerCount()).toBe(1);
    switch (ending) {
    case 'complete': gate.resolve(); break;
    case 'pause': await wrapper.get('[data-testid="llama-hf-pause"]').trigger('click'); break;
    case 'unmount': wrapper.unmount(); wrappers.splice(wrappers.indexOf(wrapper), 1); break;
    default: { const exhaustive: never = ending; throw new Error(String(exhaustive)); }
    }
    await flushPromises(); expect(vi.getTimerCount()).toBe(0);
  });
  it('restores pending downloads on mount and supports resume, pause and cancel-delete', async () => {
    vi.mocked(listPendingDownloads).mockResolvedValue([{ version: 1, selection, bytes: [48], complete: [false] }]);
    vi.mocked(downloadRepository).mockImplementation(({ signal, onProgress }) => {
      onProgress({ progress: { completed: 64, total: 128, processed: 16, phase: 'transferring' } }); return new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true }));
    });
    const wrapper = render(); await flushPromises();
    expect(wrapper.get('[data-testid="llama-hf-pending"]').text()).toContain('hf.co/owner/repo');
    await wrapper.get('[data-testid="llama-hf-resume"]').trigger('click'); await flushPromises();
    expect(wrapper.get('[data-testid="llama-hf-active-progress"]').text()).toContain('50%');
    expect(wrapper.get('[role="progressbar"]').attributes('aria-valuenow')).toBe('50');
    await wrapper.get('[data-testid="llama-hf-pause"]').trigger('click'); await flushPromises();
    expect(wrapper.find('[role="alert"]').exists()).toBe(false);
    await wrapper.get('[data-testid="llama-hf-delete"]').trigger('click'); await flushPromises();
    expect(wrapper.get('[data-testid="llama-delete-details"]').text()).toContain('model-Q4_K_M.gguf');
    await wrapper.get('[data-testid="dialog-confirm-button"]').trigger('click'); await flushPromises();
    expect(cancelDownload).toHaveBeenCalledWith({ repository: 'owner/repo', plan });
  });
});
