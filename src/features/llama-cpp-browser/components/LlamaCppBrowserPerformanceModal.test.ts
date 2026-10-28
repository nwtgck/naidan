import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ensureAllStringsForTest } from '@/strings/utils.test-support';
import { flushPromises, mount } from '@vue/test-utils';
import { shallowRef } from 'vue';
import type { LlamaCppBrowserService } from '@/features/llama-cpp-browser/service-contract';
import { performancePlan, performanceReport } from '@/features/llama-cpp-browser/test-utils/performance.test-support';
import LlamaCppBrowserPerformanceModal from './LlamaCppBrowserPerformanceModal.vue';

const mocks = vi.hoisted(() => ({
  hosted: vi.fn(() => true),
  listModelEntries: vi.fn<LlamaCppBrowserService['listModelEntries']>(),
  probeProfiles: vi.fn<LlamaCppBrowserService['probeProfiles']>(),
  runPerformanceOperation: vi.fn<LlamaCppBrowserService['runPerformanceOperation']>(),
  getOptions: vi.fn(() => ({ profile: 'auto' as const })),
  unsubscribe: vi.fn(),
  archive: vi.fn(),
  jobs: [] as never[],
}));
vi.mock('@/features/llama-cpp-browser/performance/profiling-mode', async importOriginal => ({
  ...await importOriginal<typeof import('@/features/llama-cpp-browser/performance/profiling-mode')>(),
  buildAllowsGpuProfiling: mocks.hosted,
}));
vi.mock('@/features/llama-cpp-browser', () => ({
  llamaCppBrowserService: {
    listModelEntries: mocks.listModelEntries,
    probeProfiles: mocks.probeProfiles,
    runPerformanceOperation: mocks.runPerformanceOperation,
    getOptions: mocks.getOptions,
    getState: () => ({ status: 'idle' }),
    subscribe: () => mocks.unsubscribe,
  },
}));
vi.mock('@/features/llama-cpp-browser/hugging-face/download-queue', () => ({
  getDownloadQueue: () => ({ jobs: shallowRef(mocks.jobs) }),
  jobIsBusy: () => false,
}));
vi.mock('@/features/llama-cpp-browser/performance/archive', () => ({ performanceArchive: mocks.archive }));
// String loading is outside this workflow suite; retain the real English UI.
let wrapper: ReturnType<typeof mount<typeof LlamaCppBrowserPerformanceModal>> | undefined;

beforeEach(async () => {
  vi.resetAllMocks();
  mocks.hosted.mockReturnValue(true);
  mocks.getOptions.mockReturnValue({ profile: 'auto' });
  mocks.listModelEntries.mockResolvedValue(performancePlan({ models: 2 }).models);
  mocks.probeProfiles.mockResolvedValue({ recommended: 'webgpu-wasm64-jspi', profiles: [{ profile: 'webgpu-wasm64-jspi', status: 'available' }] });
  mocks.archive.mockResolvedValue(new Blob(['zip']));
  mocks.runPerformanceOperation.mockImplementation(async ({ options, signal, operation }) => operation({
    scope: {
      options,
      signal: signal ?? new AbortController().signal,
      generate: async ({ onEvent, onSummary }) => {
        await onEvent({ event: { type: 'text', text: 'answer' } });
        onSummary({ diagnostic: performanceReport() });
        return { content: 'answer', reasoningContent: '', toolCalls: [], finishReason: 'stop' };
      },
    },
  }));
  Object.defineProperty(navigator, 'wakeLock', { configurable: true, value: undefined });
  Object.defineProperty(document, 'hidden', { configurable: true, value: false });
  Object.defineProperty(HTMLDialogElement.prototype, 'showModal', {
    configurable: true,
    value() {
      this.setAttribute('open', '');
    },
  });
  Object.defineProperty(HTMLDialogElement.prototype, 'close', {
    configurable: true,
    value() {
      this.removeAttribute('open');
    },
  });
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
  Object.defineProperty(URL, 'createObjectURL', { configurable: true, writable: true, value: vi.fn(() => 'blob:result') });
  Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, writable: true, value: vi.fn() });
  await ensureAllStringsForTest({ locale: 'en' });
});

