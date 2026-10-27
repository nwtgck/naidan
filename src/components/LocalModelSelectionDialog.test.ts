import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import { ref } from 'vue';
import { ensureAllStringsForTest } from '@/strings/utils.test-support';
import LocalModelSelectionDialog from './LocalModelSelectionDialog.vue';

const mocks = vi.hoisted(() => ({ choose: vi.fn(), cancel: vi.fn() }));
const selection = ref<{
  models: { modelId: string, size: number, importedAt: number }[],
  status: 'choosing' | 'starting',
  error: 'start-failed' | undefined,
} | undefined>();
vi.mock('@/composables/useLocalModelStart', () => ({ useBrowserModelLocalInputSelection: () => ({ selection, ...mocks }) }));
vi.mock('@/features/llama-cpp-browser/components/LlamaCppBrowserLocalRepositorySaves.vue', () => ({ default: { props: ['offeredVisibility'], template: '<aside data-testid="selection-copy-progress" :data-offered="offeredVisibility" />' } }));
const wrappers: VueWrapper[] = [];

beforeEach(async () => {
  vi.clearAllMocks();
  await ensureAllStringsForTest({ locale: 'en' });
  selection.value = {
    models: [{ modelId: 'temp/local:Q4', size: 128, importedAt: 1 }, { modelId: 'temp/local:Q8', size: 256, importedAt: 1 }],
    status: 'choosing',
    error: undefined,
  };
});

afterEach(() => {
  for (const wrapper of wrappers.splice(0)) {
    wrapper.unmount();
  }
});

function render() {
  const wrapper = mount(LocalModelSelectionDialog, { attachTo: document.body, global: { stubs: { teleport: true } } });
  wrappers.push(wrapper);
  return wrapper;
}

it('waits for an explicit configuration choice before starting', async () => {
  const wrapper = render();
  const start = wrapper.get('[data-testid="local-model-selection-start"]');
  expect(wrapper.get('[data-testid="selection-copy-progress"]').attributes('data-offered')).toBe('hidden');
  expect(start.attributes('disabled')).toBeDefined();
  expect(mocks.choose).not.toHaveBeenCalled();
  const choice = wrapper.get<HTMLInputElement>('[data-testid="local-model-choice-temp/local:Q8"]');
  await choice.setValue(true);
  expect(choice.element.checked).toBe(true);
  expect(wrapper.get('[data-testid="local-model-selection-start"]').attributes('disabled')).toBeUndefined();
  await wrapper.get('[data-testid="local-model-selection-start"]').trigger('click');
  expect(mocks.choose).toHaveBeenCalledExactlyOnceWith({ modelId: 'temp/local:Q8' });
});

it('disables selection and Start while saving and keeps cancellation available', async () => {
  const wrapper = render();
  await wrapper.get('[data-testid="local-model-choice-temp/local:Q4"]').setValue(true);
  if (selection.value) {
    selection.value.status = 'starting';
  }
  await flushPromises();
  expect(wrapper.get('[data-testid="local-model-selection-start"]').attributes('disabled')).toBeDefined();
  expect(wrapper.get('[data-testid="local-model-choice-temp/local:Q4"]').attributes('disabled')).toBeDefined();
  await wrapper.get('[data-testid="local-model-selection-cancel"]').trigger('click');
  expect(mocks.cancel).toHaveBeenCalledOnce();
});

it('shows a retry error without changing the selected configuration', async () => {
  const wrapper = render();
  const choice = wrapper.get<HTMLInputElement>('[data-testid="local-model-choice-temp/local:Q8"]');
  await choice.setValue(true);
  if (selection.value) {
    selection.value.error = 'start-failed';
  }
  await flushPromises();
  expect(wrapper.get('[data-testid="local-model-selection-error"]').text()).toBe('Could not start the model. Try again.');
  expect(choice.element.checked).toBe(true);
  await wrapper.get('[data-testid="local-model-selection-start"]').trigger('click');
  expect(mocks.choose).toHaveBeenCalledWith({ modelId: 'temp/local:Q8' });
});

it('hides a retired selection and cancels with Escape', async () => {
  const wrapper = render();
  await wrapper.get('[role="dialog"]').trigger('keydown', { key: 'Escape' });
  expect(mocks.cancel).toHaveBeenCalledOnce();
  selection.value = undefined;
  await flushPromises();
  expect(wrapper.find('[data-testid="local-model-selection"]').exists()).toBe(false);
});
