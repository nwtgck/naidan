import { enableAutoUnmount, flushPromises, mount } from '@vue/test-utils';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { computed, h } from 'vue';
import { ensureAllStringsForTest } from '@/strings/utils.test-support';
import { createDisabledImageLibrary } from '@/features/stable-diffusion-cpp-browser/library-standalone';
import type { useImageLibrary } from '@/features/stable-diffusion-cpp-browser/use-image-library';
import HuggingFaceDownloadFailureHint from '@/components/HuggingFaceDownloadFailureHint.vue';
import ImageModelLocalFileRecovery from './ImageModelLocalFileRecovery.vue';
import ImageRepositoryImport from './ImageRepositoryImport.vue';

const fixture = vi.hoisted(() => ({ configuration: undefined as unknown, create: vi.fn<typeof useImageLibrary>() }));
vi.mock('@/features/image-generation/providers/local-environment', () => ({
  get rawConfiguration() {
    return fixture.configuration;
  },
  useImageLibrary: fixture.create,
}));
// No policy/parser result is required for the existing local file workflow.
vi.mock('@/components/csp/CspMessageHint.vue', () => ({ default: { name: 'CspMessageHint', render: () => undefined } }));

enableAutoUnmount(afterEach);

beforeEach(async () => {
  vi.clearAllMocks();
  const revision = 'a'.repeat(40);
  const prefix = `stable-diffusion-cpp-runtime/${revision}/`;
  fixture.configuration = {
    kind: 'available',
    sourceCommit: revision,
    artifacts: [{ profile: 'webgpu-wasm32-asyncify', modulePath: `${prefix}webgpu-wasm32-asyncify/core.mjs`, wasmPath: `${prefix}webgpu-wasm32-asyncify/core.wasm.gz`, helpersPath: `${prefix}examples/runtime/index.mjs`, schemaSha256: 'b'.repeat(64), wasmBytes: 1, wasmSha256: 'c'.repeat(64) }],
  };
  fixture.create.mockReturnValue(createDisabledImageLibrary());
  await ensureAllStringsForTest({ locale: 'en' });
});

it('reuses an existing image owner without creating or invoking another library', async () => {
  const view = {
    ...createDisabledImageLibrary(),
    refresh: vi.fn(async () => {}),
    importFiles: vi.fn(async () => {}),
    importDirectory: vi.fn(async () => {}),
    dropDirectory: vi.fn(async () => {}),
    chooseMain: vi.fn(),
  };
  const wrapper = mount(ImageModelLocalFileRecovery, { props: { view, disabled: false } });
  expect(wrapper.getComponent(ImageRepositoryImport).props('view')).toBe(view);
  expect(wrapper.getComponent(ImageRepositoryImport).props('disabled')).toBe(false);
  expect(fixture.create).not.toHaveBeenCalled();
  expect(view.refresh).not.toHaveBeenCalled();
  expect(view.importFiles).not.toHaveBeenCalled();
  expect(view.importDirectory).not.toHaveBeenCalled();
  expect(view.dropDirectory).not.toHaveBeenCalled();
  expect(view.chooseMain).not.toHaveBeenCalled();
  await wrapper.setProps({ disabled: true });
  expect(wrapper.getComponent(ImageRepositoryImport).props('disabled')).toBe(true);
});

it('creates an independent import view only on explicit expansion and retains it when closing', async () => {
  const view = {
    ...createDisabledImageLibrary(),
    refresh: vi.fn(async () => {}),
    importFiles: vi.fn(async () => {}),
    importDirectory: vi.fn(async () => {}),
    dropDirectory: vi.fn(async () => {}),
    downloadRecipe: vi.fn(async () => {}),
    chooseMain: vi.fn(),
  };
  fixture.create.mockReturnValue(view);
  const wrapper = mount(HuggingFaceDownloadFailureHint, { slots: { default: () => h(ImageModelLocalFileRecovery, { view: undefined, disabled: false }) } });
  expect(wrapper.find('[data-testid="image-local-file-recovery"]').exists()).toBe(false);
  expect(fixture.create).not.toHaveBeenCalled();
  const trigger = wrapper.get('[data-testid="hf-download-failure-trigger"]');
  await trigger.trigger('click');
  expect(wrapper.find('[data-testid="image-local-file-recovery"]').exists()).toBe(true);
  expect(wrapper.get('input[accept=".gguf,.safetensors,.sft"]').attributes('disabled')).toBeUndefined();
  expect(fixture.create).toHaveBeenCalledOnce();
  const options = fixture.create.mock.calls[0]?.[0];
  expect(options?.blocked()).toBe(false);
  expect(options?.downloadsBlocked()).toBe(true);
  expect(options?.dependencies).toBeUndefined();
  options?.onSelection({ family: 'flux1', turbo: false });
  expect(view.chooseMain).not.toHaveBeenCalled();
  expect(view.refresh).not.toHaveBeenCalled();
  expect(view.importFiles).not.toHaveBeenCalled();
  expect(view.importDirectory).not.toHaveBeenCalled();
  expect(view.dropDirectory).not.toHaveBeenCalled();
  expect(view.downloadRecipe).not.toHaveBeenCalled();
  expect(wrapper.text()).toContain('select the model in image generation');
  await trigger.trigger('click');
  expect(wrapper.get('.settings-collapse').attributes('inert')).toBeDefined();
  await trigger.trigger('click');
  expect(fixture.create).toHaveBeenCalledOnce();
});

