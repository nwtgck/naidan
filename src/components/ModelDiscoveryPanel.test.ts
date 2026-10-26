import { DOMWrapper, flushPromises, mount } from '@vue/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { computed, ref } from 'vue';
import type { ModelDiscoveryTab } from './browser-model-presentation';
import { ensureAllStringsForTest } from '@/strings/utils.test-support';
import { modelLaunchCommand, modelLaunchEntryState, setModelLaunchEntryState, TEST_ONLY as launchTest } from '@/features/llama-cpp-browser/model-launch/entry-state';
import ModelDiscoveryPanel from './ModelDiscoveryPanel.vue';
import HuggingFaceDownloadFailureHint from './HuggingFaceDownloadFailureHint.vue';
import { modelSuggestions } from '@/features/llama-cpp-browser/hugging-face/model-suggestions';

const tabPreference = vi.hoisted(() => ({
  current: undefined as import('vue').Ref<ModelDiscoveryTab> | undefined,
  save: vi.fn(async ({ tab }: { tab: ModelDiscoveryTab }) => {
 tabPreference.current!.value = tab;
  }),
}));
vi.mock('@/composables/useModelDiscoveryTab', () => ({ useModelDiscoveryTab: () => ({ remembered: computed(() => tabPreference.current!.value), remember: tabPreference.save }) }));

const inventory = vi.hoisted(() => ({ models: [] as import('@/features/llama-cpp-browser/types').LocalModel[], list: vi.fn() }));
vi.mock('@/features/llama-cpp-browser/composables/model-inventory', () => ({ listModelInventory: inventory.list }));
vi.mock('@/features/llama-cpp-browser/runtime/host-model-store', () => ({ getHostModelInventoryIssues: () => [] }));
vi.mock('@/features/llama-cpp-browser/model-files', () => ({
  captureModelFileStorage: () => () => true,
  llamaCppBrowserModelFiles: { subscribeModelList: () => () => {} },
}));
const preparation = vi.hoisted(() => ({ tasks: [] as { task: () => Promise<void>, cancelled: boolean }[] }));
vi.mock('@/utils/idle-task', () => ({
  scheduleIdleTask: ({ task }: { task: () => Promise<void> }) => {
    const scheduled = { task, cancelled: false };
    preparation.tasks.push(scheduled);
    return {
      cancel: () => {
        scheduled.cancelled = true;
      },
    };
  },
}));
const mounts = vi.hoisted(() => ({ search: 0, files: 0 }));
vi.mock('@/features/llama-cpp-browser/components/LlamaCppBrowserHuggingFaceSearch.vue', () => ({
  default: {
    name: 'LlamaCppBrowserHuggingFaceSearch',
    props: ['disabled', 'repositoryInput', 'scrollOwner'],
    setup() {
      mounts.search++;
    },
    template: '<div data-testid="search-tools" :data-disabled="disabled" />',
  },
}));
vi.mock('./BrowserModelLibrary.vue', () => ({
  default: {
    name: 'BrowserModelLibrary',
    props: ['suspended', 'inventory'],
    setup() {
      mounts.files++;
    },
    template: '<div data-testid="local-tools" :data-suspended="suspended" :data-model-count="inventory.models.length" />',
  },
}));

beforeEach(async () => {
  launchTest.reset();
  tabPreference.current = ref('candidates');
  tabPreference.save.mockClear();
  inventory.models = [];
  inventory.list.mockReset().mockImplementation(async () => inventory.models);
  preparation.tasks = [];
  mounts.search = 0;
  mounts.files = 0;
  await ensureAllStringsForTest({ locale: 'en' });
});

afterEach(() => launchTest.reset());

