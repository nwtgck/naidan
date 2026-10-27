import { enableAutoUnmount, flushPromises, mount } from '@vue/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { defineComponent, h } from 'vue';
import { ensureAllStringsForTest } from '@/strings/utils.test-support';
import type { ModelDirectoryInput } from '@/features/llama-cpp-browser/types';
import HuggingFaceDownloadFailureHint from './HuggingFaceDownloadFailureHint.vue';
import LlamaCppBrowserLocalFileRecovery from '@/features/llama-cpp-browser/components/LlamaCppBrowserLocalFileRecovery.vue';

const fixture = vi.hoisted(() => ({ cspVisible: false, capture: vi.fn(), fromFiles: vi.fn(), importSetup: vi.fn(), linkedSetup: vi.fn(), importFails: false }));
vi.mock('@/components/csp/CspMessageHint.vue', () => ({ default: { name: 'CspMessageHint', props: ['target', 'presentation', 'activityForDisplayOnly'], setup: () => ({ fixture }), template: '<span v-if="fixture.cspVisible" data-testid="optional-csp">Policy guidance</span>' } }));
vi.mock('@/features/llama-cpp-browser/logic/local-model-input', () => ({ captureDroppedLocalModels: fixture.capture, localModelDirectoriesFromFiles: fixture.fromFiles }));
vi.mock('@/logic/host-model-directories', () => ({ missingHostModelDirectoryApis: () => [] }));
// Vue's async loader needs a module marker to unwrap a mocked SFC's default.
vi.mock('@/features/llama-cpp-browser/components/LlamaCppBrowserModelImport.vue', () => ({
  __esModule: true,
  default: {
    name: 'ModelImportProbe',
    props: ['disabled'],
    setup() {
      fixture.importSetup();
      if (fixture.importFails) {
        throw new Error('Private file view failure');
      }
    },
    template: '<div data-testid="existing-model-import" :data-disabled="disabled" />',
  },
}));
vi.mock('@/features/llama-cpp-browser/components/LlamaCppBrowserModelImportLinkedFolders.vue', () => ({ __esModule: true, default: { name: 'LinkedFoldersProbe', props: ['disabled'], setup: () => fixture.linkedSetup(), template: '<div data-testid="existing-linked-folders" />' } }));

type AcceptInput = Exclude<InstanceType<typeof LlamaCppBrowserLocalFileRecovery>['$props']['acceptLocalInput'], undefined>;
const directory: ModelDirectoryInput = { rootName: 'downloaded', files: [] };
enableAutoUnmount(afterEach);

beforeEach(async () => {
  vi.clearAllMocks();
  fixture.cspVisible = false;
  fixture.importFails = false;
  fixture.capture.mockResolvedValue([directory]);
  fixture.fromFiles.mockReturnValue([directory]);
  await ensureAllStringsForTest({ locale: 'en' });
});

async function settleViews(): Promise<void> {
  await vi.dynamicImportSettled();
  await flushPromises();
}

async function renderRecovery({ disabled, acceptLocalInput }: { disabled: boolean, acceptLocalInput: AcceptInput | undefined }) {
  const wrapper = mount(HuggingFaceDownloadFailureHint, { slots: { default: () => h(LlamaCppBrowserLocalFileRecovery, { disabled, acceptLocalInput }) } });
  await wrapper.get('[data-testid="hf-download-failure-trigger"]').trigger('click');
  await settleViews();
  return wrapper;
}