async function saveManually(): Promise<void> {
  await vi.waitFor(() => expect(wrapper!.get<HTMLButtonElement>('[data-testid="llama-performance-download"]').element.disabled).toBe(false));
  expect(mocks.archive).not.toHaveBeenCalled();
  expect(HTMLAnchorElement.prototype.click).not.toHaveBeenCalled();
  await wrapper!.get('[data-testid="llama-performance-download"]').trigger('click');
  await vi.waitFor(() => expect(mocks.archive).toHaveBeenCalledOnce());
}

afterEach(() => {
  wrapper?.unmount();
  wrapper = undefined;
  vi.restoreAllMocks();
});

describe('in-app llama performance screen', () => {
  it('opens, selects the default model and probes support without loading a runtime or generating', async () => {
    wrapper = mount(LlamaCppBrowserPerformanceModal, { props: { isOpen: true, defaultModel: 'user/m0' }, attachTo: document.body });
    await flushPromises();
    const models = wrapper.findAll<HTMLInputElement>('[data-testid="llama-performance-model"]');
    expect(models).toHaveLength(2);
    expect(models[0]?.element.checked).toBe(true);
    expect(models[1]?.element.checked).toBe(false);
    expect(wrapper.find('dialog').attributes()).toHaveProperty('open');
    expect(mocks.probeProfiles).toHaveBeenCalledOnce();
    expect(mocks.runPerformanceOperation).not.toHaveBeenCalled();
    expect(document.activeElement?.id).toBe('llama-performance-heading');
  });

  it('keeps text as the default and explicitly selects a fixed image workload with separate initial/resident runs', async () => {
    wrapper = mount(LlamaCppBrowserPerformanceModal, { props: { isOpen: true, defaultModel: 'user/m0' } });
    await flushPromises();
    expect(wrapper.get<HTMLInputElement>('[data-testid="llama-performance-workload-text"]').element.checked).toBe(true);
    await wrapper.get('[data-testid="llama-performance-workload-vision"]').setValue(true);
    expect(wrapper.get('[data-testid="llama-performance-vision-help"]').text()).toContain('512');
    expect(wrapper.get<HTMLInputElement>('[data-testid="llama-performance-diagnostic"]').element.disabled).toBe(true);
    await wrapper.get('[data-testid="llama-performance-start"]').trigger('click');
    await saveManually();
    const saved = mocks.archive.mock.calls[0]![0].snapshot;
    expect(saved.plan.protocol).toBe('targeted-vision-en-v1');
    expect(saved.plan.steps).toHaveLength(2);
    expect(saved.plan.steps.map((step: { vision: { residency: string } }) => step.vision.residency)).toEqual(['cold', 'warm']);
    expect(saved.q8KernelDiagnostic).toBeUndefined();
  });

  it('runs multiple selected models with one click, exports only on a separate click and retains results on close', async () => {
    wrapper = mount(LlamaCppBrowserPerformanceModal, { props: { isOpen: true, defaultModel: 'user/m0' } });
    await flushPromises();
    await wrapper.findAll<HTMLInputElement>('[data-testid="llama-performance-model"]')[1]!.setValue(true);
    await wrapper.get('[data-testid="llama-performance-start"]').trigger('click');
    await saveManually();
    expect(mocks.runPerformanceOperation).toHaveBeenCalledTimes(2);
    const exported = mocks.archive.mock.calls[0]![0].snapshot;
    expect(exported.trials).toHaveLength(12);
    expect(exported.plan.options.profile).toBe('webgpu-wasm64-jspi');
    await wrapper.get('[data-testid="llama-performance-back"]').trigger('click');
    expect(wrapper.emitted('close')).toHaveLength(1);
    await wrapper.setProps({ isOpen: false });
    await wrapper.setProps({ isOpen: true });
    await flushPromises();
    expect(wrapper.find('[data-testid="llama-performance-download"]').exists()).toBe(true);
    expect(mocks.runPerformanceOperation).toHaveBeenCalledTimes(2);
  });

  it('stops on leaving the modal, retains a recoverable partial result, and does not auto-download cancellation', async () => {
    mocks.runPerformanceOperation.mockImplementationOnce(({ signal }) => new Promise((_, reject) => {
      signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true });
    }));
    wrapper = mount(LlamaCppBrowserPerformanceModal, { props: { isOpen: true, defaultModel: 'user/m0' } });
    await flushPromises();
    await wrapper.get('[data-testid="llama-performance-start"]').trigger('click');
    await vi.waitFor(() => expect(mocks.runPerformanceOperation).toHaveBeenCalledOnce());
    await wrapper.setProps({ isOpen: false });
    await flushPromises();
    expect(mocks.archive).not.toHaveBeenCalled();
    await wrapper.setProps({ isOpen: true });
    await flushPromises();
    expect(wrapper.get<HTMLButtonElement>('[data-testid="llama-performance-download"]').element.disabled).toBe(false);
    await wrapper.get('[data-testid="llama-performance-download"]').trigger('click');
    await flushPromises();
    expect(mocks.archive.mock.calls[0]![0].snapshot.status).toBe('cancelled');
  });

  it('shows actual model-loading progress without treating an output limit as a completion estimate', async () => {
    mocks.runPerformanceOperation.mockImplementationOnce(async ({ options, signal, operation }) => operation({
      scope: {
        options,
        signal: signal ?? new AbortController().signal,
        generate: ({ onProgress, signal: requestSignal }) => new Promise((_, reject) => {
          onProgress?.({ progress: { phase: 'loading', completed: 0.5, total: 1 } });
          requestSignal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true });
        }),
      },
    }));
    wrapper = mount(LlamaCppBrowserPerformanceModal, { props: { isOpen: true, defaultModel: 'user/m0' } });
    await flushPromises();
    await wrapper.get('[data-testid="llama-performance-start"]').trigger('click');
    await vi.waitFor(() => expect(wrapper!.find('[data-testid="model-load-percentage"]').text()).toBe('50%'));
    await wrapper.get('[data-testid="llama-performance-stop"]').trigger('click');
    await flushPromises();
    expect(wrapper.find('[data-testid="model-load-percentage"]').exists()).toBe(false);
  });

  it('does not wait indefinitely for an optional wake lock before running', async () => {
    Object.defineProperty(navigator, 'wakeLock', { configurable: true, value: { request: () => new Promise(() => {}) } });
    wrapper = mount(LlamaCppBrowserPerformanceModal, { props: { isOpen: true, defaultModel: 'user/m0' } });
    await flushPromises();
    await wrapper.get('[data-testid="llama-performance-start"]').trigger('click');
    await saveManually();
    expect(mocks.runPerformanceOperation).toHaveBeenCalledOnce();
  });

  it('exports completed results without waiting for an optional wake-lock release', async () => {
    const release = vi.fn(() => new Promise<void>(() => {}));
    Object.defineProperty(navigator, 'wakeLock', { configurable: true, value: { request: async () => ({ release }) } });
    wrapper = mount(LlamaCppBrowserPerformanceModal, { props: { isOpen: true, defaultModel: 'user/m0' } });
    await flushPromises();
    await wrapper.get('[data-testid="llama-performance-start"]').trigger('click');
    await saveManually();
    expect(release).toHaveBeenCalledOnce();
    expect(wrapper.get<HTMLButtonElement>('[data-testid="llama-performance-download"]').element.disabled).toBe(false);
  });

  it('does not silently substitute a CPU backend when auto has no WebGPU', async () => {
    mocks.probeProfiles.mockResolvedValue({ recommended: 'cpu-wasm32', profiles: [{ profile: 'cpu-wasm32', status: 'available' }] });
    wrapper = mount(LlamaCppBrowserPerformanceModal, { props: { isOpen: true, defaultModel: 'user/m0' } });
    await flushPromises();
    await wrapper.get('[data-testid="llama-performance-start"]').trigger('click');
    await saveManually();
    expect(mocks.runPerformanceOperation).not.toHaveBeenCalled();
    expect(mocks.archive.mock.calls[0]![0].snapshot.modelErrors[0].error).toContain('WebGPU is unavailable');
  });
});

