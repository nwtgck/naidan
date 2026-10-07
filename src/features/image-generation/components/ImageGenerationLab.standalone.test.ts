import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ref, defineComponent, h } from 'vue';
import { DEFAULT_SETTINGS } from '@/01-models/types';
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import { ensureAllStringsForTest } from '@/strings/test-utils';
import ImageGenerationLab from './ImageGenerationLab.vue';
import { useImageGeneration } from '@/features/image-generation/use-image-generation-standalone';
import type { ImageGenerationView } from '@/features/image-generation/use-image-generation-types';

vi.mock('@/features/stable-diffusion-cpp-browser/use-image-benchmark', () => import('@/features/stable-diffusion-cpp-browser/use-image-benchmark-standalone'));
vi.mock('@/features/image-generation/use-image-generation', () => import('@/features/image-generation/use-image-generation-standalone'));
// These fail at import time, not only if their exported functions are called.
vi.mock('@/features/image-generation/providers/local-environment', () => import('@/features/image-generation/providers/local-environment-standalone'));
const settings = ref({ ...DEFAULT_SETTINGS, experimental: { naidanRpc: 'enabled' as const } });
vi.mock('@/composables/useSettings', () => ({ useSettings: () => ({ settings, initialized: ref(false), updateExperimental: vi.fn(), captureExperimentalStorage: () => () => true, updateExperimentalForStorage: vi.fn(async () => 'saved' as const) }) }));
vi.mock('@/00-storage/service', () => ({ storageService: { getCurrentType: () => 'memory', subscribeToChanges: () => () => {} } }));
vi.mock('@/features/naidan-peer-rpc/runtime/feature', () => ({ subscribeRpcState: () => () => {}, getRpcManager: vi.fn(async () => ({ reload: async () => {}, list: () => [] })) }));
vi.mock('@/features/stable-diffusion-cpp-browser/capabilities', () => {
  throw new Error('Device probes leaked into standalone');
});
vi.mock('@/features/stable-diffusion-cpp-browser/worker/client', () => {
  throw new Error('Worker client leaked into standalone');
});

let wrapper: VueWrapper<InstanceType<typeof ImageGenerationLab>> | undefined;
const worker = vi.fn(), fetch = vi.fn(), reader = vi.fn();
beforeEach(async () => {
  await ensureAllStringsForTest({ locale: 'en' });
  vi.clearAllMocks();
  vi.stubGlobal('Worker', worker); vi.stubGlobal('fetch', fetch); vi.stubGlobal('FileReaderSync', reader);
});
afterEach(() => {
  wrapper?.unmount(); wrapper = undefined; vi.unstubAllGlobals();
});

it('keeps local inference unavailable but enables the common remote editor without native code', async () => {
  wrapper = mount(ImageGenerationLab); await flushPromises();
  expect(wrapper.get('[data-testid="image-unavailable"]').text()).toContain('hosted');
  expect(wrapper.get('[data-testid="image-generate"]').element.matches(':disabled')).toBe(true);
  expect(wrapper.get('[data-testid="image-inference-location-kind"]').element.matches(':disabled')).toBe(false);
  expect(wrapper.get('[data-testid="image-inference-location"]').element.closest('[data-testid="image-component-settings"]')).not.toBeNull();
  await wrapper.get('[data-testid="image-inference-location-kind"]').setValue('naidan_rpc'); await flushPromises();
  expect(wrapper.get('[data-testid="image-prompt"]').element.matches(':disabled')).toBe(false);
  expect(wrapper.get('[data-testid="image-input-initial"]').element.matches(':disabled')).toBe(false);
  expect(wrapper.get('[data-testid="image-generate"]').element.matches(':disabled')).toBe(true);
  expect(wrapper.find('[data-testid="image-model-library"]').exists()).toBe(false);
  expect(wrapper.find('[data-testid="image-main-model"]').exists()).toBe(true);
  expect(wrapper.find('[data-testid="image-component-vae"]').exists()).toBe(true);
  expect(wrapper.find('[data-testid="image-component-lm"]').exists()).toBe(true);
  expect(wrapper.find('[data-testid="image-inference-location-configuration"]').exists()).toBe(true);
  expect(worker).not.toHaveBeenCalled(); expect(fetch).not.toHaveBeenCalled(); expect(reader).not.toHaveBeenCalled();
});

it('restores a pending session location before local availability would disable the form', async () => {
  let view!: ImageGenerationView;
  const host = mount(defineComponent({
    setup() {
    view = useImageGeneration(); return () => h('div');
  },
  }));
  try {
    await flushPromises();
    const local = view.captureDraft!()!; expect(local.inferenceLocation).toEqual({ kind: 'local' }); expect(local.request.runtime).toBeUndefined();
    const remote = { ...local, inferenceLocation: { kind: 'naidan_rpc' as const, connection: undefined }, request: { ...local.request, parameters: { ...local.request.parameters, prompt: 'Stored remote draft' } } };
    await view.restoreDraft!({ draft: remote }); await flushPromises();
    expect(view.inferenceLocation!.kind.value).toBe('naidan_rpc'); expect(view.parameters.value.prompt).toBe('Stored remote draft');
    expect(worker).not.toHaveBeenCalled(); expect(fetch).not.toHaveBeenCalled(); expect(reader).not.toHaveBeenCalled();
    await view.restoreDraft!({ draft: local }); expect(view.inferenceLocation!.kind.value).toBe('local');
  } finally {
    host.unmount();
  }
});

it('does not execute even when generation is invoked programmatically', async () => {
  wrapper = mount(ImageGenerationLab); await flushPromises();
  await wrapper.vm.TEST_ONLY.generate({ submission: undefined });
  expect(wrapper.vm.TEST_ONLY.files.value).toEqual({});
  expect(wrapper.vm.TEST_ONLY.results.value).toEqual([]);
  expect(worker).not.toHaveBeenCalled(); expect(fetch).not.toHaveBeenCalled(); expect(reader).not.toHaveBeenCalled();
});

it('allows opening history while keeping local history reads and saving disabled', async () => {
  wrapper = mount(ImageGenerationLab); await flushPromises();
  expect(wrapper.get('[data-testid="image-save-history"]').element.matches(':disabled')).toBe(true);
  await wrapper.get('[data-testid="image-tab-history"]').trigger('click'); await flushPromises();
  expect(wrapper.get('[data-testid="image-history-unavailable"]').text()).toContain('OPFS');
  expect(wrapper.get('[data-testid="image-history-search"]').element.matches(':disabled')).toBe(true);
  expect(wrapper.get('[data-testid="image-history-refresh"]').element.matches(':disabled')).toBe(true);
  expect(worker).not.toHaveBeenCalled(); expect(fetch).not.toHaveBeenCalled(); expect(reader).not.toHaveBeenCalled();
});
