import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import { ensureAllStringsForTest } from '@/strings/test-utils';
import type { ApplyDefaultModel, DefaultModelContext } from '@/features/llama-cpp-browser/default-model';
import LlamaCppBrowserDefaultModelAction from './LlamaCppBrowserDefaultModelAction.vue';
import LlamaCppBrowserDefaultModelDialog from './LlamaCppBrowserDefaultModelDialog.vue';
const model = { id: 'user/custom', name: 'my-model-Q4_K_M', size: 128, importedAt: 1 };
const current: DefaultModelContext = { endpoint: { type: 'ollama', url: 'http://localhost:11434' }, modelId: 'old-model' };
const wrappers: VueWrapper[] = [];
beforeEach(async () => {
  await ensureAllStringsForTest({ locale: 'en' });
});
afterEach(() => {
  for (const wrapper of wrappers.splice(0)) wrapper.unmount();
});
describe('shared default model action and confirmation', () => {
  it('requires both the endpoint and default reference to match before displaying In use', async () => {
    const wrapper = mount(LlamaCppBrowserDefaultModelAction, { props: { model, current: { ...current, modelId: model.name }, disabled: false } }); wrappers.push(wrapper);
    expect(wrapper.text()).toBe('Set as default');
    await wrapper.setProps({ current: { endpoint: { type: 'llama_cpp_browser' }, modelId: model.name } });
    expect(wrapper.text()).toBe('In use'); expect(wrapper.attributes('disabled')).toBeDefined();
    await wrapper.setProps({ current: { endpoint: { type: 'llama_cpp_browser' }, modelId: model.id } });
    expect(wrapper.text()).toBe('In use');
  });
  it('shows the model transition before endpoint changes and commits nothing until confirmation', async () => {
    const gate = Promise.withResolvers<'applied' | 'changed'>(); const apply = vi.fn<ApplyDefaultModel>().mockReturnValue(gate.promise);
    const wrapper = mount(LlamaCppBrowserDefaultModelDialog, { props: { model, current, models: [model], apply }, global: { stubs: { Teleport: true } } }); wrappers.push(wrapper); await flushPromises();
    const text = wrapper.text(); expect(text.indexOf('old-model')).toBeLessThan(text.indexOf('Ollama'));
    expect(wrapper.get('[data-testid="llama-default-model-change"]').text()).toContain(model.name);
    expect(apply).not.toHaveBeenCalled();
    await wrapper.get('[data-testid="llama-default-confirm"]').trigger('click');
    expect(apply).toHaveBeenCalledWith({ model, previous: current });
    expect(wrapper.get('[data-testid="llama-default-confirm"]').attributes('disabled')).toBeDefined();
    gate.resolve('applied'); await flushPromises(); expect(wrapper.emitted('close')).toHaveLength(1);
  });
  it('omits unchanged endpoint rows, supports cancellation and retains the dialog on save failure', async () => {
    const apply = vi.fn<ApplyDefaultModel>().mockRejectedValue(new Error('Storage unavailable'));
    const wrapper = mount(LlamaCppBrowserDefaultModelDialog, { props: { model, current: { endpoint: { type: 'llama_cpp_browser' }, modelId: undefined }, models: [model], apply }, global: { stubs: { Teleport: true } } }); wrappers.push(wrapper); await flushPromises();
    expect(wrapper.find('[data-testid="llama-default-endpoint-change"]').exists()).toBe(false);
    await wrapper.get('[data-testid="llama-default-cancel"]').trigger('click'); expect(apply).not.toHaveBeenCalled();
    await wrapper.get('[data-testid="llama-default-confirm"]').trigger('click'); await flushPromises();
    expect(wrapper.find('[role="alert"]').exists()).toBe(true); expect(wrapper.emitted('close')).toHaveLength(1);
  });
});
