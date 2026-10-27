import { beforeEach, expect, it, vi } from 'vitest';
import { mount } from '@vue/test-utils';
import { computed } from 'vue';
import { ensureAllStringsForTest } from '@/strings/utils.test-support';
import { createDisabledImageLibrary } from '@/features/stable-diffusion-cpp-browser/library-standalone';
import ImageCatalogDownloadStatus from './ImageCatalogDownloadStatus.vue';
import LlamaCppBrowserDownloadProgress from '@/features/llama-cpp-browser/components/LlamaCppBrowserDownloadProgress.vue';
import ImageModelLocalFileRecovery from './ImageModelLocalFileRecovery.vue';

vi.mock('@/components/csp/CspMessageHint.vue', () => ({ default: { name: 'CspMessageHint', render: () => undefined } }));
vi.mock('./ImageModelLocalFileRecovery.vue', () => ({ default: { name: 'ImageModelLocalFileRecovery', props: ['view', 'disabled'], template: '<div data-testid="image-local-recovery-probe" />' } }));

beforeEach(async () => {
  await ensureAllStringsForTest({ locale: 'ja' });
});

it('uses the existing llama progress component with the aggregate recipe total and removes it on completion', async () => {
  const view = createDisabledImageLibrary();
  view.downloadState.value = 'downloading';
  view.downloading = computed(() => view.downloadState.value === 'downloading');
  view.downloadProgress.value = { phase: 'transferring', index: 1, count: 3, path: 'vae/model.safetensors', repository: 'org/vae', completed: 400, total: 1000, processed: 100, fileTotal: 100, fileCompleted: 30 };
  const wrapper = mount(ImageCatalogDownloadStatus, { props: { view, disabled: false, localInputDisabled: false } });
  using _cleanupResource = {
    [Symbol.dispose]() {
      wrapper.unmount();
    },
  };
  expect(wrapper.find('progress').exists()).toBe(false);
  expect(wrapper.getComponent(LlamaCppBrowserDownloadProgress).props('progress')).toMatchObject({ completed: 400, total: 1000, processed: 100 });
  expect(wrapper.get('[role="progressbar"] > div').classes()).toContain('bg-blue-600');
  view.downloadState.value = 'complete';
  await wrapper.vm.$nextTick();
  expect(wrapper.find('[role="progressbar"]').exists()).toBe(false);
  expect(wrapper.text()).toBe('ダウンロード済み');
  view.downloadState.value = 'incomplete';
  await wrapper.vm.$nextTick();
  expect(wrapper.text()).not.toContain('準備ができました');
  expect(wrapper.text()).toContain('構成');
});

it('offers image-local recovery without a CSP message and preserves the separate editor guard', async () => {
  const view = createDisabledImageLibrary();
  view.downloadState.value = 'failed';
  view.resumeDownload = vi.fn(async () => {});
  const wrapper = mount(ImageCatalogDownloadStatus, { props: { view, disabled: false, localInputDisabled: true } });
  using _cleanup = { [Symbol.dispose]: () => wrapper.unmount() };
  expect(wrapper.findComponent(ImageModelLocalFileRecovery).exists()).toBe(false);
  await wrapper.get('[data-testid="hf-download-failure-trigger"]').trigger('click');
  const recovery = wrapper.getComponent(ImageModelLocalFileRecovery);
  expect(recovery.props('view')).toBe(view);
  expect(recovery.props('disabled')).toBe(true);
  expect(wrapper.get<HTMLButtonElement>('[data-testid="image-resume-download"]').element.disabled).toBe(false);
  expect(view.resumeDownload).not.toHaveBeenCalled();
  await wrapper.setProps({ disabled: true, localInputDisabled: false });
  expect(recovery.props('disabled')).toBe(false);
  expect(wrapper.get<HTMLButtonElement>('[data-testid="image-resume-download"]').element.disabled).toBe(true);
  view.downloadState.value = 'paused';
  await wrapper.vm.$nextTick();
  expect(wrapper.find('[data-testid="hf-download-failure-trigger"]').exists()).toBe(false);
  expect(wrapper.findComponent(ImageModelLocalFileRecovery).exists()).toBe(false);
});