it('accepts a multiline model draft on start, preserves its order, and performs no inference while editing', async () => {
  wrapper = mount(LlamaCppBrowserPerformanceModal, { props: { isOpen: true, defaultModel: undefined } });
  await flushPromises();
  await wrapper.get('[data-testid="llama-performance-model-input"]').setValue(`\
user/m1
user/m0`);
  expect(mocks.runPerformanceOperation).not.toHaveBeenCalled();
  await wrapper.get('[data-testid="llama-performance-start"]').trigger('click');
  await saveManually();
  expect(mocks.archive.mock.calls[0]![0].snapshot.plan.models.map((model: { modelId: string }) => model.modelId)).toEqual(['user/m1', 'user/m0']);
});

it('keeps invalid multiline input visible and does not run a partial list', async () => {
  wrapper = mount(LlamaCppBrowserPerformanceModal, { props: { isOpen: true, defaultModel: undefined } });
  await flushPromises();
  await wrapper.get('[data-testid="llama-performance-model-input"]').setValue(`\
user/m1
missing`);
  await wrapper.get('[data-testid="llama-performance-model-input"]').trigger('keydown', { key: 'Enter' });
  expect(wrapper.find('[role="alert"]').text()).toContain('Line 2');
  expect(wrapper.get<HTMLButtonElement>('[data-testid="llama-performance-start"]').element.disabled).toBe(true);
  expect(mocks.runPerformanceOperation).not.toHaveBeenCalled();
});

