import { createRouter, createMemoryHistory, createWebHashHistory, type Router } from 'vue-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ensureAllStringsForTest } from '@/strings/utils.test-support';
import { flushPromises, mount } from '@vue/test-utils';
import { shallowRef } from 'vue';
import type { LlamaCppBrowserService } from '@/features/llama-cpp-browser/service-contract';
import { performancePlan, performanceReport } from '@/features/llama-cpp-browser/test-utils/performance.test-support';
import LlamaCppBrowserDiagnosticsPage from './LlamaCppBrowserDiagnosticsPage.vue';

const mocks = vi.hoisted(() => ({
  hosted: vi.fn(() => true),
  listModelEntries: vi.fn<LlamaCppBrowserService['listModelEntries']>(),
  probeProfiles: vi.fn<LlamaCppBrowserService['probeProfiles']>(),
  runPerformanceOperation: vi.fn<LlamaCppBrowserService['runPerformanceOperation']>(),
  getOptions: vi.fn(() => ({ profile: 'auto' as const })),
  unsubscribe: vi.fn(),
  archive: vi.fn(),
  download: vi.fn(),
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
vi.mock('@/features/llama-cpp-browser/performance/archive', () => ({ createPerformanceArchiveStream: mocks.archive }));
vi.mock('@/utils/stream-download', () => ({ downloadReadableStream: mocks.download }));
// String loading is outside this workflow suite; retain the real English UI.
let router: Router;
let wrapper: ReturnType<typeof mount<typeof LlamaCppBrowserDiagnosticsPage>> | undefined;

beforeEach(async () => {
  vi.resetAllMocks();
  router = createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: '/', component: { template: '<div />' } },
      { path: '/settings/llama-cpp-browser', component: { template: '<div />' } },
      { path: '/llama-cpp-browser/diagnostics', component: { template: '<div />' } },
    ],
  });
  await router.push('/llama-cpp-browser/diagnostics');
  await router.isReady();
  mocks.hosted.mockReturnValue(true);
  mocks.getOptions.mockReturnValue({ profile: 'auto' });
  mocks.listModelEntries.mockResolvedValue(performancePlan({ models: 2 }).models);
  mocks.probeProfiles.mockResolvedValue({ recommended: 'webgpu-wasm64-jspi', profiles: [{ profile: 'webgpu-wasm64-jspi', status: 'available' }] });
  mocks.archive.mockImplementation(() => new ReadableStream({
    start(controller) {
      controller.close();
    },
  }));
  mocks.download.mockResolvedValue(undefined);
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

describe('in-app llama Diagnostics page', () => {
  it('opens, selects the default model and probes support without loading a runtime or generating', async () => {
    wrapper = mount(LlamaCppBrowserDiagnosticsPage, { global: { plugins: [router] }, props: { defaultModel: 'user/m0' }, attachTo: document.body });
    await flushPromises();
    const models = wrapper.findAll<HTMLInputElement>('[data-testid="llama-performance-model"]');
    expect(models).toHaveLength(2);
    expect(models[0]?.element.checked).toBe(true);
    expect(models[1]?.element.checked).toBe(false);
    expect(wrapper.find('dialog').exists()).toBe(false);
    expect(wrapper.find('[data-testid="llama-diagnostics-page"]').exists()).toBe(true);
    expect(mocks.probeProfiles).toHaveBeenCalledOnce();
    expect(mocks.runPerformanceOperation).not.toHaveBeenCalled();
    expect(document.activeElement?.id).toBe('llama-performance-heading');
  });

  it('keeps text as the default and explicitly selects a fixed image workload with separate initial/resident runs', async () => {
    wrapper = mount(LlamaCppBrowserDiagnosticsPage, { global: { plugins: [router] }, props: { defaultModel: 'user/m0' } });
    await flushPromises();
    expect(wrapper.get<HTMLInputElement>('[data-testid="llama-performance-workload-text"]').element.checked).toBe(true);
    await wrapper.get('[data-testid="llama-performance-workload-vision"]').setValue(true);
    expect(wrapper.get('[data-testid="llama-performance-vision-help"]').text()).toContain('512');
    expect(wrapper.get<HTMLInputElement>('[data-testid="llama-performance-diagnostic"]').element.disabled).toBe(true);
    await flushPromises();
    await wrapper.get('[data-testid="llama-performance-start"]').trigger('click');
    await saveManually();
    const saved = mocks.archive.mock.calls[0]![0].snapshot;
    expect(saved.plan.protocol).toBe('targeted-vision-en-v1');
    expect(saved.plan.steps).toHaveLength(2);
    expect(saved.plan.steps.map((step: { vision: { residency: string } }) => step.vision.residency)).toEqual(['cold', 'warm']);
    expect(saved.q8KernelDiagnostic).toBeUndefined();
  });

  it('runs multiple selected models with one click, exports only on a separate click and returns direct links to the top page', async () => {
    wrapper = mount(LlamaCppBrowserDiagnosticsPage, { global: { plugins: [router] }, props: { defaultModel: 'user/m0' } });
    await flushPromises();
    await wrapper.findAll<HTMLInputElement>('[data-testid="llama-performance-model"]')[1]!.setValue(true);
    await flushPromises();
    await wrapper.get('[data-testid="llama-performance-start"]').trigger('click');
    await saveManually();
    expect(mocks.runPerformanceOperation).toHaveBeenCalledTimes(2);
    const exported = mocks.archive.mock.calls[0]![0].snapshot;
    expect(exported.trials).toHaveLength(12);
    expect(exported.plan.options.profile).toBe('webgpu-wasm64-jspi');
    await wrapper.get('[data-testid="llama-performance-back"]').trigger('click');
    await flushPromises();
    expect(router.currentRoute.value.path).toBe('/');
    expect(mocks.runPerformanceOperation).toHaveBeenCalledTimes(2);
  });

  it('stops on leaving the page and does not auto-download cancellation', async () => {
    mocks.runPerformanceOperation.mockImplementationOnce(({ signal }) => new Promise((_, reject) => {
      signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true });
    }));
    wrapper = mount(LlamaCppBrowserDiagnosticsPage, { global: { plugins: [router] }, props: { defaultModel: 'user/m0' } });
    await flushPromises();
    await flushPromises();
    await wrapper.get('[data-testid="llama-performance-start"]').trigger('click');
    await vi.waitFor(() => expect(mocks.runPerformanceOperation).toHaveBeenCalledOnce());
    wrapper.unmount();
    wrapper = undefined;
    await flushPromises();
    expect(mocks.runPerformanceOperation.mock.calls[0]![0].signal?.aborted).toBe(true);
    expect(mocks.unsubscribe).toHaveBeenCalledOnce();
    expect(mocks.archive).not.toHaveBeenCalled();
    expect(mocks.download).not.toHaveBeenCalled();
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
    wrapper = mount(LlamaCppBrowserDiagnosticsPage, { global: { plugins: [router] }, props: { defaultModel: 'user/m0' } });
    await flushPromises();
    await flushPromises();
    await wrapper.get('[data-testid="llama-performance-start"]').trigger('click');
    await vi.waitFor(() => expect(wrapper!.find('[data-testid="model-load-percentage"]').text()).toBe('50%'));
    await wrapper.get('[data-testid="llama-performance-stop"]').trigger('click');
    await flushPromises();
    expect(wrapper.find('[data-testid="model-load-percentage"]').exists()).toBe(false);
  });

  it('does not wait indefinitely for an optional wake lock before running', async () => {
    Object.defineProperty(navigator, 'wakeLock', { configurable: true, value: { request: () => new Promise(() => {}) } });
    wrapper = mount(LlamaCppBrowserDiagnosticsPage, { global: { plugins: [router] }, props: { defaultModel: 'user/m0' } });
    await flushPromises();
    await flushPromises();
    await wrapper.get('[data-testid="llama-performance-start"]').trigger('click');
    await saveManually();
    expect(mocks.runPerformanceOperation).toHaveBeenCalledOnce();
  });

  it('exports completed results without waiting for an optional wake-lock release', async () => {
    const release = vi.fn(() => new Promise<void>(() => {}));
    Object.defineProperty(navigator, 'wakeLock', { configurable: true, value: { request: async () => ({ release }) } });
    wrapper = mount(LlamaCppBrowserDiagnosticsPage, { global: { plugins: [router] }, props: { defaultModel: 'user/m0' } });
    await flushPromises();
    await flushPromises();
    await wrapper.get('[data-testid="llama-performance-start"]').trigger('click');
    await saveManually();
    expect(release).toHaveBeenCalledOnce();
    expect(wrapper.get<HTMLButtonElement>('[data-testid="llama-performance-download"]').element.disabled).toBe(false);
  });

  it('does not silently substitute a CPU backend when auto has no WebGPU', async () => {
    mocks.probeProfiles.mockResolvedValue({ recommended: 'cpu-wasm32', profiles: [{ profile: 'cpu-wasm32', status: 'available' }] });
    wrapper = mount(LlamaCppBrowserDiagnosticsPage, { global: { plugins: [router] }, props: { defaultModel: 'user/m0' } });
    await flushPromises();
    await flushPromises();
    await wrapper.get('[data-testid="llama-performance-start"]').trigger('click');
    await saveManually();
    expect(mocks.runPerformanceOperation).not.toHaveBeenCalled();
    expect(mocks.archive.mock.calls[0]![0].snapshot.modelErrors[0].error).toContain('WebGPU is unavailable');
  });
});

