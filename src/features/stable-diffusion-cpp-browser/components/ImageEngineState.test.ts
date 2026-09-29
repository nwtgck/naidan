import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { computed, ref } from 'vue';
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import { ensureAllStringsForTest } from '@/strings/test-utils';
import { useImageGeneration } from '@/features/stable-diffusion-cpp-browser/use-image-generation-standalone';
import type { ImageEngineSnapshot } from '@/features/stable-diffusion-cpp-browser/engine-state';
import type { ImageEngineStateView } from '@/features/stable-diffusion-cpp-browser/use-image-generation-types';
import ImageEngineState from './ImageEngineState.vue';

let wrapper: VueWrapper | undefined;
beforeEach(async () => {
  await ensureAllStringsForTest({ locale: 'en' });
});
afterEach(() => {
  wrapper?.unmount(); wrapper = undefined;
});

function snapshot(): ImageEngineSnapshot {
  return {
    type: 'naidan-image-engine-snapshot-v1', collectedAt: Date.UTC(2026, 8, 28, 12, 34, 56),
    profile: 'webgpu-wasm64-jspi', source: 'a'.repeat(40), modelVersion: 'Fixture model',
    wasmCapacityBytes: 2 * 1024 ** 3, fileReadCacheBytes: 2 * 1024 ** 2,
    runtime: { nThreads: 4, runnersReady: true, eagerLoad: true, mmap: false, prefetch: false, segmentedCompute: false, autoFit: true },
    memory: {
      registeredTensorCount: '100', registeredTensorBytes: '1073741824',
      managerHostBufferCount: '2', managerHostBufferBytes: '268435456',
      managerDeviceBufferCount: '3', managerDeviceBufferBytes: '536870912',
      trackedRuntimeCpuBytes: '67108864', trackedRuntimeNonCpuBytes: '134217728', trackedRuntimeUnknownBytes: '0', saturated: false,
    },
    requested: { nThreads: 4, computeBackend: 'GPU', paramsBackend: 'CPU', maxVram: '0', flashAttention: false,
      diffusionFlashAttention: false, bf16WeightType: 'f16', conditioningCacheSize: 0 },
  };
}

function setup({ loaded = true, supported = true, busy = false, captured = false }: {
  loaded?: boolean, supported?: boolean, busy?: boolean, captured?: boolean,
} = {}) {
  const opened = ref(false), status = ref<ImageEngineStateView['status']['value']>('idle');
  const current = ref<ImageEngineSnapshot | undefined>(captured ? snapshot() : undefined);
  const reason = ref<ImageEngineStateView['reason']['value']>(supported ? loaded ? undefined : 'not-loaded' : 'unsupported');
  const error = ref('');
  const running = ref(busy);
  const refresh = vi.fn(async () => undefined);
  const setOpened = vi.fn(({ opened: next }: { opened: boolean }) => {
    opened.value = next;
  });
  const engineState: ImageEngineStateView = {
    opened, status, snapshot: current, reason, error,
    canRefresh: computed(() => opened.value && supported && loaded && !running.value && status.value !== 'refreshing'),
    setOpened, refresh,
  };
  const view = { ...useImageGeneration(), engineState,
    supported: computed(() => supported), busy: computed(() => running.value), modelResident: ref(loaded) };
  wrapper = mount(ImageEngineState, { props: { view, active: true } });
  return { view, engineState, refresh, setOpened, running, wrapper };
}

it('starts collapsed and invokes observation only when opened or explicitly refreshed', async () => {
  const { engineState, refresh, wrapper } = setup();
  expect(engineState.opened.value).toBe(false);
  expect(refresh).not.toHaveBeenCalled();
  const panel = wrapper.get<HTMLDetailsElement>('[data-testid="image-engine-state"]');
  panel.element.open = true;
  await panel.trigger('toggle');
  expect(engineState.opened.value).toBe(true);
  expect(refresh).not.toHaveBeenCalled(); // The owner performs the open-time observation.
  await wrapper.get('[data-testid="image-engine-refresh"]').trigger('click');
  expect(refresh).toHaveBeenCalledOnce();
});

