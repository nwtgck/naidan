import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { defineComponent, h, ref, shallowRef } from 'vue';
import { mount, flushPromises } from '@vue/test-utils';
import { ensureAllStringsForTest } from '@/strings/utils.test-support';
import ImageCompositionEditor from '@/features/image-generation/components/ImageCompositionEditor.vue';
import ImageCompositionFields from '@/features/image-generation/components/ImageCompositionFields.vue';
import { useImageComposition } from './use-image-composition';
import { compositionDraftFixture } from './draft.test-support';
const mocks = vi.hoisted(() => ({ confirm: vi.fn() }));
vi.mock('@/composables/useConfirm', () => ({ useConfirm: () => ({ showConfirm: mocks.confirm }) }));
vi.mock('@/00-storage/service/image-generation/composition', () => ({ loadImageGenerationComposition: vi.fn(), saveImageGenerationComposition: vi.fn() }));

beforeEach(async () => {
  await ensureAllStringsForTest({ locale: 'en' });
  mocks.confirm.mockReset().mockResolvedValue(true);
});

afterEach(() => vi.restoreAllMocks());

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
