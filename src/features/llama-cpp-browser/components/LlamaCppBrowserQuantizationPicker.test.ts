import { enableAutoUnmount, flushPromises, mount } from '@vue/test-utils';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { RepositoryCatalog } from '@/features/llama-cpp-browser/hugging-face/catalog';
import { ensureAllStringsForTest } from '@/strings/utils.test-support';
import LlamaCppBrowserQuantizationPicker from './LlamaCppBrowserQuantizationPicker.vue';

enableAutoUnmount(afterEach);
const inspect = vi.hoisted(() => vi.fn());
vi.mock('@/features/llama-cpp-browser/hugging-face/metadata-session', () => ({ getMetadataSession: () => ({ inspect }) }));

function catalog(): RepositoryCatalog {
  return {
    repository: 'owner/Model-GGUF',
    revision: 'a'.repeat(40),
    projectors: [],
    models: [
      { label: 'Q4_K_M', files: [{ path: 'Model-Q4_K_M.gguf', size: 1024 }], size: 1024 },
      { label: 'Q8_0', files: [{ path: 'Model-Q8_0.gguf', size: 2048 }], size: 2048 },
      { label: 'auxiliary', files: [{ path: 'dflash-Model-Q4_K_M.gguf', size: 512 }], size: 512 },
    ],
  };
}

function renderPicker({ inspection }: { inspection: 'model-url' | 'on-request' }) {
  return mount(LlamaCppBrowserQuantizationPicker, { attachTo: document.body, global: { stubs: { Teleport: true } }, props: { repository: 'owner/Model-GGUF', variant: 'Q4_K_M', disabled: false, inspection } });
}

beforeEach(async () => {
  inspect.mockReset().mockResolvedValue(catalog());
  await ensureAllStringsForTest({ locale: 'en' });
});

it('loads model-link metadata on entry and shows real sizes without a confirmation step', async () => {
  const wrapper = renderPicker({ inspection: 'model-url' });
  await flushPromises();
  await wrapper.get('[data-testid="model-preview-quantization"]').trigger('click');
  expect(wrapper.find('[data-testid="quantization-fetch-options"]').exists()).toBe(false);
  expect(inspect).toHaveBeenCalledExactlyOnceWith({ input: 'owner/Model-GGUF', signal: expect.any(AbortSignal), freshness: 'reuse' });
  expect(wrapper.findAll('[role="option"]')).toHaveLength(2);
  expect(wrapper.get('[data-testid="quantization-option-Model-Q4_K_M.gguf"]').text()).toContain('1.0 KiB');
  expect(wrapper.get('[data-testid="quantization-option-Model-Q4_K_M.gguf"]').attributes('aria-selected')).toBe('true');
  await wrapper.get('[data-testid="quantization-option-Model-Q8_0.gguf"]').trigger('click');
  expect(wrapper.emitted('select')).toEqual([['Model-Q8_0.gguf']]);
  expect(wrapper.find('[data-testid="quantization-picker"]').exists()).toBe(false);
  await wrapper.get('[data-testid="model-preview-quantization"]').trigger('click');
  expect(wrapper.findAll('[role="option"]')).toHaveLength(2);
  expect(inspect).toHaveBeenCalledOnce();
});

it('aborts on a repository change and never applies a late response', async () => {
  const pending = Promise.withResolvers<RepositoryCatalog>();
  inspect.mockReturnValueOnce(pending.promise);
  const wrapper = renderPicker({ inspection: 'model-url' });
  await flushPromises();
  const signal: AbortSignal = inspect.mock.calls[0]![0].signal;
  const nextCatalog = { ...catalog(), repository: 'owner/Other-GGUF' };
  inspect.mockResolvedValueOnce(nextCatalog);
  await wrapper.setProps({ repository: nextCatalog.repository });
  expect(signal.aborted).toBe(true);
  await flushPromises();
  pending.resolve(catalog());
  await flushPromises();
  expect(wrapper.emitted('inspected')).toEqual([[nextCatalog]]);
  expect(inspect).toHaveBeenCalledTimes(2);
});

it('retries only on another explicit action after a metadata error', async () => {
  inspect.mockRejectedValueOnce(new Error('offline'));
  const wrapper = renderPicker({ inspection: 'model-url' });
  await flushPromises();
  await wrapper.get('[data-testid="model-preview-quantization"]').trigger('click');
  expect(wrapper.get('[role="alert"]').text()).toContain('Could not fetch');
  expect(inspect).toHaveBeenCalledOnce();
  await wrapper.get('[data-testid="quantization-fetch-options"]').trigger('click');
  await flushPromises();
  expect(inspect).toHaveBeenCalledTimes(2);
  expect(wrapper.findAll('[role="option"]')).toHaveLength(2);
});

