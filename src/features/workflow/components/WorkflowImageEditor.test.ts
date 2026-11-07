import { beforeEach, afterEach, it, expect, vi } from 'vitest';
import { computed, ref } from 'vue';
import { mount, flushPromises } from '@vue/test-utils';
import { ensureAllStringsForTest } from '@/strings/utils.test-support';
import { createDisabledImageLibrary } from '@/features/stable-diffusion-cpp-browser/library-standalone';
import { artifactFixture } from '@/features/stable-diffusion-cpp-browser/test-fixtures';
import type { ImageLibraryView } from '@/features/stable-diffusion-cpp-browser/library-view';
import { imageStep, imageSelection } from '@/features/workflow/logic/image-generation.test-support';
import { workflowImageParameterKeys } from '@/features/workflow/logic/image-input';
import { literal } from '@/features/workflow/logic/workflow.test-support';
import { createWorkflowInputDrafts, workflowInputDraftsKey } from '@/features/workflow/composables/input-drafts';
import { workflowImageModelReviewKey } from '@/features/workflow/composables/model-review';
import WorkflowImageEditor from './WorkflowImageEditor.vue';
import WorkflowImageModelEditor from './WorkflowImageModelEditor.vue';
import WorkflowValueEditor from './WorkflowValueEditor.vue';
import WorkflowDisclosure from './WorkflowDisclosure.vue';
import ImageLoraControls from '@/features/stable-diffusion-cpp-browser/components/ImageLoraControls.vue';

const mocks = vi.hoisted(() => ({ library: undefined as ImageLibraryView | undefined, configuration: undefined as unknown, use: vi.fn() }));
vi.mock('@/features/image-generation/providers/local-environment', () => ({
  get rawConfiguration() {
    return mocks.configuration;
  },
  useImageLibrary: mocks.use,
}));
vi.mock('@/composables/useSettings', () => ({ useSettings: () => ({ settings: ref({}), availableModels: ref([]), isFetchingModels: ref(false), fetchModels: vi.fn() }) }));

beforeEach(async () => {
  await ensureAllStringsForTest({ locale: 'en' });
  mocks.configuration = { kind: 'available', sourceCommit: 'a'.repeat(40), artifacts: [artifactFixture()] };
  const base = new File([new Uint8Array(16)], 'model.gguf'), vae = new File([new Uint8Array(16)], 'vae.gguf');
  mocks.library = {
    ...createDisabledImageLibrary(),
    refresh: vi.fn(async () => undefined),
    restoreModelSelection: vi.fn(() => ({ loras: [], missing: [], missingInactive: [] })),
    captureModelSelection: vi.fn(() => ({ ...imageSelection(), components: [] })),
    selectedModels: vi.fn<ImageLibraryView['selectedModels']>(() => [{ slot: 'model', file: base }, { slot: 'vae', file: vae }]),
    historyFileLocation: vi.fn<ImageLibraryView['historyFileLocation']>(({ file }) => ({ name: file.name, size: file.size, lastModified: file.lastModified, type: 'opfs', path: file === vae ? 'models/user/vae/vae.gguf' : 'models/user/example/model.gguf' })),
    components: computed(() => [{ slot: 'vae', selectedCandidateKey: 'auto-selected', required: false, choices: [] }]),
    selectedCandidateKey: ref('model'),
    ready: computed(() => true),
  };
  mocks.use.mockImplementation(() => mocks.library);
});

afterEach(() => vi.resetAllMocks());

function editor() {
  const step = imageStep({ id: 'image' }), review = vi.fn(), drafts = createWorkflowInputDrafts();
  const wrapper = mount(WorkflowImageEditor, { props: { step, steps: [step], disabled: false }, global: { provide: { [workflowImageModelReviewKey as symbol]: review, [workflowInputDraftsKey as symbol]: drafts } } });
  return {
    wrapper,
    review,
    drafts,
    [Symbol.dispose]() {
      wrapper.unmount();
    },
  };
}

it('does not scan, modify or approve an imported image selection merely by rendering', async () => {
  using view = editor();
  await flushPromises();
  expect(mocks.library!.refresh).not.toHaveBeenCalled();
  expect(view.wrapper.emitted('change')).toBeUndefined();
  expect(view.review).not.toHaveBeenCalled();
  expect(mocks.use.mock.calls[0]![0].downloadsBlocked()).toBe(true);
  expect(view.wrapper.getComponent(ImageLoraControls).props('sources')).toBe('library');
});

it('scans only on request and restores a fixed selection without approving or applying defaults', async () => {
  using view = editor();
  await view.wrapper.get('[data-testid="workflow-image-refresh"]').trigger('click');
  await flushPromises();
  expect(mocks.library!.refresh).toHaveBeenCalledOnce();
  expect(mocks.library!.restoreModelSelection).toHaveBeenCalledExactlyOnceWith({ selection: imageSelection() });
  expect(view.wrapper.emitted('change')).toBeUndefined();
  expect(view.review).not.toHaveBeenCalled();
});

