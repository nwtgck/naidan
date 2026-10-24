import { beforeEach, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import { ensureAllStringsForTest } from '@/strings/utils.test-support';
import type { LocalModel } from '@/features/llama-cpp-browser/types';
import LlamaCppBrowserSavedModelPicker from './LlamaCppBrowserSavedModelPicker.vue';
import LlamaCppBrowserDeletionDialog from './LlamaCppBrowserDeletionDialog.vue';
import { modelRemovalPlan } from './model-removal.test-support';
import type { ModelRemovalRequest } from '@/features/llama-cpp-browser/runtime/model-store';
const mocks = vi.hoisted(() => ({ list: vi.fn(), prepare: vi.fn(), remove: vi.fn(), removeTemporary: vi.fn(), listener: undefined as (() => void) | undefined }));
vi.mock('../composables/model-inventory', () => ({ listModelInventory: mocks.list }));
vi.mock('../runtime/model-store', () => ({ prepareModelRemoval: mocks.prepare, prepareRepositoryRemoval: vi.fn() }));
vi.mock('../model-files', () => ({
  llamaCppBrowserModelFiles: {
    removeModel: mocks.remove,
    removeTemporaryModel: mocks.removeTemporary,
    subscribeModelList: ({ listener }: { listener(): void }) => {
      mocks.listener = listener;
      return () => {
        mocks.listener = undefined;
      };
    },
  },
}));
const model: LocalModel = { modelId: 'user/Qwen-9B:Q4_K_M', size: 1024 ** 3, importedAt: 1 };
const removalRequest: ModelRemovalRequest = { plan: modelRemovalPlan({ modelId: model.modelId, files: [] }), sharedPlan: undefined, affectedVariants: 0 };

beforeEach(async () => {
  vi.resetAllMocks();
  mocks.list.mockResolvedValue([model]);
  mocks.prepare.mockResolvedValue(removalRequest);
  mocks.remove.mockResolvedValue('deleted');
  await ensureAllStringsForTest({ locale: 'en' });
});

it('uses the same name, size and details row as model management with an action for this chat', async () => {
  const wrapper = mount(LlamaCppBrowserSavedModelPicker, { props: { disabled: false } });
  using _cleanup = {
    [Symbol.dispose]() {
      wrapper.unmount();
    },
  };
  await flushPromises();
  expect(wrapper.get('[data-testid="llama-imported-model-name"]').text()).toBe(model.modelId);
  expect(wrapper.get(`[data-testid="llama-imported-model-details-toggle-${model.modelId}"]`).text()).toContain('1.00 GiB');
  expect(wrapper.find('[data-testid="llama-default-model-action"]').exists()).toBe(false);
  expect(wrapper.find('[data-testid="llama-model-split-action"]').exists()).toBe(false);
  expect(wrapper.find(`[data-testid="llama-cpp-browser-delete-${model.modelId}"]`).exists()).toBe(true);
  await wrapper.get(`[data-testid="chat-use-saved-model-${model.modelId}"]`).trigger('click');
  expect(wrapper.emitted('select')).toEqual([[model]]);
});

it('filters models without losing the source of truth and observes inventory changes locally', async () => {
  const wrapper = mount(LlamaCppBrowserSavedModelPicker, { props: { disabled: false } });
  using _cleanup = {
    [Symbol.dispose]() {
      wrapper.unmount();
    },
  };
  await flushPromises();
  await wrapper.get('[data-testid="chat-saved-model-filter"]').setValue('missing');
  expect(wrapper.find('[data-testid="llama-imported-model-name"]').exists()).toBe(false);
  await wrapper.get('[data-testid="chat-saved-model-filter"]').setValue('qwen');
  expect(wrapper.get('[data-testid="llama-imported-model-name"]').text()).toBe(model.modelId);
  mocks.list.mockResolvedValue([]);
  mocks.listener?.();
  await flushPromises();
  expect(wrapper.find('[data-testid="llama-imported-model-name"]').exists()).toBe(false);
});

it('does not scan while its tab is inactive and prevents selection until the scan finishes', async () => {
  const pending = Promise.withResolvers<LocalModel[]>();
  mocks.list.mockReturnValue(pending.promise);
  const wrapper = mount(LlamaCppBrowserSavedModelPicker, { props: { disabled: true } });
  using _cleanup = {
    [Symbol.dispose]() {
      wrapper.unmount();
    },
  };
  expect(mocks.list).not.toHaveBeenCalled();
  await wrapper.setProps({ disabled: false });
  expect(mocks.list).toHaveBeenCalledOnce();
  await wrapper.setProps({ disabled: true });
  pending.resolve([model]);
  await flushPromises();
  expect(wrapper.find('[data-testid="llama-imported-model-name"]').exists()).toBe(false);
  expect(wrapper.emitted('select')).toBeUndefined();
});

it('uses the shared deletion confirmation and refreshes the inventory after confirmed removal', async () => {
  const wrapper = mount(LlamaCppBrowserSavedModelPicker, { props: { disabled: false } });
  using _cleanup = {
    [Symbol.dispose]() {
      wrapper.unmount();
    },
  };
  await flushPromises();
  await wrapper.get(`[data-testid="llama-cpp-browser-delete-${model.modelId}"]`).trigger('click');
  await flushPromises();
  const dialog = wrapper.getComponent(LlamaCppBrowserDeletionDialog);
  expect(dialog.props('request')).toEqual(removalRequest);
  expect(mocks.remove).not.toHaveBeenCalled();
  expect(wrapper.get(`[data-testid="chat-use-saved-model-${model.modelId}"]`).attributes('disabled')).toBeDefined();
  mocks.list.mockResolvedValue([]);
  dialog.vm.$emit('confirm', removalRequest.plan);
  await flushPromises();
  expect(mocks.remove).toHaveBeenCalledExactlyOnceWith({ plan: removalRequest.plan, signal: expect.any(AbortSignal) });
  expect(wrapper.find('[data-testid="llama-imported-model-name"]').exists()).toBe(false);
  expect(dialog.props('request')).toBeUndefined();
  expect(wrapper.emitted('select')).toBeUndefined();
});

it('does not delete after cancellation and reports a changed deletion plan', async () => {
  const wrapper = mount(LlamaCppBrowserSavedModelPicker, { props: { disabled: false } });
  using _cleanup = {
    [Symbol.dispose]() {
      wrapper.unmount();
    },
  };
  await flushPromises();
  const remove = wrapper.get(`[data-testid="llama-cpp-browser-delete-${model.modelId}"]`);
  await remove.trigger('click');
  await flushPromises();
  const dialog = wrapper.getComponent(LlamaCppBrowserDeletionDialog);
  dialog.vm.$emit('cancel');
  await flushPromises();
  expect(mocks.remove).not.toHaveBeenCalled();
  expect(wrapper.get(`[data-testid="chat-use-saved-model-${model.modelId}"]`).attributes('disabled')).toBeUndefined();
  await remove.trigger('click');
  await flushPromises();
  mocks.remove.mockResolvedValue('changed');
  dialog.vm.$emit('confirm', removalRequest.plan);
  await flushPromises();
  expect(wrapper.find('[data-testid="chat-model-removal-changed"]').exists()).toBe(true);
  expect(wrapper.find('[data-testid="llama-imported-model-name"]').exists()).toBe(true);
});

it('unregisters a temporary model without offering to delete source files', async () => {
  const temporary = { ...model, modelId: 'temp/Qwen-9B' };
  mocks.list.mockResolvedValue([temporary]);
  const wrapper = mount(LlamaCppBrowserSavedModelPicker, { props: { disabled: false } });
  using _cleanup = {
    [Symbol.dispose]() {
      wrapper.unmount();
    },
  };
  await flushPromises();
  await wrapper.get(`[data-testid="llama-cpp-browser-delete-${temporary.modelId}"]`).trigger('click');
  await flushPromises();
  expect(mocks.removeTemporary).toHaveBeenCalledExactlyOnceWith({ modelId: temporary.modelId, signal: expect.any(AbortSignal) });
  expect(mocks.prepare).not.toHaveBeenCalled();
  expect(mocks.remove).not.toHaveBeenCalled();
});

it('abandons a late deletion plan when the source tab is left', async () => {
  const pending = Promise.withResolvers<ModelRemovalRequest>();
  mocks.prepare.mockReturnValue(pending.promise);
  const wrapper = mount(LlamaCppBrowserSavedModelPicker, { props: { disabled: false } });
  using _cleanup = {
    [Symbol.dispose]() {
      wrapper.unmount();
    },
  };
  await flushPromises();
  await wrapper.get(`[data-testid="llama-cpp-browser-delete-${model.modelId}"]`).trigger('click');
  const signal: AbortSignal = mocks.prepare.mock.calls[0]![0].signal;
  await wrapper.setProps({ disabled: true });
  expect(signal.aborted).toBe(true);
  pending.resolve(removalRequest);
  await flushPromises();
  expect(wrapper.getComponent(LlamaCppBrowserDeletionDialog).props('request')).toBeUndefined();
  expect(mocks.remove).not.toHaveBeenCalled();
});