it('shows separate observed memory categories and marks a busy reading as previously observed', async () => {
  const { view, engineState, running, wrapper } = setup({ captured: true });
  engineState.setOpened({ opened: true });
  await flushPromises();
  expect(wrapper.get('[data-testid="image-engine-memory-wasm"]').text()).toBe('2 GiB');
  expect(wrapper.get('[data-testid="image-engine-memory-model-tensors"]').text()).toBe('1 GiB');
  expect(wrapper.get('[data-testid="image-engine-memory-host-buffers"]').text()).toBe('256 MiB');
  expect(wrapper.get('[data-testid="image-engine-memory-non-host-buffers"]').text()).toBe('512 MiB');
  expect(wrapper.text()).toContain('These categories can overlap');
  expect(wrapper.text()).not.toContain('Total VRAM');
  view.progress.value = { phase: 'decoding', step: 0, steps: 1 };
  running.value = true;
  await flushPromises();
  expect(wrapper.get('[data-testid="image-engine-busy"]').text()).toContain('Decoding');
  expect(wrapper.get('[data-testid="image-engine-observed-at"]').text()).toContain('Observed at');
  expect(wrapper.get<HTMLButtonElement>('[data-testid="image-engine-refresh"]').element.disabled).toBe(true);
});

it('allows an idle engine refresh while the generated image is still being saved', async () => {
  const { view, engineState, refresh, wrapper } = setup({ busy: true, captured: true });
  engineState.setOpened({ opened: true });
  engineState.reason.value = 'busy';
  engineState.canRefresh = computed(() => true);
  view.historySaving.status.value = 'saving';
  expect(view.progress.value).toBeUndefined();
  await flushPromises();
  expect(wrapper.find('[data-testid="image-engine-busy"]').exists()).toBe(false);
  const button = wrapper.get<HTMLButtonElement>('[data-testid="image-engine-refresh"]');
  expect(button.element.disabled).toBe(false);
  await button.trigger('click'); expect(refresh).toHaveBeenCalledOnce();
});

it.each([
  { loaded: false, supported: true, text: 'No model is loaded' },
  { loaded: false, supported: false, text: 'unavailable' },
])('keeps the panel visible without inventing zero measurements: $text', async ({ loaded, supported, text }) => {
  const { engineState, wrapper } = setup({ loaded, supported });
  engineState.setOpened({ opened: true });
  await flushPromises();
  expect(wrapper.text()).toContain(text);
  expect(wrapper.find('[data-testid="image-engine-memory-wasm"]').exists()).toBe(false);
  expect(wrapper.get<HTMLButtonElement>('[data-testid="image-engine-refresh"]').element.disabled).toBe(true);
});

it('does not show an old numeric reading after the model is released', async () => {
  const { engineState, wrapper } = setup({ captured: true });
  engineState.setOpened({ opened: true });
  engineState.snapshot.value = undefined;
  engineState.reason.value = 'released';
  await flushPromises();
  expect(wrapper.text()).toContain('resources have been released');
  expect(wrapper.find('[data-testid="image-engine-memory-wasm"]').exists()).toBe(false);
});

it('shows a failed inspection separately from an uncaptured state', async () => {
  const { engineState, wrapper } = setup();
  engineState.setOpened({ opened: true });
  engineState.status.value = 'failed';
  engineState.error.value = 'The context could not be queried';
  await flushPromises();
  expect(wrapper.get('[data-testid="image-engine-error"]').text()).toContain('The context could not be queried');
  expect(wrapper.text()).not.toContain('No engine state has been captured yet.');
});

it('stops observing when its tab is hidden or the component unmounts', async () => {
  const { engineState, setOpened, wrapper } = setup({ captured: true });
  engineState.setOpened({ opened: true });
  await wrapper.setProps({ active: false });
  expect(engineState.opened.value).toBe(false);
  expect(setOpened).toHaveBeenLastCalledWith({ opened: false });
  engineState.setOpened({ opened: true });
  wrapper.unmount();
  expect(engineState.opened.value).toBe(false);
  expect(setOpened).toHaveBeenLastCalledWith({ opened: false });
});
