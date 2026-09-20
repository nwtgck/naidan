import type { ModelPreset } from '@/features/llama-cpp-browser/model-preset';
import { prepareModelRemoval } from '@/features/llama-cpp-browser/runtime/model-store';
import { DownloadConflictError } from '@/features/llama-cpp-browser/hugging-face/types';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import { ensureAllStringsForTest } from '@/strings/test-utils';
import { discoverRepository } from '@/features/llama-cpp-browser/hugging-face/catalog';
import { downloadRepository, cancelDownload } from '@/features/llama-cpp-browser/hugging-face/download';
import { defineComponent, ref } from 'vue';
import { provideHuggingFaceSession } from '@/features/llama-cpp-browser/hugging-face/session';
import { installedSelection, listPendingDownloads } from '@/features/llama-cpp-browser/hugging-face/storage';
import LlamaCppBrowserHuggingFaceManager from './LlamaCppBrowserHuggingFaceManager.vue';
vi.mock('@/features/llama-cpp-browser/hugging-face/catalog', async importOriginal => ({ ...await importOriginal<typeof import('@/features/llama-cpp-browser/hugging-face/catalog')>(), discoverRepository: vi.fn() }));
vi.mock('@/features/llama-cpp-browser/hugging-face/download', () => ({ downloadRepository: vi.fn(), cancelDownload: vi.fn() }));
vi.mock('@/features/llama-cpp-browser/hugging-face/storage', () => ({ listPendingDownloads: vi.fn(), installedSelection: vi.fn() }));
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
  vi.resetAllMocks(); vi.mocked(installedSelection).mockResolvedValue(undefined); confirm.mockResolvedValue(true); vi.mocked(prepareModelRemoval).mockResolvedValue({ plan, sharedPlan: undefined, affectedVariants: 0 }); vi.mocked(cancelDownload).mockResolvedValue('deleted'); vi.mocked(listPendingDownloads).mockResolvedValue([]); await ensureAllStringsForTest({ locale: 'en' });
});
afterEach(() => {
  for (const wrapper of wrappers.splice(0)) wrapper.unmount();
  vi.useRealTimers();
});
describe('Hugging Face download controls', () => {
  it('marks existing selections downloaded and publishes the exact local model without downloading', async () => {
    const model = { id: 'hf-model', name: 'hf.co/owner/repo:Q4_K_M', size: 128, importedAt: 1 };
    vi.mocked(installedSelection).mockResolvedValue(model);
    vi.mocked(discoverRepository).mockResolvedValue({ ...selection, models: [{ label: 'model-Q4_K_M.gguf', files: selection.files, size: 128 }], projectors: [] });
    const wrapper = render(); await flushPromises();
    await wrapper.get('[data-testid="llama-hf-repository"]').setValue('owner/repo');
    await wrapper.get('[data-testid="llama-hf-inspect"]').trigger('click'); await flushPromises();
    expect(wrapper.get('[data-testid="llama-hf-download"]').text()).toContain('Downloaded');
    expect(wrapper.get('[data-testid="llama-hf-download"]').attributes('disabled')).toBeDefined();
    expect(wrapper.emitted('modelReady')).toEqual([[model]]);
    expect(downloadRepository).not.toHaveBeenCalled();
    vi.mocked(installedSelection).mockResolvedValue(undefined);
    window.dispatchEvent(new Event('focus')); await flushPromises();
    expect(wrapper.emitted('changed')).toHaveLength(1);
    expect(wrapper.get('[data-testid="llama-hf-download"]').attributes('disabled')).toBeUndefined();
    window.dispatchEvent(new Event('focus')); await flushPromises();
    expect(wrapper.emitted('changed')).toHaveLength(1);
  });
  it('rechecks completed downloads and ignores an earlier selection check', async () => {
    const stale = Promise.withResolvers<Awaited<ReturnType<typeof installedSelection>>>();
    const models = ['repo-Q4_K_M.gguf', 'repo-Q8_0.gguf'].map(path => ({ label: path, files: [{ path, size: 128 }], size: 128 }));
    const ready = { id: 'q8', name: 'hf.co/owner/repo:Q8_0', size: 128, importedAt: 1 };
    vi.mocked(discoverRepository).mockResolvedValue({ ...selection, models, projectors: [] });
    vi.mocked(installedSelection).mockReturnValueOnce(stale.promise);
    const wrapper = render(); await flushPromises();
    await wrapper.get('[data-testid="llama-hf-repository"]').setValue('owner/repo');
    await wrapper.get('[data-testid="llama-hf-inspect"]').trigger('click'); await flushPromises();
    expect(wrapper.get('[data-testid="llama-hf-download"]').attributes('disabled')).toBeDefined();
    await wrapper.get('[data-testid="llama-hf-model"]').setValue('repo-Q8_0.gguf'); await flushPromises();
    stale.resolve({ ...ready, id: 'q4', name: 'hf.co/owner/repo:Q4_K_M' }); await flushPromises();
    expect(wrapper.emitted('modelReady')).toBeUndefined();
    expect(wrapper.get('[data-testid="llama-hf-download"]').attributes('disabled')).toBeUndefined();
    vi.mocked(downloadRepository).mockImplementation(async () => {
      vi.mocked(installedSelection).mockResolvedValue(ready);
    });
    await wrapper.get('[data-testid="llama-hf-download"]').trigger('click'); await flushPromises();
    expect(wrapper.emitted('modelReady')).toEqual([[ready]]);
    expect(wrapper.get('[data-testid="llama-hf-download"]').text()).toContain('Downloaded');
  });
  it('keeps prepared inputs and manual choices across modal tabs without another metadata request', async () => {
    const models = ['repo-Q4_K_M.gguf', 'repo-Q8_0.gguf'].map(path => ({ label: path, files: [{ path, size: 128 }], size: 128 }));
    vi.mocked(discoverRepository).mockResolvedValue({ ...selection, models, projectors: [] });
    const visible = ref(true);
    const modelPreset: ModelPreset = { input: 'hf.co/owner/repo:Q4_K_M', target: 'onboarding', claim: vi.fn().mockReturnValueOnce(true).mockReturnValue(false) };
    const wrapper = mount(defineComponent({ components: { LlamaCppBrowserHuggingFaceManager }, setup() {
      provideHuggingFaceSession(); return { visible, modelPreset };
    }, template: '<LlamaCppBrowserHuggingFaceManager v-if="visible" :disabled="false" :model-preset="modelPreset" />' })); wrappers.push(wrapper);
    await flushPromises();
    await wrapper.get('[data-testid="llama-hf-model"]').setValue('repo-Q8_0.gguf'); await flushPromises();
    const checks = vi.mocked(installedSelection).mock.calls.length;
    visible.value = false; await flushPromises(); visible.value = true; await flushPromises();
    expect(wrapper.get<HTMLInputElement>('[data-testid="llama-hf-repository"]').element.value).toBe(modelPreset.input);
    expect(wrapper.get<HTMLSelectElement>('[data-testid="llama-hf-model"]').element.value).toBe('repo-Q8_0.gguf');
    expect(discoverRepository).toHaveBeenCalledTimes(1);
    expect(vi.mocked(installedSelection).mock.calls.length).toBeGreaterThan(checks);
  });
  it('prepares a preset once after availability without starting a download or reapplying on remount', async () => {
    const claim = vi.fn().mockReturnValueOnce(true).mockReturnValue(false);
    const modelPreset: ModelPreset = { input: 'hf.co/owner/repo:QAD-Q4_0', target: 'settings', claim };
    const paths = ['repo-Q4_K_M.gguf', 'repo-QAD-Q4_0.gguf'];
    vi.mocked(discoverRepository).mockResolvedValue({ repository: 'owner/repo', revision: selection.revision, models: paths.map(path => ({ label: path, files: [{ path, size: 128 }], size: 128 })), projectors: [] });
    const wrapper = mount(LlamaCppBrowserHuggingFaceManager, { props: { disabled: true, modelPreset } }); wrappers.push(wrapper);
    await flushPromises(); expect(discoverRepository).not.toHaveBeenCalled();
    await wrapper.setProps({ disabled: false }); await flushPromises();
    expect(discoverRepository).toHaveBeenCalledTimes(1);
    expect(wrapper.get<HTMLSelectElement>('[data-testid="llama-hf-model"]').element.value).toBe('repo-QAD-Q4_0.gguf');
    expect(wrapper.get('[data-testid="llama-hf-model"]').findAll('option')).toHaveLength(2);
    expect(downloadRepository).not.toHaveBeenCalled(); wrapper.unmount();
    const reopened = mount(LlamaCppBrowserHuggingFaceManager, { props: { disabled: false, modelPreset } }); wrappers.push(reopened);
    await flushPromises(); expect(discoverRepository).toHaveBeenCalledTimes(1);
  });
  it('discards a superseded metadata response and prepares the newer preset', async () => {
    const first = Promise.withResolvers<Awaited<ReturnType<typeof discoverRepository>>>();
    vi.mocked(discoverRepository).mockReturnValueOnce(first.promise).mockResolvedValueOnce({ repository: 'owner/repo', revision: selection.revision, models: [{ label: 'repo-Q8_0.gguf', files: [{ path: 'repo-Q8_0.gguf', size: 128 }], size: 128 }], projectors: [] });
    const preset = ({ input }: { input: string }): ModelPreset => ({ input, target: 'settings', claim: vi.fn().mockReturnValueOnce(true).mockReturnValue(false) });
    const wrapper = mount(LlamaCppBrowserHuggingFaceManager, { props: { disabled: false, modelPreset: preset({ input: 'hf.co/owner/repo:Q4_K_M' }) } }); wrappers.push(wrapper);
    await flushPromises(); const signal = vi.mocked(discoverRepository).mock.calls[0]![0].signal;
    await wrapper.setProps({ modelPreset: preset({ input: 'hf.co/owner/repo:Q8_0' }) });
    expect(signal.aborted).toBe(true);
    first.resolve({ repository: 'owner/repo', revision: selection.revision, models: [], projectors: [] }); await flushPromises();
    expect(wrapper.get<HTMLSelectElement>('[data-testid="llama-hf-model"]').element.value).toBe('repo-Q8_0.gguf');
    expect(downloadRepository).not.toHaveBeenCalled();
  });
  it('selects a complete quantization group and an independent optional projector', async () => {
    vi.mocked(discoverRepository).mockResolvedValue({ repository: selection.repository, revision: selection.revision, models: [{ label: 'model-Q4_K_M.gguf', files: selection.files, size: 128 }], projectors: [{ path: 'mmproj-F16.gguf', size: 64 }] });
    const wrapper = render(); await flushPromises();
    await wrapper.get('[data-testid="llama-hf-repository"]').setValue('owner/repo'); await wrapper.get('[data-testid="llama-hf-inspect"]').trigger('click'); await flushPromises();
    expect(wrapper.get('[data-testid="llama-hf-download"]').attributes('disabled')).toBeUndefined();
    expect(wrapper.get<HTMLSelectElement>('[data-testid="llama-hf-model"]').element.value).toBe('model-Q4_K_M.gguf');
    expect(wrapper.get('[data-testid="llama-hf-model"]').text()).toContain('model-Q4_K_M · 0.1 KiB');
    expect(wrapper.get('[data-testid="llama-hf-selected-model"]').text()).toBe('model-Q4_K_M');
    expect(wrapper.get('[data-testid="llama-hf-multimodal"]').attributes('aria-checked')).toBe('true');
    expect(wrapper.get('[data-testid="llama-hf-details"]').text()).toContain('mmproj-F16.gguf');
    expect(wrapper.get('[data-testid="llama-hf-projector"]').text()).toContain('F16 · 0.1 KiB');
    expect(wrapper.get('[data-testid="llama-hf-selected-projector"]').text()).toBe('F16');
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
    expect(wrapper.get('[data-testid="llama-hf-selected-model"]').text()).toBe('model-Q8_0');
    expect(wrapper.get('[data-testid="llama-hf-multimodal"]').attributes('aria-checked')).toBe('false');
    await wrapper.get('[data-testid="llama-hf-download"]').trigger('click'); await flushPromises();
    expect(vi.mocked(downloadRepository).mock.calls[0]?.[0].selection.files).toEqual([{ path: 'model-Q8_0.gguf', size: 128 }]);
  });
  it('prioritizes explicit variants over saved choices while keeping every model selectable', async () => {
    const models = ['repo-Q4_K_M.gguf', 'repo-QAD-Q4_0.gguf', 'repo-UD-Q4_K_XL.gguf'].map(path => ({ label: path, files: [{ path, size: 128 }], size: 128 }));
    vi.mocked(discoverRepository).mockResolvedValue({ repository: 'owner/repo', revision: selection.revision, models, projectors: [] });
    const wrapper = render(); await flushPromises();
    const input = wrapper.get('[data-testid="llama-hf-repository"]');
    await input.setValue('hf.co/owner/repo:QAD-Q4_0'); await wrapper.get('[data-testid="llama-hf-inspect"]').trigger('click'); await flushPromises();
    const select = wrapper.get<HTMLSelectElement>('[data-testid="llama-hf-model"]');
    expect(select.element.value).toBe('repo-QAD-Q4_0.gguf'); expect(select.findAll('option')).toHaveLength(3);
    await select.setValue('repo-Q4_K_M.gguf');
    await input.setValue('hf.co/owner/repo:UD-Q4_K_XL'); await wrapper.get('[data-testid="llama-hf-inspect"]').trigger('click'); await flushPromises();
    expect(select.element.value).toBe('repo-UD-Q4_K_XL.gguf');
    await input.setValue('hf.co/owner/repo'); await wrapper.get('[data-testid="llama-hf-inspect"]').trigger('click'); await flushPromises();
    expect(select.element.value).toBe('repo-UD-Q4_K_XL.gguf');
  });
  it.each(['unknown', 'Q4_K_M'])('requires an explicit choice for an unavailable or ambiguous variant: %s', async requestedVariant => {
    const models = ['repo-Q4_K_M.gguf', 'repo-Q4_K_M-00001-of-00002.gguf'].map(path => ({ label: path, files: [{ path, size: 128 }], size: 128 }));
    vi.mocked(discoverRepository).mockResolvedValue({ repository: 'owner/repo', revision: selection.revision, models, projectors: [] });
    const wrapper = render(); await flushPromises();
    await wrapper.get('[data-testid="llama-hf-repository"]').setValue(`hf.co/owner/repo:${requestedVariant}`); await wrapper.get('[data-testid="llama-hf-inspect"]').trigger('click'); await flushPromises();
    expect(wrapper.get<HTMLSelectElement>('[data-testid="llama-hf-model"]').element.value).toBe('');
    expect(wrapper.get('[data-testid="llama-hf-selected-model"]').text()).toBe('Choose model files');
    expect(wrapper.find('[data-testid="llama-hf-requested-variant-unresolved"]').exists()).toBe(true);
    expect(wrapper.get('[data-testid="llama-hf-download"]').attributes('disabled')).toBeDefined();
    await wrapper.get('[data-testid="llama-hf-model"]').setValue('repo-Q4_K_M.gguf'); await flushPromises();
    expect(wrapper.find('[data-testid="llama-hf-requested-variant-unresolved"]').exists()).toBe(false);
    expect(wrapper.get('[data-testid="llama-hf-download"]').attributes('disabled')).toBeUndefined();
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
    await wrapper.get('[data-testid="llama-hf-model"]').setValue('other-Q4_K_M.gguf'); await flushPromises();
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
