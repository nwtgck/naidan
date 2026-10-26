import { flushPromises, mount } from '@vue/test-utils';
import { defineComponent, h } from 'vue';
import { beforeEach, expect, it, vi } from 'vitest';
import { ensureAllStringsForTest } from '@/strings/utils.test-support';
import HuggingFaceDownloadFailureHint from './HuggingFaceDownloadFailureHint.vue';
import LlamaCppBrowserLocalFileRecovery from '@/features/llama-cpp-browser/components/LlamaCppBrowserLocalFileRecovery.vue';

vi.mock('@/composables/useCspMessageHintsOnly', () => {
  throw new Error('Optional CSP module could not load');
});

beforeEach(async () => {
  await ensureAllStringsForTest({ locale: 'en' });
});

it('keeps local file recovery and the original controls when CSP loading fails', async () => {
  const accept = vi.fn();
  const clicked = vi.fn();
  const applicationError = vi.fn();
  using mounted = {
    wrapper: mount(defineComponent({
      render: () => h('div', [
        h('p', { 'data-testid': 'original-error' }, 'Download failed'),
        h(HuggingFaceDownloadFailureHint, undefined, { default: () => h(LlamaCppBrowserLocalFileRecovery, { disabled: false, acceptLocalInput: accept }) }),
        h('button', { 'data-testid': 'original-retry', onClick: clicked }, 'Retry'),
      ]),
    }), { global: { config: { errorHandler: applicationError } } }),
    [Symbol.dispose]() {
      this.wrapper.unmount();
    },
  };
  const retry = mounted.wrapper.get('[data-testid="original-retry"]').element;
  expect(mounted.wrapper.find('[data-testid="gguf-local-recovery"]').exists()).toBe(false);
  await mounted.wrapper.get('[data-testid="hf-download-failure-trigger"]').trigger('click');
  await vi.dynamicImportSettled();
  await flushPromises();
  expect(mounted.wrapper.find('[data-testid="csp-message-hint"]').exists()).toBe(false);
  expect(mounted.wrapper.get('[data-testid="gguf-local-recovery"]').text()).toContain('Use local model files');
  expect(mounted.wrapper.find('[data-testid="llama-cpp-browser-file"]').exists()).toBe(true);
  expect(mounted.wrapper.get('[data-testid="original-error"]').text()).toBe('Download failed');
  expect(mounted.wrapper.get('[data-testid="original-retry"]').element).toBe(retry);
  await mounted.wrapper.get('[data-testid="original-retry"]').trigger('click');
  expect(clicked).toHaveBeenCalledOnce();
  expect(accept).not.toHaveBeenCalled();
  expect(applicationError).not.toHaveBeenCalled();
});