describe('shared Hugging Face failure guidance and feature-owned recovery', () => {
  it('mounts arbitrary feature recovery only after opening the shared hint without invoking an action', async () => {
    const mounted = vi.fn();
    const action = vi.fn();
    const Recovery = defineComponent({
      setup() {
        mounted();
        return () => h('button', { 'data-testid': 'image-file-recovery', onClick: action }, 'Choose an image model file');
      },
    });
    const wrapper = mount(HuggingFaceDownloadFailureHint, { slots: { default: () => h(Recovery) } });
    const trigger = wrapper.get('[data-testid="hf-download-failure-trigger"]');
    expect(trigger.text()).toBe('Hints for resolving this error');
    expect(trigger.attributes('aria-expanded')).toBe('false');
    expect(wrapper.find('[data-testid="image-file-recovery"]').exists()).toBe(false);
    expect(mounted).not.toHaveBeenCalled();
    expect(fixture.importSetup).not.toHaveBeenCalled();
    await trigger.trigger('click');
    expect(wrapper.find('[data-testid="image-file-recovery"]').exists()).toBe(true);
    expect(mounted).toHaveBeenCalledOnce();
    expect(action).not.toHaveBeenCalled();
    expect(wrapper.text()).not.toContain('GGUF');
    expect(fixture.importSetup).not.toHaveBeenCalled();
    expect(fixture.linkedSetup).not.toHaveBeenCalled();
  });

  it('returns focus to the single outer trigger and makes retained recovery inert on Escape', async () => {
    const wrapper = mount(HuggingFaceDownloadFailureHint, { attachTo: document.body, slots: { default: '<button data-testid="feature-recovery">Choose files</button>' } });
    const trigger = wrapper.get<HTMLButtonElement>('[data-testid="hf-download-failure-trigger"]');
    await trigger.trigger('click');
    const recovery = wrapper.get<HTMLButtonElement>('[data-testid="feature-recovery"]');
    recovery.element.focus();
    await recovery.trigger('keydown', { key: 'Escape' });
    expect(trigger.attributes('aria-expanded')).toBe('false');
    expect(document.activeElement).toBe(trigger.element);
    expect(wrapper.get('.settings-collapse').attributes('inert')).toBeDefined();
    expect(wrapper.get('.settings-collapse').attributes('aria-hidden')).toBe('true');
    await trigger.trigger('click');
    expect(wrapper.get('[data-testid="feature-recovery"]').element).toBe(recovery.element);
    expect(wrapper.get('.settings-collapse').attributes('inert')).toBeUndefined();
  });

  it('keeps real file controls available without a CSP notice and does not start an owner action', async () => {
    const accept = vi.fn<AcceptInput>();
    const wrapper = await renderRecovery({ disabled: false, acceptLocalInput: accept });
    await settleViews();
    expect(wrapper.find('[data-testid="optional-csp"]').exists()).toBe(false);
    expect(wrapper.get('[data-testid="gguf-local-recovery"]').text()).toContain('Use local model files');
    expect(wrapper.find('[data-testid="llama-cpp-browser-file"]').exists()).toBe(true);
    expect(wrapper.find('[data-testid="llama-cpp-browser-directory"]').exists()).toBe(true);
    expect(wrapper.find('[data-testid="llama-cpp-browser-drop-zone"]').exists()).toBe(true);
    expect(accept).not.toHaveBeenCalled();
    expect(fixture.capture).not.toHaveBeenCalled();
    expect(fixture.fromFiles).not.toHaveBeenCalled();
    expect(fixture.importSetup).not.toHaveBeenCalled();
    expect(fixture.linkedSetup).not.toHaveBeenCalled();
  });

  it.each(['files', 'directory'] as const)('captures selected %s and hands them to the existing owner only on change', async selection => {
    const accept = vi.fn<AcceptInput>();
    const wrapper = await renderRecovery({ disabled: false, acceptLocalInput: accept });
    const file = new File(['gguf'], 'model.gguf');
    const input = wrapper.get<HTMLInputElement>(`[data-testid="llama-cpp-browser-${selection === 'files' ? 'file' : 'directory'}"]`);
    Object.defineProperty(input.element, 'files', { configurable: true, value: [file] });
    await input.trigger('change');
    await flushPromises();
    expect(accept).toHaveBeenCalledOnce();
    const request = accept.mock.calls[0]?.[0];
    expect(request).toBeDefined();
    await expect(request?.directories).resolves.toEqual([directory]);
    expect(fixture.fromFiles).toHaveBeenCalledExactlyOnceWith({ files: [file], selection });
    expect(input.element.value).toBe('');
    expect(request?.controller.signal.aborted).toBe(false);
  });

  it('captures a drop during dispatch and finishes shared input preparation before replacing its owner', async () => {
    const pending = Promise.withResolvers<ModelDirectoryInput[]>();
    fixture.capture.mockReturnValue(pending.promise);
    const accept = vi.fn<AcceptInput>().mockImplementation(({ directories }) => directories.then(() => {}));
    const wrapper = await renderRecovery({ disabled: false, acceptLocalInput: accept });
    const transfer = { types: ['Files'], items: [] };
    const dispatch = wrapper.get('[data-testid="llama-cpp-browser-drop-zone"]').trigger('drop', { dataTransfer: transfer });
    expect(fixture.capture).toHaveBeenCalledOnce();
    expect(fixture.capture.mock.calls[0]?.[0].transfer).toBe(transfer);
    expect(accept).not.toHaveBeenCalled();
    await dispatch;
    await wrapper.get('[data-testid="llama-cpp-browser-drop-zone"]').trigger('drop', { dataTransfer: transfer });
    expect(accept).not.toHaveBeenCalled();
    pending.resolve([directory]);
    await flushPromises();
    expect(accept).toHaveBeenCalledOnce();
    const request = accept.mock.calls[0]?.[0];
    await expect(request?.directories).resolves.toEqual([directory]);
    expect(request).toMatchObject({ save: 'later', repositoryLayout: 'confirmed' });
    wrapper.unmount();
    expect(request?.controller.signal.aborted).toBe(false);
  });

  it('cancels unfinished input preparation without replacing a failed download after its view closes', async () => {
    const pending = Promise.withResolvers<ModelDirectoryInput[]>();
    fixture.capture.mockReturnValue(pending.promise);
    const accept = vi.fn<AcceptInput>();
    const wrapper = await renderRecovery({ disabled: false, acceptLocalInput: accept });
    await wrapper.get('[data-testid="llama-cpp-browser-drop-zone"]').trigger('drop', { dataTransfer: { types: ['Files'], items: [] } });
    expect(accept).not.toHaveBeenCalled();
    const signal = fixture.capture.mock.calls[0]?.[0].signal;
    wrapper.unmount();
    expect(signal.aborted).toBe(true);
    pending.resolve([directory]);
    await flushPromises();
    expect(accept).not.toHaveBeenCalled();
  });

  it('uses the parent action state for disabled controls without starting a capture', async () => {
    const accept = vi.fn<AcceptInput>();
    const wrapper = await renderRecovery({ disabled: true, acceptLocalInput: accept });
    await wrapper.get('[data-testid="llama-cpp-browser-drop-zone"]').trigger('drop', { dataTransfer: { types: ['Files'], items: [] } });
    expect(wrapper.get<HTMLInputElement>('[data-testid="llama-cpp-browser-file"]').element.disabled).toBe(true);
    expect(accept).not.toHaveBeenCalled();
    expect(fixture.capture).not.toHaveBeenCalled();
  });

  it('mounts the existing linked-folder UI on explicit mode selection without selecting a model', async () => {
    const accept = vi.fn<AcceptInput>();
    const wrapper = await renderRecovery({ disabled: false, acceptLocalInput: accept });
    expect(fixture.linkedSetup).not.toHaveBeenCalled();
    await wrapper.get('[data-testid="llama-import-mode-host"]').trigger('click');
    await settleViews();
    expect(wrapper.find('[data-testid="existing-linked-folders"]').exists()).toBe(true);
    expect(wrapper.get('[data-testid="gguf-local-recovery"]').text()).toContain('choose the model from the model list');
    expect(fixture.linkedSetup).toHaveBeenCalledOnce();
    expect(fixture.importSetup).not.toHaveBeenCalled();
    expect(accept).not.toHaveBeenCalled();
  });

  it('reuses the existing import workflow when no chat owner is supplied', async () => {
    const wrapper = await renderRecovery({ disabled: false, acceptLocalInput: undefined });
    await settleViews();
    expect(wrapper.find('[data-testid="existing-model-import"]').exists()).toBe(true);
    expect(wrapper.find('[data-testid="llama-cpp-browser-file"]').exists()).toBe(false);
    expect(wrapper.get('[data-testid="gguf-local-recovery"]').text()).toContain('choose the model from the model list');
    expect(fixture.importSetup).toHaveBeenCalledOnce();
    expect(fixture.capture).not.toHaveBeenCalled();
  });

  it('contains an owner rejection locally and allows another explicit selection', async () => {
    const accept = vi.fn<AcceptInput>().mockRejectedValue(new Error('Private owner error'));
    const wrapper = await renderRecovery({ disabled: false, acceptLocalInput: accept });
    const input = wrapper.get<HTMLInputElement>('[data-testid="llama-cpp-browser-file"]');
    Object.defineProperty(input.element, 'files', { configurable: true, value: [new File(['gguf'], 'model.gguf')] });
    await input.trigger('change');
    await flushPromises();
    expect(wrapper.get('[data-testid="gguf-local-recovery-error"]').text()).toBe('Could not open the local model files.');
    expect(wrapper.text()).not.toContain('Private owner error');
    expect(input.element.disabled).toBe(false);
    await input.trigger('change');
    await flushPromises();
    expect(accept).toHaveBeenCalledTimes(2);
  });

  it('isolates a file-view failure from the original error and optional CSP sibling', async () => {
    fixture.importFails = true;
    fixture.cspVisible = true;
    const applicationError = vi.fn();
    const wrapper = mount(defineComponent({ render: () => h('div', [h('p', { 'data-testid': 'original-error' }, 'Download failed'), h(HuggingFaceDownloadFailureHint, undefined, { default: () => h(LlamaCppBrowserLocalFileRecovery, { disabled: false, acceptLocalInput: undefined }) })]) }), { global: { config: { errorHandler: applicationError } } });
    await wrapper.get('[data-testid="hf-download-failure-trigger"]').trigger('click');
    await settleViews();
    expect(wrapper.get('[data-testid="original-error"]').text()).toBe('Download failed');
    expect(wrapper.find('[data-testid="optional-csp"]').exists()).toBe(true);
    expect(wrapper.find('[data-testid="gguf-local-recovery-error"]').exists()).toBe(true);
    expect(applicationError).not.toHaveBeenCalled();
  });
});