it('captures automatic companion resolution as an explicit locator only on Apply', async () => {
  using view = editor();
  await view.wrapper.get('[data-testid="workflow-image-apply-model"]').trigger('click');
  const expected = { ...imageSelection(), components: [{ slot: 'vae', choice: { kind: 'file', location: { kind: 'opfs', path: 'models/user/vae/vae.gguf' } } }] };
  expect(view.wrapper.emitted('change')?.at(-1)?.[0]).toMatchObject({ model: { type: 'literal', value: expected } });
  expect(view.review).toHaveBeenCalledExactlyOnceWith({ selection: expected });
});

it('captures an explicit absence for a built-in decoder instead of storing an automatic preference', async () => {
  const selected = mocks.library!.selectedModels()!;
  mocks.library!.selectedModels = () => selected.filter(model => model.slot === 'model');
  using view = editor();
  await view.wrapper.get('[data-testid="workflow-image-apply-model"]').trigger('click');
  expect(view.review).toHaveBeenCalledExactlyOnceWith({ selection: imageSelection() });
});

it('rejects anonymous companion files that cannot be resolved on the next run', async () => {
  mocks.library!.historyFileLocation = ({ file }) => ({ type: 'file', name: file.name, size: file.size, lastModified: file.lastModified });
  using view = editor();
  await view.wrapper.get('[data-testid="workflow-image-apply-model"]').trigger('click');
  expect(view.wrapper.get('[role="alert"]').text()).toContain('library');
  expect(view.review).not.toHaveBeenCalled();
  expect(view.wrapper.emitted('change')).toBeUndefined();
});

it('does not restore a stale document selection after a delayed scan', async () => {
  const gate = Promise.withResolvers<void>();
  mocks.library!.refresh = vi.fn(() => gate.promise);
  using view = editor();
  await view.wrapper.get('[data-testid="workflow-image-refresh"]').trigger('click');
  const step = imageStep({ id: 'other' });
  await view.wrapper.setProps({ step, steps: [step] });
  gate.resolve();
  await flushPromises();
  expect(mocks.library!.restoreModelSelection).not.toHaveBeenCalled();
  expect(view.review).not.toHaveBeenCalled();
});

it('keeps unavailable local generation editable as Values without scanning or enabling Apply', async () => {
  mocks.configuration = { kind: 'unavailable', reason: 'standalone' };
  using view = editor();
  expect(view.wrapper.get('[data-testid="workflow-image-refresh"]').element.matches(':disabled')).toBe(true);
  expect(view.wrapper.get('[data-testid="workflow-image-apply-model"]').element.matches(':disabled')).toBe(true);
  await view.wrapper.get('[data-testid="workflow-image-model-value"]').trigger('click');
  expect(view.wrapper.findComponent(WorkflowImageModelEditor).exists()).toBe(false);
  view.wrapper.findAllComponents(WorkflowValueEditor)[0]!.vm.$emit('change', literal({ value: 'not approval' }));
  expect(view.review).not.toHaveBeenCalled();
});

it('exposes all eighteen typed controls and preserves an incomplete number instead of converting it to zero', async () => {
  using view = editor();
  await view.wrapper.getComponent(WorkflowDisclosure).get('button').trigger('click');
  expect(view.wrapper.findAll('[data-image-parameter]').map(node => node.attributes('data-image-parameter')).sort()).toEqual([...workflowImageParameterKeys].sort());
  const field = view.wrapper.get('[data-image-parameter="width"] input[inputmode="decimal"]');
  await field.setValue('-');
  expect(view.drafts.dirty.value).toBe(true);
  expect(view.wrapper.get('[data-testid="workflow-image-apply-model"]').element.matches(':disabled')).toBe(true);
  expect(view.wrapper.emitted('change')).toBeUndefined();
  await field.setValue('512');
  expect(view.drafts.dirty.value).toBe(false);
  expect(view.wrapper.emitted('change')?.at(-1)?.[0]).toMatchObject({ parameters: { width: literal({ value: 512 }) } });
});

it('preserves a 64-bit seed as text and enables a separately typed memory budget explicitly', async () => {
  using view = editor();
  const seed = view.wrapper.get('[data-image-parameter="seed"]').findComponent(WorkflowValueEditor);
  seed.vm.$emit('change', literal({ value: '9223372036854775807' }));
  expect(view.wrapper.emitted('change')?.at(-1)?.[0]).toMatchObject({ parameters: { seed: literal({ value: '9223372036854775807' }) } });
  await view.wrapper.getComponent(WorkflowDisclosure).get('button').trigger('click');
  await view.wrapper.get('[data-testid="workflow-image-budget-enabled"]').setValue(true);
  expect(view.wrapper.emitted('change')?.at(-1)?.[0]).toMatchObject({ gpuBudgetMiB: literal({ value: 2048 }) });
});

export const TEST_ONLY = {
};