describe('browser model discovery', () => {
  it('prepares hidden tabs after the first render and retains their state without remounting', async () => {
    // Use Vue Teleport in jsdom so retaining child instances is part of the test.
    const owner = mount(ModelDiscoveryPanel, { attachTo: document.body, props: { visibility: 'open', tab: 'candidates', interaction: 'ready' } });
    const wrapper = new DOMWrapper(document.body);
    using _cleanup = {
      [Symbol.dispose]() {
        owner.unmount();
      },
    };
    await flushPromises();
    expect(mounts).toEqual({ search: 0, files: 0 });
    expect(preparation.tasks).toHaveLength(1);
    await preparation.tasks[0]!.task();
    await flushPromises();
    expect(mounts).toEqual({ search: 1, files: 0 });
    expect(owner.getComponent({ name: 'LlamaCppBrowserHuggingFaceSearch' }).props('scrollOwner')).toBe('parent');
    expect(wrapper.get('[data-testid="search-tools"]').attributes('data-disabled')).toBe('true');
    await preparation.tasks[1]!.task();
    await flushPromises();
    expect(mounts).toEqual({ search: 1, files: 1 });
    expect(wrapper.get('[data-testid="local-tools"]').attributes('data-suspended')).toBe('true');
    await vi.waitFor(() => expect(inventory.list).toHaveBeenCalledOnce());
    expect(wrapper.get('[data-testid="model-discovery"]').attributes('inert')).toBeUndefined();
    const search = wrapper.get('[data-testid="candidate-search"]');
    expect(search.element.closest('[inert]')).toBeNull();
    await search.setValue('Qwen');
    expect(mounts).toEqual({ search: 1, files: 1 });
    const viewport = wrapper.get('[data-testid="discovery-list-viewport"]');
    viewport.element.scrollTop = 120;
    await viewport.trigger('scroll');
    await owner.setProps({ visibility: 'closed' });
    expect(mounts).toEqual({ search: 1, files: 1 });
    expect(wrapper.get('[data-testid="model-discovery"]').attributes('inert')).toBeDefined();
    await owner.setProps({ visibility: 'open' });
    await flushPromises();
    expect(mounts).toEqual({ search: 1, files: 1 });
    expect((search.element as HTMLInputElement).value).toBe('Qwen');
    expect(viewport.element.scrollTop).toBe(120);
    expect(search.element.closest('[inert]')).toBeNull();
    await wrapper.get('#hugging-face-tab').trigger('click');
    await flushPromises();
    expect(mounts).toEqual({ search: 1, files: 1 });
    expect(wrapper.get('#hugging-face-panel').element.closest('[inert]')).toBeNull();
    expect(wrapper.get('#candidate-panel').attributes('inert')).toBeDefined();
    await wrapper.get('#local-files-tab').trigger('click');
    await flushPromises();
    expect(mounts).toEqual({ search: 1, files: 1 });
    expect(wrapper.get('#local-files-panel').element.closest('[inert]')).toBeNull();
    expect(wrapper.get('[data-testid="local-tools"]').attributes('data-suspended')).toBe('false');
    await wrapper.get('#candidate-tab').trigger('click');
    await wrapper.get('#hugging-face-tab').trigger('click');
    await flushPromises();
    expect(mounts).toEqual({ search: 1, files: 1 });
  });

  it('cancels deferred preparation when closed and refreshes one shared local snapshot on reopening', async () => {
    const wrapper = mount(ModelDiscoveryPanel, { global: { stubs: { Teleport: true } }, props: { visibility: 'closed', tab: 'candidates' } });
    using _cleanup = {
      [Symbol.dispose]() {
        wrapper.unmount();
      },
    };
    await flushPromises();
    expect(preparation.tasks).toHaveLength(0);
    expect(inventory.list).not.toHaveBeenCalled();
    await wrapper.setProps({ visibility: 'open' });
    await flushPromises();
    const stalePreparation = preparation.tasks[0]!;
    await wrapper.setProps({ visibility: 'closed' });
    expect(stalePreparation.cancelled).toBe(true);
    await stalePreparation.task();
    expect(mounts).toEqual({ search: 0, files: 0 });

    inventory.models = [{ modelId: 'temp/new', size: 16, importedAt: 2 }];
    await wrapper.setProps({ visibility: 'open' });
    await flushPromises();
    await preparation.tasks[1]!.task();
    await flushPromises();
    await preparation.tasks[2]!.task();
    await flushPromises();
    expect(wrapper.get('[data-testid="local-tools"]').attributes('data-model-count')).toBe('1');
    expect(inventory.list).toHaveBeenCalledTimes(2);
    await wrapper.get('#local-files-tab').trigger('click');
    await flushPromises();
    expect(inventory.list).toHaveBeenCalledTimes(2);
  });

  it('discards a late inventory result after closing and aborts its consumer', async () => {
    const pending = Promise.withResolvers<import('@/features/llama-cpp-browser/types').LocalModel[]>();
    inventory.list.mockReturnValueOnce(pending.promise);
    const wrapper = mount(ModelDiscoveryPanel, { global: { stubs: { Teleport: true } }, props: { visibility: 'open', tab: 'candidates' } });
    using _cleanup = {
      [Symbol.dispose]() {
        wrapper.unmount();
      },
    };
    await flushPromises();
    const signal = inventory.list.mock.calls[0]![0].signal as AbortSignal;
    await wrapper.setProps({ visibility: 'closed' });
    expect(signal.aborted).toBe(true);
    pending.resolve([{ modelId: 'hf.co/lmstudio-community/gemma-4-E2B-it-GGUF:Q8_0', size: 16, importedAt: 1 }]);
    await flushPromises();
    expect(wrapper.find('[data-testid="model-candidate-saved"]').exists()).toBe(false);
    await wrapper.setProps({ visibility: 'open' });
    await flushPromises();
    expect(inventory.list).toHaveBeenCalledTimes(2);
    expect(wrapper.find('[data-testid="model-candidate-saved"]').exists()).toBe(false);
  });

  it('paints and focuses candidates without waiting for the inventory and aborts it on unmount', async () => {
    const pending = Promise.withResolvers<import('@/features/llama-cpp-browser/types').LocalModel[]>();
    inventory.list.mockReturnValueOnce(pending.promise);
    const wrapper = mount(ModelDiscoveryPanel, { attachTo: document.body, global: { stubs: { Teleport: true } }, props: { visibility: 'open', tab: 'candidates' } });
    using _cleanup = {
      [Symbol.dispose]() {
        wrapper.unmount();
        pending.resolve([]);
      },
    };
    await flushPromises();
    expect(wrapper.get('[data-testid="candidate-list"]').findAll('li')).toHaveLength(modelSuggestions.length);
    expect(document.activeElement).toBe(wrapper.get('[data-testid="model-discovery"]').element);
    expect(mounts).toEqual({ search: 0, files: 0 });
    const signal = inventory.list.mock.calls[0]![0].signal as AbortSignal;
    wrapper.unmount();
    expect(signal.aborted).toBe(true);
    const deferred = preparation.tasks[0]!;
    expect(deferred.cancelled).toBe(true);
    await deferred.task();
    expect(mounts).toEqual({ search: 0, files: 0 });
  });

  it('coalesces updates during a scan and publishes only the latest local snapshot', async () => {
    const pending = Promise.withResolvers<import('@/features/llama-cpp-browser/types').LocalModel[]>();
    inventory.list.mockReturnValueOnce(pending.promise).mockResolvedValueOnce([]);
    const wrapper = mount(ModelDiscoveryPanel, { global: { stubs: { Teleport: true } }, props: { visibility: 'open', tab: 'candidates' } });
    using _cleanup = {
      [Symbol.dispose]() {
        wrapper.unmount();
      },
    };
    await flushPromises();
    window.dispatchEvent(new Event('focus'));
    window.dispatchEvent(new Event('focus'));
    expect(inventory.list).toHaveBeenCalledOnce();
    pending.resolve([{ modelId: 'hf.co/lmstudio-community/gemma-4-E2B-it-GGUF:Q8_0', size: 16, importedAt: 1 }]);
    await flushPromises();
    expect(inventory.list).toHaveBeenCalledTimes(2);
    expect(wrapper.find('[data-testid="model-candidate-saved"]').exists()).toBe(false);
  });

  it('keeps repository preview offline and retires a pending explicit Start on close', async () => {
    const fetch = vi.spyOn(globalThis, 'fetch');
    const wrapper = mount(ModelDiscoveryPanel, { attachTo: document.body, global: { stubs: { Teleport: true } }, props: { visibility: 'open', tab: 'hugging-face' } });
    using _cleanup = {
      [Symbol.dispose]() {
        wrapper.unmount();
        fetch.mockRestore();
      },
    };
    await flushPromises();
    await wrapper.get('[data-testid="hugging-face-repository"]').setValue('owner/unknown:Q8_0');
    await wrapper.get('[data-testid="hugging-face-repository-select"]').trigger('click');
    expect(wrapper.get('[data-testid="discovery-detail"]').text()).toContain('unknown');
    expect(wrapper.get('[data-testid="discovery-detail"]').text()).toContain('Size not checked');
    expect(wrapper.get('[data-testid="discovery-detail"]').element.closest('[inert]')).toBeNull();
    expect(wrapper.get('[data-testid="discovery-list-viewport"]').element.closest('[inert]')).not.toBeNull();
    await wrapper.get('[data-testid="discovery-back"]').trigger('click');
    expect(wrapper.get('[data-testid="hugging-face-repository"]').element.closest('[inert]')).toBeNull();
    await wrapper.get('[data-testid="hugging-face-repository-select"]').trigger('click');
    expect(fetch).not.toHaveBeenCalled();
    expect(modelLaunchEntryState.value.status).toBe('idle');
    await wrapper.get('[data-testid="discovery-start"]').trigger('click');
    expect(modelLaunchEntryState.value.status).toBe('checking');
    await wrapper.get('[data-testid="model-discovery-close"]').trigger('click');
    expect(wrapper.emitted('close')).toHaveLength(1);
    expect(modelLaunchEntryState.value.status).toBe('idle');
  });

  it('keeps expandable guidance in the detail viewport and leaves the action footer stable', async () => {
    const wrapper = mount(ModelDiscoveryPanel, {
      props: { visibility: 'open', tab: 'hugging-face' },
      global: { stubs: { Teleport: true, CspMessageHint: { template: '<details data-testid="discovery-guidance"><summary>Connection guidance</summary><button>Export data</button></details>' } } },
    });
    using _cleanup = {
      [Symbol.dispose]() {
        wrapper.unmount();
      },
    };
    await flushPromises();
    await wrapper.get('[data-testid="hugging-face-repository"]').setValue('owner/model:Q8_0');
    await wrapper.get('[data-testid="hugging-face-repository-select"]').trigger('click');
    const guidance = wrapper.get('[data-testid="discovery-guidance"]');
    const viewport = wrapper.get('[data-testid="discovery-detail-viewport"]');
    const start = wrapper.get('[data-testid="discovery-start"]');
    expect(viewport.element.contains(guidance.element)).toBe(true);
    expect(guidance.element.closest('footer')).toBeNull();
    expect(start.element.closest('footer')).not.toBeNull();
    guidance.element.setAttribute('open', '');
    await flushPromises();
    expect(wrapper.get('[data-testid="discovery-start"]').element).toBe(start.element);
    expect(modelLaunchEntryState.value.status).toBe('idle');
  });

  it('puts the original failure immediately before its hint in the same scrollable message area', async () => {
    using fetchSpy = vi.spyOn(globalThis, 'fetch');
    const wrapper = mount(ModelDiscoveryPanel, {
      props: { visibility: 'open', tab: 'hugging-face' },
      global: { stubs: { Teleport: true, CspMessageHint: { props: ['presentation', 'activityForDisplayOnly'], template: '<details data-testid="discovery-guidance" :data-presentation="presentation" :data-activity="activityForDisplayOnly"><summary>Connection guidance</summary><button>Export data</button></details>' }, LlamaCppBrowserLocalFileRecovery: { name: 'LlamaCppBrowserLocalFileRecovery', props: ['disabled', 'acceptLocalInput'], template: '<section data-testid="discovery-local-recovery"><button>Use local files</button></section>' } } },
    });
    using _cleanup = {
      [Symbol.dispose]() {
        wrapper.unmount();
      },
    };
    await flushPromises();
    await wrapper.get('[data-testid="hugging-face-repository"]').setValue('owner/model:Q8_0');
    await wrapper.get('[data-testid="hugging-face-repository-select"]').trigger('click');
    const start = wrapper.get('[data-testid="discovery-start"]');
    await start.trigger('click');
    const request = modelLaunchEntryState.value;
    if (request.status !== 'checking') {
      throw new Error('Expected an explicitly started model request');
    }
    setModelLaunchEntryState({ state: { status: 'failed', operation: request.operation, input: request.input, problem: 'failed' } });
    await flushPromises();
    const messages = wrapper.get('[data-testid="discovery-messages"]');
    const error = messages.get('[role="alert"]');
    const guidance = wrapper.getComponent(HuggingFaceDownloadFailureHint);
    const retryBeforeHint = wrapper.get('[data-testid="discovery-start"]');
    const launchBeforeHint = modelLaunchCommand.value;
    expect(error.element.nextElementSibling).toBe(guidance.element);
    expect(messages.find('[data-testid="discovery-local-recovery"]').exists()).toBe(false);
    await guidance.get('[data-testid="hf-download-failure-trigger"]').trigger('click');
    expect(wrapper.getComponent({ name: 'LlamaCppBrowserLocalFileRecovery' }).props('disabled')).toBe(false);
    expect(wrapper.getComponent({ name: 'LlamaCppBrowserLocalFileRecovery' }).props('acceptLocalInput')).toBeUndefined();
    expect(wrapper.get('[data-testid="discovery-detail-viewport"]').element.contains(messages.element)).toBe(true);
    expect(messages.element.closest('footer')).toBeNull();
    expect(retryBeforeHint.element.closest('footer')).not.toBeNull();
    expect(wrapper.get('[data-testid="discovery-start"]').element).toBe(retryBeforeHint.element);
    await guidance.get('[data-testid="hf-download-failure-trigger"]').trigger('click');
    expect(wrapper.get('[data-testid="discovery-start"]').element).toBe(retryBeforeHint.element);
    expect(modelLaunchCommand.value).toBe(launchBeforeHint);
    await guidance.get('[data-testid="hf-download-failure-trigger"]').trigger('click');
    expect(wrapper.get('[data-testid="discovery-start"]').element).toBe(retryBeforeHint.element);
    await wrapper.setProps({ interaction: 'blocked' });
    expect(wrapper.get('[data-testid="model-discovery"]').attributes('inert')).toBeDefined();
    // Inspect lazy recovery only after explicitly opening the current disclosure.
    const blockedTrigger = wrapper.getComponent(HuggingFaceDownloadFailureHint).get('[data-testid="hf-download-failure-trigger"]');
    if (blockedTrigger.attributes('aria-expanded') === 'false') {
      await blockedTrigger.trigger('click');
    }
    expect(wrapper.getComponent({ name: 'LlamaCppBrowserLocalFileRecovery' }).props('disabled')).toBe(true);
    expect(wrapper.getComponent({ name: 'LlamaCppBrowserLocalFileRecovery' }).props('acceptLocalInput')).toBeUndefined();
    const blockedStart = wrapper.get('[data-testid="discovery-start"]');
    expect(blockedStart.attributes('aria-busy')).toBe('false');
    const previousCommand = modelLaunchCommand.value;
    await blockedStart.trigger('click');
    expect(modelLaunchCommand.value).toBe(previousCommand);
    expect(fetchSpy).not.toHaveBeenCalled();
    setModelLaunchEntryState({ state: { status: 'failed', operation: request.operation, input: request.input, problem: 'variant-unavailable' } });
    await flushPromises();
    expect(wrapper.get('[data-testid="discovery-messages"]').find('[role="alert"]').exists()).toBe(true);
    expect(wrapper.findComponent(HuggingFaceDownloadFailureHint).exists()).toBe(false);
  });

  it('restores the opener and does not consume Escape from a nested dialog', async () => {
    const app = document.createElement('div');
    app.id = 'app';
    const opener = document.createElement('button');
    app.append(opener);
    document.body.append(app);
    opener.focus();
    const wrapper = mount(ModelDiscoveryPanel, { attachTo: document.body, global: { stubs: { Teleport: true } }, props: { visibility: 'open', tab: 'candidates' } });
    using _cleanup = {
      [Symbol.dispose]() {
        wrapper.unmount();
        app.remove();
      },
    };
    await flushPromises();
    expect(app.inert).toBe(true);
    const nested = document.createElement('div');
    nested.setAttribute('role', 'dialog');
    wrapper.get('[data-testid="model-discovery"]').element.append(nested);
    nested.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    expect(wrapper.emitted('close')).toBeUndefined();
    nested.remove();
    await wrapper.get('[data-testid="model-discovery"]').trigger('keydown', { key: 'Escape' });
    expect(wrapper.emitted('close')).toHaveLength(1);
    await wrapper.setProps({ visibility: 'closed' });
    expect(app.inert).toBe(false);
    await flushPromises();
    expect(document.activeElement).toBe(opener);
  });

  it('shows saved and current states from real local IDs and prefers a saved quantization', async () => {
    const modelId = 'hf.co/lmstudio-community/gemma-4-E2B-it-GGUF:Q8_0';
    inventory.models = [{ modelId, size: 4970000000, importedAt: 1 }];
    const wrapper = mount(ModelDiscoveryPanel, { attachTo: document.body, global: { stubs: { Teleport: true } }, props: { visibility: 'open', tab: 'candidates', currentModelId: modelId } });
    using _cleanup = {
      [Symbol.dispose]() {
        wrapper.unmount();
      },
    };
    await flushPromises();
    expect(wrapper.get('[data-testid="discovery-candidate-gemma-4-e2b"]').find('[data-testid="model-candidate-saved"]').exists()).toBe(true);
    expect(wrapper.get('[data-testid="discovery-candidate-gemma-4-e2b"]').find('[data-testid="model-candidate-current"]').exists()).toBe(true);
    await wrapper.setProps({ currentModelId: undefined });
    expect(wrapper.props('currentModelId')).toBeUndefined();
    await flushPromises();
    expect(wrapper.get('[data-testid="discovery-candidate-gemma-4-e2b"]').find('[data-testid="model-candidate-current"]').exists()).toBe(false);
    await wrapper.get('[data-testid="discovery-candidate-gemma-4-e2b"]').trigger('click');
    expect(wrapper.get('[data-testid="discovery-quantization"]').text()).toContain('Q8_0');
    expect(wrapper.get('[data-testid="model-preview-availability"]').text()).toBe('Saved');
    expect(wrapper.get('[data-testid="discovery-detail"]').text()).toContain('Start a new chat with the saved model.');
    await wrapper.get('[data-testid="discovery-quantization"]').trigger('click');
    await wrapper.get('[data-testid="settings-select-option-qat-q4_0"]').trigger('click');
    expect(wrapper.find('[data-testid="model-preview-availability"]').exists()).toBe(false);
    expect(wrapper.get('[data-testid="discovery-detail"]').text()).toContain('Prepare this model');
  });

  it('restores the remembered tab on generic opening and leaves an open panel stable when another view changes the preference', async () => {
    tabPreference.current!.value = 'local-files';
    using test = {
      wrapper: mount(ModelDiscoveryPanel, { global: { stubs: { Teleport: true } }, props: { visibility: 'open', tab: undefined } }),
      [Symbol.dispose]() {
        this.wrapper.unmount();
      },
    };
    await flushPromises();
    expect(test.wrapper.get('#local-files-tab').attributes('aria-selected')).toBe('true');
    expect(tabPreference.save).not.toHaveBeenCalled();
    tabPreference.current!.value = 'hugging-face';
    await flushPromises();
    expect(test.wrapper.get('#local-files-tab').attributes('aria-selected')).toBe('true');
    await test.wrapper.setProps({ visibility: 'closed' });
    await test.wrapper.setProps({ visibility: 'open' });
    await flushPromises();
    expect(test.wrapper.get('#hugging-face-tab').attributes('aria-selected')).toBe('true');
  });

  it('prioritizes explicit entry tabs and remembers pointer and keyboard navigation', async () => {
    tabPreference.current!.value = 'local-files';
    using test = {
      wrapper: mount(ModelDiscoveryPanel, { global: { stubs: { Teleport: true } }, props: { visibility: 'open', tab: 'hugging-face' } }),
      [Symbol.dispose]() {
        this.wrapper.unmount();
      },
    };
    await flushPromises();
    expect(test.wrapper.get('#hugging-face-tab').attributes('aria-selected')).toBe('true');
    expect(tabPreference.save).toHaveBeenLastCalledWith({ tab: 'hugging-face' });
    await test.wrapper.get('#candidate-tab').trigger('click');
    expect(tabPreference.save).toHaveBeenLastCalledWith({ tab: 'candidates' });
    await test.wrapper.get('[role=tablist]').trigger('keydown', { key: 'End' });
    expect(tabPreference.save).toHaveBeenLastCalledWith({ tab: 'local-files' });
  });
});
