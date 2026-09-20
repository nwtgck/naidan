import { planStoredModelRemoval } from '@/features/llama-cpp-browser/runtime/model-store';
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
vi.mock('../runtime/model-store', () => ({ planStoredModelRemoval: vi.fn() }));
const plan = { id: 'hf.co/owner/repo', files: [{ path: 'model-Q4_K_M.gguf', size: 48, lastModified: 1 }] };
const selection = { repository: 'owner/repo', revision: 'a'.repeat(40), files: [{ path: 'model-Q4_K_M.gguf', size: 128 }] };
const wrappers: VueWrapper[] = [];
function render(): VueWrapper {
  const wrapper = mount(LlamaCppBrowserHuggingFaceManager, { props: { disabled: false } }); wrappers.push(wrapper); return wrapper;
}
beforeEach(async () => {
  vi.resetAllMocks(); confirm.mockResolvedValue(true); vi.mocked(planStoredModelRemoval).mockResolvedValue(plan); vi.mocked(cancelDownload).mockResolvedValue('deleted'); vi.mocked(listPendingDownloads).mockResolvedValue([]); await ensureAllStringsForTest({ locale: 'en' });
});
afterEach(() => {
  for (const wrapper of wrappers.splice(0)) wrapper.unmount();
});
describe('Hugging Face download controls', () => {
  it('selects a complete quantization group and an independent optional projector', async () => {
    vi.mocked(discoverRepository).mockResolvedValue({ repository: selection.repository, revision: selection.revision, models: [{ label: 'model-Q4_K_M.gguf', files: selection.files, size: 128 }], projectors: [{ path: 'mmproj-F16.gguf', size: 64 }] });
    const wrapper = render(); await flushPromises();
    await wrapper.get('[data-testid="llama-hf-repository"]').setValue('owner/repo'); await wrapper.get('[data-testid="llama-hf-inspect"]').trigger('click'); await flushPromises();
    expect(wrapper.get('[data-testid="llama-hf-download"]').attributes('disabled')).toBeUndefined();
    expect(wrapper.get<HTMLSelectElement>('[data-testid="llama-hf-model"]').element.value).toBe('Q4_K_M');
    expect(wrapper.get('[data-testid="llama-hf-model"]').text()).toBe('Q4_K_M');
    expect(wrapper.get('[data-testid="llama-hf-multimodal"]').attributes('aria-checked')).toBe('true');
    expect(wrapper.get('[data-testid="llama-hf-details"]').text()).toContain('mmproj-F16.gguf');
    await wrapper.get('[data-testid="llama-hf-download"]').trigger('click'); await flushPromises();
    expect(downloadRepository).toHaveBeenCalledWith(expect.objectContaining({ selection: { ...selection, files: [...selection.files, { path: 'mmproj-F16.gguf', size: 64 }] } }));
    expect(wrapper.emitted('changed')).toHaveLength(1);
  });
  it('keeps an explicit quantization and multimodal OFF when checking the same repository again', async () => {
    const models = ['model-Q8_0.gguf', 'model-Q4_K_M.gguf'].map(path => ({ label: path, files: [{ path, size: 128 }], size: 128 }));
    vi.mocked(discoverRepository).mockResolvedValue({ repository: selection.repository, revision: selection.revision, models, projectors: [{ path: 'mmproj.gguf', size: 64 }] });
    const wrapper = render(); await flushPromises();
    await wrapper.get('[data-testid="llama-hf-repository"]').setValue('owner/repo'); await wrapper.get('[data-testid="llama-hf-inspect"]').trigger('click'); await flushPromises();
    await wrapper.get('[data-testid="llama-hf-model"]').setValue('Q8_0'); await wrapper.get('[data-testid="llama-hf-multimodal"]').trigger('click');
    await wrapper.get('[data-testid="llama-hf-inspect"]').trigger('click'); await flushPromises();
    expect(wrapper.get<HTMLSelectElement>('[data-testid="llama-hf-model"]').element.value).toBe('Q8_0');
    expect(wrapper.get('[data-testid="llama-hf-multimodal"]').attributes('aria-checked')).toBe('false');
    await wrapper.get('[data-testid="llama-hf-download"]').trigger('click'); await flushPromises();
    expect(vi.mocked(downloadRepository).mock.calls[0]?.[0].selection.files).toEqual([{ path: 'model-Q8_0.gguf', size: 128 }]);
  });
  it('explains ambiguous variants and resolves them in details without repeating full filenames in the main select', async () => {
    const models = ['base-Q4_K_M.gguf', 'other-Q4_K_M.gguf'].map(path => ({ label: path, files: [{ path, size: 128 }], size: 128 }));
    vi.mocked(discoverRepository).mockResolvedValue({ repository: selection.repository, revision: selection.revision, models, projectors: [] });
    const wrapper = render(); await flushPromises();
    await wrapper.get('[data-testid="llama-hf-repository"]').setValue('owner/repo'); await wrapper.get('[data-testid="llama-hf-inspect"]').trigger('click'); await flushPromises();
    expect(wrapper.get('[data-testid="llama-hf-model"]').text()).toBe('Q4_K_M');
    expect(wrapper.get('[data-testid="llama-hf-selection-required"]').text()).toContain('Multiple variants');
    expect(wrapper.get('[data-testid="llama-hf-download"]').attributes('disabled')).toBeDefined();
    expect(wrapper.get('[data-testid="llama-hf-multimodal"]').attributes('aria-checked')).toBe('false');
    expect(wrapper.get('[data-testid="llama-hf-multimodal"]').attributes('disabled')).toBeDefined();
    await wrapper.get('[data-testid="llama-hf-variant"]').setValue('other-Q4_K_M.gguf');
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
    confirm.mockResolvedValueOnce(false); const wrapper = render(); await flushPromises();
    await wrapper.get('[data-testid="llama-hf-delete"]').trigger('click'); await flushPromises();
    expect(cancelDownload).not.toHaveBeenCalled();
    vi.mocked(cancelDownload).mockResolvedValueOnce('changed');
    await wrapper.get('[data-testid="llama-hf-delete"]').trigger('click'); await flushPromises();
    expect(planStoredModelRemoval).toHaveBeenCalledTimes(2);
    expect(wrapper.get('[role="alert"]').text()).toContain('Deletion stopped because the files changed');
    expect(listPendingDownloads).toHaveBeenCalledTimes(2);
  });
  it('restores pending downloads on mount and supports resume, pause and cancel-delete', async () => {
    vi.mocked(listPendingDownloads).mockResolvedValue([{ version: 1, selection, bytes: [48], complete: [false] }]);
    vi.mocked(downloadRepository).mockImplementation(({ signal, onProgress }) => {
      onProgress({ progress: { completed: 64, total: 128 } }); return new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true }));
    });
    const wrapper = render(); await flushPromises();
    expect(wrapper.get('[data-testid="llama-hf-pending"]').text()).toContain('hf.co/owner/repo');
    await wrapper.get('[data-testid="llama-hf-resume"]').trigger('click'); await flushPromises();
    expect(wrapper.get('[data-testid="llama-hf-active-progress"]').text()).toContain('50%');
    expect(wrapper.get('[role="progressbar"]').attributes('aria-valuenow')).toBe('50');
    await wrapper.get('[data-testid="llama-hf-pause"]').trigger('click'); await flushPromises();
    expect(wrapper.find('[role="alert"]').exists()).toBe(false);
    await wrapper.get('[data-testid="llama-hf-delete"]').trigger('click'); await flushPromises();
    expect(confirm).toHaveBeenCalledWith(expect.objectContaining({ details: { summary: 'Files to delete', items: ['model-Q4_K_M.gguf'] } }));
    expect(cancelDownload).toHaveBeenCalledWith({ repository: 'owner/repo', plan });
  });
});