describe('Transformers.js model-list interaction parity', () => {
  async function open(): Promise<void> {
    wrapper = mount(LlamaCppBrowserPerformanceModal, { props: { isOpen: true, defaultModel: undefined } });
    await flushPromises();
  }
  const draft = () => wrapper!.get<HTMLTextAreaElement>('[data-testid="llama-performance-model-input"]');
  const rows = () => wrapper!.findAll('[data-testid="llama-performance-target-row"]');
  const copy = () => wrapper!.get<HTMLButtonElement>('[data-testid="llama-performance-copy-models"]');

  it('places full-width committed rows before the two-line draft, with no Add button', async () => {
    await open();
    await draft().setValue(`\
user/m1
user/m0`);
    await draft().trigger('keydown', { key: 'Enter' });
    expect(rows().map(row => row.get('span[title]').attributes('title'))).toEqual(['user/m1', 'user/m0']);
    expect(draft().element.value).toBe('');
    expect(draft().attributes('rows')).toBe('2');
    expect(wrapper!.find('[data-testid="llama-performance-add-models"]').exists()).toBe(false);
    expect(wrapper!.get('[data-testid="llama-performance-target-list"]').element.compareDocumentPosition(draft().element) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(wrapper!.get('[data-testid="llama-performance-saved-models"]').attributes('open')).toBeUndefined();
    await rows()[0]!.get('button').trigger('click');
    expect(rows().map(row => row.get('span[title]').attributes('title'))).toEqual(['user/m0']);
  });

  it.each(['user/m1', `\
user/m1
user/m0
user/m1`])('commits single/multiline paste atomically in input order: %s', async text => {
    await open();
    await draft().trigger('paste', { clipboardData: { getData: () => text } });
    expect(rows().map(row => row.get('span[title]').attributes('title'))).toEqual(text.includes('\n') ? ['user/m1', 'user/m0'] : ['user/m1']);
    expect(draft().element.value).toBe('');
    expect(mocks.listModelEntries).toHaveBeenCalledOnce();
    expect(mocks.runPerformanceOperation).not.toHaveBeenCalled();
  });

  it('appends pasted lines to the existing draft instead of replacing the selected text', async () => {
    await open();
    await draft().setValue('user/m0');
    draft().element.select();
    await draft().trigger('paste', { clipboardData: { getData: () => 'user/m1' } });
    expect(rows().map(row => row.get('span[title]').attributes('title'))).toEqual(['user/m0', 'user/m1']);
  });

  it('leaves an invalid pasted batch editable, with live errors and no partial commit', async () => {
    await open();
    await draft().setValue('user/m0');
    await draft().trigger('paste', { clipboardData: { getData: () => 'missing' } });
    expect(rows()).toHaveLength(0);
    expect(draft().element.value).toBe(`\
user/m0
missing`);
    expect(wrapper!.get('[data-testid="llama-performance-model-input-errors"]').text()).toContain('Line 2');
    expect(copy().element.disabled).toBe(true);
    await draft().setValue(`\
user/m0
user/m1`);
    expect(wrapper!.find('[data-testid="llama-performance-model-input-errors"]').exists()).toBe(false);
    await draft().trigger('keydown', { key: 'Enter' });
    expect(rows()).toHaveLength(2);
  });

  it.each([{ shiftKey: true }, { isComposing: true }, { keyCode: 229 }])('does not commit Shift+Enter or composition: %j', async extra => {
    await open();
    await draft().setValue('user/m0');
    await draft().trigger('keydown', { key: 'Enter', ...extra });
    expect(rows()).toHaveLength(0);
    expect(draft().element.value).toBe('user/m0');
  });

  it('copies canonical IDs including valid draft, deduplicates, and ignores clipboard failure', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
    await open();
    await draft().setValue('user/m1');
    await draft().trigger('keydown', { key: 'Enter' });
    await draft().setValue(`\
user/m0
user/m1`);
    await copy().trigger('click');
    await flushPromises();
    expect(writeText).toHaveBeenLastCalledWith(`\
user/m1
user/m0`);
    expect(rows()).toHaveLength(1);
    writeText.mockRejectedValueOnce(new Error('denied'));
    await copy().trigger('click');
    await flushPromises();
    expect(draft().element.value).toBe(`\
user/m0
user/m1`);
    expect(wrapper!.find('[data-testid="llama-performance-model-input-errors"]').exists()).toBe(false);
    await draft().setValue('missing');
    expect(copy().element.disabled).toBe(true);
  });
});

