vi.mock('@/components/SettingsSelect.vue', async () => ({
  default: (await import('@/components/settings-select.test-support')).SettingsSelectStub,
}));
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { computed, effectScope, ref } from 'vue';
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import { ensureAllStringsForTest } from '@/strings/utils.test-support';
import { useImageGeneration } from '@/features/image-generation/test-utils/unavailable-image-view.test-support';
import { useImageInferenceLocation } from '@/features/image-generation/composables/use-image-inference-location';
import { toBinaryObjectId } from '@/01-models/ids';
import { recommendationForSelection, type ImageModelFacts } from '@/features/stable-diffusion-cpp-browser/recommendations';
import ImageGenerationEditor from './ImageGenerationEditor.vue';
import { imageModelParameterDefaults } from '@/features/image-generation/model-parameter-defaults';
import ImageRecommendedFieldHint from './ImageRecommendedFieldHint.vue';
import ImageSettingsSection from './ImageSettingsSection.vue';
import ImageModelConfiguration from '@/features/stable-diffusion-cpp-browser/components/ImageModelConfiguration.vue';
import { ExternalLinkIcon } from 'lucide-vue-next';

vi.mock('@/features/naidan-rpc-integration/runtime/feature', () => ({ subscribeRpcState: () => () => {}, getRpcManager: vi.fn(), configureRpcFeature: vi.fn(async () => {}) }));

let wrapper: VueWrapper | undefined;

beforeEach(async () => {
  await ensureAllStringsForTest({ locale: 'en' });
});

afterEach(() => {
  wrapper?.unmount();
  wrapper = undefined;
});

it('keeps next-run fields editable while destructive model controls and generation remain locked', async () => {
  const view = useImageGeneration(), restoring = ref(false);
  view.supported = computed(() => true);
  view.formDisabled = computed(() => true);
  view.draftDisabled = computed(() => restoring.value);
  view.busy = computed(() => true);
  view.progress.value = { phase: 'model', step: 0, steps: 0 };
  view.seedMode.value = 'fixed';
  wrapper = mount(ImageGenerationEditor, { props: { view, active: true } });
  for (const key of ['prompt', 'negative-prompt', 'width', 'height', 'steps', 'guidance', 'distilled-guidance', 'sampler', 'scheduler', 'seed', 'seed-mode', 'resolution-presets', 'swap-resolution', 'randomize-seed', 'bf16-weight-type', 'weight-residency']) {
    expect(wrapper.get(`[data-testid="image-${key}"]`).element.matches(':disabled')).toBe(false);
  }
  for (const key of ['generate', 'file-model', 'release-model']) {
    expect(wrapper.get(`[data-testid="image-${key}"]`).element.matches(':disabled')).toBe(true);
  }
  await wrapper.get('[data-testid="image-resolution-presets"]').setValue('768x1024');
  await wrapper.get('[data-testid="image-swap-resolution"]').trigger('click');
  expect([view.parameters.value.width, view.parameters.value.height]).toEqual([1024, 768]);
  restoring.value = true;
  await flushPromises();
  expect(wrapper.get('[data-testid="image-prompt"]').element.matches(':disabled')).toBe(true);
  expect(wrapper.get('[data-testid="image-width"]').element.matches(':disabled')).toBe(true);
  const dimensions = [view.parameters.value.width, view.parameters.value.height];
  await wrapper.get('[data-testid="image-swap-resolution"]').trigger('click');
  expect([view.parameters.value.width, view.parameters.value.height]).toEqual(dimensions);
});

it.each(['import', 'download'])('only locks conflicting model layout and preset actions during %s', async transfer => {
  const pending = ref(true);
  const view = useImageGeneration();
  view.formDisabled = computed(() => false);
  view.draftDisabled = computed(() => false);
  view.supported = computed(() => true);
  view.library.importing = computed(() => pending.value && transfer === 'import');
  view.library.downloading = computed(() => pending.value && transfer === 'download');
  view.recommendation = computed(() => recommendationForSelection({ model: { family: 'z-image', variant: 'turbo', evidence: [] } }));
  view.applyRecommendedSettings = vi.fn();
  view.resetFiles = vi.fn();
  wrapper = mount(ImageGenerationEditor, { props: { view, active: true } });
  const layout = wrapper.get('[data-testid="image-model-options"] select');
  const preset = wrapper.get('[data-testid="image-apply-recommendation"]');
  expect(layout.element.matches(':disabled')).toBe(transfer === 'import');
  expect(preset.element.matches(':disabled')).toBe(transfer === 'import');
  await preset.trigger('click');
  expect(view.applyRecommendedSettings).toHaveBeenCalledTimes(transfer === 'import' ? 0 : 1);
  expect(view.resetFiles).not.toHaveBeenCalled();
  const prompt = wrapper.get('[data-testid="image-prompt"]');
  expect(prompt.element.matches(':disabled')).toBe(false);
  await prompt.setValue('a quiet afternoon');
  expect(view.parameters.value.prompt).toBe('a quiet afternoon');

  pending.value = false;
  await flushPromises();
  expect(layout.element.matches(':disabled')).toBe(false);
  expect(preset.element.matches(':disabled')).toBe(false);
  await layout.setValue('components');
  expect(view.layout.value).toBe('components');
  expect(view.resetFiles).toHaveBeenCalledOnce();
  await preset.trigger('click');
  expect(view.applyRecommendedSettings).toHaveBeenCalledTimes(transfer === 'import' ? 1 : 2);
});

