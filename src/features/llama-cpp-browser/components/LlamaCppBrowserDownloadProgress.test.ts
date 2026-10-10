import { mount } from '@vue/test-utils';
import { beforeEach, describe, expect, it } from 'vitest';
import { ensureAllStringsForTest } from '@/strings/test-utils';
import LlamaCppBrowserDownloadProgress from './LlamaCppBrowserDownloadProgress.vue';
import type { DownloadProgress } from '@/features/llama-cpp-browser/hugging-face/types';

beforeEach(async () => {
  await ensureAllStringsForTest({ locale: 'en' });
});

describe('download progress appearance', () => {
  const progress: DownloadProgress = { phase: 'transferring', completed: 25, total: 100, processed: 25 };

  it('uses Naidan blue for both appearances while keeping their respective sizes', () => {
    const welcome = mount(LlamaCppBrowserDownloadProgress, { props: { progress, appearance: 'welcome' } });
    const manager = mount(LlamaCppBrowserDownloadProgress, { props: { progress, appearance: 'manager' } });
    for (const wrapper of [welcome, manager]) {
      expect(wrapper.get('[role="progressbar"]').attributes('aria-valuenow')).toBe('25');
      expect(wrapper.get('[role="progressbar"] > div').classes()).toContain('bg-blue-600');
      expect(wrapper.get('[role="progressbar"] > div').classes()).toContain('dark:bg-blue-500');
      expect(wrapper.get('[role="progressbar"] > div').classes()).toContain('motion-reduce:transition-none');
      expect(wrapper.get('[data-testid="llama-download-progress"] .font-semibold').classes()).toContain('text-blue-600');
    }
    expect(welcome.get('[role="progressbar"]').classes()).toContain('h-2.5');
    expect(manager.get('[role="progressbar"]').classes()).toContain('h-1.5');
    welcome.unmount(); manager.unmount();
  });

  it('does not render NaN or an invalid aria value for an unknown total', () => {
    const wrapper = mount(LlamaCppBrowserDownloadProgress, { props: { progress: { ...progress, completed: 0, total: 0 }, appearance: 'welcome' } });
    expect(wrapper.find('[role="progressbar"]').exists()).toBe(false);
    expect(wrapper.text()).not.toContain('NaN');
    wrapper.unmount();
  });
});