it('never exports on completion/reopen, serializes manual saves, and retains results after export failure', async () => {
  wrapper = mount(LlamaCppBrowserPerformanceModal, { props: { isOpen: true, defaultModel: 'user/m0' } });
  await flushPromises();
  await wrapper.get('[data-testid="llama-performance-start"]').trigger('click');
  await vi.waitFor(() => expect(wrapper!.get<HTMLButtonElement>('[data-testid="llama-performance-download"]').element.disabled).toBe(false));
  expect(mocks.archive).not.toHaveBeenCalled();
  await wrapper.setProps({ isOpen: false });
  await wrapper.setProps({ isOpen: true });
  await flushPromises();
  expect(mocks.archive).not.toHaveBeenCalled();
  const pending = Promise.withResolvers<Blob>();
  mocks.archive.mockReturnValueOnce(pending.promise);
  await wrapper.get('[data-testid="llama-performance-download"]').trigger('click');
  await flushPromises();
  await wrapper.get('[data-testid="llama-performance-download"]').trigger('click');
  expect(mocks.archive).toHaveBeenCalledOnce();
  pending.reject(new Error('export fixture failure'));
  await flushPromises();
  expect(wrapper.get('[role="alert"]').text()).toContain('export fixture failure');
  await wrapper.get('[data-testid="llama-performance-download"]').trigger('click');
  await flushPromises();
  expect(mocks.archive).toHaveBeenCalledTimes(2);
  expect(mocks.archive.mock.calls[0]![0].snapshot.plan.id).toBe(mocks.archive.mock.calls[1]![0].snapshot.plan.id);
});