it('connects independent width and height hints without changing other draft fields', async () => {
  const view = useImageGeneration();
  view.draftDisabled = computed(() => false);
  view.parameters.value = { ...view.parameters.value, width: 1024, height: 768, steps: 20 };
  const preset = recommendationForSelection({ model: { family: 'z-image', variant: 'turbo', evidence: [] } })!;
  view.recommendation = computed(() => preset);
  // The real hosted preset's no-resize contract is tested by the lifecycle suite.
  view.applyRecommendedSettings = vi.fn();
  wrapper = mount(ImageGenerationEditor, { props: { view, active: true, context: 'session-A' } });
  const hints = wrapper.findAllComponents(ImageRecommendedFieldHint);
  const width = hints.find(hint => hint.props('field') === 'width')!;
  width.vm.$emit('apply', { field: 'width', recommendationId: preset.id, context: 'session-A' });
  await flushPromises();
  expect([view.parameters.value.width, view.parameters.value.height, view.parameters.value.steps]).toEqual([512, 768, 20]);
  const height = hints.find(hint => hint.props('field') === 'height')!;
  height.vm.$emit('apply', { field: 'height', recommendationId: preset.id, context: 'session-A' });
  await flushPromises();
  expect([view.parameters.value.width, view.parameters.value.height, view.parameters.value.steps]).toEqual([512, 512, 20]);
  await wrapper.setProps({ context: 'session-B' });
  view.parameters.value.width = 768;
  width.vm.$emit('apply', { field: 'width', recommendationId: preset.id, context: 'session-A' });
  expect(view.parameters.value.width).toBe(768);
  await wrapper.get('[data-testid="image-apply-recommendation"]').trigger('click');
  expect(view.applyRecommendedSettings).toHaveBeenCalledOnce();
});

it('edits the VAE tile preference while displaying its resolved model-specific number', async () => {
  const view = useImageGeneration();
  view.draftDisabled = computed(() => false);
  view.resolvedVaeTileSize = computed(() => view.vaeTileSizePreference.value === 'auto' ? 16 : view.vaeTileSizePreference.value);
  wrapper = mount(ImageGenerationEditor, { props: { view, active: true } });
  const input = wrapper.get<HTMLInputElement>('[data-testid="image-vae-tile-size"]');
  expect(input.element.value).toBe('16');
  await input.trigger('focus');
  expect(view.vaeTileSizePreference.value).toBe('auto');
  await input.setValue('16');
  expect(view.vaeTileSizePreference.value).toBe(16);
  expect(wrapper.get('[data-testid="vae-tile-size-preference"]').text()).toBe('Fixed');
});

it('allows a remote VAE tile preference without exposing local runtime controls', async () => {
  using scope = {
    value: effectScope(),
    [Symbol.dispose]() {
      this.value.stop();
    },
  };
  const view = useImageGeneration(), disabled = ref(false);
  view.draftDisabled = computed(() => disabled.value);
  view.inferenceLocation = scope.value.run(() => useImageInferenceLocation({ form: view, blocked: () => false, identifyInput: () => toBinaryObjectId({ raw: 'input-image' }) }))!;
  view.inferenceLocation.kind.value = 'naidan_rpc';
  view.resolvedVaeTileSize = computed(() => view.vaeTileSizePreference.value === 'auto' ? 16 : view.vaeTileSizePreference.value);
  wrapper = mount(ImageGenerationEditor, { props: { view, active: true }, global: { stubs: { ImageInferenceLocation: true, ImageRemoteModelConfiguration: true } } });
  const input = wrapper.get<HTMLInputElement>('[data-testid="image-vae-tile-size"]');
  expect(input.element.value).toBe('16');
  expect(wrapper.get('[data-testid="vae-tile-size-preference"]').text()).toBe('Auto');
  await input.setValue('24');
  expect(view.vaeTileSizePreference.value).toBe(24);
  for (const key of ['bf16-weight-type', 'weight-residency', 'memory-budget', 'qwen-vae-policy']) {
    expect(wrapper.find(`[data-testid="image-${key}"]`).exists()).toBe(false);
  }
  disabled.value = true;
  await flushPromises();
  expect(input.element.matches(':disabled')).toBe(true);
});

