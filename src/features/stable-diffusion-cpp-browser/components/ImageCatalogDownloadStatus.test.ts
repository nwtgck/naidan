import { beforeEach, expect, it } from 'vitest';
import { mount } from '@vue/test-utils';
import { computed } from 'vue';
import { ensureAllStringsForTest } from '@/strings/test-utils';
import { createDisabledImageLibrary } from '@/features/stable-diffusion-cpp-browser/library-standalone';
import ImageCatalogDownloadStatus from './ImageCatalogDownloadStatus.vue';
import LlamaCppBrowserDownloadProgress from '@/features/llama-cpp-browser/components/LlamaCppBrowserDownloadProgress.vue';
beforeEach(async () => {
  await ensureAllStringsForTest({ locale: 'ja' });
});
it('uses the existing llama progress component with the aggregate recipe total and removes it on completion', async () => {
  const view = createDisabledImageLibrary(); view.downloadState.value = 'downloading';
  view.downloading = computed(() => view.downloadState.value === 'downloading');
  view.downloadProgress.value = { phase: 'transferring', index: 1, count: 3, path: 'vae/model.safetensors', repository: 'org/vae', completed: 400, total: 1000, processed: 100, fileTotal: 100, fileCompleted: 30 };
  const wrapper = mount(ImageCatalogDownloadStatus, { props: { view, disabled: false } });
  try {
    expect(wrapper.find('progress').exists()).toBe(false);
    expect(wrapper.getComponent(LlamaCppBrowserDownloadProgress).props('progress')).toMatchObject({ completed: 400, total: 1000, processed: 100 });
    view.downloadState.value = 'complete'; await wrapper.vm.$nextTick();
    expect(wrapper.find('[role="progressbar"]').exists()).toBe(false);
    expect(wrapper.text()).toBe('ダウンロード済み');
    view.downloadState.value = 'incomplete'; await wrapper.vm.$nextTick();
    expect(wrapper.text()).not.toContain('準備ができました');
    expect(wrapper.text()).toContain('構成');
  } finally {
    wrapper.unmount();
  }
});