it('accepts a multiline model draft on start, preserves its order, and performs no inference while editing', async () => {
  wrapper = mount(LlamaCppBrowserDiagnosticsPage, { global: { plugins: [router] }, props: { defaultModel: undefined } });
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
  wrapper = mount(LlamaCppBrowserDiagnosticsPage, { global: { plugins: [router] }, props: { defaultModel: undefined } });
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
    wrapper = mount(LlamaCppBrowserDiagnosticsPage, { global: { plugins: [router] }, props: { defaultModel: undefined } });
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

it('never exports on completion, serializes manual saves, and retains results after export failure', async () => {
  wrapper = mount(LlamaCppBrowserDiagnosticsPage, { global: { plugins: [router] }, props: { defaultModel: 'user/m0' } });
  await flushPromises();
  await wrapper.get('[data-testid="llama-performance-start"]').trigger('click');
  await vi.waitFor(() => expect(wrapper!.get<HTMLButtonElement>('[data-testid="llama-performance-download"]').element.disabled).toBe(false));
  expect(mocks.archive).not.toHaveBeenCalled();
  await flushPromises();
  expect(mocks.archive).not.toHaveBeenCalled();
  const pending = Promise.withResolvers<void>();
  mocks.download.mockReturnValueOnce(pending.promise);
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
    wrapper = mount(LlamaCppBrowserDiagnosticsPage, { global: { plugins: [router] }, props: { defaultModel: 'user/m0' } });
    await flushPromises();
  }

  it('defaults to profiling in Hosted when the artifact and browser support it', async () => {
    available();
    await open();
    expect(wrapper!.get<HTMLInputElement>('[data-testid="llama-performance-mode-gpu-profile"]').element.checked).toBe(true);
    await flushPromises();
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
    await flushPromises();
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
    await flushPromises();
    await wrapper!.get('[data-testid="llama-performance-start"]').trigger('click');
    await flushPromises();
    expect(mocks.runPerformanceOperation).not.toHaveBeenCalled();
    expect(wrapper!.get('[role="alert"]').text()).toContain('timestamp-query');
  });

  it('makes Save ZIP the primary right-hand action and keeps replacement secondary on the left', async () => {
    await open();
    await flushPromises();
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
    wrapper = mount(LlamaCppBrowserDiagnosticsPage, { global: { plugins: [router] }, props: { defaultModel: model.modelId } });
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
    wrapper = mount(LlamaCppBrowserDiagnosticsPage, { global: { plugins: [router] }, props: { defaultModel: 'user/m0' } });
    await flushPromises();
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
    wrapper = mount(LlamaCppBrowserDiagnosticsPage, { global: { plugins: [router] }, props: { defaultModel: 'user/m0' } });
    await flushPromises();
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
    wrapper = mount(LlamaCppBrowserDiagnosticsPage, { global: { plugins: [router] }, props: { defaultModel: 'user/m0' } });
    await flushPromises();
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
  wrapper = mount(LlamaCppBrowserDiagnosticsPage, { global: { plugins: [router] }, props: { defaultModel: 'user/m0' } });
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

describe('Diagnostics page URL contract', () => {
  const path = '/llama-cpp-browser/diagnostics';
  const availableProfiles = {
    recommended: 'webgpu-wasm64-jspi',
    profiles: [
      { profile: 'webgpu-wasm64-jspi', status: 'available' },
      { profile: 'webgpu-wasm64-jspi-gpu-profile', status: 'available' },
    ],
  } satisfies Awaited<ReturnType<LlamaCppBrowserService['probeProfiles']>>;

  it('keeps all-models and explicit mode during late initialization, ordinary edits and inventory refresh', async () => {
    const list = Promise.withResolvers<Awaited<ReturnType<LlamaCppBrowserService['listModelEntries']>>>();
    const probe = Promise.withResolvers<Awaited<ReturnType<LlamaCppBrowserService['probeProfiles']>>>();
    mocks.listModelEntries.mockReturnValueOnce(list.promise);
    mocks.probeProfiles.mockReturnValueOnce(probe.promise);
    await router.replace(path + '?all-models&mode=both&placement=1&obsolete=x');
    const replace = vi.spyOn(router, 'replace');
    using _cleanup = {
      [Symbol.dispose]() {
        replace.mockRestore();
      },
    };
    wrapper = mount(LlamaCppBrowserDiagnosticsPage, { global: { plugins: [router] }, props: { defaultModel: 'user/m0' } });
    await flushPromises();
    list.resolve(performancePlan({ models: 20 }).models);
    await flushPromises();
    probe.resolve(availableProfiles);
    await flushPromises();
    expect(wrapper.findAll('[data-testid="llama-performance-target-row"]')).toHaveLength(20);
    expect(wrapper.get<HTMLInputElement>('[data-testid="llama-performance-mode-both"]').element.checked).toBe(true);
    expect(wrapper.get<HTMLInputElement>('input[type="number"][max="5"]').element.value).toBe('1');
    expect(replace).not.toHaveBeenCalled();
    expect(mocks.runPerformanceOperation).not.toHaveBeenCalled();
    await wrapper.get('input[type="number"][max="5"]').setValue(3);
    await flushPromises();
    expect(router.currentRoute.value.query).toEqual({ 'all-models': null, mode: 'both', placement: '1', repeats: '3' });
    const calls = replace.mock.calls.length;
    mocks.listModelEntries.mockResolvedValueOnce(performancePlan({ models: 21 }).models);
    mocks.probeProfiles.mockResolvedValueOnce(availableProfiles);
    await wrapper.findAll('button').find(button => button.text() === 'Refresh models')!.trigger('click');
    await flushPromises();
    expect(wrapper.findAll('[data-testid="llama-performance-target-row"]')).toHaveLength(21);
    expect(replace).toHaveBeenCalledTimes(calls);
    await wrapper.findAll('[data-testid="llama-performance-model"]')[0]!.setValue(false);
    await flushPromises();
    expect(router.currentRoute.value.query['all-models']).toBeUndefined();
    expect(router.currentRoute.value.query.model).toHaveLength(20);
    await wrapper.findAll('[data-testid="llama-performance-model"]')[0]!.setValue(true);
    await flushPromises();
    expect(router.currentRoute.value.query.model).toHaveLength(21);
    expect(router.currentRoute.value.query['all-models']).toBeUndefined();
    await wrapper.findAll('button').find(button => button.text() === 'Clear selection')!.trigger('click');
    await flushPromises();
    expect(router.currentRoute.value.query.model).toBe('');
    expect(wrapper.get<HTMLButtonElement>('[data-testid="llama-performance-start"]').element.disabled).toBe(true);
  });

  it('keeps unavailable requested profiling selected instead of substituting standard mode', async () => {
    await router.replace(path + '?all-models&mode=both');
    wrapper = mount(LlamaCppBrowserDiagnosticsPage, { global: { plugins: [router] }, props: { defaultModel: 'user/m0' } });
    await flushPromises();
    expect(wrapper.get<HTMLInputElement>('[data-testid="llama-performance-mode-both"]').element.checked).toBe(true);
    expect(wrapper.get<HTMLButtonElement>('[data-testid="llama-performance-start"]').element.disabled).toBe(true);
    expect(router.currentRoute.value.query).toEqual({ 'all-models': null, mode: 'both' });
  });

  it.each(['?model=', '?model=missing'])('does not replace explicit selection with the default: %s', async query => {
    await router.replace(path + query);
    wrapper = mount(LlamaCppBrowserDiagnosticsPage, { global: { plugins: [router] }, props: { defaultModel: 'user/m0' } });
    await flushPromises();
    expect(wrapper.get<HTMLButtonElement>('[data-testid="llama-performance-start"]').element.disabled).toBe(true);
    expect(wrapper.findAll<HTMLInputElement>('[data-testid="llama-performance-model"]').some(model => model.element.checked)).toBe(false);
    if (query.includes('missing')) {
      expect(wrapper.get('[data-testid="llama-performance-model-input-errors"]').text()).toContain('missing');
      expect(wrapper.get('[data-testid="llama-performance-target-row"]').text()).toContain('missing');
    } else {
      expect(wrapper.findAll('[data-testid="llama-performance-target-row"]')).toHaveLength(0);
    }
    expect(mocks.runPerformanceOperation).not.toHaveBeenCalled();
  });

  it('retains selected IDs after an inventory error but requires a successful refresh before starting', async () => {
    await router.replace(path + '?all-models&mode=standard');
    wrapper = mount(LlamaCppBrowserDiagnosticsPage, { global: { plugins: [router] }, props: { defaultModel: 'user/m0' } });
    await flushPromises();
    mocks.listModelEntries.mockRejectedValueOnce(new Error('inventory unavailable'));
    const refresh = wrapper.findAll('button').find(button => button.text() === 'Refresh models')!;
    await refresh.trigger('click');
    await flushPromises();
    expect(wrapper.findAll('[data-testid="llama-performance-target-row"]')).toHaveLength(2);
    expect(wrapper.get<HTMLButtonElement>('[data-testid="llama-performance-start"]').element.disabled).toBe(true);
    expect(wrapper.text()).toContain('inventory unavailable');
    expect(router.currentRoute.value.query).toEqual({ 'all-models': null, mode: 'standard' });
    await refresh.trigger('click');
    await flushPromises();
    expect(wrapper.get<HTMLButtonElement>('[data-testid="llama-performance-start"]').element.disabled).toBe(false);
  });

  it('passes optional runtime fields to the frozen plan, and exports the same conditions shown by the controls', async () => {
    await router.replace(path + '?model=user%2Fm0&mode=standard&repeats=2&maxTokens=16&timeoutMinutes=1&placement=0&contextTokens=4096&visionBf16Storage=retain-checked&unknown=x');
    wrapper = mount(LlamaCppBrowserDiagnosticsPage, { global: { plugins: [router] }, props: { defaultModel: undefined } });
    await flushPromises();
    expect(wrapper.get<HTMLInputElement>('[data-testid="llama-diagnostics-context"]').element.value).toBe('4096');
    expect(wrapper.get<HTMLSelectElement>('[data-testid="llama-diagnostics-vision-storage"]').element.value).toBe('retain-checked');
    await wrapper.get('[data-testid="llama-performance-start"]').trigger('click');
    await saveManually();
    const saved = mocks.archive.mock.calls[0]![0].snapshot;
    expect(saved.plan.options).toMatchObject({ contextTokens: 4096, visionBf16Storage: 'retain-checked' });
    expect(saved.plan.settings).toMatchObject({ mode: 'standard', repeats: 2, maxTokens: 16, timeoutMs: 60000, diagnostics: 'none' });
    expect(mocks.runPerformanceOperation.mock.calls[0]![0].options).toMatchObject({ contextTokens: 4096, visionBf16Storage: 'retain-checked' });
  });

  it('keeps unsent model text while editing other fields and writes its committed IDs before starting', async () => {
    await router.replace(path + '?mode=standard');
    wrapper = mount(LlamaCppBrowserDiagnosticsPage, { global: { plugins: [router] }, props: { defaultModel: undefined } });
    await flushPromises();
    await wrapper.get('[data-testid="llama-performance-model-input"]').setValue('user/m1');
    await wrapper.get('input[type="number"][max="5"]').setValue(2);
    await flushPromises();
    expect(wrapper.get<HTMLTextAreaElement>('[data-testid="llama-performance-model-input"]').element.value).toBe('user/m1');
    expect(router.currentRoute.value.query.model).toBeUndefined();
    await wrapper.get('[data-testid="llama-performance-start"]').trigger('click');
    await saveManually();
    expect([router.currentRoute.value.query.model].flat()).toEqual(['user/m1']);
    expect(mocks.archive.mock.calls[0]![0].snapshot.plan.models.map((model: { modelId: string }) => model.modelId)).toEqual(['user/m1']);
  });

  it('stops an active run on external query changes without rewriting its existing plan', async () => {
    mocks.runPerformanceOperation.mockImplementationOnce(({ signal }) => new Promise((_, reject) => {
      signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true });
    }));
    wrapper = mount(LlamaCppBrowserDiagnosticsPage, { global: { plugins: [router] }, props: { defaultModel: 'user/m0' } });
    await flushPromises();
    await wrapper.get('[data-testid="llama-performance-start"]').trigger('click');
    await vi.waitFor(() => expect(mocks.runPerformanceOperation).toHaveBeenCalledOnce());
    await router.push(path + '?model=user%2Fm1&repeats=3');
    await flushPromises();
    expect(mocks.runPerformanceOperation.mock.calls[0]![0].signal?.aborted).toBe(true);
    await saveManually();
    const saved = mocks.archive.mock.calls[0]![0].snapshot;
    expect(saved.status).toBe('cancelled');
    expect(saved.plan.settings.repeats).toBe(1);
    expect(saved.plan.models[0].modelId).toBe('user/m0');
    expect(wrapper.get<HTMLInputElement>('input[type="number"][max="5"]').element.value).toBe('3');
    expect(wrapper.get('[data-testid="llama-performance-target-row"]').text()).toContain('user/m1');
    expect(mocks.runPerformanceOperation).toHaveBeenCalledTimes(1);
  });

  it('returns to the preceding internal page in one Back after several settings edits', async () => {
    const previousUrl = window.location.href;
    const previousState: unknown = window.history.state;
    const history = createWebHashHistory('/');
    using _historyCleanup = {
      [Symbol.dispose]() {
        wrapper?.unmount();
        wrapper = undefined;
        history.destroy();
        window.history.replaceState(previousState, '', previousUrl);
      },
    };
    router = createRouter({
      history,
      routes: [
        { path: '/', component: { template: '<div />' } },
        { path: '/settings/llama-cpp-browser', component: { template: '<div />' } },
        { path, component: { template: '<div />' } },
      ],
    });
    await router.replace('/settings/llama-cpp-browser');
    await router.push(path + '?all-models');
    wrapper = mount(LlamaCppBrowserDiagnosticsPage, { global: { plugins: [router] }, props: { defaultModel: 'user/m0' } });
    await flushPromises();
    await wrapper.get('input[type="number"][max="5"]').setValue(2);
    await flushPromises();
    await wrapper.get('input[type="number"][max="5"]').setValue(3);
    await flushPromises();
    await wrapper.get('[data-testid="llama-performance-back"]').trigger('click');
    await vi.waitFor(() => expect(router.currentRoute.value.path).toBe('/settings/llama-cpp-browser'));
  });

  it('reports a profile conflict rather than silently replacing an explicitly requested CPU profile', async () => {
    mocks.probeProfiles.mockResolvedValue(availableProfiles);
    await router.replace(path + '?all-models&mode=both&profile=cpu-wasm32');
    wrapper = mount(LlamaCppBrowserDiagnosticsPage, { global: { plugins: [router] }, props: { defaultModel: 'user/m0' } });
    await flushPromises();
    expect(wrapper.find('[data-testid="llama-diagnostics-profile-conflict"]').exists()).toBe(true);
    expect(wrapper.get<HTMLButtonElement>('[data-testid="llama-performance-start"]').element.disabled).toBe(true);
    await wrapper.get('[data-testid="llama-diagnostics-reset"]').trigger('click');
    await flushPromises();
    expect(router.currentRoute.value.query).toEqual({});
    expect(wrapper.find('[data-testid="llama-diagnostics-profile-conflict"]').exists()).toBe(false);
  });

  it('runs more than sixteen models, limits rendered rows only, and keeps every trial in the export', async () => {
    mocks.listModelEntries.mockResolvedValue(performancePlan({ models: 20 }).models);
    await router.replace(path + '?all-models&mode=standard');
    wrapper = mount(LlamaCppBrowserDiagnosticsPage, { global: { plugins: [router] }, props: { defaultModel: undefined } });
    await flushPromises();
    await wrapper.get('[data-testid="llama-performance-start"]').trigger('click');
    await saveManually();
    expect(mocks.runPerformanceOperation).toHaveBeenCalledTimes(20);
    expect(mocks.archive.mock.calls[0]![0].snapshot.trials).toHaveLength(120);
    expect(wrapper.findAll('tbody tr')).toHaveLength(100);
    await wrapper.get('[data-testid="llama-diagnostics-more-trials"]').trigger('click');
    expect(wrapper.findAll('tbody tr')).toHaveLength(120);
    expect(router.currentRoute.value.query).toEqual({ 'all-models': null, mode: 'standard' });
  });

  it('aborts an in-progress export on page disposal rather than reporting a completed download', async () => {
    wrapper = mount(LlamaCppBrowserDiagnosticsPage, { global: { plugins: [router] }, props: { defaultModel: 'user/m0' } });
    await flushPromises();
    await wrapper.get('[data-testid="llama-performance-start"]').trigger('click');
    await vi.waitFor(() => expect(wrapper!.find('[data-testid="llama-performance-download"]').exists()).toBe(true));
    let signal: AbortSignal | undefined;
    mocks.download.mockImplementationOnce((args: { signal: AbortSignal }) => {
      signal = args.signal;
      return new Promise<void>((_, reject) => signal!.addEventListener('abort', () => reject(signal!.reason), { once: true }));
    });
    await wrapper.get('[data-testid="llama-performance-download"]').trigger('click');
    await flushPromises();
    expect(signal?.aborted).toBe(false);
    wrapper.unmount();
    wrapper = undefined;
    await flushPromises();
    expect(signal?.aborted).toBe(true);
  });
});