it('shows reviewed Qwen Turbo CFG and a browser-standard step count without unsupported sampling hints', () => {
  const view = useImageGeneration();
  const model = { family: 'qwen-image-2.1' as const, variant: 'turbo' as const, evidence: [] };
  view.draftDisabled = computed(() => false);
  view.recommendation = computed(() => recommendationForSelection({ model }));
  view.modelParameterDefaults = computed(() => imageModelParameterDefaults({ model }));
  view.resolvedSteps = computed(() => view.stepsPreference.value === 'auto' ? view.modelParameterDefaults.value.steps.value : view.stepsPreference.value);
  view.resolvedGuidance = computed(() => view.guidancePreference.value === 'auto' ? view.modelParameterDefaults.value.guidance.value : view.guidancePreference.value);
  wrapper = mount(ImageGenerationEditor, { props: { view, active: true } });
  const hints = wrapper.findAllComponents(ImageRecommendedFieldHint);
  for (const field of ['width', 'height']) {
    const hint = hints.find(item => item.props('field') === field)!;
    expect(hint.get('[data-testid="recommended-field-hint"]').text()).toContain('1024');
  }
  expect(hints.some(item => item.props('field') === 'steps' || item.props('field') === 'guidance')).toBe(false);
  expect(wrapper.get<HTMLInputElement>('[data-testid="image-steps"]').element.value).toBe('20');
  expect(wrapper.get('[data-testid="image-steps-origin"]').text()).toBe('Naidan standard value');
  expect(wrapper.get<HTMLInputElement>('[data-testid="image-guidance"]').element.value).toBe('1');
  expect(wrapper.get('[data-testid="image-guidance-origin"]').text()).toBe('Model recommendation');
});

it('keeps recommendation evidence compact and marks every external source without losing referrer protection', () => {
  const view = useImageGeneration();
  view.recommendation = computed(() => recommendationForSelection({ model: { family: 'anima', variant: 'turbo', evidence: [] } }));
  wrapper = mount(ImageGenerationEditor, { props: { view, active: true } });
  const section = wrapper.findAllComponents(ImageSettingsSection).find(item => item.attributes('data-testid') === 'image-recommendation-sources');
  expect(section?.props('compact')).toBe(true);
  const links = wrapper.findAll('[data-testid="image-recommendation-source"]');
  expect(links).toHaveLength(2);
  for (const link of links) {
    expect(link.findComponent(ExternalLinkIcon).exists()).toBe(true);
    expect(link.attributes('target')).toBe('_blank');
    expect(link.attributes('rel')).toBe('noopener noreferrer');
    expect(link.attributes('referrerpolicy')).toBe('no-referrer');
  }
});

it('uses a compact section for unresolved file diagnostics and preserves the full path and reason', () => {
  const view = useImageGeneration().library;
  const issue = 'models/very-long-name/model.gguf: tensor metadata is incomplete';
  view.issues = computed(() => [issue]);
  wrapper = mount(ImageModelConfiguration, { props: { view, disabled: false, active: true } });
  const section = wrapper.findAllComponents(ImageSettingsSection).find(item => item.attributes('data-testid') === 'image-inspection-issues');
  expect(section?.props('compact')).toBe(true);
  expect(wrapper.get('[data-testid="image-inspection-issue"]').text()).toBe(issue);
});

it('changes step and CFG intent only on numeric edits and follows model values only while automatic', async () => {
  const view = useImageGeneration(), model = ref<ImageModelFacts>({ family: 'minimax-h3-image', variant: 'unknown', evidence: [] });
  view.draftDisabled = computed(() => false);
  view.modelParameterDefaults = computed(() => imageModelParameterDefaults({ model: model.value }));
  view.resolvedSteps = computed(() => view.stepsPreference.value === 'auto' ? view.modelParameterDefaults.value.steps.value : view.stepsPreference.value);
  view.resolvedGuidance = computed(() => view.guidancePreference.value === 'auto' ? view.modelParameterDefaults.value.guidance.value : view.guidancePreference.value);
  wrapper = mount(ImageGenerationEditor, { props: { view, active: true } });
  const steps = wrapper.get<HTMLInputElement>('[data-testid="image-steps"]'), guidance = wrapper.get<HTMLInputElement>('[data-testid="image-guidance"]');
  expect(steps.element.value).toBe('6');
  expect(guidance.element.value).toBe('1');
  await steps.trigger('focus');
  expect(view.stepsPreference.value).toBe('auto');
  model.value = { family: 'z-image', variant: 'base', evidence: [] };
  await flushPromises();
  expect(steps.element.value).toBe('50');
  expect(guidance.element.value).toBe('5');
  await steps.setValue('50');
  await guidance.setValue('5');
  expect(view.stepsPreference.value).toBe(50);
  expect(view.guidancePreference.value).toBe(5);
  model.value = { family: 'minimax-h3-image', variant: 'unknown', evidence: [] };
  await flushPromises();
  expect(steps.element.value).toBe('50');
  expect(guidance.element.value).toBe('5');
  expect(wrapper.get('[data-testid="image-steps-preference"]').text()).toBe('Fixed');
  expect(wrapper.get('[data-testid="image-guidance-preference"]').text()).toBe('Fixed');
});