it('closes on Escape without cancelling page metadata, restores focus, and aborts on unmount', async () => {
  const pending = Promise.withResolvers<RepositoryCatalog>();
  inspect.mockReturnValueOnce(pending.promise);
  const wrapper = renderPicker({ inspection: 'model-url' });
  await flushPromises();
  const trigger = wrapper.get('[data-testid="model-preview-quantization"]');
  await trigger.trigger('click');
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  await flushPromises();
  expect(inspect.mock.calls[0]![0].signal.aborted).toBe(false);
  expect(document.activeElement).toBe(trigger.element);
  expect(wrapper.find('[data-testid="quantization-picker"]').exists()).toBe(false);
  pending.resolve(catalog());
  await flushPromises();
  expect(wrapper.emitted('inspected')).toEqual([[catalog()]]);
  await wrapper.setProps({ disabled: true });
  await trigger.trigger('click');
  expect(wrapper.find('[data-testid="quantization-picker"]').exists()).toBe(false);
  const next = Promise.withResolvers<RepositoryCatalog>();
  inspect.mockReturnValueOnce(next.promise);
  await wrapper.setProps({ repository: 'owner/Other-GGUF' });
  await flushPromises();
  const signal: AbortSignal = inspect.mock.calls[1]![0].signal;
  wrapper.unmount();
  expect(signal.aborted).toBe(true);
  next.resolve({ ...catalog(), repository: 'owner/Other-GGUF' });
  await flushPromises();
});

it('requires an explicit action outside the model-link page', async () => {
  const wrapper = renderPicker({ inspection: 'on-request' });
  await flushPromises();
  expect(inspect).not.toHaveBeenCalled();
  await wrapper.get('[data-testid="model-preview-quantization"]').trigger('click');
  expect(inspect).not.toHaveBeenCalled();
  await wrapper.get('[data-testid="quantization-fetch-options"]').trigger('click');
  await flushPromises();
  expect(inspect).toHaveBeenCalledExactlyOnceWith({ input: 'owner/Model-GGUF', signal: expect.any(AbortSignal), freshness: 'refresh' });
});

it('keeps guidance and choices in one content area while preserving their separate keyboard controls', async () => {
  const wrapper = mount(LlamaCppBrowserQuantizationPicker, {
    attachTo: document.body,
    props: { repository: 'owner/Model-GGUF', variant: 'Q4_K_M', disabled: false, inspection: 'model-url' },
    global: { stubs: { Teleport: true, CspMessageHint: { template: '<details data-testid="picker-guidance"><summary>Connection guidance</summary><button data-testid="guidance-action">Export data</button></details>' } } },
  });
  await flushPromises();
  const trigger = wrapper.get('[data-testid="model-preview-quantization"]');
  await trigger.trigger('click');
  const content = wrapper.get('[data-testid="quantization-picker-content"]');
  const guidance = wrapper.get('[data-testid="picker-guidance"]');
  const list = wrapper.get('[role="listbox"]');
  expect(content.element.contains(guidance.element)).toBe(true);
  expect(content.element.contains(list.element)).toBe(true);
  expect(list.element.contains(guidance.element)).toBe(false);
  guidance.element.setAttribute('open', '');
  const action = wrapper.get<HTMLButtonElement>('[data-testid="guidance-action"]');
  action.element.focus();
  await action.trigger('keydown', { key: 'Tab' });
  await action.trigger('keydown', { key: 'ArrowDown' });
  expect(wrapper.find('[data-testid="quantization-picker"]').exists()).toBe(true);
  expect(document.activeElement).toBe(action.element);
  const options = wrapper.findAll<HTMLButtonElement>('[role="option"]');
  options[0]!.element.focus();
  await options[0]!.trigger('keydown', { key: 'ArrowDown' });
  expect(document.activeElement).toBe(options[1]!.element);
  expect(inspect).toHaveBeenCalledOnce();
  await options[1]!.trigger('keydown', { key: 'Escape' });
  expect(wrapper.find('[data-testid="quantization-picker"]').exists()).toBe(false);
  expect(document.activeElement).toBe(trigger.element);
});