it('hands explicit file, directory, drop and folder-link actions to the image owner with no chat fallback', async () => {
  const view = {
    ...createDisabledImageLibrary(),
    importFiles: vi.fn(async () => {}),
    importDirectory: vi.fn(async () => {}),
    dropDirectory: vi.fn(async () => {}),
  };
  view.hostDirectories.supported = computed(() => true);
  view.hostDirectories.add = vi.fn(async () => {});
  const wrapper = mount(ImageModelLocalFileRecovery, { props: { view, disabled: false } });
  await wrapper.get('input[accept=".gguf,.safetensors,.sft"]').trigger('change');
  await wrapper.get('input[webkitdirectory]').trigger('change');
  const transfer = { types: ['Files'], items: [] };
  const dispatch = wrapper.get('[data-testid="image-repository-drop"]').trigger('drop', { dataTransfer: transfer });
  expect(view.dropDirectory).toHaveBeenCalledOnce();
  await dispatch;
  expect(view.importFiles).toHaveBeenCalledWith(expect.objectContaining({ storage: 'opfs' }));
  expect(view.importDirectory).toHaveBeenCalledWith(expect.objectContaining({ storage: 'opfs' }));
  expect(view.dropDirectory).toHaveBeenCalledWith(expect.objectContaining({ storage: 'opfs' }));
  await wrapper.get('[data-testid="image-import-mode-host"]').trigger('click');
  expect(view.hostDirectories.add).not.toHaveBeenCalled();
  await wrapper.get('[data-testid="linked-add-model-directory"]').trigger('click');
  expect(view.hostDirectories.add).toHaveBeenCalledOnce();
  expect(fixture.create).not.toHaveBeenCalled();
  expect(wrapper.find('[data-testid="gguf-local-recovery"]').exists()).toBe(false);
});

it('shows independent local import errors without changing the failed download', async () => {
  const view = createDisabledImageLibrary();
  fixture.create.mockReturnValue(view);
  const wrapper = mount(ImageModelLocalFileRecovery, { props: { view: undefined, disabled: false } });
  view.failure.value = 'Local file could not be read';
  await wrapper.vm.$nextTick();
  expect(wrapper.get('[data-testid="image-local-file-recovery-error"]').text()).toBe('Local file could not be read');
  expect(view.downloadState.value).toBe('idle');
  expect(wrapper.find('[data-testid="image-repository-drop"]').exists()).toBe(true);
});

it.each(['unavailable', 'invalid'] as const)('keeps %s local operations disabled without replacing the provider facade', state => {
  fixture.configuration = state === 'unavailable' ? { kind: 'unavailable', reason: 'standalone' } : undefined;
  const wrapper = mount(ImageModelLocalFileRecovery, { props: { view: undefined, disabled: false } });
  expect(wrapper.get<HTMLInputElement>('input[type="file"]').element.disabled).toBe(true);
  expect(fixture.create.mock.calls[0]?.[0].blocked()).toBe(true);
  expect(fixture.create.mock.calls[0]?.[0].downloadsBlocked()).toBe(true);
});

it('isolates independent-view initialization failure from the original download error', async () => {
  fixture.create.mockImplementation(() => {
    throw new Error('Private initialization failure');
  });
  const applicationError = vi.fn();
  const wrapper = mount(HuggingFaceDownloadFailureHint, { slots: { default: () => h(ImageModelLocalFileRecovery, { view: undefined, disabled: false }) }, global: { config: { errorHandler: applicationError } } });
  await wrapper.get('[data-testid="hf-download-failure-trigger"]').trigger('click');
  expect(wrapper.get('[data-testid="image-local-file-recovery-error"]').text()).toBe('Could not open the local image model files.');
  expect(wrapper.text()).not.toContain('Private initialization failure');
  expect(applicationError).not.toHaveBeenCalled();
});

it('contains a child local-file view failure within the recovery leaf', async () => {
  const applicationError = vi.fn();
  const wrapper = mount(ImageModelLocalFileRecovery, {
    props: { view: createDisabledImageLibrary(), disabled: false },
    global: {
      config: { errorHandler: applicationError },
      stubs: {
        ImageRepositoryImport: {
          setup() {
            throw new Error('Private child failure');
          },
          render: () => undefined,
        },
      },
    },
  });
  await flushPromises();
  expect(wrapper.get('[data-testid="image-local-file-recovery-error"]').text()).toBe('Could not open the local image model files.');
  expect(applicationError).not.toHaveBeenCalled();
});
