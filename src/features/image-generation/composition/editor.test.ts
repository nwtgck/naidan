import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { defineComponent, h, ref, shallowRef } from 'vue';
import { mount, flushPromises } from '@vue/test-utils';
import { ensureAllStringsForTest } from '@/strings/utils.test-support';
import ImageCompositionEditor from '@/features/image-generation/components/ImageCompositionEditor.vue';
import ImageCompositionFields from '@/features/image-generation/components/ImageCompositionFields.vue';
import SettingsFormSelect from '@/components/SettingsFormSelect.vue';
import { useImageComposition } from './use-image-composition';
import { compositionDraftFixture } from './draft.test-support';
import { parseImageGenerationInput, validateImageGenerationInputs } from './input';
const mocks = vi.hoisted(() => ({ confirm: vi.fn() }));
vi.mock('@/composables/useConfirm', () => ({ useConfirm: () => ({ showConfirm: mocks.confirm }) }));
vi.mock('@/00-storage/service/image-generation/composition', () => ({ loadImageGenerationComposition: vi.fn(), saveImageGenerationComposition: vi.fn() }));

beforeEach(async () => {
  await ensureAllStringsForTest({ locale: 'en' });
  mocks.confirm.mockReset().mockResolvedValue(true);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

it('imports pasted text into editable manual rows without a file or format picker', async () => {
  let view: ReturnType<typeof useImageComposition> | undefined;
  const wrapper = mount(defineComponent({
    setup() {
      view = useImageComposition({ store: shallowRef(undefined), sessionId: shallowRef(undefined), blocked: ref(false), commonCount: ref(1), captureDraft: compositionDraftFixture });
      return () => h(ImageCompositionEditor, { editor: view!, shared: { width: 256, count: 1 }, supported: true, running: false, stopping: false, progress: undefined });
    },
  }));
  using _cleanupResource = {
    [Symbol.dispose]() {
      wrapper.unmount();
    },
  };
  await wrapper.get('[data-testid="composition-add"]').trigger('click');
  await wrapper.get('[data-testid="composition-prompt"]').setValue('manual');
  await wrapper.get('[data-testid="composition-paste"]').trigger('click');
  await wrapper.get('[data-testid="composition-paste-text"]').setValue('{"prompt":"pasted","count":2}');
  await wrapper.get('[data-testid="composition-parse"]').trigger('click');
  await vi.waitFor(() => expect(view!.preview.value).toBeDefined());
  await flushPromises();
  expect(wrapper.text()).toContain('JSONL');
  await wrapper.get('[data-testid="composition-import"]').trigger('click');
  expect(wrapper.findAll('[data-testid="composition-job"]')).toHaveLength(2);
  await wrapper.findAll('[data-testid="composition-prompt"]')[1]!.setValue('edited pasted');
  expect(view!.state.value.jobs.map(job => job.input.prompt)).toEqual(['manual', 'edited pasted']);
  expect(view!.state.value.jobs[1]!.input.count).toBe(2);
  expect(wrapper.find('input[type="file"]').exists()).toBe(false);
  await wrapper.get('[data-testid="composition-shared-negative"]').setValue('common exclusion');
  expect(wrapper.findComponent(ImageCompositionEditor).emitted('sharedNegativePrompt')!.at(-1)).toEqual(['common exclusion']);
  expect(view!.state.value.jobs.every(job => job.input.negativePrompt === undefined)).toBe(true);
});

it('preserves exact seed text and removes overrides when inheritance is selected', async () => {
  const wrapper = mount(ImageCompositionFields, { props: { input: { prompt: 'cat', width: 512, seed: '42' }, disabled: false, shared: { width: 256, seed: null } } });
  using _cleanupResource = {
    [Symbol.dispose]() {
      wrapper.unmount();
    },
  };
  await wrapper.get('[data-testid="composition-field-seed"] input[type="text"]').setValue('9007199254740993');
  expect(wrapper.emitted('update')!.at(-1)![0]).toMatchObject({ seed: '9007199254740993' });
  await wrapper.get('[data-testid="composition-field-width"] input[type="checkbox"]').setValue(true);
  expect(wrapper.emitted('update')!.at(-1)![0]).not.toHaveProperty('width');
});

it('shows both valid YAML and JSONL examples together and copies either without replacing pasted input', async () => {
  const writeText = vi.fn().mockResolvedValue(undefined);
  vi.stubGlobal('navigator', { clipboard: { writeText } });
  const wrapper = mount(defineComponent({
    setup() {
      const editor = useImageComposition({ store: shallowRef(undefined), sessionId: shallowRef(undefined), blocked: ref(false), commonCount: ref(1), captureDraft: compositionDraftFixture });
      return () => h(ImageCompositionEditor, { editor, shared: {}, supported: true, running: false, stopping: false, progress: undefined });
    },
  }));
  using _cleanupResource = {
    [Symbol.dispose]() {
      wrapper.unmount();
    },
  };
  await wrapper.get('[data-testid="composition-paste"]').trigger('click');
  const pasted = '{"prompt":"My unfinished input"}';
  await wrapper.get('[data-testid="composition-paste-text"]').setValue(pasted);
  const examples = wrapper.get<HTMLDetailsElement>('[data-testid="composition-input-examples"]');
  examples.element.open = true;
  await examples.trigger('toggle');
  const expected = [
    { prompt: 'A red-haired character in a forest', negativePrompt: 'blurry, low quality', count: 2, seed: null, steps: 'auto' },
    { prompt: 'A blue-haired character in a forest', count: 1, seed: '42' },
  ];
  expect(wrapper.findAll('[data-testid^="composition-input-example-code-"]')).toHaveLength(2);
  for (const format of ['YAML', 'JSONL'] as const) {
    const text = wrapper.get(`[data-testid="composition-input-example-code-${format}"]`).text();
    const parsed = await parseImageGenerationInput({ text });
    expect(parsed).toEqual({ format, inputs: expected });
    expect(validateImageGenerationInputs({ inputs: parsed.inputs, defaultCount: 4 }).totalImages).toBe(3);
    await wrapper.get(`[data-testid="composition-copy-example-${format}"]`).trigger('click');
    await flushPromises();
    expect(writeText).toHaveBeenLastCalledWith(`${text}\n`);
  }
  expect(writeText).toHaveBeenCalledTimes(2);
  expect(wrapper.get<HTMLTextAreaElement>('[data-testid="composition-paste-text"]').element.value).toBe(pasted);
  expect(wrapper.find('[data-testid="composition-job"]').exists()).toBe(false);
});

it('does not accept a stale number behind an empty visible input', async () => {
  const wrapper = mount(ImageCompositionFields, { props: { input: { prompt: 'cat', width: 512 }, disabled: false, shared: {} } });
  using _cleanupResource = {
    [Symbol.dispose]() {
      wrapper.unmount();
    },
  };
  const input = wrapper.get('[data-testid="composition-field-width"] input[type="number"]');
  await input.setValue('');
  expect((input.element as HTMLInputElement).value).toBe('512');
  expect(wrapper.emitted('update')).toBeUndefined();
});

it.each(['steps', 'guidance', 'vaeTileSize'] as const)('keeps unresolved automatic %s separate from the common model and fixes only an explicit number', async key => {
  const original = { prompt: 'cat', uiModelConfigurationSlot: 'other-model', [key]: 'auto' as const };
  const wrapper = mount(ImageCompositionFields, { attachTo: document.body, props: { input: original, disabled: false, shared: { [key]: 64 } } });
  using _cleanupResource = {
    [Symbol.dispose]() {
      wrapper.unmount();
    },
  };
  const input = wrapper.get<HTMLInputElement>(`[data-testid="composition-field-${key}"] input[type="number"]`);
  const trigger = wrapper.get<HTMLButtonElement>(`[data-testid="composition-${key}-preference"]`);
  expect(input.element.value).toBe('');
  expect(trigger.text()).toBe('Auto');
  await trigger.trigger('click');
  await flushPromises();
  const fixed = document.querySelector<HTMLButtonElement>(`[data-testid="composition-${key}-fixed"]`)!;
  expect(fixed.disabled).toBe(true);
  fixed.click();
  expect(wrapper.emitted('update')).toBeUndefined();
  await input.setValue('16');
  expect(wrapper.emitted('update')!.at(-1)![0]).toEqual({ ...original, [key]: 16 });
  await wrapper.setProps({ input: { ...original, [key]: 16 } });
  expect(trigger.text()).toBe('Fixed');
  await input.setValue('');
  expect(input.element.value).toBe('16');
  expect(wrapper.emitted('update')).toHaveLength(1);
  await trigger.trigger('keydown', { key: 'ArrowDown' });
  await flushPromises();
  document.querySelector<HTMLButtonElement>(`[data-testid="composition-${key}-automatic"]`)!.click();
  await flushPromises();
  expect(wrapper.emitted('update')!.at(-1)![0]).toEqual(original);
  expect(trigger.attributes('aria-expanded')).toBe('false');
  expect(document.activeElement).toBe(trigger.element);
});

it('selects random or fixed seeds without coercing seed text into a number', async () => {
  const wrapper = mount(ImageCompositionFields, { props: { input: { prompt: 'cat', seed: '9007199254740993' }, disabled: false, shared: {} } });
  using _cleanupResource = {
    [Symbol.dispose]() {
      wrapper.unmount();
    },
  };
  const mode = wrapper.getComponent(SettingsFormSelect);
  expect(mode.props()).toMatchObject({ modelValue: 'fixed' });
  mode.vm.$emit('update:modelValue', 'random');
  expect(wrapper.emitted('update')!.at(-1)![0]).toEqual({ prompt: 'cat', seed: null });
  await wrapper.setProps({ input: { prompt: 'cat', seed: null } });
  const input = wrapper.get<HTMLInputElement>('[data-testid="composition-field-seed"] input[type="text"]');
  expect(input.element.readOnly).toBe(true);
  mode.vm.$emit('update:modelValue', 'fixed');
  expect(wrapper.emitted('update')!.at(-1)![0]).toEqual({ prompt: 'cat', seed: '0' });
  await wrapper.setProps({ input: { prompt: 'cat', seed: '0' } });
  await input.setValue('9007199254740993');
  expect(wrapper.emitted('update')!.at(-1)![0]).toEqual({ prompt: 'cat', seed: '9007199254740993' });
});