describe('profiling modes and safe result actions', () => {
  function available(): void {
    mocks.probeProfiles.mockResolvedValue({
      recommended: 'webgpu-wasm64-jspi',
      profiles: [
        { profile: 'webgpu-wasm64-jspi', status: 'available' },
        { profile: 'webgpu-wasm64-jspi-gpu-profile', status: 'available' },
      ],
    });
  }
  async function open(): Promise<void> {
    wrapper = mount(LlamaCppBrowserPerformanceModal, { props: { isOpen: true, defaultModel: 'user/m0' } });
    await flushPromises();
  }

  it('defaults to profiling in Hosted when the artifact and browser support it', async () => {
    available();
    await open();
    expect(wrapper!.get<HTMLInputElement>('[data-testid="llama-performance-mode-gpu-profile"]').element.checked).toBe(true);
    await wrapper!.get('[data-testid="llama-performance-start"]').trigger('click');
    await saveManually();
    expect(mocks.runPerformanceOperation).toHaveBeenCalledTimes(2);
    expect(mocks.runPerformanceOperation.mock.calls[0]![0].options.profile).toBe('webgpu-wasm64-jspi-gpu-profile');
    expect(mocks.archive.mock.calls[0]![0].snapshot.trials).toHaveLength(6);
  });

  it.each(['standard', 'both'] as const)('allows %s and runs exactly the selected lanes', async mode => {
    available();
    await open();
    await wrapper!.get(`[data-testid="llama-performance-mode-${mode}"]`).setValue(true);
    await wrapper!.get('[data-testid="llama-performance-start"]').trigger('click');
    await saveManually();
    expect(mocks.runPerformanceOperation.mock.calls.map(([args]) => args.options.profile)).toEqual(mode === 'both' ? ['webgpu-wasm64-jspi', 'webgpu-wasm64-jspi-gpu-profile', 'webgpu-wasm64-jspi-gpu-profile'] : ['webgpu-wasm64-jspi']);
    expect(mocks.archive.mock.calls[0]![0].snapshot.trials).toHaveLength(mode === 'both' ? 12 : 6);
    expect(mocks.archive.mock.calls[0]![0].snapshot.plan.settings.mode).toBe(mode);
  });

  it('offers ordinary measurement with an explanation when the artifact is absent', async () => {
    await open();
    expect(wrapper!.get<HTMLInputElement>('[data-testid="llama-performance-mode-standard"]').element.checked).toBe(true);
    expect(wrapper!.get<HTMLInputElement>('[data-testid="llama-performance-mode-gpu-profile"]').element.disabled).toBe(true);
    expect(wrapper!.get<HTMLInputElement>('[data-testid="llama-performance-mode-both"]').element.disabled).toBe(true);
    expect(wrapper!.text()).toContain('The installed runtime package does not include GPU profiling.');
  });

  it('never enables profiling in standalone, even if a stale capability report says available', async () => {
    mocks.hosted.mockReturnValue(false);
    available();
    await open();
    expect(wrapper!.get<HTMLInputElement>('[data-testid="llama-performance-mode-standard"]').element.checked).toBe(true);
    expect(wrapper!.get<HTMLInputElement>('[data-testid="llama-performance-mode-both"]').element.disabled).toBe(true);
    expect(wrapper!.text()).toContain('GPU profiling is available in Hosted mode only.');
  });

  it('rechecks capabilities on Start instead of silently replacing a requested diagnostic run', async () => {
    available();
    await open();
    mocks.probeProfiles.mockResolvedValue({
      recommended: 'webgpu-wasm64-jspi',
      profiles: [
        { profile: 'webgpu-wasm64-jspi', status: 'available' },
        { profile: 'webgpu-wasm64-jspi-gpu-profile', status: 'unavailable', reason: 'timestamp-query' },
      ],
    });
    await wrapper!.get('[data-testid="llama-performance-start"]').trigger('click');
    await flushPromises();
    expect(mocks.runPerformanceOperation).not.toHaveBeenCalled();
    expect(wrapper!.get('[role="alert"]').text()).toContain('timestamp-query');
  });

  it('makes Save ZIP the primary right-hand action and keeps replacement secondary on the left', async () => {
    await open();
    await wrapper!.get('[data-testid="llama-performance-start"]').trigger('click');
    await vi.waitFor(() => expect(wrapper!.get<HTMLButtonElement>('[data-testid="llama-performance-download"]').element.disabled).toBe(false));
    const replace = wrapper!.get('[data-testid="llama-performance-start"]');
    const save = wrapper!.get('[data-testid="llama-performance-download"]');
    expect(replace.element.compareDocumentPosition(save.element) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(save.classes()).toContain('border-blue-300/80');
    expect(replace.classes()).not.toContain('border-blue-300/80');
    expect(replace.classes()).toContain('border');
  });

  it('uses the same public modelId for display, title and copying', async () => {
    const model = { ...performancePlan().models[0]!, modelId: 'host/MyModels1/unsloth/Qwen3.8-Flash-Next-GGUF:UD-Q4_K_XL' };
    mocks.listModelEntries.mockResolvedValue([model]);
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
    wrapper = mount(LlamaCppBrowserPerformanceModal, { props: { isOpen: true, defaultModel: model.modelId } });
    await flushPromises();
    const label = wrapper.get('[data-testid="llama-performance-target-row"] span[title]');
    expect(label.text()).toBe(model.modelId);
    expect(label.attributes('title')).toBe(model.modelId);
    await wrapper.get('[data-testid="llama-performance-copy-models"]').trigger('click');
    expect(writeText).toHaveBeenCalledExactlyOnceWith(model.modelId);
  });
});

describe('current-trial interruption controls', () => {
  it('drains partial evidence, keeps Stop available and waits for retirement before continuing', async () => {
    const released = Promise.withResolvers<void>();
    using _cleanup = {
      [Symbol.dispose]() {
        released.resolve();
      },
    };
    mocks.runPerformanceOperation.mockImplementationOnce(async ({ options, signal, operation }) => {
      await using _retire = {
        async [Symbol.asyncDispose]() {
          await released.promise;
        },
      };
      await operation({
        scope: {
          options,
          signal: signal!,
          generate: async args => {
            await args.onEvent({ event: { type: 'text', text: 'partial from slow model' } });
            await new Promise<void>(resolve => args.signal.addEventListener('abort', () => resolve(), { once: true }));
            args.onSummary({ diagnostic: performanceReport({ outcome: 'aborted' }) });
            args.onMemoryDiagnostics?.({ memory: { samples: [], droppedSamples: 0, nativeAllocations: [], droppedNativeAllocations: 0, nativeSettings: [], droppedNativeSettings: 0 } });
            throw new DOMException('Interrupted', 'AbortError');
          },
        },
      });
    });
    wrapper = mount(LlamaCppBrowserPerformanceModal, { props: { isOpen: true, defaultModel: 'user/m0' } });
    await flushPromises();
    await wrapper.get('[data-testid="llama-performance-start"]').trigger('click');
    await vi.waitFor(() => expect(wrapper!.get<HTMLButtonElement>('[data-testid="llama-performance-interrupt"]').element.disabled).toBe(false));
    await wrapper.get('[data-testid="llama-performance-interrupt"]').trigger('click');
    await flushPromises();
    expect(wrapper.get<HTMLButtonElement>('[data-testid="llama-performance-interrupt"]').element.disabled).toBe(true);
    expect(wrapper.get('[data-testid="llama-performance-interrupting"]').text()).toContain('Interrupting and preparing the next trial…');
    expect(wrapper.get<HTMLButtonElement>('[data-testid="llama-performance-stop"]').element.disabled).toBe(false);
    expect(wrapper.get<HTMLButtonElement>('[data-testid="llama-performance-download"]').element.disabled).toBe(true);
    expect(mocks.runPerformanceOperation).toHaveBeenCalledOnce();
    expect(mocks.archive).not.toHaveBeenCalled();
    released.resolve();
    await saveManually();
    const snapshot = mocks.archive.mock.calls[0]![0].snapshot;
    expect(snapshot.status).toBe('completed');
    expect(snapshot.trials).toHaveLength(6);
    expect(snapshot.trials[0]).toMatchObject({ status: 'interrupted', partialText: 'partial from slow model', interruption: { recovery: 'new-scope' }, summary: { performance: { outcome: 'aborted' } }, memoryDiagnostics: { samples: [] } });
    expect(snapshot.trials.slice(1).every((trial: { status: string }) => trial.status === 'succeeded')).toBe(true);
    expect(mocks.runPerformanceOperation).toHaveBeenCalledTimes(2);
  });

  it('keeps the interruption button disabled while acquiring rather than accidentally skipping a future trial', async () => {
    mocks.runPerformanceOperation.mockImplementationOnce(({ signal }) => new Promise((_, reject) => {
      signal?.addEventListener('abort', () => reject(new DOMException('Stopped', 'AbortError')), { once: true });
    }));
    wrapper = mount(LlamaCppBrowserPerformanceModal, { props: { isOpen: true, defaultModel: 'user/m0' } });
    await flushPromises();
    await wrapper.get('[data-testid="llama-performance-start"]').trigger('click');
    await vi.waitFor(() => expect(mocks.runPerformanceOperation).toHaveBeenCalledOnce());
    expect(wrapper.get<HTMLButtonElement>('[data-testid="llama-performance-interrupt"]').element.disabled).toBe(true);
    await wrapper.get('[data-testid="llama-performance-stop"]').trigger('click');
    await saveManually();
    expect(mocks.archive.mock.calls[0]![0].snapshot.status).toBe('cancelled');
    expect(mocks.runPerformanceOperation).toHaveBeenCalledOnce();
  });

  it('lets Stop during interrupted-scope retirement cancel the remaining plan', async () => {
    const released = Promise.withResolvers<void>();
    using _cleanup = {
      [Symbol.dispose]() {
        released.resolve();
      },
    };
    mocks.runPerformanceOperation.mockImplementationOnce(async ({ options, signal, operation }) => {
      await using _retire = {
        async [Symbol.asyncDispose]() {
          await released.promise;
        },
      };
      await operation({
        scope: {
          options,
          signal: signal!,
          generate: async args => {
            await args.onEvent({ event: { type: 'reasoning', text: 'saved partial reasoning' } });
            await new Promise<void>(resolve => args.signal.addEventListener('abort', () => resolve(), { once: true }));
            throw new DOMException('Interrupted', 'AbortError');
          },
        },
      });
    });
    wrapper = mount(LlamaCppBrowserPerformanceModal, { props: { isOpen: true, defaultModel: 'user/m0' } });
    await flushPromises();
    await wrapper.get('[data-testid="llama-performance-start"]').trigger('click');
    await vi.waitFor(() => expect(wrapper!.get<HTMLButtonElement>('[data-testid="llama-performance-interrupt"]').element.disabled).toBe(false));
    await wrapper.get('[data-testid="llama-performance-interrupt"]').trigger('click');
    await flushPromises();
    await wrapper.get('[data-testid="llama-performance-stop"]').trigger('click');
    expect(wrapper.get<HTMLButtonElement>('[data-testid="llama-performance-stop"]').element.disabled).toBe(true);
    released.resolve();
    await saveManually();
    const snapshot = mocks.archive.mock.calls[0]![0].snapshot;
    expect(snapshot.status).toBe('cancelled');
    expect(snapshot.trials[0]).toMatchObject({ status: 'interrupted', interruption: { recovery: 'stopped' }, partialReasoning: 'saved partial reasoning' });
    expect(snapshot.trials.slice(1).every((trial: { status: string }) => trial.status === 'skipped')).toBe(true);
    expect(mocks.runPerformanceOperation).toHaveBeenCalledOnce();
  });
});

it('does not redirect a queued click on the old button to the next trial', async () => {
  const observed: AbortSignal[] = [];
  mocks.runPerformanceOperation.mockImplementation(async ({ options, signal, operation }) => operation({
    scope: {
      options,
      signal: signal!,
      generate: async args => {
        observed.push(args.signal);
        await new Promise<void>(resolve => args.signal.addEventListener('abort', () => resolve(), { once: true }));
        throw new DOMException('Aborted', 'AbortError');
      },
    },
  }));
  wrapper = mount(LlamaCppBrowserPerformanceModal, { props: { isOpen: true, defaultModel: 'user/m0' } });
  await flushPromises();
  await wrapper.get('[data-testid="llama-performance-start"]').trigger('click');
  await vi.waitFor(() => expect(observed).toHaveLength(1));
  const button = wrapper.get<HTMLButtonElement>('[data-testid="llama-performance-interrupt"]');
  const previous = button.element;
  await button.trigger('click');
  await vi.waitFor(() => expect(observed).toHaveLength(2));
  await flushPromises();
  expect(wrapper.get('[data-testid="llama-performance-interrupt"]').element).not.toBe(previous);
  previous.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  expect(observed[0]!.aborted).toBe(true);
  expect(observed[1]!.aborted).toBe(false);
  await wrapper.get('[data-testid="llama-performance-stop"]').trigger('click');
  await saveManually();
  expect(mocks.runPerformanceOperation).toHaveBeenCalledTimes(2);
});
